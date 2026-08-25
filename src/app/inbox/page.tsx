import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { InboxClient } from './InboxClient'

export const dynamic = 'force-dynamic'

export default async function InboxPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  // Customer conversations sit beside order values and refunds - company
  // business. An ambassador lands on their own portal instead.
  if (user.role !== 'ADMIN') redirect('/portal')

  const [mailboxes, users, macros] = await Promise.all([
    db.mailbox.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, address: true, name: true, language: true } }),
    db.user.findMany({ where: { role: { in: ['ADMIN', 'MARKETING'] } }, orderBy: { email: 'asc' }, select: { id: true, email: true } }),
    db.macro.findMany({ orderBy: [{ name: 'asc' }, { language: 'asc' }], select: { id: true, name: true, language: true, body: true } }),
  ])
  return <InboxClient me={{ id: user.userId, email: user.email }} mailboxes={mailboxes} users={users} macros={macros} />
}
