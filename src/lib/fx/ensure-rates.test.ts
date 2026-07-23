import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ensureRates } from './rates'
import { db } from '../db'

/**
 * Currency markets do not publish at weekends, so those days can NEVER be
 * filled. Treating every calendar day as a gap made each dashboard load call an
 * external API that could not help — on every request, forever. `convert()`
 * already falls back to the nearest earlier rate, so a missing weekend costs
 * nothing; being genuinely BEHIND is the only thing worth a network call.
 *
 * Dated in 2027, past every seeded rate, so these tests control the conditions.
 */

const CUR = 'ZZZ' // a currency no other test or seed uses

async function wipe() {
  await db.fxRate.deleteMany({ where: { OR: [{ base: CUR }, { date: { gte: new Date('2027-01-01') } }] } })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  await wipe()
  fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ base: 'USD', rates: {} }), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await wipe()
})

const hold = (day: string) =>
  db.fxRate.create({ data: { date: new Date(`${day}T00:00:00Z`), base: CUR, quote: 'USD', rate: 0.1 } })

describe('ensureRates', () => {
  // The bug: Fri held, Sat/Sun missing forever -> a pointless call every request.
  it('does not call the provider when it already holds a recent rate', async () => {
    await hold('2027-01-20')
    await ensureRates(new Date('2027-01-01'), new Date('2027-01-22'), [CUR])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('DOES fetch when what it holds is genuinely stale', async () => {
    await hold('2027-01-01')
    await ensureRates(new Date('2027-01-01'), new Date('2027-01-22'), [CUR])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Only what is missing: from the day after the newest it holds.
    expect(String(fetchMock.mock.calls[0][0])).toContain('2027-01-02..2027-01-22')
  })

  it('fetches the whole range when it holds nothing that recent', async () => {
    await ensureRates(new Date('2027-01-01'), new Date('2027-01-22'), [CUR])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Never reaches back before the range it was asked about.
    expect(String(fetchMock.mock.calls[0][0])).toContain('2027-01-01..2027-01-22')
  })

  it('never calls out when nothing needs converting', async () => {
    await ensureRates(new Date('2027-01-01'), new Date('2027-01-22'), ['USD'])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
