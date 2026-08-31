// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  usePathname: () => '/support/agents',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const { AgentsClient, TopPerformers } = await import('./AgentsClient')

afterEach(() => vi.unstubAllGlobals())

const row = (agent: string, over: Record<string, unknown> = {}) => ({
  agent,
  tickets: 40,
  closed: 30,
  closedShare: 0.3,
  medianResolutionHours: 20,
  resolutionSample: 30,
  medianFirstResponseHours: 4,
  firstResponseSample: 25,
  csat: 4.6,
  csatSample: 12,
  openNow: 3,
  messagesSent: 151,
  ticketsReplied: 84,
  messagesReceived: 149,
  medianResponseHours: 7.5,
  responseSample: 120,
  oneTouchShare: 0.3288,
  oneTouchSample: 25,
  ...over,
})

describe('TopPerformers', () => {
  it('names the best in each discipline, with the figure that earned it', () => {
    render(
      <TopPerformers
        agents={[
          row('Selena Guillermo', { closed: 73 }),
          row('Develyn', { csat: 5, csatSample: 5, medianFirstResponseHours: 0.5 }),
          row('Marvin Albuera', { medianResolutionHours: 17.2 }),
        ]}
      />,
    )

    expect(screen.getByText('Most closed')).toBeInTheDocument()
    expect(screen.getByText('73')).toBeInTheDocument()
    expect(screen.getByText('Best satisfaction')).toBeInTheDocument()
    expect(screen.getByText('5.0 / 5')).toBeInTheDocument()
    expect(screen.getByText('Fastest first reply')).toBeInTheDocument()
    expect(screen.getByText('30 min')).toBeInTheDocument()
    expect(screen.getByText('Fastest to close')).toBeInTheDocument()
  })

  it('refuses to crown a discipline nobody has three measurements in', () => {
    render(<TopPerformers agents={[row('Dina', { csatSample: 1, csat: 5 })]} />)
    // One answered survey is luck, not a title.
    expect(screen.queryByText('Best satisfaction')).not.toBeInTheDocument()
  })
})

describe('AgentsClient', () => {
  it('shows the table with an Average row and the unassigned pile named', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              days: 90,
              from: '2026-06-03',
              to: '2026-08-31',
              agents: [row('Selena Guillermo', { closed: 73, closedShare: 0.17 })],
              unassigned: 741,
            }),
            { status: 200 },
          ),
        ),
      ),
    )
    render(<AgentsClient email="a@b.test" />)

    expect(await screen.findByRole('columnheader', { name: 'Closed' })).toBeInTheDocument()
    // Once in the top-performer strip, once in the table row.
    expect(screen.getAllByText('Selena Guillermo').length).toBeGreaterThan(0)
    expect(screen.getByText('17%')).toBeInTheDocument()
    expect(screen.getByText('Average')).toBeInTheDocument()
    expect(screen.getByText(/741/)).toBeInTheDocument()
    // The message columns the Gorgias page carries, from our own mirror.
    for (const col of ['Replied', 'Sent', 'Received', 'Response', 'One touch']) {
      expect(screen.getByRole('columnheader', { name: col })).toBeInTheDocument()
    }
    expect(screen.getAllByText('151').length).toBeGreaterThan(0) // messages sent
    expect(screen.getAllByText('33%').length).toBeGreaterThan(0) // one touch share
  })
})
