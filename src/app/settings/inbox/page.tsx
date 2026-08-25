import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { InboxSettingsClient } from './InboxSettingsClient'

export const dynamic = 'force-dynamic'

export default async function InboxSettingsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const [mailboxes, shops, macros] = await Promise.all([
    db.mailbox.findMany({
      orderBy: { name: 'asc' },
      include: { shop: { select: { id: true, name: true } }, _count: { select: { tickets: true } } },
    }),
    db.shop.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    db.macro.findMany({ orderBy: [{ name: 'asc' }, { language: 'asc' }] }),
  ])

  return (
    <InboxSettingsClient
      email={user.email}
      initialMailboxes={mailboxes.map((m) => ({
        id: m.id, address: m.address, name: m.name, language: m.language, signature: m.signature,
        active: m.active, shop: m.shop, ticketCount: m._count.tickets,
      }))}
      shops={shops}
      initialMacros={macros}
      forwardingAddress={process.env.POSTMARK_INBOUND_ADDRESS ?? null}
    />
  )
}
