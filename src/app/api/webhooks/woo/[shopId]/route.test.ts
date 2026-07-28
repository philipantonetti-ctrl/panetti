import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import { POST } from './route'
import { encryptSecret } from '@/lib/secrets'
import { db } from '@/lib/db'

const MARK = '[webhook-test]'
const SECRET = 'whsec-test'

async function wipe() {
  await db.shop.deleteMany({ where: { name: { contains: MARK } } })
  await db.ambassador.deleteMany({ where: { email: { contains: 'webhook-test' } } })
}
beforeEach(wipe)
afterEach(wipe)

async function connectedShop(overrides: { active?: boolean } = {}) {
  return db.shop.create({
    data: {
      name: `Hooked ${MARK}`,
      currency: 'DKK',
      wooUrl: 'https://shop.example',
      wooKey: encryptSecret('ck'),
      wooSecret: encryptSecret('cs'),
      wooWebhookSecret: encryptSecret(SECRET),
      active: overrides.active ?? true,
    },
  })
}

/** A full Woo order payload, as a delivery body. */
function wooOrder(id: number, status = 'processing') {
  return {
    id,
    number: String(id),
    status,
    currency: 'DKK',
    date_created_gmt: '2026-07-21T18:47:05',
    discount_total: '0.00',
    discount_tax: '0.00',
    shipping_total: '23.50',
    shipping_tax: '5.88',
    total_tax: '54.00',
    total: '269.99',
    coupon_lines: [{ code: 'emma10' }],
    billing: { first_name: 'Tino', last_name: 'Skaarup', email: 'tino@x.dk' },
    line_items: [
      {
        id: id * 10,
        product_id: 661,
        sku: 'MACBL661',
        name: 'Mazzetti Advanced Comfort',
        quantity: 1,
        subtotal: '192.49',
        total: '192.49',
      },
    ],
  }
}

function signed(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64')
}

function deliver(
  shopId: string,
  body: string,
  opts: { signature?: string | null; topic?: string } = {},
) {
  const headers = new Headers({ 'content-type': 'application/json' })
  const signature = opts.signature === undefined ? signed(body) : opts.signature
  if (signature !== null) headers.set('x-wc-webhook-signature', signature)
  headers.set('x-wc-webhook-topic', opts.topic ?? 'order.updated')
  return POST(new Request('http://localhost/api/webhooks/woo/x', { method: 'POST', body, headers }), {
    params: Promise.resolve({ shopId }),
  })
}

describe('POST /api/webhooks/woo/[shopId]', () => {
  it('stores a signed order delivery: items, customer and frozen attribution', async () => {
    const shop = await connectedShop()
    const amb = await db.ambassador.create({
      data: {
        name: 'Emma',
        email: 'emma-webhook-test@x.local',
        commissionRate: 0.1,
        codes: { create: { shopId: shop.id, code: 'EMMA10' } },
      },
    })

    const res = await deliver(shop.id, JSON.stringify(wooOrder(9001)), { topic: 'order.created' })
    expect(res.status).toBe(200)

    const order = await db.order.findUniqueOrThrow({
      where: { shopId_externalId: { shopId: shop.id, externalId: '9001' } },
      include: { items: true },
    })
    expect(order.status).toBe('processing')
    expect(order.customerName).toBe('Tino Skaarup')
    expect(order.ambassadorId).toBe(amb.id)
    expect(order.items).toHaveLength(1)
    expect(order.items[0].sku).toBe('MACBL661')
  })

  it('a later delivery for the same order updates it — a refund lands as a refund', async () => {
    const shop = await connectedShop()
    await deliver(shop.id, JSON.stringify(wooOrder(9002)), { topic: 'order.created' })

    const res = await deliver(shop.id, JSON.stringify(wooOrder(9002, 'refunded')))
    expect(res.status).toBe(200)

    const order = await db.order.findUniqueOrThrow({
      where: { shopId_externalId: { shopId: shop.id, externalId: '9002' } },
    })
    expect(order.status).toBe('refunded')
    expect(await db.order.count({ where: { shopId: shop.id } })).toBe(1) // updated, not duplicated
  })

  it('refuses a delivery whose signature does not verify, and stores nothing', async () => {
    const shop = await connectedShop()
    const body = JSON.stringify(wooOrder(9003))

    expect((await deliver(shop.id, body, { signature: signed(body, 'wrong') })).status).toBe(401)
    expect((await deliver(shop.id, body, { signature: null })).status).toBe(401)
    expect(await db.order.count({ where: { shopId: shop.id } })).toBe(0)
  })

  it("answers Woo's unsigned activation ping without writing anything", async () => {
    const shop = await connectedShop()
    const res = await deliver(shop.id, 'webhook_id=42', { signature: null })
    expect(res.status).toBe(200)
    expect(await db.order.count({ where: { shopId: shop.id } })).toBe(0)
  })

  it('order.deleted marks the order trash, and every figure lets it go', async () => {
    const shop = await connectedShop()
    await deliver(shop.id, JSON.stringify(wooOrder(9004)), { topic: 'order.created' })

    // Trash sends only the id — no line items to store, just a status to land.
    const res = await deliver(shop.id, JSON.stringify({ id: 9004 }), { topic: 'order.deleted' })
    expect(res.status).toBe(200)

    const order = await db.order.findUniqueOrThrow({
      where: { shopId_externalId: { shopId: shop.id, externalId: '9004' } },
    })
    expect(order.status).toBe('trash')
  })

  it('refuses deliveries for a shop that does not exist or was switched off', async () => {
    expect((await deliver('no-such-shop', JSON.stringify(wooOrder(9005)))).status).toBe(404)

    const off = await connectedShop({ active: false })
    expect((await deliver(off.id, JSON.stringify(wooOrder(9006)))).status).toBe(404)
    expect(await db.order.count({ where: { shopId: off.id } })).toBe(0)
  })
})
