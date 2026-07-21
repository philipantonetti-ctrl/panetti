'use client'

import Link from 'next/link'
import { useState } from 'react'

type Item = { href: string; title: string; blurb: string; icon: string }

/** Our real features arranged in BeProfit's tab layout — every tile is a live page. */
const TABS: { name: string; items: Item[] }[] = [
  {
    name: 'Costs',
    items: [
      { href: '/settings/costs', title: 'Product Costs', blurb: 'Set your product costs', icon: '📦' },
      { href: '/settings/expenses', title: 'Operational Expenses', blurb: 'Add your operational expenses', icon: '💸' },
      { href: '/settings/fees', title: 'Fulfillment', blurb: 'Set your shipping & handling preferences', icon: '🚚' },
      { href: '/settings/processing-fees', title: 'Processing Fees', blurb: 'Add payment gateway charges', icon: '🪙' },
    ],
  },
  {
    name: 'Shop',
    items: [
      { href: '/settings/shop', title: 'General settings', blurb: 'Set each webshop’s formats & info', icon: '⚙️' },
      { href: '/settings/shops', title: 'Connected stores', blurb: 'Connect WooCommerce and sync orders', icon: '🔌' },
    ],
  },
  {
    name: 'User',
    items: [
      { href: '/settings/ambassadors', title: 'Ambassadors', blurb: 'Invite links, codes and commissions', icon: '🤝' },
      { href: '/account', title: 'Your account', blurb: 'Your details and your password', icon: '👤' },
    ],
  },
  {
    name: 'Workspace',
    items: [
      {
        href: '/settings/general',
        title: 'Workspace defaults',
        blurb: 'What every new webshop starts with — each shop can override these under Shop',
        icon: '🌍',
      },
    ],
  },
]

export function SettingsTabs() {
  const [active, setActive] = useState(0)

  return (
    <div>
      <div role="tablist" className="flex gap-6 border-b border-line">
        {TABS.map((tab, i) => (
          <button
            key={tab.name}
            role="tab"
            aria-selected={i === active}
            onClick={() => setActive(i)}
            className={`-mb-px border-b-2 pb-2 text-[13px] transition-colors duration-150 ${
              i === active
                ? 'border-ink font-semibold text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {tab.name}
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-[var(--radius-card)] border border-line bg-surface p-5">
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          {TABS[active].items.map((item) => (
            <Link key={item.href} href={item.href} className="group flex items-start gap-3">
              <span
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-panel text-[15px]"
              >
                {item.icon}
              </span>
              <span>
                <span className="block text-[13px] font-semibold text-ink group-hover:underline">
                  {item.title}
                </span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">
                  {item.blurb}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
