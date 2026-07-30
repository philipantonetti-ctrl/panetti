import { describe, it, expect } from 'vitest'
import { summariseProducts } from './ambassador-products'

const gift = (ambassadorId: string, sku: string, name: string, quantity = 1) => ({
  ambassadorId,
  sku,
  name,
  quantity,
})

describe('summariseProducts', () => {
  it('counts a person once per product, however many they were sent', () => {
    // Emma got two of the same chair on two dates. That is one ambassador
    // holding it, not two — the whole reason this is a function and not a
    // groupBy in a route.
    const rows = [gift('emma', 'MACBL661', 'Advanced Comfort', 1), gift('emma', 'MACBL661', 'Advanced Comfort', 2)]

    expect(summariseProducts(rows)).toEqual([
      { sku: 'MACBL661', name: 'Advanced Comfort', ambassadors: 1, units: 3 },
    ])
  })

  it('counts distinct people and sums their units', () => {
    const rows = [
      gift('emma', 'MPX-001', 'Pro X', 1),
      gift('johan', 'MPX-001', 'Pro X', 2),
      gift('sofia', 'MACBL661', 'Advanced Comfort', 1),
    ]

    expect(summariseProducts(rows)).toEqual([
      { sku: 'MPX-001', name: 'Pro X', ambassadors: 2, units: 3 },
      { sku: 'MACBL661', name: 'Advanced Comfort', ambassadors: 1, units: 1 },
    ])
  })

  it('breaks ties by units, then by name, so the order is total', () => {
    const rows = [
      gift('emma', 'B-SKU', 'Bravo', 1),
      gift('johan', 'A-SKU', 'Alpha', 5),
      gift('sofia', 'C-SKU', 'Charlie', 1),
    ]

    // All three have one ambassador; Alpha wins on units, then Bravo before
    // Charlie by name.
    expect(summariseProducts(rows).map((r) => r.name)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('ranks by people before units, not the other way round', () => {
    // The one case that tells the two orderings apart: A-SKU has more units,
    // B-SKU has more people. Reach is the question this table answers, so
    // B-SKU must come first.
    const rows = [
      gift('emma', 'A-SKU', 'Alpha', 9),
      gift('johan', 'B-SKU', 'Bravo', 1),
      gift('sofia', 'B-SKU', 'Bravo', 1),
    ]

    expect(summariseProducts(rows).map((r) => r.sku)).toEqual(['B-SKU', 'A-SKU'])
  })

  it('falls back to sku when everything else ties, so the order is truly total', () => {
    // Same product name under two SKUs, same reach, same units — without the
    // sku tiebreaker this pair would come back in whatever order the caller
    // happened to supply.
    const rows = [gift('emma', 'Z-SKU', 'Same Name', 1), gift('johan', 'A-SKU', 'Same Name', 1)]

    expect(summariseProducts(rows).map((r) => r.sku)).toEqual(['A-SKU', 'Z-SKU'])
    // Reversing the input must not reverse the output.
    expect(summariseProducts([...rows].reverse()).map((r) => r.sku)).toEqual(['A-SKU', 'Z-SKU'])
  })

  it('returns an empty list when nothing has been handed out', () => {
    expect(summariseProducts([])).toEqual([])
  })
})
