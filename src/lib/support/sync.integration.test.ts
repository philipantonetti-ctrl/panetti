import { describe, expect, it, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { db } from '@/lib/db'
import { syncSupport } from './sync'

/**
 * The network is mocked throughout: this proves the resumable logic, which is
 * where the bugs live. A real run against the live account is done by hand.
 */

/**
 * A source of this test's own, never the real one.
 *
 * Cleaning up by `source: 'gorgias'` deleted the REAL import - 1,600 live
 * tickets, all 23 agents and the backfill cursor - every time the suite ran.
 * Namespacing everything this file touches is what makes the cleanup safe.
 */
const SOURCE = 'gorgias-test'
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const ticket = (id: number, created: string, updated = created) => ({
  id,
  status: 'closed',
  priority: 'normal',
  channel: 'email',
  via: 'email',
  language: 'no',
  spam: false,
  from_agent: false,
  messages_count: 2,
  subject: `Ticket ${id}`,
  customer: { email: `c${id}@example.invalid`, name: `Customer ${id}` },
  assignee_user: null,
  tags: [],
  created_datetime: created,
  opened_datetime: null,
  closed_datetime: null,
  last_received_message_datetime: null,
  last_message_datetime: null,
  updated_datetime: updated,
})

const page = (data: unknown[], nextCursor: string | null = null) =>
  new Response(JSON.stringify({ data, meta: { next_cursor: nextCursor } }), { status: 200 })

async function cleanup() {
  await db.supportTicket.deleteMany({ where: { source: SOURCE } })
  await db.supportAgent.deleteMany({ where: { source: SOURCE } })
  await db.supportSyncState.deleteMany({ where: { source: SOURCE } })
}
afterAll(cleanup)
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  await cleanup()
  vi.stubEnv('GORGIAS_DOMAIN', 'test-account')
  vi.stubEnv('GORGIAS_EMAIL', 'admin@example.invalid')
  vi.stubEnv('GORGIAS_API_KEY', 'key')
})

/** Answers each endpoint from a script, so a test says what Gorgias returned. */
function stubGorgias(script: { tickets?: Response[]; users?: Response[]; surveys?: Response[] }) {
  const queues = {
    tickets: [...(script.tickets ?? [])],
    users: [...(script.users ?? [page([])])],
    surveys: [...(script.surveys ?? [page([])])],
  }
  const calls: string[] = []
  const fn = vi.fn<Fetch>(async (input) => {
    const url = String(input)
    calls.push(url)
    const which = url.includes('/users') ? 'users' : url.includes('/satisfaction-surveys') ? 'surveys' : 'tickets'
    return queues[which].shift() ?? page([])
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

const soon = () => Date.now() + 30_000
/** Zero pause: the real one-second pacing is production behaviour, not logic. */
const run = () => syncSupport({ deadline: soon(), pauseMs: 0, source: SOURCE })

describe('syncSupport', () => {
  it('says so plainly when the helpdesk is not connected, and asks it nothing', async () => {
    vi.stubEnv('GORGIAS_API_KEY', '')
    const fn = vi.fn<Fetch>(async () => page([]))
    vi.stubGlobal('fetch', fn)

    expect(await run()).toMatchObject({ configured: false, stored: 0 })
    expect(fn).not.toHaveBeenCalled()
  })

  it('stores what it reads and remembers how far back it has got', async () => {
    stubGorgias({
      tickets: [
        page([ticket(1, '2026-08-20T10:00:00+00:00')]), // incremental
        page([ticket(2, '2021-06-09T09:00:00+00:00')]), // backfill, no cursor back = done
      ],
    })

    const r = await run()
    expect(r).toMatchObject({ configured: true, error: null, backfilling: false })
    expect(await db.supportTicket.count({ where: { source: SOURCE } })).toBe(2)

    const state = await db.supportSyncState.findUniqueOrThrow({ where: { source: SOURCE } })
    expect(state.backfilling).toBe(false)
    expect(state.oldestSeenAt?.toISOString()).toBe('2021-06-09T09:00:00.000Z')
    expect(state.watermark?.toISOString()).toBe('2026-08-20T10:00:00.000Z')
  })

  /**
   * The list endpoint has no date filter, so "since last time" is expressed as
   * "newest first, stop at what we hold". Without the stop, every run would
   * walk five years of history again.
   */
  it('stops the newest-first pass at the ticket it already has', async () => {
    // History already imported, and the newest ticket we hold is from the 20th.
    await db.supportSyncState.create({
      data: { source: SOURCE, watermark: new Date('2026-08-20T00:00:00Z'), backfilling: false },
    })

    const calls = stubGorgias({
      tickets: [
        page(
          [
            ticket(10, '2026-08-21T10:00:00+00:00'), // newer, stored
            ticket(11, '2026-08-19T10:00:00+00:00'), // older, stops the pass
          ],
          'cursor-there-is-more',
        ),
      ],
    })

    await run()

    expect(await db.supportTicket.count({ where: { source: SOURCE } })).toBe(1)
    expect((await db.supportTicket.findFirstOrThrow({ where: { source: SOURCE } })).externalId).toBe('10')
    // One ticket page only: it stopped rather than following the cursor.
    expect(calls.filter((u) => u.includes('/tickets')).length).toBe(1)
  })

  it('keeps the backfill cursor when history is longer than one run', async () => {
    stubGorgias({
      tickets: [
        page([]), // nothing new
        ...Array.from({ length: 9 }, (_, i) =>
          page([ticket(100 + i, `2021-06-${String(9 + i).padStart(2, '0')}T09:00:00+00:00`)], `cursor-${i}`),
        ),
      ],
    })

    const r = await run()
    expect(r.backfilling).toBe(true)

    const state = await db.supportSyncState.findUniqueOrThrow({ where: { source: SOURCE } })
    expect(state.backfillCursor).toBeTruthy()
    expect(state.backfilling).toBe(true)
  })

  it('records a refusal instead of throwing, so the rest of the cron survives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<Fetch>(async () => new Response('{}', { status: 429, headers: { 'retry-after': '20' } })),
    )

    const r = await run()
    expect(r.error).toMatch(/rate limit/i)

    const state = await db.supportSyncState.findUniqueOrThrow({ where: { source: SOURCE } })
    expect(state.lastError).toMatch(/rate limit/i)
  })

  it('writes a score onto its ticket, and ignores a survey nobody answered', async () => {
    stubGorgias({
      tickets: [page([ticket(7, '2026-08-20T10:00:00+00:00')]), page([])],
      surveys: [
        page([
          { ticket_id: 7, score: 5, scored_datetime: '2026-08-22T10:00:00+00:00' },
          { ticket_id: 7, score: null, scored_datetime: null },
        ]),
      ],
    })

    await run()
    const t = await db.supportTicket.findFirstOrThrow({ where: { source: SOURCE, externalId: '7' } })
    expect(t.satisfaction).toBe(5)
  })
})
