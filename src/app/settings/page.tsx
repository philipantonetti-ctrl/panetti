import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'

/** Everything that feeds the profit numbers, in one place. */
const TILES = [
  {
    href: '/settings/costs',
    title: 'Product costs',
    blurb: 'What each product costs you to buy and handle',
  },
  {
    href: '/settings/expenses',
    title: 'Operational expenses',
    blurb: 'Rent, payroll and subscriptions, spread across the days they cover',
  },
  {
    href: '/settings/shops',
    title: 'Shops',
    blurb: 'Connect your WooCommerce stores and sync their orders',
  },
  {
    href: '/settings/ambassadors',
    title: 'Ambassadors',
    blurb: 'Add ambassadors, send invite links and set what they earn',
  },
  {
    href: '/settings/fees',
    title: 'Fulfillment and fees',
    blurb: 'Per-order fulfillment rates and the Dintero payment fee',
  },
]

export default async function SettingsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  return (
    <AppShell email={user.email}>
      <PageHeader title="Settings" subtitle="Everything that feeds the profit numbers." />

      <PageBody>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TILES.map((tile) => (
            <Link
              key={tile.href}
              href={tile.href}
              className="rounded-[var(--radius-card)] border border-line bg-surface p-4 transition-colors duration-150 hover:bg-panel"
            >
              <span className="block text-[13px] font-semibold text-ink">{tile.title}</span>
              <span className="mt-1 block text-[12px] leading-relaxed text-muted">{tile.blurb}</span>
            </Link>
          ))}
        </div>

        <p className="mt-4 text-[12px] text-muted">
          Marketing platforms, processing fees and returns arrive in the next phases. They will
          appear here.
        </p>
      </PageBody>
    </AppShell>
  )
}
