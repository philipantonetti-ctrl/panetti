import { db } from '../db'
import { VOIDED_STATUSES } from '../metrics/types'
import { postSlack } from '../slack/notify'
import { getSetting } from '../settings'
import { getDeliveryConfig } from './config'
import { deliveryFor, type DeliveryState } from './view'

export type LateAlert = {
  id: string
  number: string
  shop: string
  country: string | null
  daysOver: number
  promiseDays: number | null
  state: DeliveryState
  trackingNumbers: string[]
}

/** Lines printed before the message summarises the rest. Slack limits payloads. */
const MAX_LINES = 25

const DAY = 24 * 60 * 60 * 1000

/**
 * How far back a run will look for an order that has newly broken its promise.
 * Bounds the candidate set in time, so the queue cannot silently fill with
 * history that will never alert. Also stops a flood on the day the feature is
 * switched on with a backdated tracking start.
 */
const ALERT_WINDOW_DAYS = 90

/**
 * How many candidates one run considers. With the outstanding-only filter and
 * the time window below, this is bounded by orders genuinely in flight, not by
 * total order history — what makes 500 a safe number rather than an
 * optimistic one.
 */
const CANDIDATE_LIMIT = 500

const SAYS: Record<DeliveryState, string> = {
  NO_TRACKING: 'Not shipped',
  BOOKED: 'Still at the warehouse',
  IN_TRANSIT: 'In transit',
  RETURNED: 'Returned to sender',
  CANCELLED: 'Delivery cancelled',
  AVAILABLE: 'Delivered',
  VOIDED: 'Refunded',
  UNTRACKED: 'Not tracked',
  BEFORE_TRACKING: 'Before tracking started',
}

export function alertMessage(late: LateAlert[], appUrl: string): string {
  const head =
    late.length === 1
      ? '1 order is past its delivery promise'
      : `${late.length} orders are past their delivery promise`

  const lines = late.slice(0, MAX_LINES).map((l) => {
    const where = l.country ? ` to ${l.country}` : ''
    const promise = l.promiseDays === null ? '' : ` (promise ${l.promiseDays} days)`
    const track = l.trackingNumbers
      .map((n) => ` <https://tracking.bring.com/tracking/${n}|track>`)
      .join('')
    return (
      `• <${appUrl}/orders?q=${encodeURIComponent(l.number)}|${l.number}> ` +
      `${l.shop}${where} — ${l.daysOver} days over${promise}. ${SAYS[l.state]}.${track}`
    )
  })

  const rest = late.length - lines.length
  return [head, ...lines, ...(rest > 0 ? [`…and ${rest} more.`] : [])].join('\n')
}

/**
 * Post one message naming the orders that newly broke their promise, then mark
 * them so they never alert again.
 *
 * Runs at the end of the ordinary 15-minute cron, so there is no second
 * schedule to maintain. Most runs find nothing and post nothing.
 *
 * The order of the last two steps matters: Slack first, the stamp second. If
 * Slack is down the orders stay unstamped and the next run tries again, instead
 * of the alert vanishing into a 500.
 */
export async function flushDeliveryAlerts(
  opts: { now?: Date } = {},
): Promise<{ sent: number; skipped: string | null }> {
  const now = opts.now ?? new Date()
  const { slackWebhookUrl } = await getDeliveryConfig()
  if (!slackWebhookUrl) return { sent: 0, skipped: 'Slack is not connected.' }

  const [candidates, promises, { timezone }] = await Promise.all([
    db.order.findMany({
      where: {
        deliveryAlertedAt: null,
        // A refunded or cancelled order is never going to be delivered. Without
        // this every refund in the tracked window becomes a permanent late
        // delivery and the channel fills with orders nobody is waiting for.
        status: { notIn: [...VOIDED_STATUSES] },
        shop: { deliveryTrackingFrom: { not: null } },
        // Only orders that could still be outstanding. An order whose every
        // parcel is already with the customer can never be "late AND not yet
        // available", and — because an on-time delivery is never stamped — such
        // orders would otherwise sit in this filter forever. Ordered oldest
        // first under a limit, they permanently crowd out the orders that
        // actually need alerting, and the run reports alertsSent: 0 while
        // looking perfectly healthy.
        //
        // `none: {}` keeps the order the warehouse never booked at all, which
        // is the single most important thing this alert catches. A RETURNED
        // parcel has a null availableAt by construction in map.ts, so returns
        // stay in too.
        OR: [
          { shipments: { none: {} } },
          { shipments: { some: { availableAt: null } } },
        ],
        // And a floor in time. Without one, orders that were never shipped and
        // never alerted accumulate the same way. An order that went late months
        // ago is not news now — it alerted when it first went late, or the
        // feature was not running, and either way paging someone today changes
        // nothing.
        placedAt: { gte: new Date(now.getTime() - ALERT_WINDOW_DAYS * DAY) },
      },
      orderBy: { placedAt: 'asc' },
      take: CANDIDATE_LIMIT,
      select: {
        id: true, number: true, placedAt: true, status: true, shippingCountry: true,
        shop: { select: { name: true, timezone: true, deliveryTrackingFrom: true } },
        shipments: {
          select: {
            trackingNumber: true, bookedAt: true, handedInAt: true,
            availableAt: true, collectedAt: true, outcome: true, lastStatus: true,
          },
        },
      },
    }),
    db.deliveryPromise.findMany(),
    getSetting(),
  ])

  const late: LateAlert[] = []
  for (const o of candidates) {
    const view = deliveryFor(
      {
        id: o.id, number: o.number, placedAt: o.placedAt, status: o.status,
        shippingCountry: o.shippingCountry,
        shopName: o.shop.name,
        shopTimezone: o.shop.timezone,
        shopTrackingFrom: o.shop.deliveryTrackingFrom,
        shipments: o.shipments,
      },
      promises,
      timezone,
      now,
    )
    // Two conditions, not one. `late` covers everything that missed its
    // promise, INCLUDING orders that arrived late — those belong in the on-time
    // rate, but paging someone about a parcel already in the customer's hands
    // changes nothing and trains people to ignore the channel. Alert only on
    // what is still outstanding: undelivered, or returned (availableAt is null
    // for a return, so returns correctly stay in).
    if (!view.late || view.availableAt !== null) continue
    late.push({
      id: o.id, number: o.number, shop: o.shop.name,
      country: o.shippingCountry || null,
      daysOver: view.daysOver ?? 0,
      promiseDays: view.promiseDays,
      state: view.state,
      trackingNumbers: view.trackingNumbers,
    })
  }

  if (late.length === 0) return { sent: 0, skipped: null }

  // Worst first: if the message is capped, the lines that survive are the ones
  // that matter most.
  late.sort((a, b) => b.daysOver - a.daysOver)

  const appUrl = process.env.APP_URL ?? 'https://panetti.vercel.app'
  try {
    await postSlack(slackWebhookUrl, alertMessage(late, appUrl))
  } catch (e) {
    // postSlack throws on failure, deliberately: the caller must not mark
    // anything alerted for a message that never arrived. Caught here so this
    // function keeps its own promise — Slack being down is a normal result,
    // not an unhandled rejection — and RECORDED, because a silently broken
    // webhook is indistinguishable from a quiet week with nothing late.
    const reason = e instanceof Error ? e.message : 'Slack post failed'
    await db.deliveryConfig
      .update({ where: { id: 'singleton' }, data: { lastError: reason } })
      .catch(() => {
        // Bookkeeping is never worth failing an alert run over — same rule
        // recordRun follows in woo/sync.ts.
      })
    return { sent: 0, skipped: reason }
  }

  // Every one of them, not only the printed lines: a line we chose not to print
  // is not new tomorrow.
  await db.order.updateMany({
    where: { id: { in: late.map((l) => l.id) } },
    data: { deliveryAlertedAt: now },
  })

  // A stale error that outlives the outage is its own lie: clear it the moment
  // Slack accepts a message again. Best-effort, same as recording it.
  await db.deliveryConfig
    .update({ where: { id: 'singleton' }, data: { lastError: null } })
    .catch(() => {
      // Bookkeeping is never worth failing an alert run over.
    })

  return { sent: late.length, skipped: null }
}
