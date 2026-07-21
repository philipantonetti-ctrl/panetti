import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cookieValue = { current: undefined as string | undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (cookieValue.current ? { value: cookieValue.current } : undefined),
  }),
}))

const { GET, PUT } = await import('./route')
const { signSession } = await import('@/lib/auth/session')
const { db } = await import('@/lib/db')

const asAdmin = async () => {
  cookieValue.current = await signSession({
    userId: 'test-admin', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null,
  })
}

async function cleanup() {
  await db.processingFee.deleteMany({ where: { gateway: { contains: '[pf-test]' } } })
}
beforeEach(cleanup)
afterEach(cleanup)

const put = (body: unknown) =>
  PUT(new Request('http://localhost/api/processing-fee', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

describe('processing-fee API', () => {
  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    expect((await put({ gateways: [] })).status).toBe(403)
  })

  it('upserts the sent gateways and leaves the rest alone', async () => {
    await asAdmin()
    await db.processingFee.create({ data: { gateway: 'Keep [pf-test]', percent: 1, fixedMinor: 0 } })

    const res = await put({
      gateways: [
        { gateway: 'Edit [pf-test]', percent: 2.9, fixed: 0.3, noFeesApply: false, crossBorderPercent: 1.5 },
      ],
    })
    expect(res.status).toBe(200)

    const edited = await db.processingFee.findUnique({ where: { gateway: 'Edit [pf-test]' } })
    expect(edited).toMatchObject({ percent: 2.9, fixedMinor: 30, crossBorderPercent: 1.5 })
    expect(await db.processingFee.findUnique({ where: { gateway: 'Keep [pf-test]' } })).not.toBeNull()

    // Second PUT updates in place instead of duplicating.
    await put({ gateways: [{ gateway: 'Edit [pf-test]', percent: 3.1, fixed: 0, noFeesApply: true, crossBorderPercent: null }] })
    const updated = await db.processingFee.findUnique({ where: { gateway: 'Edit [pf-test]' } })
    expect(updated).toMatchObject({ percent: 3.1, fixedMinor: 0, noFeesApply: true, crossBorderPercent: null })
  })

  it('GET returns the saved rows with major-unit fixed fees', async () => {
    await asAdmin()
    await db.processingFee.create({
      data: { gateway: 'List [pf-test]', percent: 0.6, fixedMinor: 10, crossBorderPercent: 2 },
    })
    const res = await GET()
    expect(res.status).toBe(200)
    const { fees } = (await res.json()) as { fees: Array<Record<string, unknown>> }
    expect(fees.find((f) => f.gateway === 'List [pf-test]')).toMatchObject({
      percent: 0.6, fixed: 0.1, currency: 'EUR', noFeesApply: false, crossBorderPercent: 2,
    })
  })
})
