import { describe, expect, it } from 'vitest'
import { catalogueOf, namedFromSource, splitBySource } from './sources'

const item = (sku: string, name: string) => ({ sku, name })

describe('catalogueOf', () => {
  it('keys the source shops’ names by SKU', () => {
    const catalogue = catalogueOf([
      { sku: 'PZO-500', name: 'Pizzaovn Pro' },
      { sku: 'MPX-001', name: 'Massasjepistol Pro X' },
    ])

    expect(catalogue.get('PZO-500')).toBe('Pizzaovn Pro')
    expect(catalogue.get('MPX-001')).toBe('Massasjepistol Pro X')
  })

  it('finds a SKU however the shop cased or spaced it', () => {
    expect(catalogueOf([{ sku: ' pzo-500 ', name: 'Pizzaovn Pro' }]).get('PZO-500')).toBe(
      'Pizzaovn Pro',
    )
  })

  /**
   * First one wins, matching the forecast: two source shops both carrying a SKU
   * must not have the winner depend on the order Postgres returned them in, or
   * the same product reads differently between two loads.
   */
  it('keeps the first name when two source shops both carry a SKU', () => {
    const catalogue = catalogueOf([
      { sku: 'PZO-500', name: 'Pizzaovn Pro' },
      { sku: 'PZO-500', name: 'Pizza Oven Pro' },
    ])

    expect(catalogue.get('PZO-500')).toBe('Pizzaovn Pro')
  })

  /**
   * A shop that carries the product but has left its title empty must not blank
   * out a name another source shop does have. Same rule as the photo.
   */
  it('does not let a blank title win', () => {
    const catalogue = catalogueOf([
      { sku: 'PZO-500', name: '   ' },
      { sku: 'PZO-500', name: 'Pizzaovn Pro' },
    ])

    expect(catalogue.get('PZO-500')).toBe('Pizzaovn Pro')
  })

  it('leaves out a SKU that cannot identify a product', () => {
    expect(catalogueOf([{ sku: '0', name: 'Something' }]).size).toBe(0)
  })
})

describe('splitBySource', () => {
  it('separates what the source shops carry from what only other shops do', () => {
    const { carried, elsewhere } = splitBySource(
      [item('PZO-500', 'Pizza Oven'), item('PC-AF-BOWL', 'Air fryer bowl')],
      new Map([['PZO-500', 'Pizzaovn Pro']]),
    )

    expect(carried.map((i) => i.sku)).toEqual(['PZO-500'])
    expect(elsewhere.map((i) => i.sku)).toEqual(['PC-AF-BOWL'])
  })

  it('matches a purchasing row to the catalogue however its SKU was typed', () => {
    const { carried } = splitBySource(
      [item(' pzo-500 ', 'Pizza Oven')],
      new Map([['PZO-500', 'Pizzaovn Pro']]),
    )

    expect(carried).toHaveLength(1)
  })

  /**
   * The state every workspace is in until somebody ticks a source shop. The
   * page must behave exactly as it did before this existed, rather than hiding
   * its entire contents behind a drawer.
   */
  it('carries everything when no shop has been named as a source', () => {
    const { carried, elsewhere } = splitBySource(
      [item('PZO-500', 'Pizza Oven'), item('PC-AF-BOWL', 'Air fryer bowl')],
      null,
    )

    expect(carried).toHaveLength(2)
    expect(elsewhere).toEqual([])
  })

  it('keeps the order it was given, so an alphabetical list stays alphabetical', () => {
    const { carried } = splitBySource(
      [item('A-1', 'Anna'), item('B-1', 'Bertil'), item('C-1', 'Cecilia')],
      new Map([
        ['A-1', 'Anna'],
        ['C-1', 'Cecilia'],
      ]),
    )

    expect(carried.map((i) => i.sku)).toEqual(['A-1', 'C-1'])
  })
})

describe('namedFromSource', () => {
  /**
   * The bug this exists to fix. `SupplyItem` snapshots its name once, from
   * whichever shop the database returned first, and never updates it — which is
   * why Norwegian products are listed under their Finnish and Swedish names.
   * Reading the name from the source shop fixes every existing row with no
   * migration, exactly as the Forecast tab already does.
   */
  it('renames a row to what the source shop calls it', () => {
    const [renamed] = namedFromSource(
      [item('PZO-500', 'Rei’itetty Pizzalapio')],
      new Map([['PZO-500', 'Pizzaovn Pro']]),
    )

    expect(renamed.name).toBe('Pizzaovn Pro')
  })

  it('keeps the stored name when the source shops do not carry the product', () => {
    const [kept] = namedFromSource([item('PC-AF-BOWL', 'Air fryer bowl')], new Map())

    expect(kept.name).toBe('Air fryer bowl')
  })

  it('keeps every stored name when no shop has been named as a source', () => {
    const [kept] = namedFromSource([item('PZO-500', 'Whatever we stored')], null)

    expect(kept.name).toBe('Whatever we stored')
  })

  /**
   * The rows carry lead times, a supplier and an id. Rebuilding them as
   * `{sku, name}` would silently empty every field on the page.
   */
  it('leaves the rest of the row alone', () => {
    const [renamed] = namedFromSource(
      [{ sku: 'PZO-500', name: 'Old', productionDays: 60, supplierId: 's1' }],
      new Map([['PZO-500', 'Pizzaovn Pro']]),
    )

    expect(renamed).toEqual({
      sku: 'PZO-500',
      name: 'Pizzaovn Pro',
      productionDays: 60,
      supplierId: 's1',
    })
  })
})
