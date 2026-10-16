'use client'

import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { PAYOUT_SETTINGS_TABS, PageTabs } from '@/components/shell/PageTabs'
import { VismaPostingCard } from '../VismaPostingCard'

/**
 * The Visma posting tab of Payout settings: the mode and each shop's Visma
 * accounts, on a page of their own instead of under every shop's Dintero card.
 */
export function VismaPostingClient({ email }: { email: string }) {
  return (
    <AppShell email={email}>
      <PageHeader
        title="Payouts (Dintero)"
        subtitle="Post each Dintero payout into the Visma test company, the way the bookkeeper's drawing describes."
      />
      <PageTabs tabs={PAYOUT_SETTINGS_TABS} />
      <PageBody>
        <VismaPostingCard />
      </PageBody>
    </AppShell>
  )
}
