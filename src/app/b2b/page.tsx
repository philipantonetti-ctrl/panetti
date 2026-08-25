import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { B2bClient } from './B2bClient'

export default async function B2bPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true },
    orderBy: { name: 'asc' },
  })

  // What the last Visma sales import did. Read here rather than fetched: it
  // changes once every fifteen minutes at most, so a value fixed at page load
  // is as fresh as anything a client fetch would get, and it costs no round
  // trip. Null when no run has been recorded - a workspace without Visma.
  const run = await db.b2bImportRun.findUnique({ where: { id: 'singleton' } })

  return (
    <B2bClient
      email={user.email}
      shops={shops}
      importRun={run ? { ...run, ranAt: run.ranAt.toISOString() } : null}
    />
  )
}
