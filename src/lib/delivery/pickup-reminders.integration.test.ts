import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { encryptSecret } from '../secrets'
import { sendPickupReminders, sendTestPickupReminder } from './pickup-reminders'

// Unique to THIS file - shops, orders and parcels are shared with every other test.
const TAG = '[pickup-reminder-test]'
const PREFIX = '77PICK'
const scoped = { shop: { name: { contains: TAG } } }

const NOW = new Date('2026-09-28T09:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)

/** When the Norway shop was switched on. */
const SWITCHED_ON = new Date('2026-09-01T00:00:00Z')

const BRING_FIELDS = {
  bringApiUid: 'ops@example.com',
  bringApiKey: encryptSecret('k'),
  bringClientUrl: 'https://panetti.vercel.app',
}

let norwayId: string
let swedenOffId: string

type Sent = { From: string; To: string; Subject: string; TextBody: string }
let sent: Sent[] = []
let bringAsked: string[] = []

/** What Bring says about each number when asked now. Missing = still waiting at the pickup point. */
let bringNow: Record<string, { status: string; dateIso: string }[] | 'fail' | 'unknown'> = {}
/** How Postmark answers. */
let postmark: () => Response = () => json({ MessageID: 'pm-1' })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function stubNetwork() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url))
      if (u.hostname === 'api.bring.com') {
        const n = u.searchParams.get('q')!
        bringAsked.push(n)
        const said = bringNow[n]
        if (said === 'fail') return new Response('gateway down', { status: 502 })
        if (said === 'unknown') return json({ consignmentSet: [{ error: { code: 404, message: 'No shipments found' } }] })
        const events = said ?? [{ status: 'READY_FOR_PICKUP', dateIso: daysAgo(3).toISOString() }]
        return json({ consignmentSet: [{ packageSet: [{ packageNumber: n, eventSet: events }] }] })
      }
      if (u.hostname === 'api.postmarkapp.com') {
        sent.push(JSON.parse(String(init?.body)))
        return postmark()
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
}

const shop = (name: string, over: Record<string, unknown>) =>
  db.shop.create({ data: { name: `${name} ${TAG}`, currency: 'NOK', timezone: 'Europe/Oslo', ...over } })

let counter = 0
const order = (shopId: string, over: Record<string, unknown> = {}) =>
  db.order.create({
    data: {
      shopId,
      externalId: `pick-${++counter}`,
      number: String(20000 + counter),
      placedAt: daysAgo(8),
      status: 'completed',
      currency: 'NOK',
      grossSales: 1000,
      discountTotal: 0,
      netSales: 1000,
      shippingCharged: 0,
      taxTotal: 0,
      total: 1000,
      customerName: 'kari nordmann',
      customerEmail: `kari${counter}@example.test`,
      shippingCountry: 'NO',
      ...over,
    },
  })

/** A parcel of this order that reached the pickup point `arrived` days ago and still sits there. */
const waitingParcel = (suffix: string, orderId: string, arrived: number, over: Record<string, unknown> = {}) =>
  db.shipment.create({
    data: {
      trackingNumber: `${PREFIX}${suffix}`,
      carrier: 'BRING',
      orderId,
      availableAt: daysAgo(arrived),
      outcome: 'DELIVERED',
      lastStatus: 'READY_FOR_PICKUP',
      terminal: false,
      ...over,
    },
  })

const orderRow = (id: string) => db.order.findUniqueOrThrow({ where: { id } })

async function cleanupRows() {
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: PREFIX } } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
}

async function cleanup() {
  await cleanupRows()
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

beforeAll(async () => {
  await cleanup()
  norwayId = (await shop('Panetti Norway', { pickupReminderFrom: SWITCHED_ON })).id
  swedenOffId = (await shop('Panetti Sweden', { pickupReminderFrom: null, currency: 'SEK' })).id
})

beforeEach(async () => {
  await cleanupRows()
  sent = []
  bringAsked = []
  bringNow = {}
  postmark = () => json({ MessageID: 'pm-1' })
  vi.stubEnv('POSTMARK_SERVER_TOKEN', 'server-token')
  vi.stubEnv('EMAIL_FROM', 'Panetti <no-reply@ledendeteknologi.no>')
  await db.deliveryConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', ...BRING_FIELDS },
    update: { ...BRING_FIELDS, pickupReminderLastError: null },
  })
  stubNetwork()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

afterAll(cleanup)

describe('sendPickupReminders', () => {
  it('emails the customer once, in Norwegian, from the brand, and stamps the order', async () => {
    const o = await order(norwayId)
    await waitingParcel('0001', o.id, 2.5)

    const result = await sendPickupReminders({ now: NOW })

    expect(result).toMatchObject({ sent: 1, failed: 0, skipped: null })
    expect(sent).toHaveLength(1)
    expect(sent[0].To).toBe(o.customerEmail)
    expect(sent[0].From).toBe('"Panetti" <no-reply@ledendeteknologi.no>')
    expect(sent[0].Subject).toBe('Pakken din fra Panetti venter på hentestedet')
    expect(sent[0].TextBody).toContain('Hei Kari,')
    expect(sent[0].TextBody).toContain(`(ordre ${o.number})`)
    expect(sent[0].TextBody).toContain('siden 25. september')
    expect(sent[0].TextBody).toContain(`https://tracking.bring.com/tracking/${PREFIX}0001`)
    // Bring was asked right before sending, not trusted from the last poll.
    expect(bringAsked).toEqual([`${PREFIX}0001`])

    const row = await orderRow(o.id)
    expect(row.pickupReminderAt).toEqual(NOW)
    expect(row.pickupReminderError).toBeNull()

    // And never again.
    expect((await sendPickupReminders({ now: NOW })).sent).toBe(0)
    expect(sent).toHaveLength(1)
  })

  it('sends from the shop’s own address when one is set', async () => {
    await db.shop.update({ where: { id: norwayId }, data: { reminderSenderEmail: 'kundeservice@panetti.no' } })
    try {
      const o = await order(norwayId)
      await waitingParcel('0005', o.id, 3)
      await sendPickupReminders({ now: NOW })
      expect(sent[0].From).toBe('"Panetti" <kundeservice@panetti.no>')
    } finally {
      await db.shop.update({ where: { id: norwayId }, data: { reminderSenderEmail: null } })
    }
  })

  it('sends one email for an order whose two boxes both wait', async () => {
    const o = await order(norwayId)
    await waitingParcel('0010', o.id, 3)
    await waitingParcel('0011', o.id, 2.2)

    expect((await sendPickupReminders({ now: NOW })).sent).toBe(1)
    expect(sent).toHaveLength(1)
    // The date is the first box's.
    expect(sent[0].TextBody).toContain('siden 25. september')
  })

  it('writes in the language of the country the parcel went to', async () => {
    const o = await order(norwayId, { shippingCountry: 'DK', customerName: 'Mette' })
    await waitingParcel('0020', o.id, 3)

    await sendPickupReminders({ now: NOW })

    expect(sent[0].Subject).toBe('Din pakke fra Panetti venter på afhentningsstedet')
    expect(sent[0].TextBody.startsWith('Hej Mette,')).toBe(true)
  })

  it('leaves alone what is not due, not this shop’s, or not a webshop parcel', async () => {
    const tooSoon = await order(norwayId)
    await waitingParcel('0030', tooSoon.id, 1)
    const tooOld = await order(norwayId)
    await waitingParcel('0031', tooOld.id, 7)
    const collected = await order(norwayId)
    await waitingParcel('0032', collected.id, 3, { collectedAt: daysAgo(1) })
    const shopOff = await order(swedenOffId, { shippingCountry: 'SE' })
    await waitingParcel('0033', shopOff.id, 3)
    const beforeSwitch = await order(norwayId)
    await waitingParcel('0034', beforeSwitch.id, 3)
    await db.shop.update({ where: { id: norwayId }, data: { pickupReminderFrom: daysAgo(2) } })
    try {
      expect((await sendPickupReminders({ now: NOW })).sent).toBe(0)
    } finally {
      await db.shop.update({ where: { id: norwayId }, data: { pickupReminderFrom: SWITCHED_ON } })
    }

    const refunded = await order(norwayId, { status: 'refunded' })
    await waitingParcel('0035', refunded.id, 3)
    const dhl = await order(norwayId)
    await waitingParcel('0036', dhl.id, 3, { carrier: 'DHL' })
    const reminded = await order(norwayId, { pickupReminderAt: daysAgo(1) })
    await waitingParcel('0037', reminded.id, 3)

    // Everything above except the "before the switch" one, now that the switch is back.
    const result = await sendPickupReminders({ now: NOW })
    expect(result.sent).toBe(1)
    expect(sent.map((s) => s.To)).toEqual([beforeSwitch.customerEmail])
  })

  it('does not email when Bring says the parcel was collected since the last poll', async () => {
    const o = await order(norwayId)
    const p = await waitingParcel('0040', o.id, 3)
    bringNow[p.trackingNumber] = [
      { status: 'READY_FOR_PICKUP', dateIso: daysAgo(3).toISOString() },
      { status: 'DELIVERED', dateIso: daysAgo(0.1).toISOString() },
    ]

    const result = await sendPickupReminders({ now: NOW })

    expect(result).toMatchObject({ sent: 0, alreadyCollected: 1 })
    expect(sent).toHaveLength(0)
    // The poller is sent to write it down properly; the order stays unstamped.
    expect((await db.shipment.findUniqueOrThrow({ where: { id: p.id } })).nextPollAt).toEqual(NOW)
    expect((await orderRow(o.id)).pickupReminderAt).toBeNull()
  })

  it('does not email when Bring cannot be asked, and tries again next run', async () => {
    const o = await order(norwayId)
    const p = await waitingParcel('0050', o.id, 3)
    bringNow[p.trackingNumber] = 'fail'

    expect((await sendPickupReminders({ now: NOW })).sent).toBe(0)
    const row = await orderRow(o.id)
    expect(row.pickupReminderAt).toBeNull()
    expect(row.pickupReminderError).toMatch(/Could not ask Bring/)

    bringNow = {}
    expect((await sendPickupReminders({ now: NOW })).sent).toBe(1)
  })

  it('takes an order out of the queue when Postmark says the address can never receive', async () => {
    const o = await order(norwayId)
    await waitingParcel('0060', o.id, 3)
    postmark = () => json({ ErrorCode: 406, Message: 'Inactive recipient' }, 422)

    const result = await sendPickupReminders({ now: NOW })

    expect(result).toMatchObject({ sent: 0, failed: 1 })
    const row = await orderRow(o.id)
    expect(row.pickupReminderAt).toEqual(NOW)
    expect(row.pickupReminderError).toMatch(/Inactive recipient/)
  })

  it('treats an invalid To as the customer’s address, but an invalid From as ours', async () => {
    const badTo = await order(norwayId)
    await waitingParcel('0065', badTo.id, 3)
    postmark = () => json({ ErrorCode: 300, Message: "Invalid 'To' address: 'kari@'." }, 422)
    await sendPickupReminders({ now: NOW })
    expect((await orderRow(badTo.id)).pickupReminderAt).toEqual(NOW)

    const badFrom = await order(norwayId)
    await waitingParcel('0066', badFrom.id, 3)
    postmark = () => json({ ErrorCode: 300, Message: "Invalid 'From' address: 'kundeservice@'." }, 422)
    await sendPickupReminders({ now: NOW })
    const row = await orderRow(badFrom.id)
    expect(row.pickupReminderAt).toBeNull()
    expect(row.pickupReminderError).toMatch(/Invalid 'From'/)
  })

  it('keeps orders queued, says why on the settings page, and stops early when WE cannot send', async () => {
    const orders = []
    for (let i = 0; i < 5; i++) {
      const o = await order(norwayId)
      await waitingParcel(`007${i}`, o.id, 3)
      orders.push(o)
    }
    postmark = () =>
      json({ ErrorCode: 412, Message: 'While your account is pending approval, all recipient addresses must share the same domain' }, 422)

    const result = await sendPickupReminders({ now: NOW })

    // Three in a row is enough to know it is the sender, not the customers.
    expect(result).toMatchObject({ sent: 0, failed: 3 })
    for (const o of orders) expect((await orderRow(o.id)).pickupReminderAt).toBeNull()
    const config = await db.deliveryConfig.findUniqueOrThrow({ where: { id: 'singleton' } })
    expect(config.pickupReminderLastError).toMatch(/pending approval/)

    // Fixed: the next run sends them all and the warning goes away.
    postmark = () => json({ MessageID: 'pm-2' })
    expect((await sendPickupReminders({ now: NOW })).sent).toBe(5)
    expect((await db.deliveryConfig.findUniqueOrThrow({ where: { id: 'singleton' } })).pickupReminderLastError).toBeNull()
  })

  it('falls back to the email Bring holds, and gives up on an order with none', async () => {
    const bringOnly = await order(norwayId, { customerEmail: '' })
    await waitingParcel('0080', bringOnly.id, 3, { recipientEmail: 'from-bring@example.test' })
    const nobody = await order(norwayId, { customerEmail: '' })
    await waitingParcel('0081', nobody.id, 3)

    expect((await sendPickupReminders({ now: NOW })).sent).toBe(1)
    expect(sent[0].To).toBe('from-bring@example.test')
    const gaveUp = await orderRow(nobody.id)
    expect(gaveUp.pickupReminderAt).toEqual(NOW)
    expect(gaveUp.pickupReminderError).toBe('The order has no email address')
  })

  it('does nothing, and says so, when no shop is switched on', async () => {
    await db.shop.update({ where: { id: norwayId }, data: { pickupReminderFrom: null } })
    try {
      const result = await sendPickupReminders({ now: NOW })
      expect(result.skipped).toBe('No shop has pickup reminders switched on.')
      expect(bringAsked).toHaveLength(0)
    } finally {
      await db.shop.update({ where: { id: norwayId }, data: { pickupReminderFrom: SWITCHED_ON } })
    }
  })
})

describe('sendTestPickupReminder', () => {
  it('sends the shop’s reminder to the admin, in the language most of its orders ship to', async () => {
    await order(swedenOffId, { shippingCountry: 'SE' })
    await order(swedenOffId, { shippingCountry: 'SE' })
    await order(swedenOffId, { shippingCountry: 'NO' })
    await db.deliveryConfig.update({ where: { id: 'singleton' }, data: { pickupReminderLastError: 'old problem' } })

    const result = await sendTestPickupReminder(swedenOffId, 'philip@example.test', NOW)

    expect(result.language).toBe('sv')
    expect(sent).toHaveLength(1)
    expect(sent[0].To).toBe('philip@example.test')
    expect(sent[0].Subject).toBe('[TEST] Ditt paket från Panetti väntar på utlämningsstället')
    // A test that got through proves the sender; the old warning goes.
    expect((await db.deliveryConfig.findUniqueOrThrow({ where: { id: 'singleton' } })).pickupReminderLastError).toBeNull()
  })

  it('passes Postmark’s own refusal through', async () => {
    postmark = () => json({ ErrorCode: 401, Message: 'Sender signature not confirmed' }, 422)
    await expect(sendTestPickupReminder(norwayId, 'philip@example.test', NOW)).rejects.toThrow(/Sender signature not confirmed/)
  })
})
