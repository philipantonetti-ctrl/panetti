// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AnalyticsView } from './AnalyticsView'

afterEach(() => vi.unstubAllGlobals())

const emptyStats = {
  tickets: 0,
  open: 0,
  closed: 0,
  medianResolutionHours: null,
  p90ResolutionHours: null,
  resolutionSample: 0,
  medianFirstResponseHours: null,
  firstResponseSample: 0,
  csat: null,
  csatSample: 0,
  byChannel: [],
  byAgent: [],
  byTag: [],
  byLanguage: [],
  byShop: [],
  perDay: [],
  byWeekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((key) => ({ key, tickets: 0 })),
  byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, tickets: 0 })),
  busiestHour: null,
  spam: 0,
}

const busyStats = {
  ...emptyStats,
  tickets: 100,
  open: 20,
  closed: 80,
  medianResolutionHours: 9,
  p90ResolutionHours: 108,
  resolutionSample: 80,
  csat: 4.5,
  csatSample: 25,
  perDay: [
    { day: '2026-08-01', tickets: 4 },
    { day: '2026-08-03', tickets: 6 },
  ],
  byWeekday: [
    { key: 'Mon', tickets: 5 },
    { key: 'Tue', tickets: 9 },
    { key: 'Wed', tickets: 3 },
    { key: 'Thu', tickets: 2 },
    { key: 'Fri', tickets: 1 },
    { key: 'Sat', tickets: 0 },
    { key: 'Sun', tickets: 0 },
  ],
  busiestHour: 11,
}

const sync = { ranAt: null, backfilling: false, oldestSeenAt: '2021-06-09T00:00:00.000Z', lastError: null }

function show(over: Record<string, unknown> = {}) {
  const body = {
    days: 90,
    timezone: 'Europe/Oslo',
    configured: true,
    from: '2026-08-01',
    to: '2026-08-03',
    previousFrom: '2026-05-03',
    previousTo: '2026-07-31',
    stats: busyStats,
    previous: { ...busyStats, tickets: 50, closed: 20, medianResolutionHours: 18, csat: 4.0 },
    backlog: { open: 20, olderThanWeek: 0, oldestAgeDays: 3, medianAgeHours: 5 },
    matchedToCustomer: 40,
    ai: {},
    sync,
    ...over,
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })))
  render(<AnalyticsView />)
}

describe('AnalyticsView', () => {
  /**
   * The backlog is the only part of the page that demands an action today, so
   * it is not allowed to be windowed away or buried among the period figures.
   */
  it('shows what is open right now, and how long the worst has waited', async () => {
    show({ backlog: { open: 224, olderThanWeek: 79, oldestAgeDays: 986, medianAgeHours: 135 } })

    const band = await screen.findByLabelText('Open right now')
    expect(band).toHaveTextContent('224')
    expect(band).toHaveTextContent('79')
    expect(band).toHaveTextContent('986 days')
  })

  it('says plainly when nothing is waiting, rather than showing four zeroes', async () => {
    show({ backlog: { open: 0, olderThanWeek: 0, oldestAgeDays: null, medianAgeHours: null } })
    expect(await screen.findByText('Nothing is waiting for an answer.')).toBeInTheDocument()
  })

  /**
   * The point of the p90. Measured on the real account the median was 9.1h and
   * the tail 108.7h: the same team, and two completely different stories about
   * what a customer experiences.
   */
  it('puts the slow tail beside the median, where it contradicts it', async () => {
    show()
    expect(await screen.findByText('Median time to close')).toBeInTheDocument()
    expect(screen.getByText('9 in 10 within 4.5 days')).toBeInTheDocument()
  })

  /**
   * The bug this guards against was found on live data: mid-import, 779 real
   * tickets sat against a partially loaded 8 and the delta read "+9638%". That
   * is a fact about the importer, not the business.
   */
  it('shows no change at all while the history import is still running', async () => {
    show({ sync: { ...sync, backfilling: true } })

    expect(await screen.findByText('Tickets arrived')).toBeInTheDocument()
    expect(screen.queryByText(/vs previous 90 days/)).not.toBeInTheDocument()
    expect(screen.getByText(/appears once the history import has finished/)).toBeInTheDocument()
  })

  it('shows the change once both periods are fully imported', async () => {
    show()
    expect(await screen.findAllByText(/vs previous 90 days/)).not.toHaveLength(0)
    expect(screen.queryByText(/appears once the history import has finished/)).not.toBeInTheDocument()
  })

  /** Waiting less is good news, and a colour alone is never allowed to say so. */
  it('marks a faster time to close as good, with an arrow and a sign as well as a colour', async () => {
    show()
    // 9h now against 18h before: half the wait, and the improvement is a fall.
    const better = (await screen.findAllByTitle(/vs previous 90 days/)).find((el) =>
      el.textContent?.includes('-50%'),
    )
    expect(better).toBeDefined()
    expect(better).toHaveClass('text-gain')
    expect(better).toHaveTextContent('↓')
  })

  /**
   * Volume is not moral. More tickets usually means more orders, so it is
   * reported without a verdict rather than painted red.
   */
  it('leaves rising ticket volume uncoloured, because more tickets is not bad news', async () => {
    show()
    const volume = (await screen.findAllByTitle(/vs previous 90 days/)).find((el) =>
      el.textContent?.includes('+100%'),
    )
    expect(volume).toHaveClass('text-muted')
    expect(volume).not.toHaveClass('text-loss')
  })

  /**
   * Only days that had a ticket come back from the server. Plotting that list
   * directly closes every gap, so a silent fortnight draws as steady traffic.
   */
  it('draws the quiet days, so a gap in the traffic stays visible', async () => {
    show()
    const chart = await screen.findByRole('img', { name: 'Tickets per day' })
    // 1 to 3 August is three bars, not the two days that had tickets.
    expect(chart.children).toHaveLength(3)
    expect(chart.querySelector('[title="2 Aug: 0"]')).toBeInTheDocument()
  })

  it('counts by week over a long range, so a year is not 365 slivers', async () => {
    show({ days: 366, from: '2025-08-28', to: '2026-08-28' })
    const chart = await screen.findByRole('img', { name: 'Tickets per week' })
    expect(chart.children.length).toBeLessThan(60)
    expect(screen.getByText('Tickets per week')).toBeInTheDocument()
  })

  it('keeps the week in calendar order and names the busiest day and hour', async () => {
    show()
    expect(await screen.findByText('When tickets arrive')).toBeInTheDocument()

    const week = screen.getByRole('img', { name: 'Tickets by weekday' })
    expect(week.children).toHaveLength(7)
    // Tuesday is the tallest, yet it sits second where the calendar puts it
    // rather than first: sorted by size this would be a ranking, and the
    // question it answers is which day of the week to staff.
    expect(week.querySelector('[title="Tue: 9"]')).toBe(week.children[1])

    expect(screen.getByText('Busiest day:').parentElement).toHaveTextContent('Tue')
    expect(screen.getByText('11:00')).toBeInTheDocument()
  })

  /** A bar with no height is not a bar. The nested flex that caused this drew nothing. */
  it('gives the weekday bars a real height', async () => {
    show()
    const week = await screen.findByRole('img', { name: 'Tickets by weekday' })
    const tallest = week.querySelector('[title="Tue: 9"]') as HTMLElement
    expect(tallest.style.height).toBe('100%')
    expect((week.querySelector('[title="Mon: 5"]') as HTMLElement).style.height).not.toBe('0%')
  })

  /**
   * An empty dashboard has four causes needing four different actions, and the
   * first version of this said the same thing for all of them. The client spent
   * a day asking why the page was empty after saving the keys.
   */
  describe('when there is nothing to show, it names which of the four it is', () => {
    const nothing = {
      stats: emptyStats,
      previous: emptyStats,
      backlog: { open: 0, olderThanWeek: 0, oldestAgeDays: null, medianAgeHours: null },
    }

    it('says the keys are not reaching the app, and what that takes', async () => {
      show({ ...nothing, configured: false, sync: null })

      expect(await screen.findByText('Not connected to Gorgias yet')).toBeInTheDocument()
      expect(screen.getByText(/GORGIAS_DOMAIN/)).toBeInTheDocument()
      expect(screen.getByText(/redeploy is needed/)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Go to support settings' })).toBeInTheDocument()
    })

    /** The case that cost a day: keys in, nothing wrong, simply not run yet. */
    it('says it is connected and waiting, not that it is unconfigured', async () => {
      show({ ...nothing, configured: true, sync: null })

      expect(await screen.findByText('Connected, waiting for the first import')).toBeInTheDocument()
      expect(screen.getByText(/every 15 minutes/)).toBeInTheDocument()
      expect(screen.queryByText('Not connected to Gorgias yet')).not.toBeInTheDocument()
    })

    /**
     * A failing import used to read as "no tickets in this period", swallowing
     * the one line that explained the whole thing.
     */
    it('shows what Gorgias said back rather than calling a failure a quiet period', async () => {
      show({
        ...nothing,
        configured: true,
        sync: { ...sync, ranAt: '2026-08-28T11:00:00.000Z', lastError: 'Gorgias responded 401: unauthorized' },
      })

      expect(await screen.findByText('The last import did not work')).toBeInTheDocument()
      expect(screen.getByText('Gorgias responded 401: unauthorized')).toBeInTheDocument()
      expect(screen.queryByText('No tickets in this period')).not.toBeInTheDocument()
    })

    it('calls a genuinely quiet period quiet, once an import has actually run', async () => {
      show({ ...nothing, configured: true, sync: { ...sync, ranAt: '2026-08-28T11:00:00.000Z' } })

      expect(await screen.findByText('No tickets in this period')).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Go to support settings' })).not.toBeInTheDocument()
    })
  })

  /**
   * "and 2 more" with no way to see them is worse than saying nothing: it tells
   * the reader something is being withheld. The client asked what the 2 were.
   */
  it('opens the long tail of a breakdown instead of only counting it', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ key: `channel-${i}`, tickets: 11 - i }))
    show({ stats: { ...busyStats, byChannel: many } })

    expect(await screen.findByText('channel-0')).toBeInTheDocument()
    expect(screen.queryByText('channel-9')).not.toBeInTheDocument()

    const more = screen.getByRole('button', { name: 'Show all 11' })
    fireEvent.click(more)
    expect(screen.getByText('channel-9')).toBeInTheDocument()
    expect(screen.getByText('channel-10')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }))
    expect(screen.queryByText('channel-9')).not.toBeInTheDocument()
  })

  /** A visible bar labelled 0% reads as a bug, not as a small number. */
  it('never rounds a real share down to zero per cent', async () => {
    show({
      stats: {
        ...busyStats,
        byChannel: [
          { key: 'email', tickets: 997 },
          { key: 'instagram-comment', tickets: 3 },
        ],
      },
    })

    expect(await screen.findByText('instagram-comment')).toBeInTheDocument()
    expect(screen.getByText('<1%')).toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
  })

  it('does not offer to expand a breakdown that is already showing everything', async () => {
    show()
    expect(await screen.findByText('When tickets arrive')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument()
  })

  /** Two pages saying "this month" must ask the server for the same days. */
  it('asks for a range the way the dashboard does, by preset', async () => {
    show()
    await screen.findByText('Tickets arrived')
    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).toContain('preset=last_90_days')
    expect(url).not.toContain('days=')
  })

  it('shows the exact days counted, so a preset is never taken on trust', async () => {
    show()
    expect(await screen.findByText('2026-08-01 to 2026-08-03')).toBeInTheDocument()
  })

  it('says it could not load rather than drawing an empty dashboard', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    render(<AnalyticsView />)
    await waitFor(() => expect(screen.getByText('Could not load the support figures')).toBeInTheDocument())
  })
})
