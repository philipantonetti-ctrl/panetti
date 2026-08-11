import { describe, expect, it } from 'vitest'
import { buildSpendCheck } from './spend-check'
import { buildRateTable } from '../metrics/fx'

const rates = buildRateTable([
  { date: new Date('2026-07-01T00:00:00Z'), currency: 'NOK', rate: 0.1 },
])

const FROM = new Date('2026-07-01T00:00:00Z')
const TO = new Date('2026-07-10T00:00:00Z') // 10 days inclusive
const NOW = new Date('2026-07-10T12:00:00Z')

const account = (over: Record<string, unknown> = {}) => ({
  id: 'acc-1',
  name: 'Panetti NO',
  provider: 'meta',
  currency: 'NOK',
  shopId: 'shop-a',
  active: true,
  lastSyncAt: new Date('2026-07-10T06:00:00Z'),
  lastError: null as string | null,
  ...over,
})

const row = (day: number, spend: number) => ({
  accountId: 'acc-1',
  date: new Date(`2026-07-${String(day).padStart(2, '0')}T00:00:00Z`),
  spend,
  impressions: 0,
  clicks: 0,
  linkClicks: 0,
  conversions: 0,
  conversionValue: 0,
  videoViews3s: 0,
  thruplays: 0,
})

const build = (accounts: ReturnType<typeof account>[], spend: ReturnType<typeof row>[]) =>
  buildSpendCheck({ accounts, spend, rates, from: FROM, to: TO, displayCurrency: 'USD', now: NOW })

describe('buildSpendCheck', () => {
  it('reports the native total UNCONVERTED, in the account currency', () => {
    // The whole point of the panel. This is the figure a human holds against
    // Ads Manager. Converting it would make it unverifiable.
    const result = build([account()], [row(1, 1000_00), row(2, 500_00)])
    expect(result.accounts[0].nativeTotal).toBe(1500_00)
    expect(result.accounts[0].currency).toBe('NOK')
  })

  it('reports the converted total alongside it', () => {
    const result = build([account()], [row(1, 1000_00)])
    expect(result.accounts[0].convertedTotal).toBe(100_00) // NOK 0.1 -> USD
  })

  it('counts days with data against the length of the range', () => {
    const result = build([account()], [row(1, 100), row(2, 100), row(5, 100)])
    expect(result.accounts[0].daysWithData).toBe(3)
    expect(result.accounts[0].daysInRange).toBe(10)
  })

  it('does NOT raise attention for missing days on their own', () => {
    // A platform returns no row for a day it delivered nothing, so a paused
    // campaign and a broken sync are indistinguishable from the count alone.
    // Crying wolf every time a campaign pauses would make the banner useless.
    const result = build([account()], [row(1, 100)])
    expect(result.accounts[0].daysWithData).toBe(1)
    expect(result.needsAttention).toBe(false)
  })

  it('raises attention for a stored sync error', () => {
    const result = build([account({ lastError: 'Facebook login expired.' })], [row(1, 100)])
    expect(result.needsAttention).toBe(true)
    expect(result.accounts[0].status).toBe('error')
  })

  it('raises attention when a sync has not run for over a day', () => {
    // The cron runs every 15 minutes and each account is due every 6 hours,
    // so a full day of silence is a fault, not a quiet period.
    const stale = account({ lastSyncAt: new Date('2026-07-08T06:00:00Z') })
    const result = build([stale], [row(1, 100)])
    expect(result.needsAttention).toBe(true)
    expect(result.accounts[0].status).toBe('stale')
  })

  it('raises attention for an inactive account that still holds spend in the range', () => {
    const result = build([account({ active: false })], [row(1, 100)])
    expect(result.needsAttention).toBe(true)
    expect(result.accounts[0].status).toBe('inactive')
  })

  it('is quiet for a healthy account', () => {
    const result = build([account()], [row(1, 100)])
    expect(result.accounts[0].status).toBe('ok')
    expect(result.needsAttention).toBe(false)
  })

  it('reports the first and last day carrying data', () => {
    const result = build([account()], [row(3, 100), row(7, 100)])
    expect(result.accounts[0].firstDay).toBe('2026-07-03')
    expect(result.accounts[0].lastDay).toBe('2026-07-07')
  })

  it('lists an account with no rows at all, rather than omitting it', () => {
    // An account that vanishes from the list is exactly the failure the panel
    // exists to make visible.
    const result = build([account()], [])
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0].nativeTotal).toBe(0)
    expect(result.accounts[0].firstDay).toBeNull()
  })

  it('sorts the biggest spender first', () => {
    const result = buildSpendCheck({
      accounts: [account(), account({ id: 'acc-2', name: 'Small', currency: 'NOK' })],
      spend: [row(1, 100_00), { ...row(1, 900_00), accountId: 'acc-2' }],
      rates,
      from: FROM,
      to: TO,
      displayCurrency: 'USD',
      now: NOW,
    })
    expect(result.accounts.map((a) => a.name)).toEqual(['Small', 'Panetti NO'])
  })
})
