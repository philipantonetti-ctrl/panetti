'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { DateFilter, type RangeChoice } from '@/components/filters/DateFilter'
import { type Preset } from '@/lib/dates'
import type { AgentRow } from '@/lib/support/agent-stats'

/**
 * The Agents page the client asked for, from the Gorgias screenshot: the top
 * performers up front, then one row per person. Every figure carries the
 * sample it is made of, and only disciplines with at least three measured
 * tickets can crown anyone - one lucky survey is not a title.
 */

/** The route decorates each row with the helpdesk's profile photo, if set. */
type AgentWithPhoto = AgentRow & { avatarUrl?: string | null }

type Payload = {
  days: number
  from: string
  to: string
  agents: AgentWithPhoto[]
  unassigned: number
  /** True while the message mirror is still walking its year of history. */
  messagesBackfilling?: boolean
}

/** Hours as a person says them - the dashboard's own wording. */
function duration(hours: number | null): string {
  if (hours === null) return '-'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 48) return `${hours.toFixed(1)} h`
  return `${(hours / 24).toFixed(1)} days`
}

const share = (v: number | null) => (v === null ? '-' : `${Math.round(v * 100)}%`)

/**
 * Gorgias's picture bucket refuses the open internet (403, measured
 * 2026-08-31), so the browser never loads its URL directly: our own proxy
 * asks with the helpdesk credentials and streams the bytes through. The
 * payload's avatarUrl is only the SIGNAL that a photo exists.
 */
const proxied = (agent: string) => `/api/support/agents/avatar?agent=${encodeURIComponent(agent)}`

/**
 * The person's real helpdesk photo when Gorgias holds one, initials when it
 * does not or the file is gone. The fallback is a state, not a guess: a
 * broken image renders letters, never a torn icon.
 */
function Avatar({ name, url }: { name: string; url?: string | null }) {
  const [broken, setBroken] = useState(false)
  if (url && !broken) {
    return (
      // Plain <img>, deliberately: the photo lives on Gorgias's CDN, whose
      // host next/image would need pre-registered in next.config to serve.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        onError={() => setBroken(true)}
        className="h-7 w-7 shrink-0 rounded-full object-cover"
      />
    )
  }
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-ink">
      {initials}
    </span>
  )
}

/** A discipline needs at least this many measured tickets to crown anyone. */
const CROWN_SAMPLE = 3

type Crown = { label: string; agent: string; value: string; url?: string | null }

function crowns(agents: AgentWithPhoto[]): Crown[] {
  const out: Crown[] = []

  const closers = agents.filter((a) => a.closed > 0)
  if (closers.length) {
    const best = closers.reduce((a, b) => (b.closed > a.closed ? b : a))
    out.push({ label: 'Most closed', agent: best.agent, value: String(best.closed), url: best.avatarUrl })
  }

  const scored = agents.filter((a) => a.csat !== null && a.csatSample >= CROWN_SAMPLE)
  if (scored.length) {
    const best = scored.reduce((a, b) => (b.csat! > a.csat! ? b : a))
    out.push({ label: 'Best satisfaction', agent: best.agent, value: `${best.csat!.toFixed(1)} / 5`, url: best.avatarUrl })
  }

  const responders = agents.filter(
    (a) => a.medianFirstResponseHours !== null && a.firstResponseSample >= CROWN_SAMPLE,
  )
  if (responders.length) {
    const best = responders.reduce((a, b) =>
      b.medianFirstResponseHours! < a.medianFirstResponseHours! ? b : a,
    )
    out.push({ label: 'Fastest first reply', agent: best.agent, value: duration(best.medianFirstResponseHours), url: best.avatarUrl })
  }

  const resolvers = agents.filter(
    (a) => a.medianResolutionHours !== null && a.resolutionSample >= CROWN_SAMPLE,
  )
  if (resolvers.length) {
    const best = resolvers.reduce((a, b) =>
      b.medianResolutionHours! < a.medianResolutionHours! ? b : a,
    )
    out.push({ label: 'Fastest to close', agent: best.agent, value: duration(best.medianResolutionHours), url: best.avatarUrl })
  }

  return out
}

/** One surface divided by hairlines - the stat-strip rule, worn by people. */
export function TopPerformers({ agents }: { agents: AgentWithPhoto[] }) {
  const titles = crowns(agents)
  if (titles.length === 0) return null

  return (
    <section
      aria-label="Top performers"
      className="grid overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface sm:grid-cols-2 lg:grid-cols-4"
    >
      {titles.map((t) => (
        <div key={t.label} className="border-b border-line p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
          <div className="flex items-center gap-2.5">
            <Avatar name={t.agent} url={t.url ? proxied(t.agent) : null} />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-ink">{t.agent}</p>
              <p className="text-[11px] text-muted">{t.label}</p>
            </div>
          </div>
          <p className="num mt-2 text-[19px] font-semibold text-ink">{t.value}</p>
        </div>
      ))}
    </section>
  )
}

/** Averages over the agents shown, weighted the honest way: by their tickets. */
function averages(agents: AgentRow[]) {
  const sum = (f: (a: AgentRow) => number) => agents.reduce((n, a) => n + f(a), 0)
  const weighted = (
    value: (a: AgentRow) => number | null,
    sample: (a: AgentRow) => number,
  ): number | null => {
    const measured = agents.filter((a) => value(a) !== null && sample(a) > 0)
    const total = sum((a) => (measured.includes(a) ? sample(a) : 0))
    if (total === 0) return null
    return measured.reduce((n, a) => n + value(a)! * sample(a), 0) / total
  }
  return {
    tickets: sum((a) => a.tickets),
    closed: sum((a) => a.closed),
    openNow: sum((a) => a.openNow),
    ticketsReplied: sum((a) => a.ticketsReplied),
    messagesSent: sum((a) => a.messagesSent),
    messagesReceived: sum((a) => a.messagesReceived),
    medianFirstResponseHours: weighted((a) => a.medianFirstResponseHours, (a) => a.firstResponseSample),
    medianResponseHours: weighted((a) => a.medianResponseHours, (a) => a.responseSample),
    medianResolutionHours: weighted((a) => a.medianResolutionHours, (a) => a.resolutionSample),
    oneTouchShare: weighted((a) => a.oneTouchShare, (a) => a.oneTouchSample),
    csat: weighted((a) => a.csat, (a) => a.csatSample),
  }
}

export function AgentsClient({ email }: { email: string }) {
  const [preset, setPreset] = useState<Preset | 'custom'>('last_90_days')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const params = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      params.set('from', from)
      params.set('to', to)
    } else if (preset !== 'custom') {
      params.set('preset', preset)
    }
    const ctrl = new AbortController()
    fetch(`/api/support/agents?${params}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load the agent figures'))))
      .then((body: Payload) => {
        setData(body)
        setError('')
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
    return () => ctrl.abort()
  }, [preset, from, to])

  function pickRange(next: RangeChoice) {
    setPreset(next.preset)
    setFrom(next.from ?? '')
    setTo(next.to ?? '')
  }

  const avg = data ? averages(data.agents) : null

  return (
    <AppShell email={email}>
      <PageHeader
        title="Agents"
        subtitle="Each person's period: what they closed, how fast they answered, and what customers said."
      />
      <PageBody>
        {error ? (
          <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">
            {error}
          </div>
        ) : !data ? (
          <div className="skeleton h-[300px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <DateFilter preset={preset} from={data.from} to={data.to} onChange={pickRange} align="left" />
              <span className="num text-[12px] text-faint">
                {data.from} to {data.to}
              </span>
            </div>

            {data.messagesBackfilling && data.agents.length > 0 && (
              <p className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-muted">
                The message history is still importing, so Replied, Sent, Received, Response and One
                touch are filling in - they grow with each sync until the last year is in.
              </p>
            )}
            {data.agents.length === 0 ? (
              <p className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-8 text-center text-[13px] text-muted">
                No ticket in this period carries an assignee, so there is nobody to measure yet.
                Assign tickets in Gorgias and this page fills itself.
              </p>
            ) : (
              <>
                <TopPerformers agents={data.agents} />

                <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="border-b border-line bg-panel text-left text-[11px] font-semibold text-faint">
                          <th className="px-4 py-2.5">Agent</th>
                          <th className="num px-3 py-2.5 text-right">Tickets</th>
                          <th className="num px-3 py-2.5 text-right">Closed</th>
                          <th className="num px-3 py-2.5 text-right">% of all closed</th>
                          <th className="num px-3 py-2.5 text-right" title="Tickets they wrote at least one reply on">Replied</th>
                          <th className="num px-3 py-2.5 text-right" title="Messages they sent (internal notes excluded)">Sent</th>
                          <th className="num px-3 py-2.5 text-right" title="Customer messages on tickets assigned to them">Received</th>
                          <th className="num px-3 py-2.5 text-right" title="Ticket arrival to their first reply, median">First reply</th>
                          <th className="num px-3 py-2.5 text-right" title="Customer message to their reply, median">Response</th>
                          <th className="num px-3 py-2.5 text-right">Time to close</th>
                          <th className="num px-3 py-2.5 text-right" title="Closed tickets they replied to that took exactly one reply">One touch</th>
                          <th className="num px-3 py-2.5 text-right">Satisfaction</th>
                          <th className="num px-4 py-2.5 text-right">Open now</th>
                        </tr>
                      </thead>
                      <tbody className="text-ink">
                        {avg && (
                          <tr className="border-b border-line bg-panel/60 font-medium">
                            <td className="px-4 py-2.5">Average</td>
                            <td className="num px-3 py-2.5 text-right">{avg.tickets}</td>
                            <td className="num px-3 py-2.5 text-right">{avg.closed}</td>
                            <td className="num px-3 py-2.5 text-right">-</td>
                            <td className="num px-3 py-2.5 text-right">{avg.ticketsReplied}</td>
                            <td className="num px-3 py-2.5 text-right">{avg.messagesSent}</td>
                            <td className="num px-3 py-2.5 text-right">{avg.messagesReceived}</td>
                            <td className="num px-3 py-2.5 text-right">{duration(avg.medianFirstResponseHours)}</td>
                            <td className="num px-3 py-2.5 text-right">{duration(avg.medianResponseHours)}</td>
                            <td className="num px-3 py-2.5 text-right">{duration(avg.medianResolutionHours)}</td>
                            <td className="num px-3 py-2.5 text-right">{share(avg.oneTouchShare)}</td>
                            <td className="num px-3 py-2.5 text-right">
                              {avg.csat === null ? '-' : `${avg.csat.toFixed(2)} / 5`}
                            </td>
                            <td className="num px-4 py-2.5 text-right">{avg.openNow}</td>
                          </tr>
                        )}
                        {data.agents.map((a) => (
                          <tr key={a.agent} className="border-b border-line last:border-b-0 hover:bg-panel">
                            <td className="px-4 py-2.5">
                              <span className="flex items-center gap-2.5">
                                <Avatar name={a.agent} url={a.avatarUrl ? proxied(a.agent) : null} />
                                <span className="truncate font-medium">{a.agent}</span>
                              </span>
                            </td>
                            <td className="num px-3 py-2.5 text-right">{a.tickets}</td>
                            <td className="num px-3 py-2.5 text-right">{a.closed}</td>
                            <td className="num px-3 py-2.5 text-right">{share(a.closedShare)}</td>
                            <td className="num px-3 py-2.5 text-right">{a.ticketsReplied}</td>
                            <td className="num px-3 py-2.5 text-right">{a.messagesSent}</td>
                            <td className="num px-3 py-2.5 text-right">{a.messagesReceived}</td>
                            <td
                              className="num px-3 py-2.5 text-right"
                              title={a.firstResponseSample ? `over ${a.firstResponseSample} measured` : undefined}
                            >
                              {duration(a.medianFirstResponseHours)}
                            </td>
                            <td
                              className="num px-3 py-2.5 text-right"
                              title={a.responseSample ? `over ${a.responseSample} replies` : undefined}
                            >
                              {duration(a.medianResponseHours)}
                            </td>
                            <td
                              className="num px-3 py-2.5 text-right"
                              title={a.resolutionSample ? `over ${a.resolutionSample} closed` : undefined}
                            >
                              {duration(a.medianResolutionHours)}
                            </td>
                            <td
                              className="num px-3 py-2.5 text-right"
                              title={a.oneTouchSample ? `of ${a.oneTouchSample} replied and closed` : undefined}
                            >
                              {share(a.oneTouchShare)}
                            </td>
                            <td
                              className="num px-3 py-2.5 text-right"
                              title={a.csatSample ? `${a.csatSample} answered` : undefined}
                            >
                              {a.csat === null ? '-' : `${a.csat.toFixed(2)} / 5`}
                            </td>
                            <td className="num px-4 py-2.5 text-right">{a.openNow}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <p className="text-[12px] text-muted">
                  {data.unassigned.toLocaleString('en-US')} tickets in this period carry no assignee
                  and are counted on the main dashboard, not here. Medians and satisfaction show the
                  sample they are made of on hover.
                </p>
              </>
            )}
          </div>
        )}
      </PageBody>
    </AppShell>
  )
}
