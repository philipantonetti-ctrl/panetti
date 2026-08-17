// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

const quality = (kind: Fact['kind'], subject: string | null = null): Fact => ({
  id: `${kind}:shop_no`,
  kind,
  shopId: 'shop_no',
  shopName: 'Panetti Norway',
  subject,
  current: 1,
  previous: null,
  deltaPct: null,
  unit: 'count',
  severity: 1,
})

const briefing = (over: Partial<Briefing> = {}): Briefing => ({
  day: '2026-08-10',
  writtenAt: '2026-08-10T05:00:00.000Z',
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

  /**
   * A failed briefing used to lead with the error text itself, which for an API
   * failure is a line of status codes and an id. That answers "what broke" for
   * a developer and nothing at all for the person the page is written for.
   */
  it('leads with what to do, not with the failure', () => {
    render(
      <AdvisorClient
        initial={briefing({
          items: null,
          error: '400 invalid_request_error (req_011Ce7jTJaTjz33YEBYvR3VY): Invalid request data',
        })}
      />,
    )
    expect(screen.getByText(/Press Refresh/i)).toBeInTheDocument()
    expect(screen.getByText(/still computed from your own figures/i)).toBeInTheDocument()
  })

  /**
   * Kept, but moved out of the sentence and into its own line: it is the only
   * thing that lets a failure be quoted to somebody who can trace it.
   */
  it('keeps the technical detail in its own place, so it can be reported', () => {
    render(
      <AdvisorClient
        initial={briefing({
          items: null,
          error: '400 invalid_request_error (req_011Ce7jTJaTjz33YEBYvR3VY): Invalid request data',
        })}
      />,
    )
    const detail = screen.getByTestId('briefing-error-detail')
    expect(detail.textContent).toMatch(/req_011Ce7jTJaTjz33YEBYvR3VY/)
    expect(screen.getByText(/Press Refresh/i).textContent).not.toMatch(/req_011/)
  })

  /**
   * Refreshing cannot conjure an environment variable, so offering it as the
   * remedy would send someone round a loop that cannot end.
   */
  it('does not offer Refresh as the cure for a missing key', () => {
    render(
      <AdvisorClient
        initial={briefing({ items: null, error: 'No ANTHROPIC_API_KEY is configured, so no briefing could be written.' })}
      />,
    )
    expect(screen.getByText(/has not been given its API key/i)).toBeInTheDocument()
    expect(screen.queryByText(/Press Refresh/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('briefing-error-detail')).not.toBeInTheDocument()
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

  it('shows the facts, not a false all-clear, when the model’s items were all dropped', () => {
    // generateBrief returns items: [] both for a quiet week and for a week
    // where validateItems dropped every item the model returned. facts is
    // non-empty here, so this is the second case, and the facts must render
    // instead of the "nothing needs your attention" message that contradicts them.
    render(<AdvisorClient initial={briefing({ items: [] })} />)
    expect(screen.queryByText(/Nothing needs your attention/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Panetti Sweden/)).toBeInTheDocument()
  })

  it('labels cited facts by kind, so two facts for one shop read differently', () => {
    const roas: Fact = {
      id: 'roas:shop_se',
      kind: 'ROAS_MOVE',
      shopId: 'shop_se',
      shopName: 'Panetti Sweden',
      subject: null,
      current: 1.8,
      previous: 2.4,
      deltaPct: -0.25,
      unit: 'ratio',
      severity: 0.5,
    }
    render(
      <AdvisorClient
        initial={briefing({
          facts: [fact, roas],
          items: [{ ...briefing().items![0], factIds: ['revenue:shop_se', 'roas:shop_se'] }],
        })}
      />,
    )
    expect(screen.getByText(/Revenue · Panetti Sweden/)).toBeInTheDocument()
    expect(screen.getByText(/ROAS · Panetti Sweden/)).toBeInTheDocument()
  })

  describe('a failed refresh', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('explains a non-ok response instead of just re-enabling the button', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Could not write the briefing' }) }),
      )
      render(<AdvisorClient initial={briefing()} />)
      fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
      await waitFor(() => expect(screen.getByText(/Could not write the briefing/)).toBeInTheDocument())
    })

    it('explains a request that threw rather than resolved', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
      render(<AdvisorClient initial={briefing()} />)
      fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
      await waitFor(() => expect(screen.getByText(/Refresh failed/i)).toBeInTheDocument())
    })
  })

  describe('when the briefing was written', () => {
    it('says how old it is, so a stalled cron cannot pass for this morning', () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString()
      render(<AdvisorClient initial={briefing({ writtenAt: threeDaysAgo })} />)
      expect(screen.getByText(/3 days ago/i)).toBeInTheDocument()
    })

    it('says today when it was written today', () => {
      render(<AdvisorClient initial={briefing({ writtenAt: new Date().toISOString() })} />)
      expect(screen.getByText(/written today/i)).toBeInTheDocument()
    })
  })

  describe('acting on a trust warning', () => {
    it('links an uncosted-product warning to the page that fixes it', () => {
      render(
        <AdvisorClient initial={briefing({ items: [], facts: [quality('UNCOSTED_PRODUCTS')] })} />,
      )
      expect(screen.getByRole('link', { name: /enter the cost/i })).toHaveAttribute(
        'href',
        '/settings/costs',
      )
    })

    it('links a failing sync to the shops page', () => {
      render(
        <AdvisorClient
          initial={briefing({ items: [], facts: [quality('SHOP_SYNC_FAILING', '403')] })}
        />,
      )
      expect(screen.getByRole('link', { name: /check the connection/i })).toHaveAttribute(
        'href',
        '/settings/shops',
      )
    })

    it('offers no link for a missing rate, which no page of ours can fix', () => {
      // Rates arrive on their own from the provider. A link to somewhere that
      // cannot help is worse than no link.
      render(<AdvisorClient initial={briefing({ items: [], facts: [quality('MISSING_FX', 'SEK')] })} />)
      expect(screen.queryByRole('link')).not.toBeInTheDocument()
    })
  })
})
