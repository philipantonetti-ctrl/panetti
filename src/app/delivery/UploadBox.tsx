'use client'

import { useState } from 'react'

type Result = {
  parsed: number
  linked: number
  unmatched: { orderNumber: string; reason: string }[]
  unaccounted: number
}

/**
 * The manual way in. It exists permanently, not as a stopgap: when the
 * warehouse's email does not arrive, this is the fix.
 *
 * It posts to /api/delivery/import, which calls the same `importWarehouseFile`
 * the inbound email route calls — one path, one set of rules, one linking
 * behaviour. That matters beyond tidiness: both paths upsert on the one
 * `Shipment.trackingNumber` unique key, so a second path with a different
 * linking rule could silently overwrite a correct link with a wrong one.
 */
export function UploadBox({ onImported }: { onImported: () => void }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function send(file: File) {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const body = new FormData()
      body.append('file', file)
      const res = await fetch('/api/delivery/import', { method: 'POST', body })
      const json = await res.json()
      if (!res.ok) setError(json.error ?? 'Could not read this file.')
      else {
        setResult(json)
        onImported()
      }
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <p className="text-[13px] font-semibold text-ink">Tracking file from the warehouse</p>
      <p className="mt-0.5 text-[12px] text-muted">
        The daily Excel report, exactly as the warehouse sends it. PDF and CSV work too. Only the
        tracking numbers are read — Bring tells us which order each parcel belongs to.
      </p>

      <input
        type="file"
        accept=".xlsx,.pdf,.csv,.txt"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) send(file)
          e.target.value = ''
        }}
        className="mt-3 block text-[12px] text-muted file:mr-3 file:rounded-[var(--radius-control)] file:border file:border-line file:bg-panel file:px-3 file:py-1.5 file:text-[12px] file:text-ink"
      />

      {busy && <p className="mt-2 text-[12px] text-muted">Reading the file…</p>}

      {result && (
        <p className="mt-2 text-[12px] text-ink">
          {/*
            Parcels, not numbers. A file lists two long numbers per parcel — a
            package number and a shipment reference — so counting numbers would
            report a flawless import as half of them vanishing.
          */}
          Read {result.parsed} {result.parsed === 1 ? 'parcel' : 'parcels'}, linked {result.linked}.
          {/*
            The shortfall is the signal, so it is stated first and in warn. Most
            of it usually has no reason we can name — a row whose layout we
            could not read leaves nothing to describe — so the count comes
            first and the reasons we DO have follow it.
          */}
          {result.unaccounted > 0 && (
            <span className="text-warn">
              {' '}
              {result.unaccounted} could not be matched to an order.
              {result.unmatched.length > 0 && ` ${result.unmatched[0].reason}.`}
            </span>
          )}
        </p>
      )}

      {error && <p className="mt-2 text-[12px] text-loss">{error}</p>}
    </div>
  )
}
