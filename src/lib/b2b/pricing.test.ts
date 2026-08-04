import { describe, it, expect } from 'vitest'
import { lineTotals, orderTotals, type B2bLine } from './pricing'

const line = (over: Partial<B2bLine> = {}): B2bLine => ({
  quantity: 1,
  unitPrice: 10000, // 100.00
  discountValue: 0,
  discountKind: 'PERCENT',
  ...over,
})

describe('lineTotals', () => {
  it('takes a percentage off the whole line', () => {
    // 10 x 89.00 = 890.00, less 10% = 801.00
    const t = lineTotals(line({ quantity: 10, unitPrice: 8900, discountValue: 10 }))
    expect(t).toEqual({ gross: 89000, discount: 8900, net: 80100 })
  })

  it('takes a fixed amount off EACH UNIT, not off the line', () => {
    // 4 x 245.00 = 980.00, less 20.00 per chair = 900.00
    const t = lineTotals(
      line({ quantity: 4, unitPrice: 24500, discountValue: 2000, discountKind: 'AMOUNT' }),
    )
    expect(t).toEqual({ gross: 98000, discount: 8000, net: 90000 })
  })

  it('charges the full price when there is no discount', () => {
    expect(lineTotals(line({ quantity: 3 }))).toEqual({ gross: 30000, discount: 0, net: 30000 })
  })

  it('rounds a percentage half away from zero, like every other figure', () => {
    // 3 x 33.33 = 99.99; 10% of that is 9.999 -> 10.00
    const t = lineTotals(line({ quantity: 3, unitPrice: 3333, discountValue: 10 }))
    expect(t.discount).toBe(1000)
    expect(t.net).toBe(8999)
  })

  it('never discounts more than the line is worth', () => {
    // A discount cannot invent revenue: net floors at zero, never goes negative.
    const percent = lineTotals(line({ quantity: 2, discountValue: 150 }))
    expect(percent).toEqual({ gross: 20000, discount: 20000, net: 0 })

    const amount = lineTotals(
      line({ quantity: 2, discountValue: 99999, discountKind: 'AMOUNT' }),
    )
    expect(amount).toEqual({ gross: 20000, discount: 20000, net: 0 })
  })

  it('ignores a negative discount rather than adding to the price', () => {
    expect(lineTotals(line({ discountValue: -50 })).discount).toBe(0)
  })
})

describe('orderTotals', () => {
  const lines: B2bLine[] = [
    { quantity: 10, unitPrice: 8900, discountValue: 10, discountKind: 'PERCENT' },
    { quantity: 4, unitPrice: 24500, discountValue: 2000, discountKind: 'AMOUNT' },
  ]

  it('adds the lines up the way the engine defines net sales', () => {
    const t = orderTotals(lines, 0, 0)
    expect(t.grossSales).toBe(187000) // 890.00 + 980.00
    expect(t.discountTotal).toBe(16900) // 89.00 + 80.00
    expect(t.netSales).toBe(170100)
  })

  it('charges VAT on the goods AND the shipping', () => {
    // net 1701.00 + shipping 50.00 = 1751.00; 25% = 437.75
    const t = orderTotals(lines, 5000, 25)
    expect(t.shippingCharged).toBe(5000)
    expect(t.taxTotal).toBe(43775)
    expect(t.total).toBe(218875) // 175100 + 43775
  })

  it('records no VAT for a reverse-charge or export customer', () => {
    const t = orderTotals(lines, 5000, 0)
    expect(t.taxTotal).toBe(0)
    expect(t.total).toBe(175100) // exactly net sales plus shipping
  })

  it('is all zeros for an empty order', () => {
    expect(orderTotals([], 0, 25)).toEqual({
      grossSales: 0, discountTotal: 0, netSales: 0,
      shippingCharged: 0, taxTotal: 0, total: 0,
    })
  })
})
