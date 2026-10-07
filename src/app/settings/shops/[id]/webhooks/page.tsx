import { notFound, redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'
import { fetchWebhooks } from '@/lib/woo/client'
import { appBaseUrl, webhookDeliveryUrl } from '@/lib/woo/webhooks'
import { WebhooksClient, type Webhook } from './WebhooksClient'

/**
 * The store's webhooks, read live on every visit: this page exists for the
 * moment someone asks "why did orders stop reaching Visma?", and a cached
 * answer to that question is worse than a slow one.
 */
export default async function ShopWebhooksPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'ADMIN') redirect('/portal')

  const { id } = await params
  const shop = await db.shop.findUnique({
    where: { id },
    select: { id: true, name: true, wooUrl: true, wooKey: true, wooSecret: true },
  })
  if (!shop) notFound()
  if (!shop.wooUrl || !shop.wooKey || !shop.wooSecret) redirect('/settings/shops')

  let webhooks: Webhook[] = []
  let error: string | null = null
  try {
    const hooks = await fetchWebhooks({
      url: shop.wooUrl,
      key: decryptSecret(shop.wooKey),
      secret: decryptSecret(shop.wooSecret),
    })
    const base = appBaseUrl()
    const ourUrl = base ? webhookDeliveryUrl(base, shop.id) : null
    // Same shape, same stripping as the diagnostics route: never the secret,
    // never a delivery URL's query string.
    webhooks = hooks.map((w) => ({
      id: w.id,
      name: w.name ?? '',
      topic: w.topic,
      status: w.status,
      delivery: hostAndPath(w.delivery_url),
      ours: w.delivery_url === ourUrl,
      created: w.date_created_gmt ?? null,
      modified: w.date_modified_gmt ?? null,
    }))
  } catch (e) {
    error = e instanceof Error ? e.message : 'Could not read webhooks'
  }

  return <WebhooksClient email={user.email} shop={{ id: shop.id, name: shop.name }} webhooks={webhooks} error={error} />
}

function hostAndPath(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return '(unreadable address)'
  }
}
