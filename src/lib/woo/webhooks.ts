import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { db } from '../db'
import { decryptSecret, encryptSecret } from '../secrets'
import { activateWebhook, createWebhook, fetchWebhooks, type WooCredentials } from './client'

/**
 * Live sync: the store calls US the moment an order changes, instead of us
 * asking every 15 minutes. These four topics cover the whole life of an order —
 * a refund or cancellation is an UPDATE (the status changes), a trashed order
 * is a delete, an untrashed one is a restore.
 */
export const WEBHOOK_TOPICS = [
  'order.created',
  'order.updated',
  'order.deleted',
  'order.restored',
] as const

/**
 * Where this deployment can be reached from the internet. Explicit APP_URL
 * first; on Vercel the production URL env var is there anyway. Local dev has
 * neither — and a webhook pointing at localhost would be worse than none.
 */
export function appBaseUrl(): string | null {
  const explicit = process.env.APP_URL
  if (explicit) return explicit.replace(/\/$/, '')
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (vercel) return `https://${vercel}`
  return null
}

export function webhookDeliveryUrl(base: string, shopId: string): string {
  return `${base}/api/webhooks/woo/${shopId}`
}

/**
 * Woo signs every delivery: base64(HMAC-SHA256(raw body, secret)). Compared
 * timing-safely — a signature check that leaks how far it matched is no check.
 */
export function verifyWooSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest()
  let given: Buffer
  try {
    given = Buffer.from(signature, 'base64')
  } catch {
    return false
  }
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * Make sure the store streams its order changes to us: every topic registered,
 * pointing at this deployment, signing with this shop's secret. Idempotent and
 * self-healing — run after every completed sync, it re-creates what someone
 * deleted and re-activates what Woo paused after delivery failures.
 *
 * Talks to the WP REST API server-to-server; nothing here (or in the
 * deliveries themselves, which Woo queues in the background) runs in a
 * shopper's page load.
 */
export async function ensureWebhooks(
  shopId: string,
  creds: WooCredentials,
): Promise<{ registered: number; activated: number } | null> {
  const base = appBaseUrl()
  if (!base) return null // nowhere reachable to deliver to — nothing to set up

  // The signing secret: one per shop, made by us, stored like the API keys.
  // Unreadable (AUTH_SECRET rotated) counts as absent: a new one is minted and
  // pushed onto the store's webhooks below, so deliveries verify again.
  const shop = await db.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { wooWebhookSecret: true },
  })
  let secret: string | null = null
  if (shop.wooWebhookSecret) {
    try {
      secret = decryptSecret(shop.wooWebhookSecret)
    } catch {
      secret = null
    }
  }
  const minted = secret === null
  if (secret === null) {
    secret = randomBytes(24).toString('hex')
    await db.shop.update({
      where: { id: shopId },
      data: { wooWebhookSecret: encryptSecret(secret) },
    })
  }

  const deliveryUrl = webhookDeliveryUrl(base, shopId)
  const existing = await fetchWebhooks(creds)

  let registered = 0
  let activated = 0
  for (const topic of WEBHOOK_TOPICS) {
    const ours = existing.find((w) => w.topic === topic && w.delivery_url === deliveryUrl)
    if (!ours) {
      await createWebhook(creds, {
        name: `panetti-analytics ${topic}`,
        topic,
        deliveryUrl,
        secret,
      })
      registered++
    } else if (ours.status !== 'active' || minted) {
      await activateWebhook(creds, ours.id, secret)
      activated++
    }
  }

  return { registered, activated }
}
