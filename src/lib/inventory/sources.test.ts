import { describe, expect, it } from 'vitest'
import {
  catalogueOf,
  imageOf,
  imagesOf,
  nameOf,
  namedFromSource,
  oneRowPerSku,
  splitBySource,
} from './sources'

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

describe('nameOf', () => {
  it('gives the source shop’s name for a SKU it carries', () => {
    expect(nameOf(new Map([['PZO-500', 'Pizzaovn Pro']]), item('PZO-500', 'Stored'))).toBe(
      'Pizzaovn Pro',
    )
  })

  it('matches however the stored row cased its SKU', () => {
    expect(nameOf(new Map([['PZO-500', 'Pizzaovn Pro']]), item(' pzo-500 ', 'Stored'))).toBe(
      'Pizzaovn Pro',
    )
  })

  /**
   * The purchase-order list has to name a product whatever its provenance —
   * including one the source shops stopped carrying after the order was placed.
   * A blank there would be an order you cannot identify.
   */
  it('falls back to the stored name when the source shops do not carry it', () => {
    expect(nameOf(new Map(), item('PC-AF-BOWL', 'Air fryer bowl'))).toBe('Air fryer bowl')
  })

  it('falls back to the stored name when no shop is a source', () => {
    expect(nameOf(null, item('PZO-500', 'Stored'))).toBe('Stored')
  })
})

describe('oneRowPerSku', () => {
  /**
   * Two source shops both list a product, or one shop lists it twice under
   * different spellings. Either way it is one product to cost, and showing it
   * twice is the complaint this is here to end.
   */
  it('keeps one row per SKU, the first it was given', () => {
    const rows = oneRowPerSku([
      { sku: 'PZO-500', id: 'no' },
      { sku: ' pzo-500 ', id: 'se' },
      { sku: 'MPX-001', id: 'no-2' },
    ])

    expect(rows.map((r) => r.id)).toEqual(['no', 'no-2'])
  })

  /**
   * Six live products share the SKU "0" and are not one product — a pizza oven
   * and a massage chair among them. Collapsing them would hide five products
   * that each need a cost, which is worse than showing a duplicate.
   */
  it('never collapses SKUs that cannot identify a product', () => {
    const rows = oneRowPerSku([
      { sku: '0', id: 'oven' },
      { sku: '0', id: 'chair' },
      { sku: '', id: 'blank' },
    ])

    expect(rows.map((r) => r.id)).toEqual(['oven', 'chair', 'blank'])
  })

  it('leaves a list with nothing to collapse exactly as it was', () => {
    const rows = oneRowPerSku([{ sku: 'A-1', id: 'a' }, { sku: 'B-1', id: 'b' }])

    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('imagesOf', () => {
  it('keys the source shops photos by SKU', () => {
    const images = imagesOf([
      { sku: 'PZO-500', imageUrl: 'https://shop.example/oven.png' },
      { sku: 'MPX-001', imageUrl: 'https://shop.example/gun.png' },
    ])

    expect(images.get('PZO-500')).toBe('https://shop.example/oven.png')
    expect(images.get('MPX-001')).toBe('https://shop.example/gun.png')
  })

  it('finds a SKU however the shop cased or spaced it', () => {
    expect(
      imagesOf([{ sku: ' pzo-500 ', imageUrl: 'https://shop.example/oven.png' }]).get('PZO-500'),
    ).toBe('https://shop.example/oven.png')
  })

  /**
   * First one wins, for the same reason the name does: two source shops both
   * carrying a SKU must not have the winner depend on the order Postgres
   * returned them in.
   */
  it('keeps the first photo when two source shops both carry a SKU', () => {
    const images = imagesOf([
      { sku: 'PZO-500', imageUrl: 'https://no.example/oven.png' },
      { sku: 'PZO-500', imageUrl: 'https://se.example/oven.png' },
    ])

    expect(images.get('PZO-500')).toBe('https://no.example/oven.png')
  })

  /**
   * The rule the name follows for a blank title. A source shop that lists the
   * product with no picture must not blank out one another source shop has,
   * or a product loses its photo depending on which shop synced first.
   */
  it('does not let a shop with no photo blank out one another shop has', () => {
    const images = imagesOf([
      { sku: 'PZO-500', imageUrl: null },
      { sku: 'PZO-500', imageUrl: 'https://shop.example/oven.png' },
    ])

    expect(images.get('PZO-500')).toBe('https://shop.example/oven.png')
  })

  it('leaves out a SKU that cannot identify a product', () => {
    expect(imagesOf([{ sku: '0', imageUrl: 'https://shop.example/oven.png' }]).size).toBe(0)
  })
})

describe('imageOf', () => {
  it('gives the photo a source shop shows for the product', () => {
    expect(
      imageOf(new Map([['PZO-500', 'https://shop.example/oven.png']]), item('PZO-500', 'Stored')),
    ).toBe('https://shop.example/oven.png')
  })

  it('finds it however the shop cased or spaced the SKU', () => {
    expect(
      imageOf(new Map([['PZO-500', 'https://shop.example/oven.png']]), item(' pzo-500 ', 'Stored')),
    ).toBe('https://shop.example/oven.png')
  })

  /**
   * Null, not undefined: this goes straight into a prop the table renders as a
   * placeholder, and a spare part no shop lists on its own is the common case
   * rather than the exception.
   */
  it('gives null for a product no source shop carries', () => {
    expect(imageOf(new Map(), item('PPP-ST-001', 'Pizzeta Primo Stone'))).toBeNull()
  })
})

/**
 * Not hypothetical: one live product on a source shop stores an empty string
 * rather than null for its photo. Prisma reports that as a value, so a guard
 * written as `!== null` would put '' in the map and the page would render an
 * img with no src — a broken image where the placeholder belongs.
 */
describe('imagesOf, on the empty string a live shop actually stores', () => {
  it('treats an empty photo as no photo', () => {
    expect(imagesOf([{ sku: 'PZO-500', imageUrl: '' }]).size).toBe(0)
  })

  it('does not let an empty photo beat a real one from another source shop', () => {
    const images = imagesOf([
      { sku: 'PZO-500', imageUrl: '' },
      { sku: 'PZO-500', imageUrl: 'https://shop.example/oven.png' },
    ])

    expect(images.get('PZO-500')).toBe('https://shop.example/oven.png')
  })
})
