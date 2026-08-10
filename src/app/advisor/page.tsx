import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { AppShell } from '@/components/shell/AppShell'
import { AdvisorClient, type Briefing } from './AdvisorClient'

export const dynamic = 'force-dynamic'

export default async function AdvisorPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  // Company money. An ambassador lands on their own portal instead.
  if (user.role !== 'ADMIN') redirect('/portal')

  const row = await db.briefing.findFirst({ orderBy: { day: 'desc' } })

  const initial: Briefing | null = row
    ? {
        day: row.day.toISOString().slice(0, 10),
        from: row.from.toISOString().slice(0, 10),
        to: row.to.toISOString().slice(0, 10),
        facts: JSON.parse(row.facts),
        items: row.items ? JSON.parse(row.items) : null,
        error: row.error,
        model: row.model,
      }
    : null

  return (
    <AppShell email={user.email}>
      <AdvisorClient initial={initial} />
    </AppShell>
  )
}
