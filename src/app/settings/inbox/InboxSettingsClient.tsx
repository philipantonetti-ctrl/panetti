'use client'

import { useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'
import { LANGUAGES } from '@/lib/inbox/classify'
import { MACRO_VARIABLES } from '@/lib/inbox/macros'

type MailboxRow = {
  id: string
  address: string
  name: string
  language: string
  signature: string
  active: boolean
  shop: { id: string; name: string } | null
  ticketCount: number
}
type MacroRow = { id: string; name: string; language: string; body: string }
type ShopOption = { id: string; name: string }

export function InboxSettingsClient({
  email,
  initialMailboxes,
  shops,
  initialMacros,
  forwardingAddress,
}: {
  email: string
  initialMailboxes: MailboxRow[]
  shops: ShopOption[]
  initialMacros: MacroRow[]
  forwardingAddress: string | null
}) {
  const toast = useToast()
  const [mailboxes, setMailboxes] = useState(initialMailboxes)
  const [macros, setMacros] = useState(initialMacros)

  async function refreshMailboxes() {
    const res = await fetch('/api/inbox/mailboxes')
    if (res.ok) setMailboxes((await res.json()).mailboxes)
  }
  async function refreshMacros() {
    const res = await fetch('/api/inbox/macros')
    if (res.ok) setMacros((await res.json()).macros)
  }

  return (
    <AppShell email={email}>
      <PageHeader title="Support inbox" subtitle="The addresses customers write to, and the macros agents answer with." />
      <PageBody>
        <div className="max-w-[900px] space-y-4">
          <Addresses mailboxes={mailboxes} shops={shops} onChanged={refreshMailboxes} toastError={toast.error} toastOk={toast.success} />
          <HowToConnect forwardingAddress={forwardingAddress} />
          <Macros macros={macros} onChanged={refreshMacros} toastError={toast.error} toastOk={toast.success} />
        </div>
      </PageBody>
    </AppShell>
  )
}

function Addresses({
  mailboxes, shops, onChanged, toastError, toastOk,
}: {
  mailboxes: MailboxRow[]
  shops: ShopOption[]
  onChanged: () => Promise<void>
  toastError: (t: string) => void
  toastOk: (t: string) => void
}) {
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [shopId, setShopId] = useState('')
  const [language, setLanguage] = useState('en')
  const [signature, setSignature] = useState('')

  async function add() {
    const res = await fetch('/api/inbox/mailboxes', {
      method: 'POST',
      body: JSON.stringify({ address, name, shopId: shopId || null, language, signature }),
    })
    if (!res.ok) {
      toastError((await res.json()).error ?? 'Could not add the address')
      return
    }
    toastOk('Address added')
    setAddress(''); setName(''); setShopId(''); setSignature('')
    await onChanged()
  }

  async function patch(id: string, fields: Record<string, unknown>) {
    const res = await fetch(`/api/inbox/mailboxes/${id}`, { method: 'PATCH', body: JSON.stringify(fields) })
    if (!res.ok) toastError((await res.json()).error ?? 'Could not update the address')
    await onChanged()
  }

  async function remove(id: string) {
    const res = await fetch(`/api/inbox/mailboxes/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      toastError((await res.json()).error ?? 'Could not remove the address')
      return
    }
    toastOk('Address removed')
    await onChanged()
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <h2 className="mb-3 text-[15px] font-semibold text-ink">Support addresses</h2>
      {mailboxes.length > 0 && (
        <div className="mb-4 overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-faint">
                <th className="py-2 pr-3 font-semibold">Address</th>
                <th className="py-2 pr-3 font-semibold">Name</th>
                <th className="py-2 pr-3 font-semibold">Shop</th>
                <th className="py-2 pr-3 font-semibold">Language</th>
                <th className="py-2 pr-3 font-semibold">Active</th>
                <th className="py-2 pr-3 text-right font-semibold">Tickets</th>
                <th className="py-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {mailboxes.map((m) => (
                <tr key={m.id} className="border-b border-line last:border-b-0">
                  <td className="py-2 pr-3 text-ink">{m.address}</td>
                  <td className="py-2 pr-3 text-ink">{m.name}</td>
                  <td className="py-2 pr-3 text-muted">{m.shop?.name ?? '-'}</td>
                  <td className="py-2 pr-3 text-muted">{m.language}</td>
                  <td className="py-2 pr-3">
                    <button
                      onClick={() => void patch(m.id, { active: !m.active })}
                      className="rounded-full border border-line px-2 py-0.5 text-[12px] text-ink hover:border-faint"
                    >
                      {m.active ? 'Active' : 'Off'}
                    </button>
                  </td>
                  <td className="py-2 pr-3 text-right text-muted tabular-nums">{m.ticketCount}</td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => void remove(m.id)}
                      disabled={m.ticketCount > 0}
                      title={m.ticketCount > 0 ? 'Deactivate instead - this address has tickets' : undefined}
                      className="text-[12px] text-loss disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[12px] text-muted">
          Email address
          <input aria-label="Email address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="support@panetti.no"
            className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink" />
        </label>
        <label className="block text-[12px] text-muted">
          Name
          <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Panetti Norway"
            className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink" />
        </label>
        <label className="block text-[12px] text-muted">
          Shop
          <select aria-label="Shop" value={shopId} onChange={(e) => setShopId(e.target.value)}
            className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink">
            <option value="">None - order numbers will not be brand-scoped</option>
            {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="block text-[12px] text-muted">
          Language
          <select aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value)}
            className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink">
            {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="col-span-2 block text-[12px] text-muted">
          Signature
          <textarea aria-label="Signature" value={signature} onChange={(e) => setSignature(e.target.value)} rows={2}
            placeholder={'Med vennlig hilsen\nPanetti kundeservice'}
            className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink" />
        </label>
      </div>
      <div className="mt-2 flex justify-end">
        <button onClick={() => void add()} disabled={!address.trim() || !name.trim()}
          className="rounded-[var(--radius-control)] bg-ink px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-40">
          Add address
        </button>
      </div>
    </section>
  )
}

function HowToConnect({ forwardingAddress }: { forwardingAddress: string | null }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-4 text-[13px]">
      <h2 className="mb-2 text-[15px] font-semibold text-ink">How to connect an address</h2>
      {forwardingAddress ? (
        <p className="text-ink">
          Forward each address to <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-[12px]">{forwardingAddress}</code>.
          Every email forwarded there lands in the inbox within seconds.
        </p>
      ) : (
        <p className="text-warn">
          Set <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-[12px]">POSTMARK_INBOUND_ADDRESS</code> to your
          Postmark server&apos;s inbound address (Postmark → your server → Inbound stream → Settings) so this page can show
          where to forward.
        </p>
      )}
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
        <li><span className="text-ink">Google Workspace:</span> Admin console → Gmail → Routing → recipient address map. No confirmation step.</li>
        <li><span className="text-ink">Gmail mailbox:</span> Settings → Forwarding. Google emails a confirmation link - it arrives HERE as a ticket; open it and click the link.</li>
        <li><span className="text-ink">Microsoft 365:</span> external forwarding is blocked by default - an admin enables it in the outbound spam policy first.</li>
        <li><span className="text-ink">Domain host (one.com, cPanel…):</span> a plain forward or alias to the address above.</li>
      </ul>
      <p className="mt-2 text-muted">
        Sending: verify each brand domain in Postmark (DKIM + Return-Path DNS records) so replies leave from these addresses.
      </p>
    </section>
  )
}

function Macros({
  macros, onChanged, toastError, toastOk,
}: {
  macros: MacroRow[]
  onChanged: () => Promise<void>
  toastError: (t: string) => void
  toastOk: (t: string) => void
}) {
  const [name, setName] = useState('')
  const [language, setLanguage] = useState('en')
  const [body, setBody] = useState('')
  const [editing, setEditing] = useState<string | null>(null)

  async function save() {
    const res = editing
      ? await fetch(`/api/inbox/macros/${editing}`, { method: 'PATCH', body: JSON.stringify({ name, language, body }) })
      : await fetch('/api/inbox/macros', { method: 'POST', body: JSON.stringify({ name, language, body }) })
    if (!res.ok) {
      toastError((await res.json()).error ?? 'Could not save the macro')
      return
    }
    toastOk(editing ? 'Macro updated' : 'Macro added')
    setName(''); setBody(''); setEditing(null)
    await onChanged()
  }

  async function remove(id: string) {
    const res = await fetch(`/api/inbox/macros/${id}`, { method: 'DELETE' })
    if (!res.ok) toastError((await res.json()).error ?? 'Could not remove the macro')
    else toastOk('Macro removed')
    await onChanged()
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <h2 className="mb-1 text-[15px] font-semibold text-ink">Macros</h2>
      <p className="mb-3 text-[12px] text-muted">
        Variables:{' '}
        {MACRO_VARIABLES.map((v) => (
          <code key={v} className="mr-1 rounded bg-panel px-1.5 py-0.5 font-mono text-[11px]">{'{{' + v + '}}'}</code>
        ))}
      </p>
      {macros.length > 0 && (
        <div className="mb-4 space-y-1.5">
          {macros.map((m) => (
            <div key={m.id} className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5 text-[13px] last:border-b-0">
              <div className="min-w-0">
                <span className="font-semibold text-ink">{m.name}</span>
                <span className="ml-1.5 text-[11px] text-faint">{m.language}</span>
                <div className="truncate text-[12px] text-muted">{m.body.split('\n')[0]}</div>
              </div>
              <div className="flex shrink-0 gap-2 text-[12px]">
                <button onClick={() => { setEditing(m.id); setName(m.name); setLanguage(m.language); setBody(m.body) }} className="text-accent">
                  Edit
                </button>
                <button onClick={() => void remove(m.id)} className="text-loss">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[12px] text-muted">
          Macro name
          <input aria-label="Macro name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Where is my order?"
            className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink" />
        </label>
        <label className="block text-[12px] text-muted">
          Language
          <select aria-label="Macro language" value={language} onChange={(e) => setLanguage(e.target.value)}
            className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink">
            {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="col-span-2 block text-[12px] text-muted">
          Body
          <textarea aria-label="Macro body" value={body} onChange={(e) => setBody(e.target.value)} rows={4}
            placeholder={'Hi {{customer_name}},\n\nYour order {{order_number}} is {{delivery_status}}.'}
            className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink" />
        </label>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        {editing && (
          <button onClick={() => { setEditing(null); setName(''); setBody('') }} className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-[13px] text-ink">
            Cancel
          </button>
        )}
        <button onClick={() => void save()} disabled={!name.trim() || !body.trim()}
          className="rounded-[var(--radius-control)] bg-ink px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-40">
          {editing ? 'Save macro' : 'Add macro'}
        </button>
      </div>
    </section>
  )
}
