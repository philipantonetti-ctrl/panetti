'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Four views behind one sidebar entry.
 *
 * One entry rather than four, because the sidebar already carries 14 items and
 * Philip asked for a single tab. Each button is a real route, so a link to the
 * purchase orders is a link someone can send, and the back button behaves.
 *
 * Forecast is first and is the index route: it is the answer, and the answer
 * should not be behind a click.
 */
const VIEWS = [
  { href: '/inventory', label: 'Forecast' },
  { href: '/inventory/stock', label: 'Stock' },
  { href: '/inventory/purchase-orders', label: 'Purchase orders' },
  { href: '/inventory/suppliers', label: 'Suppliers & lead times' },
] as const

export function InventoryTabs() {
  const pathname = usePathname()

  return (
    <div role="tablist" className="flex flex-wrap gap-1">
      {VIEWS.map((v) => {
        // Exact match for the index, prefix for the rest — otherwise /inventory
        // would light up on every child route at once.
        const active = v.href === '/inventory' ? pathname === v.href : pathname.startsWith(v.href)
        return (
          <Link
            key={v.href}
            href={v.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] transition-colors duration-150 ${
              active
                ? 'bg-accent-soft font-semibold text-accent-ink'
                : 'text-muted hover:bg-panel hover:text-ink'
            }`}
          >
            {v.label}
          </Link>
        )
      })}
    </div>
  )
}
