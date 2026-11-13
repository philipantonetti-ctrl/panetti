'use client'

import { useState, type FormEvent } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { DELIVERY_TABS, PageTabs } from '@/components/shell/PageTabs'

const INPUT =
  'rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint'

/** Type a panetti.com order number, get the XML file the warehouse reads. */
export function WarehouseFileClient({ email, role }: { email: string; role: 'ADMIN' | 'OPERATIONS' }) {
  const [number, setNumber] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!number.trim()) return
    setBusy(true)
    setError('')
    try {
      const r = await fetch(`/api/warehouse/order-xml?${new URLSearchParams({ number: number.trim() })}`)
      if (!r.ok) {
        const body = await r.json().catch(() => null)
        setError(body?.error ?? 'Could not make the warehouse file')
        return
      }
      const name = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') ?? '')?.[1] ?? 'order.xml'
      const url = URL.createObjectURL(await r.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setError('Could not make the warehouse file')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AppShell email={email} role={role}>
      <PageHeader title="Delivery" subtitle="A panetti.com order as the XML file the warehouse reads." />
      <PageTabs tabs={DELIVERY_TABS} />
      <PageBody>
        <form onSubmit={submit} className="mb-5 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">
            panetti.com order number
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="e.g. 1234"
              className={`${INPUT} w-64`}
            />
          </label>
          <button
            type="submit"
            disabled={busy || !number.trim()}
            className="rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Download XML
          </button>
        </form>
        {error && (
          <p data-testid="warehouse-file-error" className="text-sm text-loss">
            {error}
          </p>
        )}
      </PageBody>
    </AppShell>
  )
}
