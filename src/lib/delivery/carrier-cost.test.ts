import { describe, expect, it } from 'vitest'
import { carrierAverages, firstFullMonth } from './carrier-cost'

const ship = (carrier: string, month: string, count: number) => ({ carrier, month, count })
const cost = (carrier: string, month: string, amount: number, currency = 'NOK') => ({
  carrier,
  month,
  amount,
  currency,
})

const bring = (rows: ReturnType<typeof carrierAverages>) =>
  rows.find((r) => r.carrier === 'BRING')

describe('carrierAverages', () => {
  it('divides what the carrier invoiced by the parcels it carried', () => {
    const [row] = carrierAverages([ship('BRING', '2026-07', 400)], [cost('BRING', '2026-07', 2_000_00)])
    expect(row.shipments).toBe(400)
    expect(row.cost).toBe(2_000_00)
    expect(row.averageMinor).toBe(50_0) // NOK 50.00 a parcel
    expect(row.currency).toBe('NOK')
  })

  it('sums whole months rather than averaging the averages', () => {
    // 300 + 100 parcels for 2000 + 1000: 3000/400, not (2000/300 + 1000/100)/2.
    const row = bring(
      carrierAverages(
        [ship('BRING', '2026-06', 300), ship('BRING', '2026-07', 100)],
        [cost('BRING', '2026-06', 2_000_00), cost('BRING', '2026-07', 1_000_00)],
      ),
    )
    expect(row?.shipments).toBe(400)
    expect(row?.averageMinor).toBe(750)
  })

  /**
   * The rule the whole thing rests on: a month's parcels only count when that
   * month's invoice is known. Counting July's 400 parcels against June's
   * invoice alone would halve the average and read as a saving nobody made.
   */
  it('leaves out a month whose invoice has not been entered', () => {
    const row = bring(
      carrierAverages(
        [ship('BRING', '2026-06', 300), ship('BRING', '2026-07', 100)],
        [cost('BRING', '2026-06', 2_000_00)],
      ),
    )
    expect(row?.shipments).toBe(300)
    expect(row?.averageMinor).toBe(667) // 200000 / 300 = 666.67, rounded
  })

  it('names the months it could not include, so the gap is not silent', () => {
    const row = bring(
      carrierAverages(
        [ship('BRING', '2026-06', 300), ship('BRING', '2026-07', 100)],
        [cost('BRING', '2026-06', 2_000_00)],
      ),
    )
    expect(row?.monthsMissingCost).toEqual(['2026-07'])
    expect(row?.monthsCounted).toEqual(['2026-06'])
  })

  it('still reports the parcels when no invoice is known at all', () => {
    const row = bring(carrierAverages([ship('BRING', '2026-07', 400)], []))
    // The count is a fact we hold; only the money is missing.
    expect(row?.shipments).toBe(0)
    expect(row?.parcelsInRange).toBe(400)
    expect(row?.averageMinor).toBeNull()
    expect(row?.cost).toBeNull()
  })

  // An invoice for a month we carried nothing in cannot produce an average,
  // and must not make one up by dividing by zero.
  it('never divides by zero', () => {
    const row = bring(carrierAverages([], [cost('BRING', '2026-07', 2_000_00)]))
    expect(row?.averageMinor ?? null).toBeNull()
  })

  it('keeps each carrier apart, because they bill differently', () => {
    const rows = carrierAverages(
      [ship('BRING', '2026-07', 400), ship('DHL', '2026-07', 100)],
      [cost('BRING', '2026-07', 2_000_00), cost('DHL', '2026-07', 800_00, 'EUR')],
    )
    expect(rows.find((r) => r.carrier === 'BRING')?.averageMinor).toBe(500)
    expect(rows.find((r) => r.carrier === 'DHL')?.averageMinor).toBe(800)
    expect(rows.find((r) => r.carrier === 'DHL')?.currency).toBe('EUR')
  })

  /**
   * Two currencies cannot be added. Converting them here would invent a rate
   * the page never showed, so it refuses and says why - the same rule the rest
   * of the app follows when a figure cannot be trusted.
   */
  it('refuses to sum an invoice in one currency with another', () => {
    const row = bring(
      carrierAverages(
        [ship('BRING', '2026-06', 300), ship('BRING', '2026-07', 100)],
        [cost('BRING', '2026-06', 2_000_00, 'NOK'), cost('BRING', '2026-07', 1_000_00, 'EUR')],
      ),
    )
    expect(row?.averageMinor).toBeNull()
    expect(row?.mixedCurrency).toBe(true)
  })

  it('reports carriers in a stable order, so the panel does not reshuffle', () => {
    const rows = carrierAverages(
      [ship('DHL', '2026-07', 100), ship('BRING', '2026-07', 400)],
      [],
    )
    expect(rows.map((r) => r.carrier)).toEqual(['BRING', 'DHL'])
  })
})

/**
 * A month can hold parcels AND an invoice and still not be divisible, because
 * WE were not counting parcels for all of it. Live case, measured 2026-08-21:
 * production holds exactly one stray Bring parcel dated July beside July's
 * auto-read 324 814.90 kr bill DASH divided, that is 324 814.90 kr PER PARCEL,
 * one date-range click from the screen. The month's own numbers cannot reveal
 * this; only the flag can.
 */
describe('carrierAverages and a month whose parcel count is incomplete', () => {
  it('refuses to divide an incomplete month, even with parcels and an invoice', () => {
    const [bring] = carrierAverages(
      [
        { carrier: 'BRING', month: '2026-07', count: 1, complete: false },
        { carrier: 'BRING', month: '2026-09', count: 400 },
      ],
      [
        { carrier: 'BRING', month: '2026-07', amount: 324_814_90, currency: 'NOK' },
        { carrier: 'BRING', month: '2026-09', amount: 20_000_00, currency: 'NOK' },
      ],
    )

    // September alone: 20 000.00 over 400 parcels. Including July would make
    // it 344 814.90 over 401 and read 859.89 instead of 50.00.
    expect(bring.shipments).toBe(400)
    expect(bring.averageMinor).toBe(50_00)
    expect(bring.monthsCounted).toEqual(['2026-09'])
  })

  it('does not nag for an invoice for a month it would refuse to divide anyway', () => {
    const [bring] = carrierAverages(
      [{ carrier: 'BRING', month: '2026-08', count: 201, complete: false }],
      [],
    )

    expect(bring.monthsMissingCost).toEqual([])
  })

  it('still reports incomplete months\' parcels in the range total, because they moved', () => {
    const [bring] = carrierAverages(
      [
        { carrier: 'BRING', month: '2026-08', count: 201, complete: false },
        { carrier: 'BRING', month: '2026-09', count: 400 },
      ],
      [],
    )

    expect(bring.parcelsInRange).toBe(601)
  })
})

/**
 * 'YYYY-MM-01' of the first month wholly inside the record: the month itself
 * when counting began on the 1st, otherwise the next one.
 */
describe('firstFullMonth', () => {
  it('is the month itself when counting began on its first day', () => {
    expect(firstFullMonth(new Date('2026-08-01T00:00:00Z'))).toBe('2026-08')
  })

  it('is the next month when counting began part-way through', () => {
    expect(firstFullMonth(new Date('2026-08-21T00:00:00Z'))).toBe('2026-09')
  })

  it('rolls over a year end', () => {
    expect(firstFullMonth(new Date('2026-12-05T00:00:00Z'))).toBe('2027-01')
  })
})
