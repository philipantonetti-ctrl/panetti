import { describe, expect, it } from 'vitest'
import { carrierAverages } from './carrier-cost'

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
   * the page never showed, so it refuses and says why — the same rule the rest
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
