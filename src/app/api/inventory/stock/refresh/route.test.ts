import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { resetVismaTokenCache } from '@/lib/visma/client'
import { POST } from './route'

const SKU = `TEST-STOCKREFRESH-${Date.now()}`

const as = (role: 'ADMIN' | 'OPERATIONS' | null) =>
  vi.mocked(currentUser).mockResolvedValue(
    role ? ({ id: 'u1', email: 'a@b.c', role } as never) : null,
  )

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Visma's inventory list, as the scheduled sync already reads it. */
function stubVisma(status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('connect/token')) return json({ access_token: 'tok', expires_in: 3600 })
      return json(
        [
          {
            inventoryNumber: SKU,
            stockItem: true,
            warehouseDetails: [
              { warehouse: '10', quantityOnHand: 4942, available: 4732, availableForShipment: 4740 },
            ],
          },
        ],
        status,
      )
    }),
  )
}

beforeEach(() => {
  resetVismaTokenCache()
  vi.stubEnv('VISMA_CLIENT_ID', 'cid')
  vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
  vi.stubEnv('VISMA_TENANT_ID', 'tid')
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await db.vismaStock.deleteMany({ where: { sku: SKU } })
})

describe('POST /api/inventory/stock/refresh', () => {
  it('reads Visma now and stores available for shipping', async () => {
    as('ADMIN')
    stubVisma()

    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ configured: true, stored: 1, error: null })
    expect(await db.vismaStock.findUnique({ where: { sku: SKU } })).toMatchObject({
      quantityOnHand: 4942,
      availableForShipment: 4740,
    })
  })

  /** Stock carries no cost, and the warehouse team is who needs it fresh. */
  it('lets the operations login refresh too', async () => {
    as('OPERATIONS')
    stubVisma()

    expect((await POST()).status).toBe(200)
  })

  it('refuses a visitor who is not signed in', async () => {
    as(null)
    stubVisma()

    expect((await POST()).status).toBe(403)
    expect(await db.vismaStock.findUnique({ where: { sku: SKU } })).toBeNull()
  })

  it('says so when Visma is not connected here', async () => {
    as('ADMIN')
    vi.stubEnv('VISMA_CLIENT_ID', '')

    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ configured: false })
  })

  it('answers 502 with the reason when Visma fails, keeping the last snapshot', async () => {
    as('ADMIN')
    await db.vismaStock.create({ data: { sku: SKU, quantityOnHand: 5, available: 5 } })
    stubVisma(500)

    const res = await POST()
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBeTruthy()
    expect((await db.vismaStock.findUnique({ where: { sku: SKU } }))!.quantityOnHand).toBe(5)
  })
})
