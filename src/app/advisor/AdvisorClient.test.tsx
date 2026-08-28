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
   * The cards used to lay their facts out with flex-wrap, so six figures of
   * different label lengths sat beside each other and nothing lined up. The
   * Report section one scroll further down already solved this: label left,
   * before/after in the middle, the percentage in its own right-hand column.
   */
  describe('the figures on a card', () => {
    const move = (over: Partial<Fact> & { id: string }): Fact => ({
      kind: 'REVENUE_MOVE',
      shopId: 'shop_no',
      shopName: 'Mazzetti Norway',
      subject: null,
      current: 13_759_500,
      previous: 19_919_400,
      deltaPct: -0.309,
      unit: 'money',
      severity: 0.5,
      currency: 'NOK',
      ...over,
    })

    const card = (cited: Fact[]) =>
      briefing({
        facts: cited,
        items: [
          {
            headline: 'Mazzetti Norway fell',
            why: 'The best-selling chair halved.',
            factIds: cited.map((f) => f.id),
            severity: 'high',
            action: null,
          },
        ],
      })

    it('drops the shop name when the card is about one shop', () => {
      // The headline already says Mazzetti Norway. Repeating it on every line
      // makes the reader parse three segments to find the one word that differs.
      render(
        <AdvisorClient
          initial={card([move({ id: 'revenue:shop_no' }), move({ id: 'profit:shop_no', kind: 'PROFIT_MOVE' })])}
        />,
      )
      expect(screen.getByText('Revenue')).toBeInTheDocument()
      expect(screen.getByText('Profit')).toBeInTheDocument()
      expect(screen.queryByText(/Revenue · Mazzetti Norway/)).not.toBeInTheDocument()
    })

    it('keeps the shop name when the card compares several shops', () => {
      // Here the shop IS the thing that differs, so dropping it would leave two
      // identical labels against two different numbers.
      render(
        <AdvisorClient
          initial={card([
            move({ id: 'revenue:shop_no' }),
            move({ id: 'revenue:shop_se', shopId: 'shop_se', shopName: 'Panetti Sweden' }),
          ])}
        />,
      )
      expect(screen.getByText('Revenue · Mazzetti Norway')).toBeInTheDocument()
      expect(screen.getByText('Revenue · Panetti Sweden')).toBeInTheDocument()
    })

    /**
     * It used to be the last thing inside a long string, in brackets. It is the
     * single most important signal on the line.
     */
    it('gives the percentage its own place rather than burying it in brackets', () => {
      render(<AdvisorClient initial={card([move({ id: 'revenue:shop_no' })])} />)
      expect(screen.getByText('−30.9%')).toBeInTheDocument()
      expect(screen.queryByText(/\(−30\.9%\)/)).not.toBeInTheDocument()
    })

    it('signs a fall as well as colouring it', () => {
      render(<AdvisorClient initial={card([move({ id: 'revenue:shop_no' })])} />)
      // Red/green colour-blindness must never be the only thing between the
      // reader and a fall. U+2212, matching every other figure on the page.
      expect(screen.getByText('−30.9%').textContent).toMatch(/^−/)
    })

    it('reads the worst line first, however the facts arrived', () => {
      const { container } = render(
        <AdvisorClient
          initial={card([
            move({ id: 'margin:shop_no', kind: 'MARGIN_MOVE', severity: 0.2, deltaPct: -0.05 }),
            move({ id: 'profit:shop_no', kind: 'PROFIT_MOVE', severity: 0.9, deltaPct: -0.79 }),
          ])}
        />,
      )
      const text = container.textContent!
      expect(text.indexOf('Profit')).toBeLessThan(text.indexOf('Margin'))
    })
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
    // currency key at all. previous/100 = 1,000 and current/100 = 1,500 - the
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
    // By KIND is what this test is about: two figures for one shop must not
    // read alike. The shop itself is no longer repeated on each line - both
    // facts are Panetti Sweden's and the headline says so - which is covered by
    // "keeps the shop name when the card compares several shops" above.
    expect(screen.getByText('Revenue')).toBeInTheDocument()
    expect(screen.getByText('ROAS')).toBeInTheDocument()
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
      // Scoped past the section tabs, which are navigation rather than a
      // remedy this warning is offering.
      const links = screen.queryAllByRole('link').filter((a) => !a.closest('nav'))
      expect(links).toEqual([])
    })
  })

  /**
   * Live on 2026-08-20 a client read this off his own dashboard:
   *
   *   Sync failing · Mazzetti Norway · WooCommerce responded 500: <!DOCTYPE html>
   *
   * Two failures met on that line. The trust band - the only thing that states
   * these in words and links to the page that fixes them - lived inside
   * Report, which renders ONLY when the model wrote no items, so on any normal
   * day it was absent. And a quality fact the model happened to cite fell
   * through to FactLine, which prints fact.subject verbatim beside two empty
   * columns, because a broken sync has no from-and-to to show.
   *
   * collect.ts goes out of its way to keep trust warnings ("never cap away a
   * trust warning"). The page dropped them at the last step.
   */
  describe('a failing sync on a day the model wrote items', () => {
    const failing = quality(
      'SHOP_SYNC_FAILING',
      'WooCommerce responded 500: <!DOCTYPE html> <html lang="nb-NO"> <head> <meta name="viewport"',
    )

    // Deliberately free of both "figures are stale" and "Sync failing": the
    // assertions below must catch the band and the card, not this prose.
    const withItems = briefing({
      facts: [fact, failing],
      items: [
        {
          headline: 'Norway has stopped reporting',
          why: 'The store stopped answering, so what is below is old.',
          factIds: ['revenue:shop_se', failing.id],
          severity: 'high',
          action: null,
        },
      ],
    })

    it('states the warning even on a day the report section is not shown', () => {
      render(<AdvisorClient initial={withItems} />)
      expect(screen.getByText(/figures are stale/i)).toBeInTheDocument()
    })

    /**
     * 401 and 403 are our key; 500 is their site. "Could not be reached" sends
     * the owner to check his internet when what needs looking at is WordPress.
     */
    it('says a 500 is the store erroring, not us failing to reach it', () => {
      render(<AdvisorClient initial={withItems} />)
      expect(screen.getByText(/returned an error/i)).toBeInTheDocument()
    })

    it('offers the link that fixes it, which only the band carries', () => {
      render(<AdvisorClient initial={withItems} />)
      expect(screen.getByRole('link', { name: /check the connection/i })).toHaveAttribute(
        'href',
        '/settings/shops',
      )
    })

    it('puts no raw error text anywhere on the page', () => {
      const { container } = render(<AdvisorClient initial={withItems} />)
      expect(container.textContent).not.toContain('DOCTYPE')
      expect(container.textContent).not.toContain('<html')
    })

    /**
     * A trust fact in a card reads as a movement that went from nothing to
     * nothing. The band above already states it as a sentence, so the card
     * keeps the figures and lets the band keep the warning.
     */
    it('keeps the warning out of the card, where it reads as a movement', () => {
      const { container } = render(<AdvisorClient initial={withItems} />)
      expect(container.querySelector('article')?.textContent).not.toMatch(/Sync failing/)
    })

    // Guards the hoist: the band moved above the cards, so Report must no
    // longer draw its own, or a quiet day would state every warning twice.
    it('states each warning once, not once per section', () => {
      render(<AdvisorClient initial={briefing({ items: [], facts: [failing] })} />)
      expect(screen.getAllByText(/figures are stale/i)).toHaveLength(1)
    })
  })
})
