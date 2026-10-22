import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { resetVismaTokenCache } from '@/lib/visma/client'
import { GET as listFiles } from './route'
import { GET as getFile } from './[attachmentId]/route'

const TAG = `TEST-POFILES-${Date.now()}`
const FILE_ID = '11111111-2222-3333-4444-555555555555'

const as = (role: 'ADMIN' | 'OPERATIONS' | null) =>
  vi.mocked(currentUser).mockResolvedValue(
    role ? ({ id: 'u1', email: 'a@b.c', role } as never) : null,
  )

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

/** Visma as the routes meet it: a token, the supplier invoices, and the file itself. */
function stubVisma(calls: string[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url)
      calls.push(u)
      if (u.includes('connect/token')) return json({ access_token: 'tok', expires_in: 3600 })
      if (u.includes('/v1/attachment/'))
        return new Response('%PDF-1.4 fake', {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        })
      return json([
        {
          referenceNumber: 'INV-9',
          date: '2026-07-02T00:00:00',
          attachments: [{ id: FILE_ID, name: 'order-confirmation.pdf', revision: 1 }],
          invoiceLines: [{ lineNumber: 1, poNumber: `${TAG}PO` }],
        },
      ])
    }),
  )
}

let orderId = ''

beforeEach(async () => {
  resetVismaTokenCache()
  vi.stubEnv('VISMA_CLIENT_ID', 'cid')
  vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
  vi.stubEnv('VISMA_TENANT_ID', 'tid')
  const item = await db.supplyItem.create({ data: { sku: `${TAG}-SKU`, name: 'Test' } })
  const order = await db.purchaseOrder.create({
    data: {
      supplyItemId: item.id,
      quantity: 10,
      orderedAt: new Date('2026-06-15T00:00:00Z'),
      externalId: `${TAG}PO-1`,
    },
  })
  orderId = order.id
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await db.supplyItem.deleteMany({ where: { sku: { startsWith: TAG } } })
})

const list = (id: string) => listFiles(new Request(`http://test/api/inventory/purchase-orders/files?id=${id}`))
const file = (id: string, name = 'a.pdf') =>
  getFile(new Request(`http://test/x?name=${encodeURIComponent(name)}`), {
    params: Promise.resolve({ attachmentId: id }),
  })

describe('the files of a purchase order', () => {
  /**
   * A supplier invoice prints what we paid per unit, and the operations
   * login never sees what a product costs us - so both doors are the owner's.
   */
  it('are the owner\'s only', async () => {
    stubVisma()
    as('OPERATIONS')
    expect((await list(orderId)).status).toBe(403)
    expect((await file(FILE_ID)).status).toBe(403)
    as(null)
    expect((await list(orderId)).status).toBe(403)
  })

  it('lists the files of the supplier invoices that name this PO', async () => {
    const calls: string[] = []
    stubVisma(calls)
    as('ADMIN')

    const res = await list(orderId)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      configured: true,
      poNumber: `${TAG}PO`,
      complete: true,
      files: [{ id: FILE_ID, name: 'order-confirmation.pdf', invoice: 'INV-9', invoiceDate: '2026-07-02' }],
    })
    expect(calls.some((u) => u.includes('supplierinvoice') && u.includes(`item=${TAG}-SKU`))).toBe(true)
  })

  it('says Visma is not connected rather than claiming there are no files', async () => {
    vi.stubEnv('VISMA_CLIENT_SECRET', '')
    as('ADMIN')
    expect(await (await list(orderId)).json()).toMatchObject({ configured: false, files: [] })
  })

  it('has nothing to look up for a typed row with no PO number', async () => {
    as('ADMIN')
    const item = await db.supplyItem.findFirstOrThrow({ where: { sku: `${TAG}-SKU` } })
    const typed = await db.purchaseOrder.create({
      data: { supplyItemId: item.id, quantity: 1, orderedAt: new Date() },
    })
    expect(await (await list(typed.id)).json()).toMatchObject({ poNumber: null, files: [] })
    expect((await list('no-such-order')).status).toBe(404)
  })

  it('hands the file on with its own type, named for download', async () => {
    const calls: string[] = []
    stubVisma(calls)
    as('ADMIN')

    const res = await file(FILE_ID, 'order "confirmation".pdf')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toBe(
      `inline; filename="order confirmation.pdf"; filename*=UTF-8''order%20%22confirmation%22.pdf`,
    )
    expect(await res.text()).toBe('%PDF-1.4 fake')
    expect(calls).toContain(`https://api.finance.visma.net/v1/attachment/${FILE_ID}`)
  })

  it('refuses an id that is not one of Visma\'s, before asking Visma anything', async () => {
    const calls: string[] = []
    stubVisma(calls)
    as('ADMIN')
    expect((await file('../customerinvoice')).status).toBe(400)
    expect(calls).toEqual([])
  })
})
