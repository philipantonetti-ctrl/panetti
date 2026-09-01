import { redirect } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { FINANCE_TABS, PageTabs } from '@/components/shell/PageTabs'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { FinanceClient } from './FinanceClient'

export const dynamic = 'force-dynamic'

export default async function FinancePage() {
  const user = await currentUser()
  if (!user || user.role !== 'ADMIN') redirect('/login')

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
    <AppShell email={user.email}>
      {/* Said out loud because it bounds what this page can be blamed for: the
          figures are Visma's, and a payment booked there is what clears a row
          here. */}
      <PageHeader
        title="Finance"
        subtitle="What customers still owe us, straight from Visma. Webshop orders paid at the checkout are not counted."
      />
      <PageTabs tabs={FINANCE_TABS} />
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
