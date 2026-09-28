/**
 * Reminding a customer that their parcel is waiting at the pickup point.
 *
 * Bring already tells the customer when a parcel arrives and sends up to two
 * reminders of its own. People still forget, and an uncollected parcel comes
 * back to us at our cost. So two days after arrival, if it is still not
 * collected, the customer gets ONE email from the shop itself, in their
 * language. Two days because Bring's parcel lockers keep a parcel for only four
 * days from 1 October 2026; a reminder on day five would arrive after it left.
 *
 * Bring only. DHL's tracking has no "ready for pickup" status yet (DHL says it
 * is planned), so a DHL parcel at a service point looks exactly like a parcel
 * at the door and there is nothing to remind about.
 *
 * Its own cron route rather than a stage in the fifteen-minute sync: that run
 * is budgeted to the second, and a reminder is a daytime job anyway.
 */
import { db } from '../db'
import { fetchTracking as fetchBring } from '../bring/client'
import { mapConsignments } from '../bring/map'
import { PostmarkError, sendEmail } from '../email/send'
import { VOIDED_STATUSES } from '../metrics/types'
import { getSetting } from '../settings'
import { getDeliveryConfig } from './config'
import { brandOf, firstNameOf, languageFor, pickupReminderEmail, type ReminderLanguage } from './pickup-reminder-text'
import { trackingUrl } from './tracking-url'

const DAY = 24 * 60 * 60 * 1000

/** How long a parcel waits before we remind. */
export const REMIND_AFTER_DAYS = 2

/**
 * Past this, a reminder is more likely to arrive after the parcel was sent
 * back than before. Also what bounds retries: an order whose email keeps
 * failing leaves the queue on its own once its parcel is this old.
 */
export const GIVE_UP_AFTER_DAYS = 6

const MAX_ORDERS_PER_RUN = 25

/**
 * A run stops after this many failures in a row. A sender Postmark has not
 * verified fails every message the same way, and one more try teaches nothing.
 */
const MAX_FAILURES_IN_A_ROW = 3

/** Postmark's codes for "this ADDRESS can never receive", as opposed to "we cannot send". */
const DEAD_ADDRESS = new Set([300, 406])

const ERROR_LIMIT = 300

export type PickupReminderResult = {
  sent: number
  failed: number
  /** Orders whose parcels turned out to be collected when we asked Bring just before sending. */
  alreadyCollected: number
  /** Why the run did nothing at all; null when it ran. */
  skipped: string | null
}

type SenderShop = { name: string; reminderSenderEmail: string | null; mailboxes: { address: string }[] }

/** The bare address in EMAIL_FROM, which may already carry a display name. */
function bareAddress(from: string | undefined): string | null {
  if (!from) return null
  const m = from.match(/<([^>]+)>/)
  return (m ? m[1] : from).trim() || null
}

/**
 * Who the reminder is from: the shop's brand by name, at the address set for
 * reminders, else the shop's inbox mailbox, else the app's EMAIL_FROM. Null
 * when none exists, and sendEmail then says EMAIL_FROM is missing.
 */
export function senderFor(shop: SenderShop): string | null {
  const address =
    shop.reminderSenderEmail?.trim() || shop.mailboxes[0]?.address || bareAddress(process.env.EMAIL_FROM)
  if (!address) return null
  return `"${brandOf(shop.name).replace(/"/g, '')}" <${address}>`
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, ERROR_LIMIT)

export async function sendPickupReminders(
  opts: { now?: Date; deadline?: number; maxOrders?: number } = {},
): Promise<PickupReminderResult> {
  const now = opts.now ?? new Date()
  const max = opts.maxOrders ?? MAX_ORDERS_PER_RUN
  const idle = (skipped: string): PickupReminderResult => ({ sent: 0, failed: 0, alreadyCollected: 0, skipped })

  const shops = await db.shop.findMany({
    where: { pickupReminderFrom: { not: null } },
    select: {
      id: true, name: true, timezone: true, pickupReminderFrom: true, reminderSenderEmail: true,
      mailboxes: { where: { active: true }, select: { address: true }, orderBy: { createdAt: 'asc' }, take: 1 },
    },
  })
  if (shops.length === 0) return idle('No shop has pickup reminders switched on.')

  // Asked again just before sending, so the reminder rests on what Bring says
  // now rather than on the once-a-day poll a parcel gets while it waits.
  const { creds } = await getDeliveryConfig()
  if (!creds) return idle('Bring is not connected.')

  const { timezone: fallbackTz } = await getSetting()
  const byId = new Map(shops.map((s) => [s.id, s]))

  const remindBy = new Date(now.getTime() - REMIND_AFTER_DAYS * DAY)
  const tooOld = new Date(now.getTime() - GIVE_UP_AFTER_DAYS * DAY)
  /** A parcel still sitting at the pickup point, as the last poll left it. */
  const waiting = { carrier: 'BRING', dismissedAt: null, collectedAt: null, terminal: false, availableAt: { not: null } }

  const orders = await db.order.findMany({
    where: {
      pickupReminderAt: null,
      // A B2B order has no shop customer to write to, and a refunded or
      // cancelled one has nothing worth collecting.
      b2bCustomerId: null,
      status: { notIn: [...VOIDED_STATUSES] },
      OR: shops.map((s) => ({
        shopId: s.id,
        shipments: {
          some: {
            ...waiting,
            // Arrived on or after the day the shop was switched on, at least
            // two days ago, and not so long ago it has probably gone back.
            availableAt: {
              gte: s.pickupReminderFrom! > tooOld ? s.pickupReminderFrom! : tooOld,
              lte: remindBy,
            },
          },
        },
      })),
    },
    orderBy: { placedAt: 'asc' },
    take: max,
    select: {
      id: true, number: true, shopId: true, customerName: true, customerEmail: true, shippingCountry: true,
      shipments: {
        where: waiting,
        orderBy: { availableAt: 'asc' },
        select: { id: true, trackingNumber: true, availableAt: true, recipientEmail: true, destinationCountry: true },
      },
    },
  })

  let sent = 0
  let failed = 0
  let alreadyCollected = 0
  let inARow = 0
  let lastProblem: string | null = null

  for (const order of orders) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break
    if (inARow >= MAX_FAILURES_IN_A_ROW) break
    const shop = byId.get(order.shopId)
    if (!shop) continue

    // Which of this order's parcels are still there, according to Bring now.
    const still: typeof order.shipments = []
    let unsure = false
    for (const p of order.shipments) {
      try {
        const found = mapConsignments(await fetchBring(creds, [p.trackingNumber], { deadline: opts.deadline }))[0]
        if (!found) {
          unsure = true
          continue
        }
        const m = found.milestones
        if (m.collectedAt || !m.availableAt || m.outcome !== 'DELIVERED') {
          // Collected or on its way back since the last poll. The poller owns
          // writing that down properly, so it is simply made due now.
          await db.shipment.update({ where: { id: p.id }, data: { nextPollAt: now } }).catch(() => {})
          continue
        }
        still.push(p)
      } catch (e) {
        unsure = true
        await db.order
          .update({ where: { id: order.id }, data: { pickupReminderError: `Could not ask Bring: ${message(e)}` } })
          .catch(() => {})
      }
    }
    // Never remind on a guess: a parcel Bring would not answer about stays
    // unreminded this run, and the next run asks again.
    if (unsure) continue
    if (still.length === 0) {
      alreadyCollected++
      continue
    }

    const first = still[0]
    const to = (order.customerEmail ?? '').trim() || (first.recipientEmail ?? '').trim()
    if (!to) {
      // Nothing to send to, now or later. Out of the queue, with the reason.
      await db.order.update({
        where: { id: order.id },
        data: { pickupReminderAt: now, pickupReminderError: 'The order has no email address' },
      })
      continue
    }

    const language: ReminderLanguage = languageFor(order.shippingCountry || first.destinationCountry)
    const email = pickupReminderEmail({
      language,
      brand: brandOf(shop.name),
      firstName: firstNameOf(order.customerName),
      orderNumber: order.number,
      trackingUrl: trackingUrl(first.trackingNumber, 'BRING')!,
      arrivedAt: first.availableAt!,
      timeZone: shop.timezone ?? fallbackTz,
    })

    try {
      await sendEmail(to, email.subject, email.text, { from: senderFor(shop) ?? undefined })
      await db.order.update({ where: { id: order.id }, data: { pickupReminderAt: now, pickupReminderError: null } })
      sent++
      inARow = 0
    } catch (e) {
      failed++
      const why = message(e)
      const dead = e instanceof PostmarkError && e.errorCode !== null && DEAD_ADDRESS.has(e.errorCode)
      if (dead) {
        // The address itself is refused. Trying again changes nothing.
        await db.order
          .update({ where: { id: order.id }, data: { pickupReminderAt: now, pickupReminderError: why } })
          .catch(() => {})
      } else {
        // Our side: a sender not verified, an account not approved, Postmark
        // down. The order keeps its place and the settings page says why.
        inARow++
        lastProblem = why
        await db.order.update({ where: { id: order.id }, data: { pickupReminderError: why } }).catch(() => {})
      }
    }
  }

  // The settings page shows the last problem until a reminder gets through.
  if (lastProblem || sent > 0) {
    await db.deliveryConfig
      .update({ where: { id: 'singleton' }, data: { pickupReminderLastError: sent > 0 && !lastProblem ? null : lastProblem } })
      .catch(() => {})
  }

  return { sent, failed, alreadyCollected, skipped: null }
}

/**
 * The reminder as a customer of this shop would get it, sent to whoever is
 * asking. Proves the sender works and shows the words, before any customer
 * sees them. The language is the one most of the shop's orders ship to.
 */
export async function sendTestPickupReminder(
  shopId: string,
  to: string,
  now: Date = new Date(),
): Promise<{ language: ReminderLanguage; from: string | null }> {
  const shop = await db.shop.findUnique({
    where: { id: shopId },
    select: {
      name: true, timezone: true, reminderSenderEmail: true,
      mailboxes: { where: { active: true }, select: { address: true }, orderBy: { createdAt: 'asc' }, take: 1 },
    },
  })
  if (!shop) throw new Error('No such shop')
  const [top] = await db.order.groupBy({
    by: ['shippingCountry'],
    where: { shopId, shippingCountry: { notIn: [''] } },
    _count: { _all: true },
    orderBy: { _count: { shippingCountry: 'desc' } },
    take: 1,
  })
  const language = languageFor(top?.shippingCountry)
  const { timezone: fallbackTz } = await getSetting()
  const from = senderFor(shop)
  const email = pickupReminderEmail({
    language,
    brand: brandOf(shop.name),
    firstName: 'Anna',
    orderNumber: '12345',
    trackingUrl: trackingUrl('370000000000000000', 'BRING')!,
    arrivedAt: new Date(now.getTime() - REMIND_AFTER_DAYS * DAY),
    timeZone: shop.timezone ?? fallbackTz,
  })
  await sendEmail(to, `[TEST] ${email.subject}`, email.text, { from: from ?? undefined })
  // A test that got through is proof the sender works; the old problem is gone.
  await db.deliveryConfig
    .update({ where: { id: 'singleton' }, data: { pickupReminderLastError: null } })
    .catch(() => {})
  return { language, from }
}
