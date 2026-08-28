import { db } from '@/lib/db'
import {
  fetchSurveys,
  fetchTickets,
  fetchUsers,
  gorgiasCredentials,
  GorgiasError,
  PAGE_PAUSE_MS,
  type GorgiasCredentials,
} from './client'
import { mapAgent, mapTicket, SOURCE, type GorgiasTicket } from './map'

/**
 * Bringing the helpdesk's tickets in.
 *
 * Five years of history cannot arrive in one request, and the list endpoint has
 * no date filter, so this works exactly the way the WooCommerce sync does:
 *
 *  - INCREMENTAL, every run: newest first, stopping at the newest ticket we
 *    already hold. Cheap, and the only pass that matters once history is in.
 *  - BACKFILL, while history remains: oldest first from a stored cursor, a few
 *    pages per run, resuming next time. It takes hours and that is fine.
 *
 * Paced deliberately. The account allows 40 requests per 20 seconds and this
 * shares that ceiling with nothing else we run, but a 429 would cost the whole
 * import rather than one page, so it takes about half.
 */

/** Pages per run, per pass. Bounded so this can never starve the stages after it. */
const PAGES_PER_RUN = 8

export type SupportSyncResult = {
  configured: boolean
  stored: number
  /** True while history is still being walked. */
  backfilling: boolean
  oldestSeenAt: Date | null
  error: string | null
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

async function storeTickets(raw: GorgiasTicket[]): Promise<number> {
  let stored = 0
  for (const t of raw) {
    // A ticket with no creation stamp cannot be placed in time, so it is no use
    // to any report. Skipped rather than stored with a guessed date.
    if (!t.created_datetime) continue
    const data = mapTicket(t)
    await db.supportTicket.upsert({
      where: { source_externalId: { source: data.source, externalId: data.externalId } },
      create: data,
      // firstResponseAt and satisfaction are written by their own passes and
      // must survive a re-read of the ticket that knows nothing about them.
      update: data,
    })
    stored++
  }
  return stored
}

/** The newest updatedAt we hold, which is where the incremental pass stops. */
async function readState() {
  return db.supportSyncState.upsert({
    where: { source: SOURCE },
    create: { source: SOURCE },
    update: {},
  })
}

/**
 * Newest first, until we reach what we already have.
 *
 * Returns the newest updatedAt seen, which becomes the next run's stopping
 * point - written by the caller only after the pass completes, so an
 * interrupted run repeats a page rather than skipping one.
 */
async function incremental(
  creds: GorgiasCredentials,
  watermark: Date | null,
  deadline: number,
  pause: number,
): Promise<{ stored: number; newest: Date | null }> {
  let cursor: string | null = null
  let stored = 0
  let newest: Date | null = null

  for (let page = 0; page < PAGES_PER_RUN; page++) {
    if (Date.now() > deadline) break

    const { data, nextCursor } = await fetchTickets(creds, { order: 'updated_datetime:desc', cursor }, deadline)
    if (data.length === 0) break

    // Everything on this page that is newer than what we hold. The moment one
    // is older, the rest of history is older too and the pass is done.
    const fresh = watermark ? data.filter((t) => new Date(t.updated_datetime) > watermark) : data
    stored += await storeTickets(fresh)

    for (const t of fresh) {
      const at = new Date(t.updated_datetime)
      if (!newest || at > newest) newest = at
    }

    if (fresh.length < data.length || !nextCursor) break
    cursor = nextCursor
    await sleep(pause)
  }

  return { stored, newest }
}

/** Oldest first, a few pages at a time, remembering where it stopped. */
async function backfill(
  creds: GorgiasCredentials,
  cursor: string | null,
  deadline: number,
  pause: number,
): Promise<{ stored: number; cursor: string | null; done: boolean; oldest: Date | null }> {
  let next = cursor
  let stored = 0
  let oldest: Date | null = null

  for (let page = 0; page < PAGES_PER_RUN; page++) {
    if (Date.now() > deadline) return { stored, cursor: next, done: false, oldest }

    const { data, nextCursor } = await fetchTickets(creds, { order: 'created_datetime:asc', cursor: next }, deadline)
    stored += await storeTickets(data)

    for (const t of data) {
      const at = new Date(t.created_datetime)
      if (!oldest || at < oldest) oldest = at
    }

    // No cursor back means we have reached the present: history is complete.
    if (!nextCursor || data.length === 0) return { stored, cursor: null, done: true, oldest }
    next = nextCursor
    await sleep(pause)
  }

  return { stored, cursor: next, done: false, oldest }
}

/** Who answers tickets. A short list, refreshed whole. */
async function syncAgents(creds: GorgiasCredentials, deadline: number, pause: number): Promise<void> {
  let cursor: string | null = null
  for (let page = 0; page < 5; page++) {
    if (Date.now() > deadline) return
    const { data, nextCursor } = await fetchUsers(creds, cursor, deadline)
    for (const u of data) {
      const agent = mapAgent(u)
      await db.supportAgent.upsert({
        where: { source_externalId: { source: agent.source, externalId: agent.externalId } },
        create: agent,
        update: agent,
      })
    }
    if (!nextCursor) return
    cursor = nextCursor
    await sleep(pause)
  }
}

/**
 * The customer's score, onto the ticket it belongs to.
 *
 * Only scored surveys are worth writing: an unanswered one is not a zero, and
 * storing it as one would drag every average down with silence.
 */
async function syncSurveys(creds: GorgiasCredentials, deadline: number, pause: number): Promise<void> {
  let cursor: string | null = null
  for (let page = 0; page < 3; page++) {
    if (Date.now() > deadline) return
    const { data, nextCursor } = await fetchSurveys(creds, cursor, deadline)
    for (const s of data) {
      if (s.score === null || s.score === undefined) continue
      await db.supportTicket.updateMany({
        where: { source: SOURCE, externalId: String(s.ticket_id) },
        data: { satisfaction: s.score },
      })
    }
    if (!nextCursor) return
    cursor = nextCursor
    await sleep(pause)
  }
}

/**
 * One run. Never throws: this is one stage of a cron that also syncs shops,
 * and a helpdesk outage must not cost the money figures.
 */
export async function syncSupport(opts: {
  deadline: number
  /** Between pages. Only a test sets it to zero; production pacing is the point. */
  pauseMs?: number
}): Promise<SupportSyncResult> {
  const pause = opts.pauseMs ?? PAGE_PAUSE_MS
  const creds = gorgiasCredentials()
  if (!creds) {
    return { configured: false, stored: 0, backfilling: false, oldestSeenAt: null, error: null }
  }

  const state = await readState()
  let stored = 0
  let backfilling = state.backfilling
  let oldestSeenAt = state.oldestSeenAt

  try {
    await syncAgents(creds, opts.deadline, pause)

    const fresh = await incremental(creds, state.watermark, opts.deadline, pause)
    stored += fresh.stored
    if (fresh.newest) {
      await db.supportSyncState.update({
        where: { source: SOURCE },
        data: { watermark: fresh.newest },
      })
    }

    if (state.backfilling) {
      const old = await backfill(creds, state.backfillCursor, opts.deadline, pause)
      stored += old.stored
      backfilling = !old.done
      if (old.oldest && (!oldestSeenAt || old.oldest < oldestSeenAt)) oldestSeenAt = old.oldest
      await db.supportSyncState.update({
        where: { source: SOURCE },
        data: { backfillCursor: old.cursor, backfilling, oldestSeenAt },
      })
    }

    await syncSurveys(creds, opts.deadline, pause)

    await db.supportSyncState.update({
      where: { source: SOURCE },
      data: { ranAt: new Date(), lastError: null, ticketsStored: { increment: stored } },
    })
    return { configured: true, stored, backfilling, oldestSeenAt, error: null }
  } catch (e) {
    const error = e instanceof GorgiasError ? e.message : e instanceof Error ? e.message : 'Support sync failed'
    // Recorded rather than thrown. What it DID store stays stored, and the
    // watermark only ever moved for pages that completed.
    await db.supportSyncState
      .update({ where: { source: SOURCE }, data: { ranAt: new Date(), lastError: error } })
      .catch(() => {})
    return { configured: true, stored, backfilling, oldestSeenAt, error }
  }
}
