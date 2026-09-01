'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Two pages that belong together, shown as tabs rather than as two sidebar
 * entries.
 *
 * The sidebar is a list of places, and it grows every time a feature ships.
 * Where two screens are the same subject seen twice - the assistant reading
 * the business, and the assistant answering customers - they cost one entry
 * and a tab, not two entries.
 */

export type Tab = { href: string; label: string }

export function PageTabs({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname()

  return (
    <nav aria-label="Section" className="flex gap-1 border-b border-line px-6">
      {tabs.map((tab) => {
        // Exact match: /advisor must not light up while /advisor/support is
        // the page being read.
        const active = pathname === tab.href
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2.5 text-[13px] transition-colors duration-150 motion-reduce:transition-none ${
              active
                ? 'border-accent font-semibold text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}


/**
 * Marketing's two screens: money spent on ads, and the email campaigns from
 * Klaviyo. One sidebar entry, two tabs - the same trade the assistant made.
 */
export const MARKETING_TABS: Tab[] = [
  { href: '/marketing', label: 'Advertising' },
  { href: '/marketing/email', label: 'Email' },
]

/**
 * Finance's two screens: what customers still owe us, and what Dintero has
 * paid out to the bank. One sidebar entry, two tabs - marketing's trade.
 */
export const FINANCE_TABS: Tab[] = [
  { href: '/finance', label: 'Receivables' },
  { href: '/finance/payouts', label: 'Payouts' },
]
