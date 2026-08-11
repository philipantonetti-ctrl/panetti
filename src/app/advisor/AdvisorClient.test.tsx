// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { Fact } from '@/lib/advisor/types'
import { AdvisorClient, type Briefing } from './AdvisorClient'

const fact = {
  id: 'revenue:shop_se',
  kind: 'REVENUE_MOVE' as const,
  shopId: 'shop_se',
  shopName: 'Panetti Sweden',
  subject: null,
  current: 820_000,
  previous: 1_000_000,
  deltaPct: -0.18,
  unit: 'money' as const,
  severity: 0.4,
  currency: 'USD',
}

const briefing = (over: Partial<Briefing> = {}): Briefing => ({
  day: '2026-08-10',
  from: '2026-08-03',
  to: '2026-08-09',
  facts: [fact],
  items: [
    {
      headline: 'Sweden revenue fell',
      why: 'It fell in step with advertising efficiency.',
      factIds: ['revenue:shop_se'],
      severity: 'high',
      action: 'Check the Meta campaign that changed.',
    },
  ],
  error: null,
  model: 'claude-opus-5',
  ...over,
})

describe('AdvisorClient', () => {
  it('shows the headline and the explanation', () => {
    render(<AdvisorClient initial={briefing()} />)
    expect(screen.getByText('Sweden revenue fell')).toBeInTheDocument()
    expect(screen.getByText(/in step with advertising efficiency/)).toBeInTheDocument()
  })

  it('prints the figure from the fact, not from the prose', () => {
    render(<AdvisorClient initial={briefing()} />)
    // -18% is derived from Fact.deltaPct. No item text contains it.
    expect(screen.getByText(/−18(\.0)?%/)).toBeInTheDocument()
  })

  it('labels severity in words, never by colour alone', () => {
    render(<AdvisorClient initial={briefing()} />)
    expect(screen.getByText(/high/i)).toBeInTheDocument()
  })

  it('shows the action only when there is one', () => {
    render(<AdvisorClient initial={briefing({ items: [{ ...briefing().items![0], action: null }] })} />)
    expect(screen.queryByText(/Check the Meta campaign/)).not.toBeInTheDocument()
  })

  it('shows the facts anyway when generation failed', () => {
    render(<AdvisorClient initial={briefing({ items: null, error: '529 overloaded' })} />)
    expect(screen.getByText(/529 overloaded/)).toBeInTheDocument()
    expect(screen.getByText(/Panetti Sweden/)).toBeInTheDocument()
  })

  it('teaches the next action when nothing has been written yet', () => {
    render(<AdvisorClient initial={null} />)
    expect(screen.getByText(/No briefing yet/i)).toBeInTheDocument()
  })

  it('says plainly that a quiet week is a quiet week', () => {
    render(<AdvisorClient initial={briefing({ items: [], facts: [] })} />)
    expect(screen.getByText(/Nothing needs your attention/i)).toBeInTheDocument()
  })

  it('prints the right magnitude for a money fact with no currency', () => {
    // ambassadorFacts once produced exactly this shape: unit 'money' with no
    // currency key at all. previous/100 = 1,000 and current/100 = 1,500 — the
    // bug rendered these as the raw minor units, 100,000 and 150,000.
    const noCurrency: Fact = {
      id: 'ambassador:amb_1',
      kind: 'AMBASSADOR_MOVE',
      shopId: null,
      shopName: null,
      subject: 'Emma',
      current: 150_000,
      previous: 100_000,
      deltaPct: 0.5,
      unit: 'money',
      severity: 0.6,
    }
    render(<AdvisorClient initial={briefing({ items: null, facts: [noCurrency] })} />)
    expect(screen.getByText(/1,500/)).toBeInTheDocument()
    expect(screen.queryByText(/150,000/)).not.toBeInTheDocument()
  })
})
