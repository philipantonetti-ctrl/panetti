import { describe, it, expect } from 'vitest'
import { EXCLUDED_STATUSES } from '@/lib/metrics/types'
import { orderVerdict, statusLabel } from './code-check'

describe('orderVerdict', () => {
  it('counts a paid order', () => {
    for (const s of ['processing', 'completed', 'shipping']) {
      expect(orderVerdict(s)).toEqual({ counts: true, reason: null })
    }
  })

  it('gives every status the figures leave out a plain reason', () => {
    // The same list the sales and commission figures use, so this page can
    // never call an order "counted" that the figures dropped, or the reverse.
    for (const s of EXCLUDED_STATUSES) {
      const v = orderVerdict(s)
      expect(v.counts).toBe(false)
      expect(v.reason).toBeTruthy()
    }
  })

  it('names the reasons in words an ambassador understands', () => {
    expect(orderVerdict('cancelled').reason).toBe('Cancelled')
    expect(orderVerdict('refunded').reason).toBe('Refunded')
    expect(orderVerdict('failed').reason).toBe('Payment failed')
    expect(orderVerdict('pending').reason).toBe('Not paid')
    expect(orderVerdict('on-hold').reason).toBe('Waiting for payment')
    expect(orderVerdict('trash').reason).toBe('Deleted in the shop')
  })

  it('reads the status case-insensitively', () => {
    expect(orderVerdict('Cancelled').counts).toBe(false)
  })
})

describe('statusLabel', () => {
  it('turns a shop status into a label', () => {
    expect(statusLabel('completed')).toBe('Completed')
    expect(statusLabel('on-hold')).toBe('On hold')
    expect(statusLabel('pending')).toBe('Pending payment')
    expect(statusLabel('trash')).toBe('Deleted')
    expect(statusLabel('shipping')).toBe('Shipping')
  })
})
