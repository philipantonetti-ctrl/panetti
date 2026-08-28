import { describe, expect, it } from 'vitest'
import { pageContext } from './page-context'

describe('pageContext', () => {
  it('names the page in a sentence the model can act on', () => {
    expect(pageContext('/inventory')).toBe(
      'The user is looking at Inventory and forecasting: stock, run-out dates and what to order.',
    )
  })

  it('covers a sub-page by its section', () => {
    expect(pageContext('/inventory/purchase-orders')).toMatch(/Inventory and forecasting/)
    expect(pageContext('/b2b/abc123')).toMatch(/B2B/)
  })

  /**
   * Silence beats invention: handed a path it does not know, the model would
   * otherwise be told the name of a screen nobody described to it.
   */
  it('says nothing about a page it does not know, and nothing about nothing', () => {
    expect(pageContext('/settings/delivery')).toBeNull()
    expect(pageContext('/')).toBeNull()
    expect(pageContext(null)).toBeNull()
    expect(pageContext(undefined)).toBeNull()
  })

  it('does not mistake a longer word for a section', () => {
    expect(pageContext('/orders-export')).toBeNull()
  })
})
