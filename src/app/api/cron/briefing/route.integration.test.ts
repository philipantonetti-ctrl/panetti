import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { writeBriefing } from '@/lib/advisor/write'
import type { BriefItem } from '@/lib/advisor/brief'

const NOW = new Date('2026-08-10T05:00:00Z')
const DAY = new Date('2026-08-10T00:00:00.000Z')
const day = (iso: string) => new Date(`${iso}T00:00:00Z`)

const item: BriefItem = {
  headline: 'Something moved',
  why: 'It moved in step with advertising.',
  factIds: [],
  severity: 'medium',
  action: null,
}

/**
 * A real revenue move inside the window collectFacts computes from NOW, so
 * generateBrief has something to rank rather than taking its "quiet week"
 * shortcut (collected.facts.length === 0 short-circuits before the model is
 * ever consulted, which is what left this test unable to pass against the
 * ambient seed alone: prisma/seed.ts anchors "today" at a literal 2026-07-14,
 * so it never reaches the 2026-08-03..09 week no matter when it is re-run).
 *
 * Mirrors collect.integration.test.ts (Task 6) exactly — same shape of
 * fixture, same two-window trick — but named distinctly so it cannot collide
 * with that file's '[advisor-test] Shop', and torn down in afterAll so
 * load.integration.test.ts's hardcoded "the seeded eleven" sees exactly
 * eleven again once this file finishes.
 */
let shopId = ''
let productId = ''

async function order(number: string, placedAt: Date, netSales: number) {
  return db.order.create({
    data: {
      shopId,
      externalId: `brf-${number}`,
      number,
      placedAt,
      status: 'completed',
      currency: 'NOK',
      grossSales: netSales,
      discountTotal: 0,
      netSales,
      shippingCharged: 0,
      taxTotal: 0,
      total: netSales,
      items: {
        create: [
          { productId, sku: 'BRF-1', name: 'Briefing Cron Test Product', quantity: 1, unitPrice: netSales, lineNetTotal: netSales },
        ],
      },
    },
  })
}

beforeAll(async () => {
  const shop = await db.shop.create({ data: { name: '[briefing-test] Cron Shop', currency: 'NOK' } })
  shopId = shop.id
  const product = await db.product.create({
    data: { shopId, externalId: 'brf-1', sku: 'BRF-1', name: 'Briefing Cron Test Product' },
  })
  productId = product.id

  // Previous window (27 Jul – 2 Aug): 1_000_000 NOK.
  await order('A1', day('2026-07-29'), 1_000_000)
  // Current window (3 – 9 Aug): 400_000 NOK — a 60% fall, a real move to find.
  await order('A2', day('2026-08-05'), 400_000)
})

afterAll(async () => {
  // Dependency order: items cascade with the order, but the order and
  // product both reference the shop, so the shop must go last.
  await db.order.deleteMany({ where: { shopId } })
  await db.product.deleteMany({ where: { shopId } })
  await db.shop.delete({ where: { id: shopId } })
})

beforeEach(async () => {
  await db.briefing.deleteMany({ where: { day: DAY } })
  // generateBrief logs every failure, and several tests below fail the model
  // on purpose. Their stderr is the code working, not a finding.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await db.briefing.deleteMany({ where: { day: DAY } })
})

describe('writeBriefing', () => {
  it('stores the facts even when no model is configured', async () => {
    const result = await writeBriefing(NOW, null)
    expect(result.error).toContain('ANTHROPIC_API_KEY')

    const row = await db.briefing.findUnique({ where: { day: DAY } })
    expect(row).not.toBeNull()
    expect(row!.items).toBeNull()
    expect(JSON.parse(row!.facts)).toBeInstanceOf(Array)
  })

  it('stores the facts even when the model call fails', async () => {
    const model = vi.fn().mockRejectedValue(new Error('529 overloaded'))
    await writeBriefing(NOW, model)

    const row = await db.briefing.findUnique({ where: { day: DAY } })
    expect(row!.error).toContain('529 overloaded')
    expect(JSON.parse(row!.facts)).toBeInstanceOf(Array)
  })

  it('persists the facts BEFORE calling the model, not after', async () => {
    // A platform kill mid-model-call skips generateBrief's own catch entirely
    // -- nothing written after the kill happens. The only way the facts
    // survive that is if they were already committed by the time the model
    // is invoked, which this proves by reading the row from inside the mock.
    let factsSeenDuringTheCall: unknown = undefined
    const model = vi.fn().mockImplementation(async () => {
      const row = await db.briefing.findUnique({ where: { day: DAY } })
      factsSeenDuringTheCall = row ? JSON.parse(row.facts) : null
      throw new Error('killed mid-call')
    })

    await writeBriefing(NOW, model)

    expect(Array.isArray(factsSeenDuringTheCall)).toBe(true)
    expect((factsSeenDuringTheCall as unknown[]).length).toBeGreaterThan(0)
  })

  it('keeps yesterday-good items when a re-run on the same day dies', async () => {
    // The two-phase write must not null out a briefing that is already fine
    // before the new attempt has earned the right to replace it. A kill
    // between the facts write and the model result would otherwise destroy a
    // good briefing AND leave error null, so nothing on the page said so.
    const good = vi.fn().mockResolvedValue({ items: [item], model: 'claude-opus-5' })
    await writeBriefing(NOW, good)

    // Captured, never asserted in here: generateBrief catches everything the
    // model throws, so an expect() inside this mock would be swallowed and
    // stored as an error rather than failing the test.
    let itemsMidRerun: string | null = null
    const killed = vi.fn().mockImplementation(async () => {
      const row = await db.briefing.findUnique({ where: { day: DAY } })
      itemsMidRerun = row!.items
      throw new Error('killed mid-call')
    })
    await writeBriefing(NOW, killed)

    expect(killed).toHaveBeenCalled()
    // The previous good briefing was still standing when the re-run died.
    expect(itemsMidRerun).not.toBeNull()
  })

  it('replaces rather than duplicates when run twice on one day', async () => {
    const model = vi.fn().mockResolvedValue({ items: [item], model: 'claude-opus-5' })
    await writeBriefing(NOW, model)
    await writeBriefing(NOW, model)

    const rows = await db.briefing.findMany({ where: { day: DAY } })
    expect(rows).toHaveLength(1)
  })

  it('records which model wrote it', async () => {
    const model = vi.fn().mockResolvedValue({ items: [item], model: 'claude-opus-5' })
    await writeBriefing(NOW, model)

    const row = await db.briefing.findUnique({ where: { day: DAY } })
    expect(row!.model).toBe('claude-opus-5')
  })
})

describe('GET /api/cron/briefing', () => {
  it('refuses to run when no CRON_SECRET is set', async () => {
    const previous = process.env.CRON_SECRET
    delete process.env.CRON_SECRET
    const { GET } = await import('./route')

    const res = await GET(new Request('http://localhost/api/cron/briefing'))
    expect(res.status).toBe(503)

    if (previous) process.env.CRON_SECRET = previous
  })

  it('refuses a caller with the wrong bearer token', async () => {
    process.env.CRON_SECRET = 'test-secret'
    const { GET } = await import('./route')

    const res = await GET(
      new Request('http://localhost/api/cron/briefing', { headers: { authorization: 'Bearer wrong' } }),
    )
    expect(res.status).toBe(401)

    delete process.env.CRON_SECRET
  })
})
