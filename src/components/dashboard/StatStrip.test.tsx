// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { StatStrip, type Comparison } from './StatStrip'
import { ZERO_FIGURES, type Figures } from '@/lib/metrics/types'

/**
 * The figures from the client's own screenshot, to the øre - the run where
 * "NOK 1,006,370.25" was wide enough at 32px to leave the Net Profit card and
 * paint over the Net Revenue figure beside it.
 */
const total: Figures = {
  ...ZERO_FIGURES,
  orders: 801,
  netProfit: 100637025, // 1,006,370.25
  netRevenue: 370913717, // 3,709,137.17
  avgOrderValue: 463063, // 4,630.63 - rounds UP, which is the point
  ambassadorSales: 22319711, // 223,197.11
  affiliate: 1988019, // 19,880.19 - the real 30-day figure the day this shipped
  netMargin: 0.271,
}

const previous: Comparison = {
  label: 'vs 20 days before',
  dates: '2026-07-12 → 2026-07-31',
  missing: 'No prior data',
  figures: {
    ...ZERO_FIGURES,
    orders: 794,
    netProfit: 103217000,
    netRevenue: 352580000,
    avgOrderValue: 443800,
    ambassadorSales: 20180000,
    affiliate: 2100000, // higher than today: the cost FELL against the period before
  },
}

/**
 * The same 20 days one year earlier, as the production database actually has
 * them (1-21 Aug 2025, read 2026-08-22): 622 orders, 2,798,360.67 net.
 */
const lastYear: Comparison = {
  label: 'vs last year',
  dates: '2025-08-01 → 2025-08-20',
  missing: 'No data last year',
  figures: {
    ...ZERO_FIGURES,
    orders: 622,
    netProfit: 42968191,
    netRevenue: 279836067,
    avgOrderValue: 449897,
    ambassadorSales: 5134879,
    affiliate: 350000, // the program was weeks old: the cost ROSE hard year on year
  },
}

const strip = (over: Partial<Parameters<typeof StatStrip>[0]> = {}) =>
  render(
    <StatStrip total={total} previous={previous} lastYear={lastYear} currency="NOK" {...over} />,
  )

describe('StatStrip', () => {
  /**
   * Øre are real everywhere else in this app, because an order total or a
   * carrier invoice line has to reconcile to the øre against somebody else's
   * books. These do not: they are period sums consolidated from four
   * currencies at each order's own rate, so the last two digits are arithmetic
   * rather than money anyone can look up - and they cost the hero figure the
   * three characters that made it overflow its card.
   */
  it('shows the hero profit to the krone, not the øre', () => {
    strip()
    const hero = screen.getByTestId('stat-net-profit')
    expect(hero.textContent).toContain('1,006,370')
    expect(hero.textContent).not.toContain('.25')
  })

  /**
   * The hero, and only the hero.
   *
   * It was briefly all four. The client looked at it and asked for the other
   * four tiles back, which is his call to make: he reads these beside BeProfit,
   * and a figure that has quietly moved by up to a krone is worse for that than
   * an inconsistent row. Only the hero is set at 32px, and only the hero was
   * running out of its card, so only the hero needed the three characters.
   *
   * Pinned rather than left implicit, because "drop the decimals" is exactly
   * the change that spreads along a row on its own.
   */
  it('keeps the øre on the four figures beside it', () => {
    strip()
    for (const [id, exact] of [
      ['stat-net-revenue', '3,709,137.17'],
      ['stat-avg-order-value', '4,630.63'],
      ['stat-ambassador-sales', '223,197.11'],
      ['stat-affiliate-cost', '19,880.19'],
    ] as const) {
      expect(screen.getByTestId(id).textContent).toContain(exact)
    }
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

  /**
   * The client's ask, in his words: "show the increase and decrease in %
   * compared to last year also, so YoY (same period last year). Because now
   * it only shows compared to last month." Two lines under every figure, each
   * saying what it is measured against - an unlabelled second percentage
   * would be two arrows nobody can tell apart.
   */
  it('reads every figure against the period before AND the same dates last year', () => {
    strip()
    expect(screen.getAllByText('vs 20 days before')).toHaveLength(6)
    expect(screen.getAllByText('vs last year')).toHaveLength(6)
  })

  it('says how far each figure moved against last year', () => {
    strip()
    const yoy = screen.getAllByTitle('vs last year: 2025-08-01 → 2025-08-20').map((el) => el.textContent)
    // 3,709,137.17 against 2,798,360.67; 801 orders against 622; profit 1,006,370.25 against 429,681.91.
    expect(yoy.some((t) => t?.includes('+32.5%'))).toBe(true)
    expect(yoy.some((t) => t?.includes('+28.8%'))).toBe(true)
    expect(yoy.some((t) => t?.includes('+134.2%'))).toBe(true)
  })

  it('keeps the period-before figure it always had, labelled now', () => {
    strip()
    const before = screen.getAllByTitle('vs 20 days before: 2026-07-12 → 2026-07-31').map((el) => el.textContent)
    // 801 orders against 794.
    expect(before.some((t) => t?.includes('+0.9%'))).toBe(true)
  })

  /** A shop that opened this year has no last year. Say so; never print a NaN or a dash. */
  it('says when there is nothing last year to compare with', () => {
    strip({ lastYear: { ...lastYear, figures: ZERO_FIGURES } })
    expect(screen.getAllByText('No data last year')).toHaveLength(6)
    expect(screen.queryByText(/NaN/)).toBeNull()
  })

  /**
   * The client's instruction, verbatim: the affiliate commission "added to our
   * dashboard and show as a cost". A cost's arrows point the other way from
   * revenue's: RISING is the bad direction. Painting a +468% cost increase in
   * gain-green would read as good news, so the colours invert while the arrow
   * and percentage keep telling the plain truth.
   */
  it('paints a rising affiliate cost as a loss and a falling one as a gain', () => {
    strip()
    const cell = screen.getByTestId('stat-affiliate-cost').parentElement!

    // Against the period before, the cost FELL 5.3% - good news, green.
    const before = within(cell).getByTitle('vs 20 days before: 2026-07-12 → 2026-07-31')
    expect(before.textContent).toContain('5.3%')
    expect(before.className).toContain('text-gain')

    // Against last year it ROSE 468% - real money out, red.
    const yoy = within(cell).getByTitle('vs last year: 2025-08-01 → 2025-08-20')
    expect(yoy.textContent).toContain('468.0%')
    expect(yoy.className).toContain('text-loss')
  })
})
