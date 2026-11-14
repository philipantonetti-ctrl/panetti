import { afterEach, describe, expect, it } from 'vitest'
import { db } from '../db'
import { loadPlanned, plannedPerDay, savePlan } from './plan'

const TAG = `TEST-PLAN-${Date.now()}`
const YEAR = 2090 // a year nothing real is planned for

afterEach(async () => {
  await db.salesPlanLine.deleteMany({ where: { year: { in: [YEAR, YEAR + 1] } } })
  await db.salesPlanName.deleteMany({ where: { name: { startsWith: TAG } } })
})

describe('savePlan', () => {
  it('stores the year and lists every new name as not yet linked to a SKU', async () => {
    await savePlan(YEAR, [{ month: 11, lines: [{ name: `${TAG} Oven`, units: 2910 }] }])
    expect(await db.salesPlanLine.findMany({ where: { year: YEAR }, select: { month: true, name: true, units: true } }))
      .toEqual([{ month: 11, name: `${TAG} Oven`, units: 2910 }])
    expect(await db.salesPlanName.findUnique({ where: { name: `${TAG} Oven` } })).toMatchObject({ sku: null })
  })

  it('replaces that year on a second upload, and keeps a SKU already chosen', async () => {
    await savePlan(YEAR, [{ month: 11, lines: [{ name: `${TAG} Oven`, units: 2910 }, { name: `${TAG} Brush`, units: 5 }] }])
    await db.salesPlanName.update({ where: { name: `${TAG} Oven` }, data: { sku: `${TAG}-OVEN` } })
    await savePlan(YEAR, [{ month: 12, lines: [{ name: `${TAG} Oven`, units: 1250 }] }])

    expect(await db.salesPlanLine.findMany({ where: { year: YEAR }, select: { month: true, name: true, units: true } }))
      .toEqual([{ month: 12, name: `${TAG} Oven`, units: 1250 }])
    expect((await db.salesPlanName.findUnique({ where: { name: `${TAG} Oven` } }))?.sku).toBe(`${TAG}-OVEN`)
  })

  it('never touches another year', async () => {
    await savePlan(YEAR + 1, [{ month: 1, lines: [{ name: `${TAG} Oven`, units: 7 }] }])
    await savePlan(YEAR, [{ month: 1, lines: [{ name: `${TAG} Oven`, units: 9 }] }])
    expect(await db.salesPlanLine.count({ where: { year: YEAR + 1 } })).toBe(1)
  })
})

describe('loadPlanned', () => {
  it('gives units per SKU per month, adding names linked to the same SKU, ignoring unlinked names', async () => {
    await savePlan(YEAR, [
      { month: 11, lines: [
        { name: `${TAG} Stand-Mixer`, units: 100 },
        { name: `${TAG} PrimoMix`, units: 20 },
        { name: `${TAG} Unlinked`, units: 999 },
      ] },
    ])
    await db.salesPlanName.update({ where: { name: `${TAG} Stand-Mixer` }, data: { sku: `${TAG}-MIX` } })
    await db.salesPlanName.update({ where: { name: `${TAG} PrimoMix` }, data: { sku: `${TAG}-MIX` } })

    const planned = await loadPlanned([YEAR])
    expect(planned.get(`${TAG}-MIX`)?.get(`${YEAR}-11`)).toBe(120)
    expect([...planned.values()].some((m) => m.get(`${YEAR}-11`) === 999)).toBe(false)
  })
})

describe('plannedPerDay', () => {
  it('spreads a month over its days, and is null outside the plan', () => {
    const per = plannedPerDay(new Map([['2026-11', 2910]]))
    expect(per(new Date('2026-11-14T00:00:00Z'))).toBe(97)
    expect(per(new Date('2026-12-01T00:00:00Z'))).toBeNull()
  })

  it('knows February is short', () => {
    expect(plannedPerDay(new Map([['2027-2', 280]]))(new Date('2027-02-10T00:00:00Z'))).toBe(10)
  })
})
