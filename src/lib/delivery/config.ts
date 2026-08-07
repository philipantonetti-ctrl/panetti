import { db } from '../db'
import { decryptSecret } from '../secrets'
import type { BringCredentials } from '../bring/client'

/**
 * The delivery integration's credentials, decrypted.
 *
 * Never throws. A missing or unreadable secret returns null, and the caller
 * reports "not connected" — the same visible-failure rule the shop sync uses
 * when AUTH_SECRET has changed under it.
 */
export async function getDeliveryConfig(): Promise<{
  creds: BringCredentials | null
  slackWebhookUrl: string | null
}> {
  const row = await db.deliveryConfig.findUnique({ where: { id: 'singleton' } })
  if (!row) return { creds: null, slackWebhookUrl: null }

  let creds: BringCredentials | null = null
  if (row.bringApiUid && row.bringApiKey && row.bringClientUrl) {
    try {
      creds = {
        uid: row.bringApiUid,
        key: decryptSecret(row.bringApiKey),
        clientUrl: row.bringClientUrl,
      }
    } catch {
      creds = null // AUTH_SECRET changed; the settings page says "reconnect".
    }
  }

  let slackWebhookUrl: string | null = null
  if (row.slackWebhookUrl) {
    try {
      slackWebhookUrl = decryptSecret(row.slackWebhookUrl)
    } catch {
      slackWebhookUrl = null
    }
  }

  return { creds, slackWebhookUrl }
}
