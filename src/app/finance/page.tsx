import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { FINANCE_TABS, PageTabs } from '@/components/shell/PageTabs'
import { currentUser } from '@/lib/auth/current-user'
import { canRunOperations, canSeeProfit } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { FinanceClient } from './FinanceClient'

export const dynamic = 'force-dynamic'

export default async function FinancePage() {
  const user = await currentUser()
  // Receivables is the operations manager's too - the client asked for this
  // tab by name. The Payouts tab beside it is not, and the middleware matches
  // /finance whole rather than as a prefix so that stays true.
  if (!canRunOperations(user)) redirect('/login')
  const bothTabs = canSeeProfit(user)

  // Whatever the last COMPLETE read of Visma established. A rate-limited run
  // leaves the previous snapshot standing rather than writing a half-read
  // ledger, so this page can be stale but never short.
  const rows = await db.receivable.findMany({
    select: {
      referenceNumber: true, customerName: true, documentType: true,
      documentDate: true, dueDate: true, currency: true, balance: true,
    },
  })

  return (
    <AppShell email={user.email} role={user.role === 'OPERATIONS' ? 'OPERATIONS' : 'ADMIN'}>
      {/* Said out loud because it bounds what this page can be blamed for: the
          figures are Visma's, and a payment booked there is what clears a row
          here. */}
      <PageHeader
        title="Finance"
        subtitle="What customers still owe us, straight from Visma. Webshop orders paid at the checkout are not counted."
      />
      {/* One tab is not a choice, and offering Payouts to someone the
          middleware would bounce is a door that does not open. */}
      {bothTabs && <PageTabs tabs={FINANCE_TABS} />}
      <PageBody>
        <FinanceClient
          rows={rows.map((r) => ({
            referenceNumber: r.referenceNumber,
            customerName: r.customerName,
            documentType: r.documentType,
            documentDate: r.documentDate.toISOString(),
            dueDate: r.dueDate?.toISOString() ?? null,
            currency: r.currency,
            balance: r.balance,
          }))}
          now={new Date().toISOString()}
        />
      </PageBody>
    </AppShell>
  )
}
