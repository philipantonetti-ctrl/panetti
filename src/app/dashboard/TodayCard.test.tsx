// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TodayCard } from './TodayCard'
import { TASK_LIMIT, type TaskCard } from '@/lib/operations/today'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

const row = (n: number) => ({
  key: `k${n}`,
  label: `2861${n}`,
  sub: 'Dag-Eivind Nicolaisen',
  detail: `${n} days over`,
  href: `/orders?q=2861${n}`,
})

const card = (over: Partial<TaskCard> = {}): TaskCard => ({
  total: 3,
  rows: [row(1), row(2), row(3)],
  ...over,
})

const draw = (c: TaskCard) =>
  render(<TodayCard title="Parcels late" card={c} clear="Every parcel is on time." seeAllHref="/delivery" />)

describe('a card on the operations manager\'s first page', () => {
  it('leads with the count and lists the rows', () => {
    draw(card())

    expect(screen.getByText('Parcels late')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('28611')).toBeInTheDocument()
    expect(screen.getByText('1 days over')).toBeInTheDocument()
  })

  it('sends each row to the thing it is about', () => {
    draw(card())
    expect(screen.getByRole('link', { name: /28611/ }).getAttribute('href')).toBe('/orders?q=28611')
  })

  /**
   * An empty box reads as "this is broken". Nothing to do is a real answer and
   * the card says it in words.
   */
  it('says so in words when there is nothing to do', () => {
    draw(card({ total: 0, rows: [] }))

    expect(screen.getByText('Every parcel is on time.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /see all/i })).toBeNull()
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  /** Only worth offering when there is more than what is already on screen. */
  it('offers "see all" only when rows are being held back', () => {
    const { unmount } = draw(card())
    expect(screen.queryByRole('link', { name: /see all/i })).toBeNull()
    unmount()

    const many = Array.from({ length: TASK_LIMIT }, (_, i) => row(i))
    draw(card({ total: TASK_LIMIT + 7, rows: many }))
    const seeAll = screen.getByRole('link', { name: /see all/i })
    expect(seeAll).toHaveTextContent(`see all ${TASK_LIMIT + 7}`)
    expect(seeAll.getAttribute('href')).toBe('/delivery')
  })

  /**
   * A long product name ran under the red detail on the right ("Mazzetti
   * Advanced Comfort - Massasjestol" over "105 days late"): `truncate` on an
   * inline span does nothing. The name must be a shrinkable flex item that
   * cuts itself off, with the whole name kept in a tooltip.
   */
  it('cuts a long name off before the detail instead of running under it', () => {
    const long = 'Mazzetti Advanced Comfort - Massasjestol med varme og zero gravity'
    draw(card({ total: 1, rows: [{ ...row(1), label: 'MACBE661', sub: long, detail: 'ordered from Belgo, 105 days late' }] }))

    const sub = screen.getByText(long)
    expect(sub).toHaveClass('truncate', 'min-w-0', 'max-w-full')
    expect(sub).toHaveAttribute('title', long)
    // Its holder is a wrapping flex row that may shrink: a sub that does not
    // fit beside the label drops to its own line and cuts itself off there.
    expect(sub.parentElement).toHaveClass('flex', 'flex-wrap', 'min-w-0')
  })

  /**
   * The first fix pinned the label to its full width (shrink-0), so a long
   * customer name - "VELFERDSKLUBBEN SIBELCO NORDIC AVD. STJERNØY" on Overdue
   * invoices - ran under "29 days overdue" instead. A label must wrap.
   */
  it('wraps a long label instead of pinning it to full width', () => {
    const club = 'VELFERDSKLUBBEN SIBELCO NORDIC AVD. STJERNØY'
    draw(card({ total: 1, rows: [{ ...row(1), label: club, sub: '131042', detail: '29 days overdue' }] }))

    const label = screen.getByText(club)
    expect(label).not.toHaveClass('shrink-0')
    expect(label).toHaveClass('max-w-full')
  })

  it('shows an amount beside the row when one is carried', () => {
    draw(
      card({
        total: 1,
        rows: [
          {
            key: 'INV-1',
            label: 'Verkkokauppa.com',
            sub: 'INV-1',
            detail: '34 days overdue',
            href: '/finance',
            amount: { minor: 250000, currency: 'EUR' },
          },
        ],
      }),
    )

    expect(screen.getByText('2 500.00 EUR')).toBeInTheDocument()
  })
})
