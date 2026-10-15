import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const vismaPost = vi.fn()
const readOpenInvoices = vi.fn()
const findOurPayment = vi.fn()
vi.mock('../write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../write')>()),
  vismaPost: (...a: unknown[]) => vismaPost(...a),
}))
vi.mock('./invoices', () => ({
  readOpenInvoices: (...a: unknown[]) => readOpenInvoices(...a),
  findOurPayment: (...a: unknown[]) => findOurPayment(...a),
}))

const { db } = await import('@/lib/db')
const { encryptSecret } = await import('@/lib/secrets')
const { VismaError } = await import('../client')
const { TEST_TENANT_ID } = await import('../write')
const { runVismaPosting } = await import('./run')

const MARK = 'visma-posting-test'

async function cleanup() {
  const shops = await db.shop.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } })
  const ids = shops.map((s) => s.id)
  await db.payout.deleteMany({ where: { shopId: { in: ids } } })
  await db.dinteroConfig.deleteMany({ where: { shopId: { in: ids } } })
  await db.shop.deleteMany({ where: { id: { in: ids } } })
  await db.vismaPostingConfig.deleteMany({})
}
afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  vi.stubEnv('VISMA_CLIENT_ID', 'cid')
  vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
  vi.stubEnv('VISMA_TENANT_ID', '83949a19-af32-11ec-b60b-0638767d04b5')
  vismaPost.mockReset()
  readOpenInvoices.mockReset()
  findOurPayment.mockReset()
})

/** Pretend the last run died ten minutes ago: a `sending` row is only an orphan once it is stale. */
const age = () =>
  db.vismaPostingDocument.updateMany({
    where: { status: 'sending' },
    data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
  })

const mode = (m: string) => db.vismaPostingConfig.create({ data: { id: 'singleton', mode: m } })

async function dePayout(over: Record<string, unknown> = {}, mapped = true) {
  const shop = await db.shop.create({ data: { name: `${MARK} DE`, currency: 'EUR' } })
  await db.dinteroConfig.create({
    data: {
      shopId: shop.id, accountId: 'P11115654', clientId: encryptSecret('c'), clientSecret: encryptSecret('s'),
      ...(mapped ? { vismaCustomer: '10859', vismaClearingAccount: '1509', vismaBankAccount: '1940', vismaFeeAccount: '7770' } : {}),
    },
  })
  return db.payout.create({
    data: {
      shopId: shop.id, externalId: 'set-1', currency: 'EUR', settledAt: new Date('2026-10-06T08:00:00Z'),
      amount: 19000, capture: 20000, refund: 0, fee: 1000, reference: 'R20001-ABC', linesPending: false,
      reportVersion: 99,
      lines: {
        create: [
          { transactionId: 't1', reference: 'dwc1', reference2: '14238', amount: 11500, capture: 12000, refund: 0, fee: 500 },
          { transactionId: 't2', reference: 'dwc2', reference2: '14239', amount: 7500, capture: 8000, refund: 0, fee: 500 },
        ],
      },
      ...over,
    },
  })
}

const invoices = [
  { number: '130474', customerRefNumber: '14238', currency: 'EUR', balance: 12000 },
]

describe('runVismaPosting', () => {
  it('does nothing while the mode is off', async () => {
    await dePayout()
    const r = await runVismaPosting()
    expect(r.mode).toBe('off')
    expect(readOpenInvoices).not.toHaveBeenCalled()
  })

  it('dry run: stores the plan, writes nothing', async () => {
    await mode('dry_run')
    const payout = await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    const r = await runVismaPosting()
    expect(r).toMatchObject({ mode: 'dry_run', configured: true, payoutId: payout.id, status: 'dry_run' })
    expect(vismaPost).not.toHaveBeenCalled()
    const p = await db.vismaPosting.findUnique({ where: { payoutId_tenantId: { payoutId: payout.id, tenantId: TEST_TENANT_ID } } })
    expect(p).toMatchObject({ status: 'dry_run', matched: 1, unmatched: 1 })
  })

  it('hold: one payment per open invoice, skips the rest, then the payout entry; stores Visma numbers', async () => {
    await mode('hold')
    const payout = await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockResolvedValueOnce({ status: 201, number: 'P-1' }).mockResolvedValueOnce({ status: 201, number: 'GL-9' })

    const r = await runVismaPosting()
    expect(r.status).toBe('posted')
    expect(vismaPost).toHaveBeenCalledTimes(2)
    expect(vismaPost.mock.calls[0][0].tenantId).toBe(TEST_TENANT_ID)
    expect(vismaPost.mock.calls[0][1]).toBe('controller/api/v1/customerPayment')
    expect(vismaPost.mock.calls[1][1]).toBe('controller/api/v2/journaltransaction')

    const docs = await db.vismaPostingDocument.findMany({ orderBy: { kind: 'asc' } })
    expect(docs.map((d) => [d.kind, d.key, d.status, d.vismaNumber ?? d.reason])).toEqual(
      expect.arrayContaining([
        ['payment', '14238', 'sent', 'P-1'],
        ['payment', '14239', 'skipped', 'no open invoice'],
        ['payout', payout.id, 'sent', 'GL-9'],
      ]),
    )
    const p = await db.vismaPosting.findFirst({ where: { payoutId: payout.id } })
    expect(p).toMatchObject({ status: 'posted', matched: 1, unmatched: 1 })
  })

  it('never posts the same payout twice', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockResolvedValue({ status: 201, number: 'X' })
    await runVismaPosting()
    vismaPost.mockClear()
    const again = await runVismaPosting()
    expect(again.payoutId).toBeNull()
    expect(vismaPost).not.toHaveBeenCalled()
  })

  it('skips payouts before 1 Oct, without a reference, or for a shop with no Visma setup', async () => {
    await mode('hold')
    await dePayout({ settledAt: new Date('2026-09-29T08:00:00Z') })
    const r = await runVismaPosting()
    expect(r.payoutId).toBeNull()
    await cleanup(); await mode('hold')
    await dePayout({ reference: null })
    expect((await runVismaPosting()).payoutId).toBeNull()
    await cleanup(); await mode('hold')
    await dePayout({}, false)
    expect((await runVismaPosting()).payoutId).toBeNull()
  })

  it('a timeout after a payment POST leaves it sending; the next run asks Visma before resending', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
    const first = await runVismaPosting()
    expect(first.status).toBe('posting')
    const sending = await db.vismaPostingDocument.findFirst({ where: { kind: 'payment', key: '14238' } })
    expect(sending?.status).toBe('sending')

    // Visma DID create it: the invoice is no longer open, and our payment is found.
    readOpenInvoices.mockResolvedValue({ invoices: [], calls: 1 })
    findOurPayment.mockResolvedValue('P-77')
    await age()
    vismaPost.mockReset().mockResolvedValue({ status: 201, number: 'GL-1' })
    const second = await runVismaPosting()
    expect(findOurPayment).toHaveBeenCalledWith(expect.anything(), '10859', '130474', 'R20001-ABC', expect.anything())
    expect(vismaPost).toHaveBeenCalledTimes(1) // only the payout entry
    const doc = await db.vismaPostingDocument.findFirst({ where: { kind: 'payment', key: '14238' } })
    expect(doc).toMatchObject({ status: 'sent', vismaNumber: 'P-77' })
    expect(second.status).toBe('posted')
  })

  it('a payout entry that may have been created is marked unconfirmed and never resent', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices: [], calls: 1 })
    vismaPost.mockRejectedValueOnce(new VismaError('Visma responded 502 for POST', 502))
    await runVismaPosting()
    await age()
    vismaPost.mockReset()
    const second = await runVismaPosting()
    expect(vismaPost).not.toHaveBeenCalled()
    expect(second.status).toBe('error')
    const doc = await db.vismaPostingDocument.findFirst({ where: { kind: 'payout' } })
    expect(doc?.status).toBe('unconfirmed')
  })

  it('a 400 marks that document error and the posting error, with Visma\'s message', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost
      .mockRejectedValueOnce(new VismaError('Visma responded 400 for POST: Cash account 1509 not found', 400))
      .mockResolvedValueOnce({ status: 201, number: 'GL-2' })
    const r = await runVismaPosting()
    expect(r.status).toBe('error')
    const p = await db.vismaPosting.findFirst({})
    expect(p?.error).toContain('Cash account 1509 not found')
  })

  it('a 429 stops the run cleanly and resumes next time', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockRejectedValueOnce(new VismaError('rate limited', 429))
    const r = await runVismaPosting()
    expect(r.status).toBe('posting')
    const doc = await db.vismaPostingDocument.findFirst({ where: { kind: 'payment', key: '14238' } })
    expect(doc?.status).toBe('pending')
  })

  it('never says posted while a payment is still unsent: a pending row whose order is now skipped becomes skipped', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockRejectedValueOnce(new VismaError('rate limited', 429))
    expect((await runVismaPosting()).status).toBe('posting')
    readOpenInvoices.mockResolvedValue({ invoices: [], calls: 1 })
    vismaPost.mockReset().mockResolvedValue({ status: 201, number: 'GL-3' })
    const second = await runVismaPosting()
    const doc = await db.vismaPostingDocument.findFirst({ where: { kind: 'payment', key: '14238' } })
    expect(doc).toMatchObject({ status: 'skipped', reason: 'no open invoice' })
    expect(second.status).toBe('posted')
  })

  it('stays posting while a payment row is still pending after everything else was handled', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockRejectedValueOnce(new VismaError('rate limited', 429))
    await runVismaPosting()
    // An extra pending row the plan knows nothing about must keep the posting open.
    const posting = await db.vismaPosting.findFirstOrThrow({})
    await db.vismaPostingDocument.create({
      data: { postingId: posting.id, kind: 'payment', key: 'stray', status: 'pending' },
    })
    vismaPost.mockReset().mockResolvedValue({ status: 201, number: 'N' })
    const second = await runVismaPosting()
    expect(second.status).toBe('posting')
    expect((await db.vismaPosting.findFirstOrThrow({})).postedAt).toBeNull()
  })

  it('does not re-POST a payment forever: after two unanswered tries it is unconfirmed', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    findOurPayment.mockResolvedValue(null)
    vismaPost.mockRejectedValue(new Error('The operation was aborted due to timeout'))
    await runVismaPosting()
    await age()
    await runVismaPosting()
    await age()
    vismaPost.mockReset().mockResolvedValue({ status: 201, number: 'GL-5' }) // the payout entry goes through
    const third = await runVismaPosting()
    const paymentPosts = vismaPost.mock.calls.filter((c) => c[1] === 'controller/api/v1/customerPayment')
    expect(paymentPosts).toHaveLength(0)
    const doc = await db.vismaPostingDocument.findFirst({ where: { kind: 'payment', key: '14238' } })
    expect(doc?.status).toBe('unconfirmed')
    expect(third.status).toBe('error')
  })

  it('a read failure marks the posting error, and after three tries the payout is let go', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockRejectedValue(new VismaError('Visma responded 400 for GET: bad customer', 400))
    const r = await runVismaPosting()
    expect(r.error).toContain('bad customer')
    const p = await db.vismaPosting.findFirstOrThrow({})
    expect(p).toMatchObject({ status: 'error', attempts: 1 })
    expect(p.error).toContain('bad customer')
    await runVismaPosting()
    await runVismaPosting()
    expect((await db.vismaPosting.findFirstOrThrow({})).attempts).toBe(3)
    expect((await runVismaPosting()).payoutId).toBeNull()
  })

  it('page reads do not eat the POST budget', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 20 })
    vismaPost.mockResolvedValue({ status: 201, number: 'Z' })
    const r = await runVismaPosting()
    expect(r.status).toBe('posted')
    expect(r.calls).toBe(22)
  })

  it('never accepts a payment number that already belongs to a sibling document', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({
      invoices: [...invoices, { number: '130475', customerRefNumber: '14239', currency: 'EUR', balance: 8000 }],
      calls: 1,
    })
    vismaPost
      .mockResolvedValueOnce({ status: 201, number: 'P-1' })
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
    await runVismaPosting()
    await age()
    findOurPayment.mockResolvedValue('P-1')
    vismaPost.mockReset().mockResolvedValue({ status: 201, number: 'P-2' })
    await runVismaPosting()
    const second = await db.vismaPostingDocument.findFirstOrThrow({ where: { kind: 'payment', key: '14239' } })
    expect(second.vismaNumber).not.toBe('P-1')
  })

  it('leaves a fresh sending row alone: another run is live', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
    await runVismaPosting()
    const before = await db.vismaPostingDocument.findFirstOrThrow({ where: { kind: 'payment', key: '14238' } })
    vismaPost.mockClear()
    await runVismaPosting()
    expect(vismaPost).not.toHaveBeenCalled()
    expect(findOurPayment).not.toHaveBeenCalled()
    const after = await db.vismaPostingDocument.findFirstOrThrow({ where: { kind: 'payment', key: '14238' } })
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime())
    expect(after.status).toBe('sending')
  })
})
