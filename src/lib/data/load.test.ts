import { beforeEach, afterAll, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { loadMetricsInput } from './load'

const MARKER = '[load-currency-test]'

async function wipe() {
  await db.shop.deleteMany({ where: { name: { contains: MARKER } } })
}

beforeEach(wipe)
afterAll(async () => {
  await wipe()
  await db.setting.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', displayCurrency: 'USD' },
    update: { displayCurrency: 'USD' },
  })
})

async function setDisplayCurrency(displayCurrency: string) {
  await db.setting.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', displayCurrency },
    update: { displayCurrency },
  })
}

const RANGE = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-31T00:00:00Z') }

describe('display currency', () => {
  it('consolidates several shops into the configured currency', async () => {
    await db.shop.create({ data: { name: `${MARKER} one`, currency: 'NOK' } })
    await db.shop.create({ data: { name: `${MARKER} two`, currency: 'DKK' } })
    await setDisplayCurrency('NOK')

    const shopIds = (
      await db.shop.findMany({ where: { name: { contains: MARKER } }, select: { id: true } })
    ).map((s) => s.id)

    const input = await loadMetricsInput({ shopIds, ...RANGE })
    expect(input.displayCurrency).toBe('NOK')
  })

  it('still reports a single shop in its OWN currency, ignoring the setting', async () => {
    // One shop needs no consolidation, so converting it would introduce FX
    // error where there was none and stop the figure matching Ads Manager.
    const shop = await db.shop.create({ data: { name: `${MARKER} solo`, currency: 'DKK' } })
    await setDisplayCurrency('NOK')

    const input = await loadMetricsInput({ shopIds: [shop.id], ...RANGE })
    expect(input.displayCurrency).toBe('DKK')
  })
})
