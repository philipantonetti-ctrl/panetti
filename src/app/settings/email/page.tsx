import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { KlaviyoClient, type KlaviyoStatus } from './KlaviyoClient'

export default async function KlaviyoSettingsPage() {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const config = await db.klaviyoConfig.findUnique({ where: { id: 'singleton' } })
  const initialStatus: KlaviyoStatus = config
    ? {
        connected: true,
        currency: config.currency,
        active: config.active,
        hasOrderMetric: config.conversionMetricId !== null,
        lastSyncAt: config.lastSyncAt?.toISOString() ?? null,
        lastError: config.lastError,
        campaigns: await db.emailCampaignStat.count(),
      }
    : { connected: false }

  return <KlaviyoClient email={user.email} initialStatus={initialStatus} />
}
