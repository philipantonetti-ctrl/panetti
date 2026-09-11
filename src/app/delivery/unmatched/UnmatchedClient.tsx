'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { DELIVERY_TABS, PageTabs } from '@/components/shell/PageTabs'
import { useLiveTick } from '@/lib/use-live-tick'
import { UnattachedParcels, type UnlinkedParcel } from '../DeliveryClient'

/** The three fields of /api/delivery this tab reads. The rest is the figures tab's. */
type Payload = {
  unlinked: UnlinkedParcel[]
  unlinkedTotal: number
  shops: { id: string; name: string }[]
}

/**
 * The parcels no rule could place, on a tab of their own.
 *
 * They are not a delivery figure. The list is the same whatever shop or date
 * the Delivery tab is filtered to, and the daily chore on it - choose the
 * order, or say it is not a customer parcel - has nothing to do with medians
 * and on-time rates. It used to sit below all of those, at the bottom of a
 * long page; here it is one click from the sidebar and open on arrival.
 */
export function UnmatchedClient({
  email,
  role = 'ADMIN',
}: {
  email: string
  /** Which sidebar to draw: the owner's full menu, or the operations tabs. */
  role?: 'ADMIN' | 'OPERATIONS'
}) {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')
  // Bumped after a parcel is linked or dismissed, so the list shows what is left.
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
        subtitle="Parcels that no rule could place, each with the reason, waiting for a person to choose the order."
      />
      <PageTabs tabs={DELIVERY_TABS} />
      <PageBody>
        {error ? (
          <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">
            {error}
          </div>
        ) : !data ? (
          <div className="skeleton h-[240px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
        ) : (
          <UnattachedParcels
            items={data.unlinked}
            total={data.unlinkedTotal}
            shops={data.shops}
            onChanged={() => setReloadKey((k) => k + 1)}
            defaultOpen
          />
        )}
      </PageBody>
    </AppShell>
  )
}
