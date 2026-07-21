import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'

export default async function ShopSettingsIndex() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const [shops, base] = await Promise.all([
    db.shop.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, currency: true, timezone: true },
    }),
    getSetting(),
  ])

  return (
    <AppShell email={user.email}>
      <PageHeader title="Shop settings" subtitle="Pick a webshop to set its standards and formats." />
      <PageBody>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shops.map((s) => (
            <Link
              key={s.id}
              href={`/settings/shop/${s.id}`}
              className="rounded-[var(--radius-card)] border border-line bg-surface p-4 transition-colors duration-150 hover:bg-panel"
            >
              <span className="block text-[13px] font-semibold text-ink">{s.name}</span>
              <span className="mt-1 block text-[12px] text-muted">
                {s.currency} · {s.timezone ?? base.timezone}
              </span>
            </Link>
          ))}
        </div>
      </PageBody>
    </AppShell>
  )
}
