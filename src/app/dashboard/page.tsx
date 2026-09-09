import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { DashboardClient } from './DashboardClient'
import { OperationsDashboard } from './OperationsDashboard'
import { getSetting } from '@/lib/settings'
import type { Preset } from '@/lib/dates'

/**
 * Reading this page live is the whole point of it, for either reader: the
 * owner's figures move with every sync, and his manager's list is a list of
 * jobs that are still outstanding.
 */
export const dynamic = 'force-dynamic'

/**
 * Two dashboards behind one address.
 *
 * The client asked that his operations manager open on "one big dashboard"
 * showing the most important tasks from each of his tabs. That is the same
 * idea the owner's dashboard serves - the page you open on - so it keeps the
 * same name and the same address, and the role decides which one is drawn.
 * The alternative was a second word for one thing, and a second entry on a
 * sidebar the client has already asked to keep short.
 */
export default async function DashboardPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role === 'OPERATIONS') return <OperationsDashboard user={user} />
  if (user.role !== 'ADMIN') redirect('/portal')

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  // If the admin is also an ambassador (same email), offer a link to their own
  // ambassador portal. Most admins are not, and then no link is shown.
  const ownAmbassador = await db.ambassador.findFirst({
    where: { email: user.email },
    select: { id: true },
  })

  const setting = await getSetting()
  return (
    <DashboardClient
      email={user.email}
      shops={shops}
      initialPreset={setting.defaultPreset as Preset}
      hasOwnAmbassador={ownAmbassador !== null}
    />
  )
}
