import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { resetVismaTokenCache } from './client'
import {
  pickWebshopCustomer,
  probeKey,
  runVismaProbe,
  summariseWebshopCustomers,
  VISMA_PROBE_STEPS,
} from './probe'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** One stubbed Visma, answering by resource so a step's URL is what is tested. */
const stubVisma = (answers: Record<string, unknown>, status = 200) => {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('connect/token')) return json({ access_token: 'tok', expires_in: 3600 })
      calls.push(u)
      const hit = Object.keys(answers).find((k) => u.includes('/api/v1/' + k))
      return json(hit ? answers[hit] : [], status)
    }),
  )
  return calls
}

const resource = (u: string) => u.split('/api/v1/')[1]?.split('?')[0]

const doc = (over: Record<string, unknown> = {}) => ({
  referenceNumber: '130001',
  customer: { number: '10999', name: 'Panetti Danmark - Webkunde' },
  documentType: 'Invoice',
  documentDate: '2026-08-21T00:00:00',
  currencyId: 'DKK',
  amountInCurrency: 2999,
  balanceInCurrency: 2999,
  status: 'Open',
  ...over,
})

beforeEach(() => {
  resetVismaTokenCache()
  vi.stubEnv('VISMA_CLIENT_ID', 'cid')
  vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
  vi.stubEnv('VISMA_TENANT_ID', 'tid')
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await db.diagnosticSnapshot.deleteMany({ where: { key: { startsWith: 'visma-probe:' } } })
})

describe('runVismaProbe', () => {
  it('does nothing without credentials', async () => {
    vi.stubEnv('VISMA_CLIENT_SECRET', '')
    const calls = stubVisma({})
    const result = await runVismaProbe({ pauseMs: 0 })
    expect(result.configured).toBe(false)
    expect(calls).toEqual([])
    expect(await db.diagnosticSnapshot.count({ where: { key: { startsWith: 'visma-probe:' } } })).toBe(0)
  })

  it('runs the steps in order, at most maxCalls calls a run, storing each answer as it lands', async () => {
    const calls = stubVisma({
      cashaccount: [{ number: '1920', description: 'Bank DKK', currency: 'DKK' }],
      paymentmethod: [{ paymentMethodID: 'DINTERO', active: true }],
    })
    const result = await runVismaProbe({ maxCalls: 2, pauseMs: 0 })

    expect(result.configured).toBe(true)
    expect(result.ran).toEqual(['cashaccount', 'paymentmethod'])
    expect(result.calls).toBe(2)
    expect(result.pending).toEqual(VISMA_PROBE_STEPS.slice(2).map((s) => s.name))
    expect(calls.map(resource)).toEqual(['cashaccount', 'paymentmethod'])

    const stored = await db.diagnosticSnapshot.findUnique({ where: { key: probeKey('cashaccount') } })
    expect(stored?.payload).toMatchObject({ rows: 1 })
    expect(JSON.stringify(stored?.payload)).toContain('Bank DKK')
  })

  it('skips steps already stored and stops before a step it cannot afford', async () => {
    await db.diagnosticSnapshot.createMany({
      data: [
        { key: probeKey('cashaccount'), payload: { rows: 0 } },
        { key: probeKey('paymentmethod'), payload: { rows: 0 } },
      ],
    })
    const calls = stubVisma({
      branch: [{ number: '1', name: 'Ledende Teknologi AS' }],
      ledger: [{ number: 'ACTUAL' }],
    })

    // branch-ledger costs two calls; one is not enough, so nothing runs.
    const short = await runVismaProbe({ maxCalls: 1, pauseMs: 0 })
    expect(short.ran).toEqual([])
    expect(calls).toEqual([])

    const full = await runVismaProbe({ maxCalls: 2, pauseMs: 0 })
    expect(full.ran).toEqual(['branch-ledger'])
    expect(calls.map(resource)).toEqual(['branch', 'ledger'])
  })

  it('stops on a rate limit and stores nothing for that step', async () => {
    stubVisma({}, 429)
    const result = await runVismaProbe({ maxCalls: 4, pauseMs: 0 })
    expect(result.ran).toEqual([])
    expect(result.partial).toBe(true)
    expect(await db.diagnosticSnapshot.count({ where: { key: { startsWith: 'visma-probe:' } } })).toBe(0)
  })

  it('stores any other failure under the step so it is read rather than retried forever', async () => {
    stubVisma({}, 500)
    const result = await runVismaProbe({ maxCalls: 1, pauseMs: 0 })
    expect(result.ran).toEqual(['cashaccount'])
    const stored = await db.diagnosticSnapshot.findUnique({ where: { key: probeKey('cashaccount') } })
    expect(JSON.stringify(stored?.payload)).toContain('500')
  })

  it('reads the Denmark invoices for the webshop customer the ledger step found', async () => {
    for (const s of VISMA_PROBE_STEPS.slice(0, 3)) {
      await db.diagnosticSnapshot.create({ data: { key: probeKey(s.name), payload: { rows: 0 } } })
    }
    const calls = stubVisma({
      customerdocument: [
        doc(),
        doc({ referenceNumber: '130002', amountInCurrency: 3747, balanceInCurrency: 3747 }),
      ],
      customerinvoice: [
        {
          ...doc(),
          customerRefNumber: '14238',
          invoiceLines: [{ inventoryNumber: 'PPP-ST-001', quantity: 1, amountInCurrency: 2999 }],
        },
      ],
    })

    const result = await runVismaProbe({ maxCalls: 2, pauseMs: 0 })
    expect(result.ran).toEqual(['webkunde-customers', 'dk-invoices'])

    const invoiceUrl = calls.find((u) => u.includes('customerinvoice'))!
    expect(invoiceUrl).toContain('customer=10999')
    expect(invoiceUrl).toContain('documentDateCondition=')

    const stored = await db.diagnosticSnapshot.findUnique({ where: { key: probeKey('dk-invoices') } })
    const payload = stored?.payload as { customer: { number: string }; invoices: Record<string, unknown>[] }
    expect(payload.customer.number).toBe('10999')
    expect(payload.invoices[0]).toMatchObject({
      referenceNumber: '130001',
      customerRefNumber: '14238',
      lineCount: 1,
    })
  })
})

describe('summariseWebshopCustomers', () => {
  it('groups the open ledger by webshop house account and counts the rest', () => {
    const out = summariseWebshopCustomers([
      doc(),
      doc({
        referenceNumber: '130002',
        documentType: 'CreditNote',
        amountInCurrency: -300,
        balanceInCurrency: -300,
      }),
      doc({ customer: { number: '10681', name: 'JPK Trading Kft' }, currencyId: 'EUR' }),
      doc({
        customer: { number: '10990', name: 'Panetti Norge - Webkunde' },
        currencyId: 'NOK',
        documentDate: '2026-07-01T00:00:00',
      }),
    ])
    expect(out.read).toBe(4)
    expect(out.others).toBe(1)
    expect(out.webshop).toHaveLength(2)
    const dk = out.webshop.find((c) => c.number === '10999')!
    expect(dk).toMatchObject({
      name: 'Panetti Danmark - Webkunde',
      documents: 2,
      invoices: 1,
      creditNotes: 1,
      currencies: { DKK: 2 },
      balance: { DKK: 269900 },
      oldest: '2026-08-21',
      newest: '2026-08-21',
    })
  })
})

describe('pickWebshopCustomer', () => {
  const customers: { number: string; name: string; currencies: Record<string, number> }[] = [
    { number: '10990', name: 'Panetti Norge - Webkunde', currencies: { NOK: 5 } },
    { number: '10999', name: 'Panetti Danmark - Webkunde', currencies: { DKK: 3 } },
    { number: '10998', name: 'Mazzetti Danmark - Webkunde', currencies: { DKK: 1 } },
  ]

  it('prefers the name, then falls back to the currency', () => {
    expect(pickWebshopCustomer(customers, /panetti/i, /danmark|denmark/i, 'DKK')?.number).toBe('10999')
    expect(pickWebshopCustomer(customers, /panetti/i, /finland/i, 'NOK')?.number).toBe('10990')
    expect(pickWebshopCustomer(customers, /nobody/i, /nowhere/i, 'SEK')).toBeNull()
  })
})
