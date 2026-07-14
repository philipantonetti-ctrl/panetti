import { describe, it, expect } from 'vitest'
import { CATEGORY_GROUPS, CATEGORIES } from './expense-categories'

/**
 * The category taxonomy must match the one the business already uses in BeProfit,
 * so an expense categorised there means the same thing here.
 *
 * Groups, in order: Overhead, Financing, Marketing, Operations, Fulfillment,
 * Other, Transaction fees.
 */
describe('expense categories', () => {
  it('groups the categories in the same order as BeProfit', () => {
    expect(CATEGORY_GROUPS.map((g) => g.group)).toEqual([
      'Overhead',
      'Financing',
      'Marketing',
      'Operations',
      'Fulfillment',
      'Other',
      'Transaction fees',
    ])
  })

  it('has the Overhead options', () => {
    const overhead = CATEGORY_GROUPS.find((g) => g.group === 'Overhead')!
    expect(overhead.options).toEqual(['Office', 'Employees', 'Subscriptions', 'Equipment'])
  })

  it('has Financing, which the old list was missing', () => {
    const financing = CATEGORY_GROUPS.find((g) => g.group === 'Financing')!
    expect(financing.options).toEqual(['Financing'])
  })

  it('has the Marketing options, including Custom Ad Spend', () => {
    const marketing = CATEGORY_GROUPS.find((g) => g.group === 'Marketing')!
    expect(marketing.options).toEqual([
      'Custom Ad Spend',
      'Digital Marketing',
      'Design',
      'Website Expenses',
      'Content',
    ])
  })

  it('has the Operations options', () => {
    const operations = CATEGORY_GROUPS.find((g) => g.group === 'Operations')!
    expect(operations.options).toEqual(['COGS', 'Product Samples', 'Importing Fees'])
  })

  it('has the Fulfillment options, including Materials', () => {
    const fulfillment = CATEGORY_GROUPS.find((g) => g.group === 'Fulfillment')!
    expect(fulfillment.options).toEqual(['Fulfillment', 'Warehouse', 'Materials', 'Handling'])
  })

  it('has Other and Transaction fees', () => {
    expect(CATEGORY_GROUPS.find((g) => g.group === 'Other')!.options).toEqual(['Other'])
    expect(CATEGORY_GROUPS.find((g) => g.group === 'Transaction fees')!.options).toEqual([
      'Transaction Fees',
    ])
  })

  it('flattens to "Group > Option" strings, which is how a category is stored', () => {
    expect(CATEGORIES).toContain('Overhead > Office')
    expect(CATEGORIES).toContain('Financing > Financing')
    expect(CATEGORIES).toContain('Marketing > Custom Ad Spend')
    expect(CATEGORIES).toContain('Fulfillment > Materials')
    expect(CATEGORIES).toContain('Transaction fees > Transaction Fees')
  })

  it('covers every option exactly once — no duplicates, nothing dropped', () => {
    const expected = CATEGORY_GROUPS.reduce((n, g) => n + g.options.length, 0)
    expect(CATEGORIES).toHaveLength(expected)
    expect(new Set(CATEGORIES).size).toBe(expected)
  })

  it('keeps the categories the seeded expenses already use, so nothing orphans', () => {
    // The seed created expenses under these — they must still exist.
    expect(CATEGORIES).toContain('Fulfillment > Warehouse')
    expect(CATEGORIES).toContain('Overhead > Subscriptions')
    expect(CATEGORIES).toContain('Overhead > Employees')
    expect(CATEGORIES).toContain('Overhead > Office')
  })
})
