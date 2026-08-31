import { db } from '@/lib/db'
import {
  fetchMessages,
  fetchSurveys,
  fetchTickets,
  fetchUsers,
  gorgiasCredentials,
  GorgiasError,
  PAGE_PAUSE_MS,
  type GorgiasCredentials,
} from './client'
import { mapAgent, mapMessage, mapTicket, SOURCE, type GorgiasTicket } from './map'

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

/**
 * How far back the message mirror reaches. A year covers every range the
 * Agents page offers; five years of message history would be weeks of walking
 * for figures nobody asks of 2022.
 */
const MESSAGE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000

export type SupportSyncResult = {
  configured: boolean
  stored: number
  /** True while history is still being walked. */
  backfilling: boolean
  oldestSeenAt: Date | null
  error: string | null
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

async function storeTickets(raw: GorgiasTicket[], source: string): Promise<number> {
  let stored = 0
  for (const t of raw) {
    // A ticket with no creation stamp cannot be placed in time, so it is no use
    // to any report. Skipped rather than stored with a guessed date.
    if (!t.created_datetime) continue
    const data = mapTicket(t, source)
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
async function readState(source: string) {
  return db.supportSyncState.upsert({
    where: { source },
    create: { source },
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
  source: string,
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
    stored += await storeTickets(fresh, source)

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
  source: string,
): Promise<{ stored: number; cursor: string | null; done: boolean; oldest: Date | null }> {
  let next = cursor
  let stored = 0
  let oldest: Date | null = null

  for (let page = 0; page < PAGES_PER_RUN; page++) {
    if (Date.now() > deadline) return { stored, cursor: next, done: false, oldest }

    const { data, nextCursor } = await fetchTickets(creds, { order: 'created_datetime:asc', cursor: next }, deadline)
    stored += await storeTickets(data, source)

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

/** Photo fetches per run: a face rarely changes, and the budget is shared. */
const AVATAR_FETCHES_PER_RUN = 5

/** A face is small; anything bigger than this is not a profile picture. */
const AVATAR_MAX_BYTES = 300_000

/**
 * The photo itself, with the API credentials. Gorgias's picture bucket
 * answers 403 to the open internet and to a browser <img>, so the bytes have
 * to arrive server-side or not at all - and whether the bucket honours API
 * auth is exactly what this fetch finds out. Null on any refusal: the page
 * falls back to initials, the same face Gorgias itself shows then.
 */
async function fetchAvatar(creds: GorgiasCredentials, url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    if (!type.startsWith('image/')) return null
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) return null
    return `data:${type};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

/** Who answers tickets. A short list, refreshed whole. */
async function syncAgents(creds: GorgiasCredentials, deadline: number, pause: number, source: string): Promise<void> {
  let cursor: string | null = null
  let fetches = 0
  for (let page = 0; page < 5; page++) {
    if (Date.now() > deadline) return
    const { data, nextCursor } = await fetchUsers(creds, cursor, deadline)
    for (const u of data) {
      const agent = mapAgent(u, source)

      // The picture bytes, only when the person has one and we do not hold it
      // yet (or they changed it). Bounded per run: faces rarely change, and
      // this budget is shared with everything after it.
      let avatarData: string | undefined
      if (agent.avatarUrl && fetches < AVATAR_FETCHES_PER_RUN && Date.now() < deadline) {
        const existing = await db.supportAgent.findUnique({
          where: { source_externalId: { source: agent.source, externalId: agent.externalId } },
          select: { avatarUrl: true, avatarData: true },
        })
        if (!existing?.avatarData || existing.avatarUrl !== agent.avatarUrl) {
          fetches++
          avatarData = (await fetchAvatar(creds, agent.avatarUrl)) ?? undefined
        }
      }

      await db.supportAgent.upsert({
        where: { source_externalId: { source: agent.source, externalId: agent.externalId } },
        create: { ...agent, ...(avatarData ? { avatarData } : {}) },
        // The stored bytes survive a run that fetched nothing for them.
        update: { ...agent, ...(avatarData ? { avatarData } : {}) },
      })
    }
    if (!nextCursor) return
    cursor = nextCursor
    await sleep(pause)
  }
}

/**
 * The message mirror, for the Agents page: who wrote, when, on which ticket.
 *
 * Two passes like the tickets, both newest-first because the endpoint orders
 * no other way that helps: INCREMENTAL stops at the newest message already
 * held; BACKFILL continues from its own cursor until it walks past the
 * horizon. Each is bounded per run so neither can starve the surveys after
 * them or the parcel poll after that.
 */
async function syncMessages(
  creds: GorgiasCredentials,
  state: { messageWatermark: Date | null; messageBackfillCursor: string | null; messageBackfilling: boolean },
  deadline: number,
  pause: number,
  source: string,
): Promise<void> {
  const horizon = new Date(Date.now() - MESSAGE_HORIZON_MS)

  const store = async (raw: import('./client').GorgiasMessage[]): Promise<Date | null> => {
    let newest: Date | null = null
    for (const m of raw) {
      const data = mapMessage(m, source)
      if (!data || data.createdAt < horizon) continue
      await db.supportMessage.upsert({
        where: { source_externalId: { source, externalId: data.externalId } },
        create: data,
        update: data,
      })
      if (!newest || data.createdAt > newest) newest = data.createdAt
    }
    return newest
  }

  // Incremental: newest first, stop at what we already hold.
  let cursor: string | null = null
  let newest: Date | null = state.messageWatermark
  for (let page = 0; page < PAGES_PER_RUN; page++) {
    if (Date.now() > deadline) break
    const { data, nextCursor } = await fetchMessages(creds, cursor, deadline)
    if (data.length === 0) break
    const fresh = state.messageWatermark
      ? data.filter((m) => m.created_datetime && new Date(m.created_datetime) > state.messageWatermark!)
      : data
    const seen = await store(fresh)
    if (seen && (!newest || seen > newest)) newest = seen
    if (fresh.length < data.length || !nextCursor) break
    cursor = nextCursor
    await sleep(pause)
  }
  if (newest && newest !== state.messageWatermark) {
    await db.supportSyncState.update({ where: { source }, data: { messageWatermark: newest } })
  }

  // Backfill: continue the walk from where it stopped, until the horizon.
  if (!state.messageBackfilling) return
  let backCursor = state.messageBackfillCursor
  let backfilling = true
  for (let page = 0; page < PAGES_PER_RUN; page++) {
    if (Date.now() > deadline) break
    const { data, nextCursor } = await fetchMessages(creds, backCursor, deadline)
    await store(data)
    const pastHorizon = data.some((m) => m.created_datetime && new Date(m.created_datetime) < horizon)
    if (pastHorizon || !nextCursor || data.length === 0) {
      backfilling = false
      backCursor = null
      break
    }
    backCursor = nextCursor
    await sleep(pause)
  }
  await db.supportSyncState.update({
    where: { source },
    data: { messageBackfillCursor: backCursor, messageBackfilling: backfilling },
  })
}

/**
 * The customer's score, onto the ticket it belongs to.
 *
 * Only scored surveys are worth writing: an unanswered one is not a zero, and
 * storing it as one would drag every average down with silence.
 */
async function syncSurveys(creds: GorgiasCredentials, deadline: number, pause: number, source: string): Promise<void> {
  let cursor: string | null = null
  for (let page = 0; page < 3; page++) {
    if (Date.now() > deadline) return
    const { data, nextCursor } = await fetchSurveys(creds, cursor, deadline)
    for (const s of data) {
      if (s.score === null || s.score === undefined) continue
      await db.supportTicket.updateMany({
        where: { source, externalId: String(s.ticket_id) },
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
  /**
   * Which channel these tickets belong to. Only a test overrides it, and it
   * MUST: cleaning up by source is how a test avoids deleting the real
   * import, which is a mistake this code has already made once.
   */
  source?: string
}): Promise<SupportSyncResult> {
  const pause = opts.pauseMs ?? PAGE_PAUSE_MS
  const source = opts.source ?? SOURCE
  const creds = gorgiasCredentials()
  if (!creds) {
    return { configured: false, stored: 0, backfilling: false, oldestSeenAt: null, error: null }
  }

  const state = await readState(source)
  let stored = 0
  let backfilling = state.backfilling
  let oldestSeenAt = state.oldestSeenAt

  try {
    await syncAgents(creds, opts.deadline, pause, source)

    const fresh = await incremental(creds, state.watermark, opts.deadline, pause, source)
    stored += fresh.stored
    if (fresh.newest) {
      await db.supportSyncState.update({
        where: { source },
        data: { watermark: fresh.newest },
      })
    }

    if (state.backfilling) {
      const old = await backfill(creds, state.backfillCursor, opts.deadline, pause, source)
      stored += old.stored
      backfilling = !old.done
      if (old.oldest && (!oldestSeenAt || old.oldest < oldestSeenAt)) oldestSeenAt = old.oldest
      await db.supportSyncState.update({
        where: { source },
        data: { backfillCursor: old.cursor, backfilling, oldestSeenAt },
      })
    }

    await syncMessages(creds, state, opts.deadline, pause, source)

    await syncSurveys(creds, opts.deadline, pause, source)

    await db.supportSyncState.update({
      where: { source },
      data: { ranAt: new Date(), lastError: null, ticketsStored: { increment: stored } },
    })
    return { configured: true, stored, backfilling, oldestSeenAt, error: null }
  } catch (e) {
    const error = e instanceof GorgiasError ? e.message : e instanceof Error ? e.message : 'Support sync failed'
    // Recorded rather than thrown. What it DID store stays stored, and the
    // watermark only ever moved for pages that completed.
    await db.supportSyncState
      .update({ where: { source }, data: { ranAt: new Date(), lastError: error } })
      .catch(() => {})
    return { configured: true, stored, backfilling, oldestSeenAt, error }
  }
}
