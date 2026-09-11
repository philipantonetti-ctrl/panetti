'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { DELIVERY_TABS, PageTabs } from '@/components/shell/PageTabs'
import { useLiveTick } from '@/lib/use-live-tick'
import { ImportsList, type ImportRow } from '../DeliveryClient'
import { UploadBox } from '../UploadBox'

/** The one field of /api/delivery this tab reads. */
type Payload = { imports: ImportRow[] }

/**
 * The warehouse's files: the box to send one by hand, and the record of every
 * file read. Its own tab because sending a file is a chore that belongs to a
 * moment (the email did not arrive), not to a reading of the figures, and it
 * used to hide at the very bottom of them.
 */
export function ImportsClient({
  email,
  role = 'ADMIN',
}: {
  email: string
  /** Which sidebar to draw: the owner's full menu, or the operations tabs. */
  role?: 'ADMIN' | 'OPERATIONS'
}) {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')
  // Bumped after an upload, so the file just sent appears in the list below it.
  const [reloadKey, setReloadKey] = useState(0)
  const tick = useLiveTick()

  useEffect(() => {
    const ctrl = new AbortController()
    // The list does not depend on the range, but the route wants one.
    fetch('/api/delivery?preset=this_month', { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? 'Could not load')
        return res.json()
      })
      .then((json: Payload) => {
        setData(json)
        setError('')
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
    return () => ctrl.abort() // a superseded response must never overwrite a newer one
  }, [tick, reloadKey])

  return (
    <AppShell email={email} role={role}>
      <PageHeader
        title="Delivery"
        subtitle="The warehouse's daily tracking files: send one by hand, and see what every file attached."
      />
      <PageTabs tabs={DELIVERY_TABS} />
      <PageBody>
        <div className="space-y-3">
          <UploadBox onImported={() => setReloadKey((k) => k + 1)} />
          {error ? (
            <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">
              {error}
            </div>
          ) : !data ? (
            <div className="skeleton h-[240px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
          ) : (
            <ImportsList items={data.imports} />
          )}
        </div>
      </PageBody>
    </AppShell>
  )
}
