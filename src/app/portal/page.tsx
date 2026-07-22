import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { PortalClient } from './PortalClient'
import { getSetting } from '@/lib/settings'
import type { Preset } from '@/lib/dates'

export default async function PortalPage() {
  const user = await currentUser()
  if (!user) redirect('/login')

  // An admin can view their OWN ambassador portal (the ambassador that shares
  // their email). With no such ambassador there is nothing to show, so send them
  // back to the dashboard. Kept as admin, they get the admin nav to return.
  let admin = false
  if (user.role === 'ADMIN') {
    const mine = await db.ambassador.findFirst({ where: { email: user.email }, select: { id: true } })
    if (!mine) redirect('/dashboard')
    admin = true
  }

  const setting = await getSetting()
  return <PortalClient email={user.email} initialPreset={setting.defaultPreset as Preset} admin={admin} />
}
