import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: () => Promise.resolve({ userId: 'u1', email: 'admin@ecom.test', role: 'ADMIN' }),
}))

const MARK = 'avatar-route-test'

async function cleanup() {
  await db.supportAgent.deleteMany({ where: { source: MARK } })
}
afterAll(cleanup)
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
beforeEach(async () => {
  await cleanup()
  vi.stubEnv('GORGIAS_DOMAIN', 'test-account')
  vi.stubEnv('GORGIAS_EMAIL', 'admin@example.invalid')
  vi.stubEnv('GORGIAS_API_KEY', 'key')
})

describe('the avatar proxy', () => {
  it('streams the photo through with the helpdesk credentials', async () => {
    await db.supportAgent.create({
      data: {
        source: MARK, externalId: 'a1', name: `${MARK} Marvin`,
        avatarUrl: 'https://config.gorgias.example/profile/x',
      },
    })
    const upstream = vi.fn(async () =>
      new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    )
    vi.stubGlobal('fetch', upstream)

    const { GET } = await import('./route')
    const res = await GET(new Request(`http://localhost/api/support/agents/avatar?agent=${encodeURIComponent(`${MARK} Marvin`)}`))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    const [, init] = upstream.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /)
  })

  it('answers 404 - never a broken image - when Gorgias refuses', async () => {
    await db.supportAgent.create({
      data: {
        source: MARK, externalId: 'a2', name: `${MARK} Locked`,
        avatarUrl: 'https://config.gorgias.example/profile/y',
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })))

    const { GET } = await import('./route')
    const res = await GET(new Request(`http://localhost/api/support/agents/avatar?agent=${encodeURIComponent(`${MARK} Locked`)}`))
    expect(res.status).toBe(404)
  })

  it('answers 404 for a person with no stored photo, asking Gorgias nothing', async () => {
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)
    const { GET } = await import('./route')
    const res = await GET(new Request('http://localhost/api/support/agents/avatar?agent=Nobody'))
    expect(res.status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })
})
