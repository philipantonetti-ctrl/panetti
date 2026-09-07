import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { encryptSecret } from '../secrets'
import { resolveUnpaidOrders } from './resolve'

/**
 * The question this answers, in the client's own words: "Is there a way the
 * system can go in and check these and match them in case the system wouldn't
 * be able to match some of the orders to any payout?"
 *
 * The numbers below are real ones from the reports Dintero sent him.
 * Transaction P11114434.5z9ac5KspRdX4MccGKLR7a is order 10972, NOK 4999.00
 * with a 65.99 fee, paid in settlement R17483-E4839A on 24.05.2025 - a payout
 * far older than any this system had imported.
 */
const TAG = '[dintero-resolve-test]'
const ACCOUNT = 'P11114434'
const TX = `${ACCOUNT}.5z9ac5KspRdX4MccGKLR7a`
const SETTLEMENT = 'R17483-E4839A'
const scoped = { shop: { name: { contains: TAG } } }

/** Older than the eight days a weekly payout is given. */
const PLACED = new Date('2025-05-22T09:35:00Z')

let shopId: string
let otherShopId: string

type Call = { url: string }
let calls: Call[] = []

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * One stubbed Dintero: a token, a transaction lookup, a settlement search, the
 * attachment envelope and the report file itself. Each answer is keyed on the
 * URL, so a test that changes one leaves the rest alone.
 */
const stubDintero = (answers: {
  transaction?: () => Response
  settlements?: () => Response
  report?: () => Response
}) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url)
      calls.push({ url: u })
      if (u.includes('/auth/token')) return jsonResponse({ access_token: 'tok' })
      if (u.includes('/payments/transactions/')) {
        return (answers.transaction ?? (() => jsonResponse({}, 404)))()
      }
      if (u.includes('/settlements?')) return (answers.settlements ?? (() => jsonResponse({ items: [] })))()
      if (u.includes('/attachments/')) {
        return jsonResponse({ url: 'https://storage.dintero.example/reports/r.json' })
      }
      if (u.includes('storage.dintero.example')) {
        return (answers.report ?? (() => jsonResponse({ transactions: [] })))()
      }
      return jsonResponse({}, 404)
    }),
  )
}

/** What the transaction endpoint says for a settled order. */
const settledTransaction = (settlementId = SETTLEMENT) =>
  jsonResponse({
    id: TX,
    settlement_status: 'SETTLED',
    merchant_reference: 'dwc682ccdd8f12eb2.35071570',
    merchant_reference_2: '10972',
    events: [
      {
        event: 'CAPTURE',
        settlements: {
          events: [
            { settlement_id: settlementId, provider_reference: 'klarna', amount: 493301, capture: 499900, refund: 0, fee: 6599 },
          ],
        },
      },
    ],
  })

/** What the settlement list says when asked for that one settlement by id. */
const settlementRow = (id = SETTLEMENT) =>
  jsonResponse({
    items: [
      {
        id,
        provider: 'dintero_payout',
        settled_at: '2025-05-24T00:00:00Z',
        start_at: '2025-05-19T00:00:00Z',
        end_at: '2025-05-24T23:59:59Z',
        amounts: [{ currency: 'NOK', amount: 70660648, capture: 71456300, refund: -599900, fee: -795652 }],
        attachments: [{ id: 'att-json', extension: 'json', content_type: 'application/json' }],
      },
    ],
  })

/** The report file for that settlement, carrying our order's line. */
const reportFile = () =>
  jsonResponse({
    settlement_reference: 'R17483',
    transactions: [
      {
        transaction_id: TX,
        reference: 'dwc682ccdd8f12eb2.35071570',
        event_reference: '10972',
        amount: 493301,
        capture: 499900,
        refund: 0,
        fee: 6599,
        transaction_date: '2025-05-22T09:35:00Z',
        payment_product_type: 'klarna.klarna',
      },
    ],
  })

const order = (over: Record<string, unknown> = {}) =>
  db.order.create({
    data: {
      shopId,
      externalId: '10972',
      number: '10972',
      placedAt: PLACED,
      status: 'completed',
      currency: 'NOK',
      grossSales: 400000, discountTotal: 0, netSales: 400000,
      shippingCharged: 0, taxTotal: 99980, total: 499900,
      transactionId: TX,
      ...over,
    },
  })

const payout = (over: Record<string, unknown> = {}) =>
  db.payout.create({
    data: {
      shopId,
      externalId: SETTLEMENT,
      currency: 'NOK',
      amount: 70660648, capture: 71456300, refund: 599900, fee: 795652,
      settledAt: new Date('2025-05-24T00:00:00Z'),
      periodStart: new Date('2025-05-19T00:00:00Z'),
      periodEnd: new Date('2025-05-24T23:59:59Z'),
      linesPending: false,
      reportVersion: 3,
      ...over,
    },
  })

async function wipe() {
  await db.payoutLine.deleteMany({ where: { payout: scoped } })
  await db.payout.deleteMany({ where: scoped })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
}

async function cleanup() {
  await wipe()
  await db.dinteroConfig.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

beforeAll(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Panetti Norway ${TAG}`, currency: 'NOK' } })).id
  otherShopId = (await db.shop.create({ data: { name: `Panetti Sweden ${TAG}`, currency: 'SEK' } })).id
  await db.dinteroConfig.create({
    data: {
      shopId,
      accountId: ACCOUNT,
      clientId: encryptSecret('cid'),
      clientSecret: encryptSecret('sec'),
    },
  })
})

beforeEach(() => {
  calls = []
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await wipe()
  await db.dinteroConfig.updateMany({ where: { shopId }, data: { lastError: null } })
})

afterAll(cleanup)

const stored = () => db.order.findFirstOrThrow({ where: { shopId, number: '10972' } })

describe('resolveUnpaidOrders', () => {
  /**
   * The case that sent the client to Dintero's support: the order was paid in
   * a settlement older than anything we had imported, so no payout row could
   * ever have matched it. Dintero names the settlement, we fetch that one
   * settlement by id, ingest its report, and the order is paid.
   */
  it('imports the settlement Dintero names and links the order to it', async () => {
    stubDintero({ transaction: settledTransaction, settlements: settlementRow, report: reportFile })
    const o = await order()

    const result = await resolveUnpaidOrders({ shopId })

    expect(result.checked).toBe(1)
    expect(result.imported).toBe(1)
    expect(result.resolved).toBe(1)

    const line = await db.payoutLine.findFirstOrThrow({ where: { transactionId: TX } })
    expect(line.orderId).toBe(o.id)
    const imported = await db.payout.findFirstOrThrow({ where: { shopId, externalId: SETTLEMENT } })
    expect(imported.settledAt?.toISOString().slice(0, 10)).toBe('2025-05-24')
    expect(imported.linesPending).toBe(false)
    // Asked for that one settlement, not for the whole history.
    expect(calls.some((c) => c.url.includes(`search=${SETTLEMENT}`))).toBe(true)
  })

  /**
   * We already hold the payout and its line, but the line never found its
   * order - the matcher declined and would decline again. Dintero has just
   * told us the transaction belongs to this settlement, and we know which
   * order we asked about, so the link is made from that evidence rather than
   * by running the same matcher a second time.
   */
  it('links a line we already hold that had never matched', async () => {
    stubDintero({ transaction: settledTransaction })
    const o = await order()
    const p = await payout()
    await db.payoutLine.create({
      data: {
        payoutId: p.id,
        transactionId: TX,
        reference: 'dwc682ccdd8f12eb2.35071570',
        reference2: null,
        amount: 493301, capture: 499900, refund: 0, fee: 6599,
      },
    })

    const result = await resolveUnpaidOrders({ shopId })

    expect(result.resolved).toBe(1)
    expect(result.imported).toBe(0)
    const line = await db.payoutLine.findFirstOrThrow({ where: { transactionId: TX } })
    expect(line.orderId).toBe(o.id)
    // No settlement search: we already had the payout.
    expect(calls.some((c) => c.url.includes('search='))).toBe(false)
  })

  /**
   * The payout is there and its report was read, but it holds no line for this
   * transaction - so the report we stored is wrong or stale. Queue it for a
   * fresh download rather than inventing a line.
   */
  it('queues a payout whose report is missing the transaction for a re-read', async () => {
    stubDintero({ transaction: settledTransaction })
    await order()
    const p = await payout()

    const result = await resolveUnpaidOrders({ shopId })

    expect(result.requeued).toBe(1)
    expect(result.resolved).toBe(0)
    expect((await db.payout.findUniqueOrThrow({ where: { id: p.id } })).linesPending).toBe(true)
  })

  it('records that Dintero has not settled the order yet, and does not ask again next run', async () => {
    stubDintero({
      transaction: () => jsonResponse({ id: TX, settlement_status: 'NOT_SETTLED', events: [] }),
    })
    await order()

    const first = await resolveUnpaidOrders({ shopId })
    expect(first.checked).toBe(1)
    expect(first.unsettled).toBe(1)
    const after = await stored()
    expect(after.payoutCheckedAt).toBeInstanceOf(Date)
    expect(after.payoutCheckNote).toMatch(/not settled/i)

    calls = []
    const second = await resolveUnpaidOrders({ shopId })
    expect(second.checked).toBe(0)
    expect(calls).toEqual([])
  })

  it('records a transaction the account has never heard of, rather than failing', async () => {
    stubDintero({ transaction: () => jsonResponse({ message: 'not found' }, 404) })
    await order()

    const result = await resolveUnpaidOrders({ shopId })

    expect(result.errors).toEqual([])
    expect((await stored()).payoutCheckNote).toMatch(/does not know/i)
  })

  /**
   * These API clients were created to read settlement reports; this endpoint
   * needs read:checkout. The shop must be told which scope to add, in those
   * words, rather than being sent to re-paste credentials that are fine.
   */
  it('names the missing scope on the shop when Dintero forbids the lookup', async () => {
    stubDintero({ transaction: () => jsonResponse({}, 403) })
    await order()

    const result = await resolveUnpaidOrders({ shopId })

    expect(result.errors.join(' ')).toMatch(/read:checkout/)
    const config = await db.dinteroConfig.findFirstOrThrow({ where: { shopId } })
    expect(config.lastError).toMatch(/read:checkout/)
    // The order is left unstamped: nothing was learned about it.
    expect((await stored()).payoutCheckedAt).toBeNull()
  })

  it('leaves an order that is already in a payout alone', async () => {
    stubDintero({ transaction: settledTransaction })
    const o = await order()
    const p = await payout()
    await db.payoutLine.create({
      data: {
        payoutId: p.id, transactionId: TX, reference: 'dwc', reference2: '10972',
        amount: 493301, capture: 499900, refund: 0, fee: 6599, orderId: o.id,
      },
    })

    const result = await resolveUnpaidOrders({ shopId })

    expect(result.checked).toBe(0)
    expect(calls).toEqual([])
  })

  it('leaves an order too young for a weekly payout alone', async () => {
    stubDintero({ transaction: settledTransaction })
    await order({ placedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })

    expect((await resolveUnpaidOrders({ shopId })).checked).toBe(0)
    expect(calls).toEqual([])
  })

  it('leaves a voided order alone - a refunded order is not money waiting', async () => {
    stubDintero({ transaction: settledTransaction })
    await order({ status: 'refunded', voidedAt: new Date('2025-06-01T00:00:00Z') })

    expect((await resolveUnpaidOrders({ shopId })).checked).toBe(0)
  })

  it('leaves an order with no Dintero id alone - it was not paid through Dintero', async () => {
    stubDintero({ transaction: settledTransaction })
    await order({ transactionId: null, dinteroReference: null })

    expect((await resolveUnpaidOrders({ shopId })).checked).toBe(0)
  })

  it('ignores a shop with no Dintero connection', async () => {
    stubDintero({ transaction: settledTransaction })
    await order({ shopId: otherShopId })

    expect((await resolveUnpaidOrders({ shopId: otherShopId })).checked).toBe(0)
    expect(calls).toEqual([])
  })

  it('asks about no more orders than the run allows', async () => {
    stubDintero({
      transaction: () => jsonResponse({ id: TX, settlement_status: 'NOT_SETTLED', events: [] }),
    })
    await order()
    await order({ externalId: '10973', number: '10973', transactionId: `${ACCOUNT}.second` })

    expect((await resolveUnpaidOrders({ shopId, maxOrders: 1 })).checked).toBe(1)
  })

  it('stops when the run is out of time', async () => {
    stubDintero({ transaction: settledTransaction })
    await order()

    expect((await resolveUnpaidOrders({ shopId, deadline: Date.now() - 1 })).checked).toBe(0)
    expect(calls).toEqual([])
  })
})
