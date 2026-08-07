import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { DeliverySettingsClient } from './DeliverySettingsClient'

/**
 * Thin on purpose, like the Delivery analytics page it sits beside: all of
 * the substance — Bring/Slack config, promises, tracked shops, imports —
 * comes back in one shape from GET /api/delivery/settings, which the client
 * fetches itself. Duplicating that shape here via a second, parallel set of
 * db queries would be the same data contract maintained twice.
 */
export default async function DeliverySettingsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  return <DeliverySettingsClient email={user.email} />
}
