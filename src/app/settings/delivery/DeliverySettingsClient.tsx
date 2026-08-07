'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'

type PromiseRow = {
  id: string
  country: string
  days: number
  businessDays: boolean
  effectiveFrom: string
}

type ShopRow = { id: string; name: string; deliveryTrackingFrom: string | null }

type ImportRow = {
  id: string
  filename: string
  receivedAt: string
  rowsParsed: number
  rowsLinked: number
  rowsUnmatched: number
  error: string | null
}

type Settings = {
  bringApiUid: string
  bringClientUrl: string
  hasBringKey: boolean
  hasSlackWebhook: boolean
  lastSyncAt: string | null
  lastError: string | null
  // Its own field, not lastError above: that one belongs to the Bring sync
  // and gets cleared on every successful run, which would otherwise wipe a
  // still-live Slack failure within one cron tick.
  slackLastError: string | null
  promises: PromiseRow[]
  shops: ShopRow[]
  imports: ImportRow[]
}

const DASH = '—'

const field =
  'mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink'
const fieldLabel = 'mt-3 block text-xs font-medium text-muted'
const primaryBtn =
  'rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60'
const quietBtn =
  'rounded-[var(--radius-control)] border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition-opacity duration-150 hover:opacity-90 disabled:opacity-60'

/** One card per section of the page — Bring, Slack, promises, tracked shops, imports. */
function Card({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
      {subtitle && <p className="mt-0.5 text-[12px] text-muted">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="skeleton h-[300px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
      <div className="skeleton h-[180px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
      <div className="skeleton h-[220px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
    </div>
  )
}

/**
 * Runs a test-connection POST and hands the result to the toast: green for
 * ok, red otherwise. The server always answers in a sentence a human can act
 * on, so the client never needs to interpret the outcome itself.
 */
async function runTest(target: 'bring' | 'slack'): Promise<{ ok: boolean; message: string }> {
  const res = await fetch('/api/delivery/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) return { ok: false, message: body?.error ?? 'Could not run the test' }
  return { ok: Boolean(body?.ok), message: body?.message ?? 'Could not run the test' }
}

/**
 * Bring and Slack credentials, per-country delivery promises, which shops are
 * tracked, and the two buttons that prove the integrations actually work.
 * Follows DeliveryClient's own shape: the client fetches its data, a plain
 * effect loads it once, and every mutation calls `load()` again afterward —
 * there is no filter UI here to make a live-fetch loop worthwhile.
 */
export function DeliverySettingsClient({ email }: { email: string }) {
  const [data, setData] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // No synchronous setState at the top: `loading` already starts true, and
  // this page has no filter that re-arms it, so the only transition needed is
  // false once the fetch settles — the same shape DeliveryClient's own effect
  // uses, and calling setState synchronously inside an effect body is flagged
  // by react-hooks/set-state-in-effect.
  function load() {
    fetch('/api/delivery/settings')
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Could not load settings')
        return res.json()
      })
      .then((json: Settings) => {
        setData(json)
        setError('')
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  return (
    <AppShell email={email}>
      <PageHeader
        title="Delivery settings"
        subtitle="Set these up in order. Connect Bring, connect Slack, say how many days each country is promised, then switch on the shops you want tracked."
      />
      <PageBody>
        {error && (
          <div className="mb-4 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">
            {error}
          </div>
        )}

        {loading && !data ? (
          <Skeleton />
        ) : data ? (
          <div className="space-y-4">
            <BringSection data={data} reload={load} />
            <SlackSection data={data} reload={load} />
            <PromisesSection promises={data.promises} reload={load} />
            <ShopsSection shops={data.shops} reload={load} />
            <ImportsSection imports={data.imports} />
          </div>
        ) : null}
      </PageBody>
    </AppShell>
  )
}

function BringSection({ data, reload }: { data: Settings; reload: () => void }) {
  const [uid, setUid] = useState(data.bringApiUid)
  const [key, setKey] = useState('')
  const [clientUrl, setClientUrl] = useState(data.bringClientUrl)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const toast = useToast()

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/delivery/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bringApiUid: uid, bringApiKey: key, bringClientUrl: clientUrl }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save Bring settings')
        return
      }
      toast.success('Bring settings saved')
      setKey('')
      reload()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSaving(false)
    }
  }

  async function test() {
    setTesting(true)
    try {
      const result = await runTest('bring')
      if (result.ok) toast.success(result.message)
      else toast.error(result.message)
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card
      title="Bring"
      subtitle="Your own Mybring login, not the warehouse's. We use it to look up parcels. Press Save before Test connection."
    >
      <label className={fieldLabel} htmlFor="bring-uid">
        Account email
      </label>
      <input
        id="bring-uid"
        value={uid}
        onChange={(e) => setUid(e.target.value)}
        placeholder="ops@example.com"
        className={field}
      />

      <label className={fieldLabel} htmlFor="bring-key">
        API key
      </label>
      <input
        id="bring-key"
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={data.hasBringKey ? 'Saved' : 'from Mybring → API keys'}
        className={field}
      />

      <label className={fieldLabel} htmlFor="bring-url">
        Client URL
      </label>
      <input
        id="bring-url"
        value={clientUrl}
        onChange={(e) => setClientUrl(e.target.value)}
        placeholder="https://panetti.vercel.app"
        className={field}
      />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={save} disabled={saving} className={primaryBtn}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={test} disabled={testing} className={quietBtn}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>

      <div className="mt-4 border-t border-line pt-3 text-[12px] text-muted">
        <p>Last synced: {data.lastSyncAt ? new Date(data.lastSyncAt).toLocaleString() : 'Never'}</p>
        {data.lastError && <p className="mt-1 text-loss">{data.lastError}</p>}
      </div>
    </Card>
  )
}

function SlackSection({ data, reload }: { data: Settings; reload: () => void }) {
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const toast = useToast()

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/delivery/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slackWebhookUrl: url }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save the Slack webhook')
        return
      }
      toast.success('Slack settings saved')
      setUrl('')
      reload()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSaving(false)
    }
  }

  async function test() {
    setTesting(true)
    try {
      const result = await runTest('slack')
      if (result.ok) toast.success(result.message)
      else toast.error(result.message)
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card
      title="Slack"
      subtitle="Where late deliveries get posted. Send a test message once, so you know what a real alert looks like."
    >
      <label className={fieldLabel} htmlFor="slack-url">
        Webhook URL
      </label>
      <input
        id="slack-url"
        type="password"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={data.hasSlackWebhook ? 'Saved' : 'https://hooks.slack.com/services/…'}
        className={field}
      />
      <p className="mt-1.5 text-[11px] text-faint">
        Create an incoming webhook at{' '}
        <a
          href="https://api.slack.com/messaging/webhooks"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          api.slack.com/messaging/webhooks
        </a>{' '}
        and paste the URL.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={save} disabled={saving} className={primaryBtn}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={test} disabled={testing} className={quietBtn}>
          {testing ? 'Sending…' : 'Send test message'}
        </button>
      </div>

      {data.slackLastError && (
        <div className="mt-4 border-t border-line pt-3 text-[12px] text-loss">
          <p>Last alert failed: {data.slackLastError}</p>
        </div>
      )}
    </Card>
  )
}

const countryLabel = (c: string) => (c === '*' ? 'All other countries' : c)

function promisePayload(p: PromiseRow) {
  return { country: p.country, days: p.days, businessDays: p.businessDays, effectiveFrom: p.effectiveFrom }
}

function PromisesSection({ promises, reload }: { promises: PromiseRow[]; reload: () => void }) {
  const [editing, setEditing] = useState<PromiseRow | 'new' | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const toast = useToast()

  async function remove(row: PromiseRow) {
    if (!window.confirm(`Remove the promise for ${countryLabel(row.country)}?`)) return
    setRemoving(row.id)
    try {
      const next = promises.filter((p) => p.id !== row.id).map(promisePayload)
      const res = await fetch('/api/delivery/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promises: next }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not remove the promise')
        return
      }
      toast.success('Promise removed')
      reload()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setRemoving(null)
    }
  }

  return (
    <Card
      title="Delivery promises"
      subtitle="How many days you promise, per country. An order is late when it passes this. Change one and past figures stay as they were. Use * for every country without its own row."
    >
      <div className="overflow-hidden rounded-[var(--radius-control)] border border-line">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line bg-panel text-[11px] font-semibold text-faint">
              <th className="px-4 py-2 text-left">Country</th>
              <th className="px-4 py-2 text-right">Days</th>
              <th className="px-4 py-2 text-left">Business days</th>
              <th className="px-4 py-2 text-left">Effective from</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {promises.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted">
                  No promises set yet.
                </td>
              </tr>
            )}
            {promises.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-b-0">
                <td className="px-4 py-2.5 font-medium text-ink">{countryLabel(p.country)}</td>
                <td className="num px-4 py-2.5 text-right text-ink">{p.days}</td>
                <td className="px-4 py-2.5 text-ink">{p.businessDays ? 'Yes' : 'No'}</td>
                <td className="px-4 py-2.5 text-muted">{p.effectiveFrom}</td>
                <td className="px-4 py-2.5">
                  <div className="flex justify-end gap-3">
                    <button onClick={() => setEditing(p)} className="font-semibold text-accent hover:underline">
                      Edit
                    </button>
                    <button
                      onClick={() => void remove(p)}
                      disabled={removing !== null}
                      className="font-semibold text-loss hover:underline disabled:opacity-60"
                    >
                      {removing === p.id ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button
        onClick={() => setEditing('new')}
        className="mt-3 text-[13px] font-medium text-accent hover:underline"
      >
        Add promise
      </button>

      {editing && (
        <PromiseModal
          existing={editing === 'new' ? null : editing}
          all={promises}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            reload()
          }}
        />
      )}
    </Card>
  )
}

function PromiseModal({
  existing,
  all,
  onClose,
  onSaved,
}: {
  existing: PromiseRow | null
  all: PromiseRow[]
  onClose: () => void
  onSaved: () => void
}) {
  const [country, setCountry] = useState(existing?.country ?? '')
  const [days, setDays] = useState(String(existing?.days ?? 3))
  const [businessDays, setBusinessDays] = useState(existing?.businessDays ?? true)
  const [effectiveFrom, setEffectiveFrom] = useState(
    existing?.effectiveFrom ?? new Date().toISOString().slice(0, 10),
  )
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  async function save() {
    const daysNum = parseInt(days, 10)
    if (!country.trim()) {
      toast.error('Enter a country code, or * for all other countries')
      return
    }
    // Mirrors the server's own floor: a promise of zero days would make every
    // order late the instant it was placed.
    if (!Number.isFinite(daysNum) || daysNum < 1) {
      toast.error('Days must be at least 1')
      return
    }
    setBusy(true)
    try {
      const others = (existing ? all.filter((p) => p.id !== existing.id) : all).map(promisePayload)
      const next = [
        ...others,
        { country: country.trim().toUpperCase(), days: daysNum, businessDays, effectiveFrom },
      ]
      const res = await fetch('/api/delivery/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promises: next }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save the promise')
        return
      }
      toast.success('Promise saved')
      onSaved()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-[var(--radius-card)] bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold text-ink">{existing ? 'Edit promise' : 'Add promise'}</h2>

        <label className={fieldLabel} htmlFor="promise-country">
          Country
        </label>
        <input
          id="promise-country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          placeholder="NO, or * for all other countries"
          className={field}
        />

        <label className={fieldLabel} htmlFor="promise-days">
          Days
        </label>
        <input
          id="promise-days"
          type="number"
          min={1}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          className={field}
        />

        <label className="mt-3 flex items-center gap-2 text-xs font-medium text-ink">
          <input
            type="checkbox"
            checked={businessDays}
            onChange={(e) => setBusinessDays(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          Business days
        </label>

        <label className={fieldLabel} htmlFor="promise-from">
          Effective from
        </label>
        <input
          id="promise-from"
          type="date"
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
          className={field}
        />

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-xs text-muted">
            Cancel
          </button>
          <button onClick={save} disabled={busy} className={primaryBtn}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ShopsSection({ shops, reload }: { shops: ShopRow[]; reload: () => void }) {
  const [saving, setSaving] = useState<string | null>(null)
  const toast = useToast()

  async function setDate(shop: ShopRow, date: string) {
    setSaving(shop.id)
    try {
      const res = await fetch('/api/delivery/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopTracking: [{ shopId: shop.id, date }] }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save')
        return
      }
      toast.success(date ? `${shop.name} is now tracked from ${date}` : `${shop.name} is no longer tracked`)
      reload()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSaving(null)
    }
  }

  return (
    <Card
      title="Which shops are tracked"
      subtitle="The on and off switch. Blank means this shop is not tracked at all. A date means start judging orders from then, so switching on will not alert about old orders."
    >
      <div className="overflow-hidden rounded-[var(--radius-control)] border border-line">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line bg-panel text-[11px] font-semibold text-faint">
              <th className="px-4 py-2 text-left">Shop</th>
              <th className="px-4 py-2 text-left">Tracking start date</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {shops.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-muted">
                  No shops yet.
                </td>
              </tr>
            )}
            {shops.map((s) => (
              <tr key={s.id} className="border-b border-line last:border-b-0">
                <td className="px-4 py-2.5 font-medium text-ink">{s.name}</td>
                <td className="px-4 py-2.5">
                  <input
                    type="date"
                    aria-label={`Tracking start date for ${s.name}`}
                    defaultValue={s.deliveryTrackingFrom ?? ''}
                    onChange={(e) => void setDate(s, e.target.value)}
                    disabled={saving === s.id}
                    className="rounded-[var(--radius-control)] border border-line bg-surface px-2.5 py-1.5 text-xs text-ink disabled:opacity-60"
                  />
                </td>
                <td className="px-4 py-2.5 text-right">
                  {s.deliveryTrackingFrom && (
                    <button
                      onClick={() => void setDate(s, '')}
                      disabled={saving === s.id}
                      className="text-xs font-medium text-loss hover:underline disabled:opacity-60"
                    >
                      Clear
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function ImportsSection({ imports }: { imports: ImportRow[] }) {
  return (
    <Card
      title="Recent imports"
      subtitle="Every warehouse file we have read. If parcels found and parcels linked do not match, the file was only half understood."
    >
      <div className="overflow-x-auto rounded-[var(--radius-control)] border border-line">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line bg-panel text-[11px] font-semibold text-faint">
              <th className="px-4 py-2 text-left">File</th>
              <th className="px-4 py-2 text-left">Received</th>
              <th className="px-4 py-2 text-right">Parsed</th>
              <th className="px-4 py-2 text-right">Linked</th>
              <th className="px-4 py-2 text-right">Unmatched</th>
              <th className="px-4 py-2 text-left">Error</th>
            </tr>
          </thead>
          <tbody>
            {imports.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-muted">
                  No files imported yet.
                </td>
              </tr>
            )}
            {imports.map((i) => (
              <tr key={i.id} className="border-b border-line last:border-b-0">
                <td className="px-4 py-2.5 text-ink">{i.filename}</td>
                <td className="px-4 py-2.5 text-muted">{new Date(i.receivedAt).toLocaleString()}</td>
                <td className="num px-4 py-2.5 text-right text-ink">{i.rowsParsed}</td>
                <td className="num px-4 py-2.5 text-right text-ink">{i.rowsLinked}</td>
                <td className={`num px-4 py-2.5 text-right ${i.rowsUnmatched > 0 ? 'text-warn' : 'text-ink'}`}>
                  {i.rowsUnmatched}
                </td>
                <td className="max-w-[220px] truncate px-4 py-2.5 text-loss" title={i.error ?? undefined}>
                  {i.error ?? DASH}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
