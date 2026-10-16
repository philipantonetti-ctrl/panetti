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

  it('a pending payment row that the plan no longer knows is skipped, not waited on', async () => {
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
    // A pending row that is in neither list of the plan is the bookkeeper's, not a reason to wait forever.
    const stray = await db.vismaPostingDocument.findFirstOrThrow({ where: { key: 'stray' } })
    expect(stray).toMatchObject({ status: 'skipped', reason: 'no longer in the Dintero report' })
    expect(second.status).toBe('posted')
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

  it('does not recover a sending row that appears fresh after the entry guard (another run is mid-POST)', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockImplementation(async () => {
      const posting = await db.vismaPosting.findFirstOrThrow({})
      await db.vismaPostingDocument.create({
        data: { postingId: posting.id, kind: 'payment', key: '14238', status: 'sending', invoiceNumber: '130474', attempts: 1 },
      })
      return { invoices, calls: 1 }
    })
    vismaPost.mockResolvedValue({ status: 201, number: 'Q' })
    findOurPayment.mockResolvedValue(null)
    await runVismaPosting()
    expect(findOurPayment).not.toHaveBeenCalled()
    const paymentPosts = vismaPost.mock.calls.filter((c) => c[1] === 'controller/api/v1/customerPayment')
    expect(paymentPosts).toHaveLength(0)
    const row = await db.vismaPostingDocument.findFirstOrThrow({ where: { kind: 'payment', key: '14238' } })
    expect(row.status).toBe('sending')
  })

  it('a unique-key clash on create stops the run quietly and never marks the posting error', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockResolvedValue({ status: 201, number: 'Q' })
    const orig = db.vismaPostingDocument.findUnique.bind(db.vismaPostingDocument)
    let raced = false
    const spy = vi.spyOn(db.vismaPostingDocument, 'findUnique').mockImplementation(((args: {
      where: { postingId_kind_key: { postingId: string; kind: string; key: string } }
    }) => {
      const w = args.where.postingId_kind_key
      if (!raced && w.kind === 'payment' && w.key === '14238') {
        raced = true
        return db.vismaPostingDocument
          .create({ data: { postingId: w.postingId, kind: 'payment', key: '14238', status: 'sending', invoiceNumber: '130474', attempts: 1 } })
          .then(() => null)
      }
      return orig(args as never)
    }) as never)
    try {
      const r = await runVismaPosting()
      expect(r.error).toBeNull()
    } finally {
      spy.mockRestore()
    }
    const paymentPosts = vismaPost.mock.calls.filter((c) => c[1] === 'controller/api/v1/customerPayment')
    expect(paymentPosts).toHaveLength(0)
    expect((await db.vismaPosting.findFirstOrThrow({})).status).toBe('posting')
  })

  it('a dry run Visma refuses is kept as error with no attempt used; an outage leaves no posting behind', async () => {
    await mode('dry_run')
    const payout = await dePayout()
    readOpenInvoices.mockRejectedValue(new VismaError('Visma responded 400 for GET: nope', 400))
    const r = await runVismaPosting()
    expect(r.error).toContain('nope')
    const kept = await db.vismaPosting.findFirstOrThrow({ where: { payoutId: payout.id } })
    expect(kept).toMatchObject({ status: 'error', attempts: 0 })
    expect(kept.error).toContain('nope')
    // The queue moves on instead of failing the same preview every tick.
    readOpenInvoices.mockClear()
    expect((await runVismaPosting()).payoutId).toBeNull()
    expect(readOpenInvoices).not.toHaveBeenCalled()
    // The first hold run counts it as attempt 1.
    await db.vismaPostingConfig.update({ where: { id: 'singleton' }, data: { mode: 'hold' } })
    await runVismaPosting()
    expect((await db.vismaPosting.findFirstOrThrow({ where: { payoutId: payout.id } })).attempts).toBe(1)

    // An outage: the document-less preview is forgotten, so it is previewed again later.
    await cleanup()
    await mode('dry_run')
    await dePayout()
    readOpenInvoices.mockReset().mockRejectedValue(new Error('This operation was aborted'))
    const out = await runVismaPosting()
    expect(out.error).toContain('aborted')
    expect(await db.vismaPosting.count()).toBe(0)
  })

  it('an unanswered pending payment the plan no longer knows is unconfirmed, never skipped', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockRejectedValueOnce(new VismaError('rate limited', 429))
    await runVismaPosting()
    const posting = await db.vismaPosting.findFirstOrThrow({})
    await db.vismaPostingDocument.create({
      data: { postingId: posting.id, kind: 'payment', key: 'gone', status: 'pending', reason: 'unanswered POST, not found in Visma', invoiceNumber: '130999' },
    })
    vismaPost.mockReset().mockResolvedValue({ status: 201, number: 'N' })
    const second = await runVismaPosting()
    const gone = await db.vismaPostingDocument.findFirstOrThrow({ where: { key: 'gone' } })
    expect(gone.status).toBe('unconfirmed')
    expect(second.status).toBe('error')
  })

  it('a 429 on a resend keeps the unanswered marker, so a vanished invoice makes it unconfirmed', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    findOurPayment.mockResolvedValue(null)
    vismaPost.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
    await runVismaPosting()
    await age()
    // Run 2: not found in Visma, invoice still open, resent, and Visma answers 429.
    vismaPost.mockReset().mockRejectedValueOnce(new VismaError('rate limited', 429))
    await runVismaPosting()
    const row = await db.vismaPostingDocument.findFirstOrThrow({ where: { kind: 'payment', key: '14238' } })
    expect(row.status).toBe('pending')
    expect(row.reason).toMatch(/^unanswered/)
    // Run 3: the invoice is gone (the first POST may have paid it).
    readOpenInvoices.mockResolvedValue({ invoices: [], calls: 1 })
    vismaPost.mockReset().mockResolvedValue({ status: 201, number: 'GL-4' })
    const third = await runVismaPosting()
    const after = await db.vismaPostingDocument.findFirstOrThrow({ where: { kind: 'payment', key: '14238' } })
    expect(after.status).toBe('unconfirmed')
    expect(third.status).toBe('error')
    const paymentPosts = vismaPost.mock.calls.filter((c) => c[1] === 'controller/api/v1/customerPayment')
    expect(paymentPosts).toHaveLength(0)
  })

  it('a unique-key clash on a skipped row is left to the other run, never marks the posting error', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockResolvedValue({ status: 201, number: 'Q' })
    const orig = db.vismaPostingDocument.findUnique.bind(db.vismaPostingDocument)
    let raced = false
    const spy = vi.spyOn(db.vismaPostingDocument, 'findUnique').mockImplementation(((args: {
      where: { postingId_kind_key: { postingId: string; kind: string; key: string } }
    }) => {
      const w = args.where.postingId_kind_key
      if (!raced && w.kind === 'payment' && w.key === '14239') {
        raced = true
        return db.vismaPostingDocument
          .create({ data: { postingId: w.postingId, kind: 'payment', key: '14239', status: 'skipped', reason: 'no open invoice' } })
          .then(() => null)
      }
      return orig(args as never)
    }) as never)
    let r
    try {
      r = await runVismaPosting()
    } finally {
      spy.mockRestore()
    }
    expect(r.error).toBeNull()
    expect((await db.vismaPosting.findFirstOrThrow({})).status).not.toBe('error')
  })

  it('a Visma outage on the invoice read uses no attempt and never lets the payout go', async () => {
    await mode('hold')
    const payout = await dePayout()
    readOpenInvoices.mockRejectedValue(new Error('This operation was aborted'))
    for (let i = 0; i < 3; i++) {
      const r = await runVismaPosting()
      expect(r.error).toContain('aborted')
      expect(r.status).not.toBe('error')
      const p = await db.vismaPosting.findFirstOrThrow({})
      expect(p.status).not.toBe('error')
      expect(p.attempts).toBe(1)
      // A payout waiting on Visma says why.
      expect(p.error).toContain('aborted')
    }
    // A 5xx and a 429 are outages too.
    readOpenInvoices.mockRejectedValueOnce(new VismaError('Visma responded 503 for GET', 503))
    await runVismaPosting()
    readOpenInvoices.mockRejectedValueOnce(new VismaError('rate limited', 429))
    await runVismaPosting()
    expect(await db.vismaPosting.findFirstOrThrow({})).toMatchObject({ status: 'posting', attempts: 1 })
    readOpenInvoices.mockReset().mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockResolvedValue({ status: 201, number: 'OK' })
    const fourth = await runVismaPosting()
    expect(fourth.payoutId).toBe(payout.id)
    expect(fourth.status).toBe('posted')
  })

  it('an outage after an earlier refusal puts the posting back exactly as it was', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockRejectedValueOnce(new VismaError('Visma responded 400 for GET: bad customer', 400))
    await runVismaPosting()
    readOpenInvoices.mockRejectedValueOnce(new Error('fetch failed'))
    await runVismaPosting()
    const p = await db.vismaPosting.findFirstOrThrow({})
    expect(p).toMatchObject({ status: 'error', attempts: 1 })
    expect(p.error).toContain('bad customer')
  })

  it('an outage on the payment look-up uses no attempt', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
    await runVismaPosting()
    await age()
    findOurPayment.mockRejectedValue(new VismaError('Visma responded 502 for GET', 502))
    vismaPost.mockReset()
    const r = await runVismaPosting()
    expect(r.error).toContain('502')
    const p = await db.vismaPosting.findFirstOrThrow({})
    expect(p).toMatchObject({ status: 'posting', attempts: 1 })
    expect(p.error).toContain('Visma unavailable, will retry')
    expect(vismaPost).not.toHaveBeenCalled()
  })

  it('touches nothing when the deadline is too close to start', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    const r = await runVismaPosting({ deadline: Date.now() + 5_000 })
    expect(r.error).toBeNull()
    expect(await db.vismaPosting.count()).toBe(0)
    expect(readOpenInvoices).not.toHaveBeenCalled()
    expect(vismaPost).not.toHaveBeenCalled()
  })

  it('never pays an invoice twice when a re-ingest moved the payment to a new key', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockImplementation(async () => {
      const posting = await db.vismaPosting.findFirstOrThrow({})
      const old = await db.vismaPostingDocument.findFirst({ where: { key: 'old' } })
      if (!old) {
        await db.vismaPostingDocument.create({
          data: { postingId: posting.id, kind: 'payment', key: 'old', status: 'sent', invoiceNumber: '130474', vismaNumber: 'P-OLD', attempts: 1 },
        })
      }
      return { invoices, calls: 1 }
    })
    vismaPost.mockResolvedValue({ status: 201, number: 'GL-6' })
    await runVismaPosting()
    const paymentPosts = vismaPost.mock.calls.filter((c) => c[1] === 'controller/api/v1/customerPayment')
    expect(paymentPosts).toHaveLength(0)
    const row = await db.vismaPostingDocument.findFirst({ where: { kind: 'payment', key: '14238' } })
    expect(row?.status ?? 'none').not.toMatch(/^(sent|sending)$/)
  })

  it('a payment whose answer was lost and which then vanishes from the open invoices is unconfirmed, never skipped', async () => {
    await mode('hold')
    await dePayout()
    readOpenInvoices.mockResolvedValue({ invoices, calls: 1 })
    vismaPost.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
    await runVismaPosting()
    await age()
    findOurPayment.mockResolvedValue(null)
    // Run 2: Visma does not hold it and the invoice is no longer open.
    readOpenInvoices.mockResolvedValue({ invoices: [], calls: 1 })
    vismaPost.mockReset().mockResolvedValue({ status: 201, number: 'GL-8' })
    const second = await runVismaPosting()
    const row = await db.vismaPostingDocument.findFirstOrThrow({ where: { kind: 'payment', key: '14238' } })
    expect(row.status).toBe('unconfirmed')
    expect(second.status).toBe('error')
    const paymentPosts = vismaPost.mock.calls.filter((c) => c[1] === 'controller/api/v1/customerPayment')
    expect(paymentPosts).toHaveLength(0)
  })
})
