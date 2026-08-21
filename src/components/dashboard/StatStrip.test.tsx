// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatStrip } from './StatStrip'
import { ZERO_FIGURES, type Figures } from '@/lib/metrics/types'

/**
 * The figures from the client's own screenshot, to the øre — the run where
 * "NOK 1,006,370.25" was wide enough at 32px to leave the Net Profit card and
 * paint over the Net Revenue figure beside it.
 */
const total: Figures = {
  ...ZERO_FIGURES,
  orders: 801,
  netProfit: 100637025, // 1,006,370.25
  netRevenue: 370913717, // 3,709,137.17
  avgOrderValue: 463063, // 4,630.63 — rounds UP, which is the point
  ambassadorSales: 22319711, // 223,197.11
  netMargin: 0.271,
}

const previous: Figures = {
  ...ZERO_FIGURES,
  orders: 794,
  netProfit: 103217000,
  netRevenue: 352580000,
  avgOrderValue: 443800,
  ambassadorSales: 20180000,
}

const strip = () =>
  render(<StatStrip total={total} previous={previous} currency="NOK" hint="previous 20 days" />)

describe('StatStrip', () => {
  /**
   * Øre are real everywhere else in this app, because an order total or a
   * carrier invoice line has to reconcile to the øre against somebody else's
   * books. These do not: they are period sums consolidated from four
   * currencies at each order's own rate, so the last two digits are arithmetic
   * rather than money anyone can look up — and they cost the hero figure the
   * three characters that made it overflow its card.
   */
  it('shows the hero profit to the krone, not the øre', () => {
    strip()
    const hero = screen.getByTestId('stat-net-profit')
    expect(hero.textContent).toContain('1,006,370')
    expect(hero.textContent).not.toContain('.25')
  })

  // All of them, not just the hero. One figure without øre beside three with
  // them reads as a bug in the row rather than a decision about it.
  it('drops the øre on every money figure in the row', () => {
    strip()
    for (const [id, whole, dropped] of [
      ['stat-net-revenue', '3,709,137', '.17'],
      ['stat-ambassador-sales', '223,197', '.11'],
    ] as const) {
      expect(screen.getByTestId(id).textContent).toContain(whole)
      expect(screen.getByTestId(id).textContent).not.toContain(dropped)
    }
  })

  // Rounds, never truncates. Truncating would make every figure on the strip
  // quietly smaller than the truth.
  it('rounds a figure up rather than cutting its øre off', () => {
    strip()
    expect(screen.getByTestId('stat-avg-order-value').textContent).toContain('4,631')
  })

  // Orders is a count, not money. It was never formatted by formatMoney and
  // must not start being: "801" is exact and has no minor units to drop.
  it('leaves the order count alone', () => {
    strip()
    expect(screen.getByTestId('stat-orders').textContent).toBe('801')
  })

  // The margin is a percentage, and its one decimal is the difference between
  // 27.1% and 27%. Dropping decimals from money must not reach it.
  it('keeps the one decimal on the margin', () => {
    strip()
    expect(screen.getByText(/27\.1% margin/)).toBeTruthy()
  })
})
