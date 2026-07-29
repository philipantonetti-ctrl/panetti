import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from './middleware'
import { SESSION_COOKIE, signSession } from '@/lib/auth/session'

afterEach(() => vi.unstubAllEnvs())

const production = () => {
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'panetti.vercel.app')
}

const asAmbassador = async () =>
  signSession({ userId: 'u1', email: 'amb@test.local', role: 'AMBASSADOR', ambassadorId: 'a1' })

describe('one live host', () => {
  it('walks a stray production host to the canonical domain, path and query intact', async () => {
    production()
    const res = await middleware(
      new NextRequest('https://panetti-729f33q4t-panetti-intelligence.vercel.app/settings/ad-accounts?picker=1'),
    )
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe('https://panetti.vercel.app/settings/ad-accounts?picker=1')
  })

  it('redirects strays before any session logic, even on public pages', async () => {
    production()
    const res = await middleware(
      new NextRequest('https://panetti-old12345-panetti-intelligence.vercel.app/login'),
    )
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe('https://panetti.vercel.app/login')
  })

  it('leaves the canonical host alone on public pages', async () => {
    production()
    const res = await middleware(new NextRequest('https://panetti.vercel.app/login'))
    expect(res.headers.get('location')).toBeNull()
  })

  it('never redirects outside production, where there is no canonical host', async () => {
    const res = await middleware(new NextRequest('http://localhost:3000/login'))
    expect(res.headers.get('location')).toBeNull()
  })
})

describe('the session gate, unchanged behind the host check', () => {
  it('sends a guest on a protected page to /login', async () => {
    production()
    const res = await middleware(new NextRequest('https://panetti.vercel.app/dashboard'))
    expect(res.headers.get('location')).toBe('https://panetti.vercel.app/login')
  })

  it('keeps an ambassador out of admin pages', async () => {
    production()
    const res = await middleware(
      new NextRequest('https://panetti.vercel.app/settings/ad-accounts', {
        headers: { cookie: `${SESSION_COOKIE}=${await asAmbassador()}` },
      }),
    )
    expect(res.headers.get('location')).toBe('https://panetti.vercel.app/settings/ad-accounts'.replace('/settings/ad-accounts', '/portal'))
  })

  it('lets an ambassador through to their own portal', async () => {
    production()
    const res = await middleware(
      new NextRequest('https://panetti.vercel.app/portal', {
        headers: { cookie: `${SESSION_COOKIE}=${await asAmbassador()}` },
      }),
    )
    expect(res.headers.get('location')).toBeNull()
  })
})
