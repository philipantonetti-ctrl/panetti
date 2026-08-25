import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ensureRates } from './rates'
import { db } from '../db'

/**
 * Currency markets do not publish at weekends, so those days can NEVER be
 * filled. Treating every calendar day as a gap made each dashboard load call an
 * external API that could not help - on every request, forever. `convert()`
 * already falls back to the nearest earlier rate, so a missing weekend costs
 * nothing; being genuinely BEHIND is the only thing worth a network call.
 *
 * Dated in 2027, past every seeded rate, so these tests control the conditions.
 */

// ISK and BGN: real, convertible ISO codes (src/lib/currencies.ts) that no
// other test or seed in this repo uses - chosen so a currency that genuinely
// needs a fetch behaves like a real one, not a code the provider would
// reject outright.
const CUR = 'ISK'
const OTHER = 'BGN'
// AED: a real ISO code, but NOT in our CONVERTIBLE list - Frankfurter cannot
// quote it. This is the FIX 1 currency: a B2B order or expense in AED.
const UNQUOTED = 'AED'

async function wipe() {
  await db.fxRate.deleteMany({
    where: { OR: [{ base: CUR }, { base: OTHER }, { base: UNQUOTED }, { date: { gte: new Date('2027-01-01') } }] },
  })
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

const holdOther = (day: string) =>
  db.fxRate.create({ data: { date: new Date(`${day}T00:00:00Z`), base: OTHER, quote: 'USD', rate: 0.2 } })

describe('ensureRates', () => {
  it('does not call the provider when it holds history back to the start of the range and stays fresh', async () => {
    await hold('2027-01-01') // covers the start of the range being viewed
    await hold('2027-01-20') // and stays fresh towards `to`
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

  // The bug this guards: `newest` only proves SOME currency was synced
  // recently, not that the one just picked as a display currency (e.g. a
  // workspace switching to SEK or GBP, which no shop or ad account trades in)
  // was ever fetched. The old freshness check looked only at `newest` and
  // skipped the provider call entirely, leaving that currency with zero rows
  // - crossConvert then returns amounts unconverted, silently.
  it('fetches a currency that has no rows at all, even though another currency is fresh', async () => {
    // OTHER is fresh (inside FRESH_DAYS of `to`), so a shortcut that looked
    // only at `newest` would fire and CUR - which has never been held, and is
    // never created here - would get nothing.
    await holdOther('2027-01-20')

    await ensureRates(new Date('2027-01-01'), new Date('2027-01-22'), [CUR])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    // CUR has never been held, so the WHOLE range is fetched - not just since
    // OTHER's newest day, which would leave the earlier part of the range
    // unconverted for CUR.
    expect(String(fetchMock.mock.calls[0][0])).toContain('2027-01-01..2027-01-22')
  })

  // FIX 1: a currency Frankfurter does not quote (heldSet can never gain a
  // row for it, no matter how many times we ask) must never keep the
  // freshness shortcut closed. Before the fix this currency alone was enough
  // to force startDay to the whole range and call the provider on EVERY
  // request, forever - exactly the "external API that could not help, on
  // every request, forever" failure FRESH_DAYS exists to prevent.
  it('does not force a fetch for a currency the provider cannot quote, when other rates are fresh', async () => {
    await holdOther('2027-01-20') // some OTHER currency, fresh relative to `to`
    await ensureRates(new Date('2027-01-01'), new Date('2027-01-22'), [UNQUOTED])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Companion to the above: a real, CONVERTIBLE currency with no rows at all
  // must still force a fetch - FIX 1 only exempts currencies the provider
  // cannot quote, not ordinary ones that simply have never been synced. This
  // is unaffected by FIX 1 (it already passed before it, and still does).
  it('still forces a fetch for a convertible currency that holds no rows at all', async () => {
    await ensureRates(new Date('2027-01-01'), new Date('2027-01-22'), [CUR])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // FIX 2: the real bug. An operator switches the display currency today;
  // that currency's only row lands OUTSIDE the range someone views later
  // (e.g. last year). The OLD `held` check ("does this currency have ANY
  // row, EVER") found that out-of-range row and treated the currency as
  // covered, so the shortcut fired and no fetch happened - `rateOn` then fell
  // back to the EARLIEST row it held (today's rate) for every day of the
  // viewed range, converting all of history at today's rate.
  it('forces a fetch when the only rows it holds fall OUTSIDE the range being viewed', async () => {
    await holdOther('2027-01-04') // some OTHER currency, fresh and INSIDE the range
    await hold('2027-01-20') // CUR's only row: AFTER the range being viewed
    await ensureRates(new Date('2027-01-01'), new Date('2027-01-05'), [CUR])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('2027-01-01..2027-01-05')
  })

  // FIX 3: the provider (Frankfurter/ECB) publishes nothing for non-trading
  // days. If the range being viewed STARTS on a weekend or holiday, the rows
  // we get back begin on the first trading day AFTER the range start -
  // `held`'s old "date <= start of range" test then NEVER matches, no matter
  // how many times we fetch, so every single page load re-fetches the same
  // range and re-upserts it, forever. This is the narrower survivor of FIX 2
  // above: the earliest row we hold must count as "held" even when it lands a
  // couple of days after the range start, as long as the gap is small enough
  // to be explained by the provider simply having nothing to publish for
  // those days (a weekend, plus a holiday).
  it('does not force a fetch when the earliest held row falls just after the range start (weekend gap)', async () => {
    await hold('2027-01-03') // earliest row available: first trading day after a weekend start
    await hold('2027-01-20') // and stays fresh towards `to`
    await ensureRates(new Date('2027-01-01'), new Date('2027-01-22'), [CUR])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Companion to FIX 3: the tolerance that lets a weekend gap count as "held"
  // must stay narrow. A currency whose earliest row is genuinely far after
  // the range start (viewing last year, but the only row is from just now)
  // must still force the whole-range fetch - otherwise this fix would widen
  // back into FIX 2's bug (history silently converted at today's rate).
  it('still forces a fetch when the earliest held row is far after the range start', async () => {
    await hold('2027-06-01') // CUR's only row, months after the viewed range
    await ensureRates(new Date('2026-01-01'), new Date('2026-01-31'), [CUR])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('2026-01-01..2026-01-31')
  })
})
