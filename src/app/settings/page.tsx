import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { TopBar } from '@/components/TopBar'

/** Settings → Costs. One place to reach everything that feeds the profit numbers. */
const TILES = [
  {
    href: '/settings/costs',
    title: 'Product Costs',
    blurb: 'Set your product costs',
    icon: '📦',
  },
  {
    href: '/settings/expenses',
    title: 'Operational Expenses',
    blurb: 'Add your operational expenses',
    icon: '🧾',
  },
  {
    href: '/settings/shops',
    title: 'Shops',
    blurb: 'Connect your WooCommerce stores',
    icon: '🏬',
  },
]

export default async function SettingsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  return (
    <div className="min-h-screen bg-slate-50">
      <TopBar email={user.email} />

      <main className="mx-auto max-w-5xl p-5">
        <h1 className="text-lg font-bold text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">All your settings in one place</p>

        <div className="mt-4 border-b border-slate-200">
          <span className="inline-block border-b-2 border-violet-700 pb-2 text-sm font-semibold text-violet-700">
            Costs
          </span>
        </div>

        <div className="mt-5 rounded-xl border border-slate-200 bg-white p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {TILES.map((tile) => (
              <Link
                key={tile.href}
                href={tile.href}
                className="flex items-start gap-3 rounded-lg p-3 transition hover:bg-violet-50"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-100 text-base">
                  {tile.icon}
                </span>
                <span>
                  <span className="block text-sm font-semibold text-slate-900">{tile.title}</span>
                  <span className="block text-xs text-slate-500">{tile.blurb}</span>
                </span>
              </Link>
            ))}
          </div>
        </div>

        <p className="mt-4 text-[11px] text-slate-400">
          Marketing platforms, processing fees and returns come in the next phases — they will appear
          here.
        </p>
      </main>
    </div>
  )
}
