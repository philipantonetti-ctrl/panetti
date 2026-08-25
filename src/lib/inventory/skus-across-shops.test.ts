import { describe, expect, it } from 'vitest'
import { listingsFrom, skuStem, skusAcrossShops, unitsBySku } from './skus-across-shops'

const listing = (
  shopName: string,
  sku: string,
  { source = false, active = true, name = 'A product' } = {},
) => ({ shopName, sku, name, isSource: source, isActive: active, noSkuInWoo: false })

/** Recent units per SKU. Required by the function, irrelevant to most tests. */
const NO_SALES = new Map<string, number>()

describe('skusAcrossShops', () => {
  /**
   * The question this exists to answer: is one product one SKU everywhere, or
   * does each country's shop invent its own code? A workspace where most SKUs
   * are carried by several shops is the first; one where nearly every SKU
   * belongs to exactly one shop is the second, and merging them by SKU can
   * never work.
   */
  it('counts the SKUs more than one shop carries, and the ones only one does', () => {
    const report = skusAcrossShops([
      listing('Panetti Norway', 'PZO-500', { source: true }),
      listing('Panetti Sweden', 'PZO-500'),
      listing('Panetti Sweden', 'ONLY-IN-SWEDEN'),
    ], NO_SALES)

    expect(report.sharedSkus).toBe(1)
    expect(report.soleShopSkus).toBe(1)
  })

  /**
   * Two shops typing the same code in different case is one SKU, exactly as it
   * is everywhere else in the purchasing side. Counted as two, this diagnostic
   * would report per-country SKUs in a workspace that has none - the wrong
   * answer to the only question it is here to answer.
   */
  it('treats a SKU written in another case or with stray spaces as the same SKU', () => {
    const report = skusAcrossShops([
      listing('Panetti Norway', 'PZO-500', { source: true }),
      listing('Panetti Sweden', ' pzo-500 '),
    ], NO_SALES)

    expect(report.sharedSkus).toBe(1)
    expect(report.soleShopSkus).toBe(0)
  })

  /**
   * A SKU that cannot identify a product is not evidence either way. Six live
   * products carry the SKU "0", spanning a pizza oven and a massage chair, and
   * counting that as one SKU shared by six shops would be the strongest signal
   * in the report and a completely false one.
   */
  it('ignores a SKU that cannot identify a product', () => {
    const report = skusAcrossShops([
      listing('Panetti Norway', '0', { source: true }),
      listing('Panetti Sweden', '000'),
      listing('Panetti Denmark', '  '),
    ], NO_SALES)

    expect(report.sharedSkus).toBe(0)
    expect(report.soleShopSkus).toBe(0)
  })

  /**
   * Per shop, because the totals alone cannot tell you WHERE the odd codes are.
   * `onlyHere` is the useful column: a shop carrying forty SKUs nobody else has
   * is either a separate brand or a shop that renamed everything.
   */
  it('says how many SKUs each shop carries and how many are its alone', () => {
    const report = skusAcrossShops([
      listing('Panetti Norway', 'PZO-500', { source: true }),
      listing('Panetti Norway', 'NORWAY-ONLY', { source: true }),
      listing('Panetti Sweden', 'PZO-500'),
    ], NO_SALES)

    expect(report.shops).toEqual([
      { shopName: 'Panetti Norway', isSource: true, isActive: true, skus: 2, onlyHere: 1 },
      { shopName: 'Panetti Sweden', isSource: false, isActive: true, skus: 1, onlyHere: 0 },
    ])
  })

  /**
   * A switched-off shop is never synced again, but every SKU it ever listed
   * still has a purchasing row, and those rows are part of why the lead-times
   * list is longer than the forecast. Named as inactive rather than dropped.
   */
  it('keeps a switched-off shop in the report, marked inactive', () => {
    const report = skusAcrossShops([
      listing('Panetti Norway', 'PZO-500', { source: true }),
      listing('Panetti Germany', 'GERMANY-ONLY', { active: false }),
    ], NO_SALES)

    expect(report.shops.find((s) => s.shopName === 'Panetti Germany')).toEqual({
      shopName: 'Panetti Germany',
      isSource: false,
      isActive: false,
      skus: 1,
      onlyHere: 1,
    })
  })

  /**
   * The one figure here that is about money rather than tidiness.
   *
   * The forecast lists what the source shops carry and pools sales by SKU. So a
   * SKU no source shop carries is demand the forecast cannot see at all: those
   * units are being sold and nothing is being ordered to replace them. Sorted
   * biggest first, because that is the order anyone would want to fix them in.
   */
  it('names the selling SKUs no source shop carries, biggest first', () => {
    const report = skusAcrossShops(
      [
        listing('Panetti Norway', 'PZO-500', { source: true }),
        listing('Panetti Sweden', 'PZO-500-SE'),
        listing('Panetti Denmark', 'PZO-500-DK'),
      ],
      new Map([
        ['PZO-500', 300],
        ['PZO-500-SE', 40],
        ['PZO-500-DK', 90],
      ]),
    )

    expect(report.sellingButNotSourced).toEqual([
      { sku: 'PZO-500-DK', shops: ['Panetti Denmark'], recentUnits: 90, noSkuInWoo: false },
      { sku: 'PZO-500-SE', shops: ['Panetti Sweden'], recentUnits: 40, noSkuInWoo: false },
    ])
  })

  /**
   * A SKU nobody has bought is not a blind spot, it is a listing. Reporting it
   * would bury the ones that matter under every discontinued product.
   */
  it('leaves out an unsourced SKU that has not sold', () => {
    const report = skusAcrossShops(
      [
        listing('Panetti Norway', 'PZO-500', { source: true }),
        listing('Panetti Sweden', 'DISCONTINUED'),
      ],
      new Map([['PZO-500', 300]]),
    )

    expect(report.sellingButNotSourced).toEqual([])
  })

  /**
   * A sales key that misses its SKU reads as "no units", and no units reads as
   * "no blind spot" - the reassuring answer, arrived at by a lookup failure.
   * The listings are normalised on the way in, so the sales side must be too,
   * rather than trusting every caller to have done it first.
   */
  it('still finds the blind spot when the sales are keyed in another case', () => {
    const report = skusAcrossShops(
      [
        listing('Panetti Norway', 'PZO-500', { source: true }),
        listing('Panetti Sweden', 'PZO-500-SE'),
      ],
      new Map([[' pzo-500-se ', 40]]),
    )

    expect(report.sellingButNotSourced).toEqual([
      { sku: 'PZO-500-SE', shops: ['Panetti Sweden'], recentUnits: 40, noSkuInWoo: false },
    ])
  })

  /**
   * Two keys for one product are two halves of its demand. Keeping the last one
   * seen would report a fraction of the units and make the blind spot look
   * smaller than it is - and which fraction would depend on iteration order.
   */
  it('adds up sales keys that turn out to be the same SKU', () => {
    const report = skusAcrossShops(
      [
        listing('Panetti Norway', 'PZO-500', { source: true }),
        listing('Panetti Sweden', 'PZO-500-SE'),
      ],
      new Map([
        ['PZO-500-SE', 40],
        ['pzo-500-se', 25],
      ]),
    )

    expect(report.sellingButNotSourced[0].recentUnits).toBe(65)
  })

  /**
   * Until somebody ticks a source shop the forecast lists every SKU, so nothing
   * is being missed and this must not invent a problem. It is the state every
   * workspace starts in.
   */
  it('reports no blind spot when no shop has been named as a source', () => {
    const report = skusAcrossShops(
      [listing('Panetti Norway', 'PZO-500'), listing('Panetti Sweden', 'PZO-500-SE')],
      new Map([
        ['PZO-500', 300],
        ['PZO-500-SE', 40],
      ]),
    )

    expect(report.sellingButNotSourced).toEqual([])
  })
})

describe('skuStem', () => {
  it('ignores punctuation and case, so PZO-500 and pzo500 are one stem', () => {
    expect(skuStem('PZO-500')).toBe(skuStem('pzo500'))
  })

  it('strips a country code off the end', () => {
    expect(skuStem('PZO-500-SE')).toBe('PZO500')
  })

  /**
   * Nobody has told us what their convention is, which is the whole reason this
   * report exists. If theirs is a prefix and we only ever looked at the end, the
   * report would come back clean while every product had five codes.
   */
  it('strips a country code off the front too', () => {
    expect(skuStem('SE-PZO-500')).toBe('PZO500')
  })

  /**
   * Real SKUs end in real letters. Stripping down to almost nothing pools
   * unrelated products into one stem, and a false family is worse than none -
   * it is the report inventing the very pattern it was asked to look for.
   */
  it('keeps the code when stripping it would leave almost nothing', () => {
    expect(skuStem('X-SE')).toBe('XSE')
  })
})

describe('skusAcrossShops, near-duplicate SKUs', () => {
  /**
   * The pairing that makes the report actionable: not just "Sweden has its own
   * codes" but "this Swedish code is that Norwegian product". `sourced` says
   * which one of the family the forecast is keeping.
   */
  it('groups SKUs that look like one product across shops', () => {
    const report = skusAcrossShops(
      [
        listing('Panetti Norway', 'PZO-500', { source: true }),
        listing('Panetti Sweden', 'PZO500SE'),
      ],
      new Map([
        ['PZO-500', 300],
        ['PZO500SE', 40],
      ]),
    )

    expect(report.clusters).toEqual([
      {
        stem: 'PZO500',
        variants: [
          { sku: 'PZO-500', shops: ['Panetti Norway'], recentUnits: 300, sourced: true, noSkuInWoo: false },
          { sku: 'PZO500SE', shops: ['Panetti Sweden'], recentUnits: 40, sourced: false, noSkuInWoo: false },
        ],
      },
    ])
  })

  /**
   * A stem with one SKU is just a SKU. Listing those would bury the handful of
   * real families under every product in the catalogue.
   */
  it('says nothing about a product that has only one code', () => {
    const report = skusAcrossShops(
      [
        listing('Panetti Norway', 'PZO-500', { source: true }),
        listing('Panetti Sweden', 'PZO-500'),
      ],
      NO_SALES,
    )

    expect(report.clusters).toEqual([])
  })
})

describe('unitsBySku', () => {
  it('adds up the units each SKU sold, whatever case the shop typed it in', () => {
    const units = unitsBySku([
      { sku: 'PZO-500', quantity: 2, order: { status: 'completed' } },
      { sku: 'pzo-500', quantity: 3, order: { status: 'processing' } },
    ])

    expect(units.get('PZO-500')).toBe(5)
  })

  /**
   * The same re-check the forecast makes, and for the same reason: Woo statuses
   * are stored exactly as the store sent them, custom plugin statuses included,
   * so a SQL `notIn` is case-sensitive and lets `Refunded` through. A cancelled
   * order counted here would invent demand the shops never had.
   */
  it('ignores a voided order however the store cased its status', () => {
    const units = unitsBySku([
      { sku: 'PZO-500', quantity: 2, order: { status: 'Cancelled' } },
      { sku: 'PZO-500', quantity: 3, order: { status: 'REFUNDED' } },
    ])

    expect(units.has('PZO-500')).toBe(false)
  })

  it('ignores a line whose SKU cannot identify a product', () => {
    expect(unitsBySku([{ sku: '0', quantity: 9, order: { status: 'completed' } }]).size).toBe(0)
  })
})

describe('listingsFrom', () => {
  /**
   * `isSource` is the field the whole blind-spot half of the report rests on.
   * Mapped from the wrong column it would read as "no shop is a source", the
   * report would say nothing is being missed, and it would be believed.
   */
  it('carries each shop’s source and active flags onto its listings', () => {
    expect(
      listingsFrom([
        {
          sku: 'PZO-500',
          externalId: '9454',
          name: 'Pizza Oven',
          shop: { name: 'Panetti Norway', stockSource: true, active: true },
        },
        {
          sku: 'PZO-500-SE',
          externalId: '9455',
          name: 'Pizzaugn',
          shop: { name: 'Panetti Sweden', stockSource: false, active: false },
        },
      ]),
    ).toEqual([
      {
        sku: 'PZO-500',
        name: 'Pizza Oven',
        shopName: 'Panetti Norway',
        isSource: true,
        isActive: true,
        noSkuInWoo: false,
      },
      {
        sku: 'PZO-500-SE',
        name: 'Pizzaugn',
        shopName: 'Panetti Sweden',
        isSource: false,
        isActive: false,
        noSkuInWoo: false,
      },
    ])
  })
})

describe('SKUs that are really Woo product ids', () => {
  /**
   * `map.ts` stores `li.sku || String(li.product_id)`, so a listing with no SKU
   * arrives carrying its Woo product id as one. Those ids are per-store
   * sequential, so such a "SKU" can never match another shop's and the product
   * can never be forecast - but it looks like an ordinary code, and the report
   * would otherwise send someone hunting for a product that is really a blank
   * field in the webshop.
   */
  it('marks a listing whose SKU is just its Woo product id', () => {
    const [withSku, without] = listingsFrom([
      {
        sku: 'PZO-500',
        externalId: '9454',
        name: 'Pizza Oven',
        shop: { name: 'Panetti Norway', stockSource: true, active: true },
      },
      {
        sku: '9454',
        externalId: '9454',
        name: 'Pizzaovn',
        shop: { name: 'Panetti Denmark', stockSource: false, active: true },
      },
    ])

    expect(withSku.noSkuInWoo).toBe(false)
    expect(without.noSkuInWoo).toBe(true)
  })

  it('says so on the blind spot, so the fix reads as "give it a SKU"', () => {
    const report = skusAcrossShops(
      [
        { shopName: 'Panetti Norway', sku: 'PZO-500', name: 'Oven', isSource: true, isActive: true, noSkuInWoo: false },
        { shopName: 'Panetti Denmark', sku: '9454', name: 'Ovn', isSource: false, isActive: true, noSkuInWoo: true },
        { shopName: 'Panetti Sweden', sku: 'PC-AF-BOWL', name: 'Bowl', isSource: false, isActive: true, noSkuInWoo: false },
      ],
      new Map([
        ['9454', 17],
        ['PC-AF-BOWL', 1],
      ]),
    )

    expect(report.sellingButNotSourced).toEqual([
      { sku: '9454', shops: ['Panetti Denmark'], recentUnits: 17, noSkuInWoo: true },
      { sku: 'PC-AF-BOWL', shops: ['Panetti Sweden'], recentUnits: 1, noSkuInWoo: false },
    ])
  })
})
