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

const asMarketing = async () =>
  signSession({ userId: 'u5', email: 'mkt@test.local', role: 'MARKETING', ambassadorId: null })

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

/**
 * The outage this describes: Vercel Cron calls the deployment's own generated
 * URL, never the production domain. The host check above answered it with a
 * 308, cron does not follow redirects, and a redirected cron is not even
 * logged as an invocation - so the scheduled sync silently never ran.
 */
describe('machines are not walked anywhere', () => {
  const deployment = 'https://panetti-ec53dmxro-panetti-intelligence.vercel.app'

  it('lets the scheduled sync run on the generated URL Vercel actually calls', async () => {
    production()
    const res = await middleware(new NextRequest(`${deployment}/api/cron/sync`))
    expect(res.headers.get('location')).toBeNull()
    expect(res.status).toBe(200)
  })

  it('lets a store deliver a webhook whatever host it was registered against', async () => {
    production()
    const res = await middleware(new NextRequest(`${deployment}/api/webhooks/woo/shop1`))
    expect(res.headers.get('location')).toBeNull()
    expect(res.status).toBe(200)
  })

  /**
   * The warehouse's daily report arrives here, POSTed by Postmark to the URL it
   * has on file and carrying its own `?token=` secret. Lose this exemption and
   * every delivery gets a 308 that Postmark counts as a failure: nothing is
   * recorded on our side at all, so the delivery page shows a quiet morning
   * that never happened. It is the worst failure this design has, because it is
   * the one that looks exactly like nothing being wrong.
   */
  it('lets Postmark deliver the warehouse report on the URL it has on file', async () => {
    production()
    const res = await middleware(new NextRequest(`${deployment}/api/delivery/inbound?token=s3cret`))
    expect(res.headers.get('location')).toBeNull()
    expect(res.status).toBe(200)
  })

  /**
   * The reason the exemption is three named paths and not all of /api: the
   * OAuth start route builds its redirect_uri from the host it was called on
   * (api/ads/oauth/[provider]/start/route.ts), which is the whole reason the
   * host check exists. Widening the exemption puts a hashed host back in front
   * of Facebook.
   */
  it('still walks the OAuth start route, whose redirect_uri is built from the host', async () => {
    production()
    const res = await middleware(new NextRequest(`${deployment}/api/ads/oauth/meta/start`))
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe('https://panetti.vercel.app/api/ads/oauth/meta/start')
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

  it('fences marketing onto the ambassadors page', async () => {
    production()
    const res = await middleware(
      new NextRequest('https://panetti.vercel.app/dashboard', {
        headers: { cookie: `${SESSION_COOKIE}=${await asMarketing()}` },
      }),
    )
    expect(res.headers.get('location')).toBe('https://panetti.vercel.app/ambassadors')
  })

  it('lets marketing through to the ambassadors page and their own account', async () => {
    production()
    const amb = await middleware(
      new NextRequest('https://panetti.vercel.app/ambassadors', {
        headers: { cookie: `${SESSION_COOKIE}=${await asMarketing()}` },
      }),
    )
    expect(amb.headers.get('location')).toBeNull()
    const acc = await middleware(
      new NextRequest('https://panetti.vercel.app/account', {
        headers: { cookie: `${SESSION_COOKIE}=${await asMarketing()}` },
      }),
    )
    expect(acc.headers.get('location')).toBeNull()
  })

  it('a guest on the ambassadors page goes to /login like any protected page', async () => {
    production()
    const res = await middleware(new NextRequest('https://panetti.vercel.app/ambassadors'))
    expect(res.headers.get('location')).toBe('https://panetti.vercel.app/login')
  })
})

const asOperations = async () =>
  signSession({ userId: 'u6', email: 'ops@test.local', role: 'OPERATIONS', ambassadorId: null })

const asAdmin = async () =>
  signSession({ userId: 'u7', email: 'admin@test.local', role: 'ADMIN', ambassadorId: null })

const go = async (path: string, cookie?: string) =>
  middleware(
    new NextRequest(`https://panetti.vercel.app${path}`, {
      headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : undefined,
    }),
  )

/**
 * The operations manager runs orders, delivery, products, inventory and B2B.
 * Everything else - the dashboard, finance, marketing, support, the settings
 * house - belongs to the owner, and typing its URL walks him back to Orders.
 */
describe('the operations manager is fenced onto his five tabs', () => {
  it('lets him through to every tab he was given, and to his own account', async () => {
    production()
    const token = await asOperations()
    for (const path of [
      // His first page. Same address as the owner's dashboard, a different
      // page behind it: the owner's is the money, his is what needs doing.
      '/dashboard',
      '/orders',
      '/delivery',
      '/products',
      '/inventory',
      '/inventory/stock',
      '/inventory/purchase-orders',
      '/inventory/suppliers',
      '/b2b',
      '/b2b/some-customer-id',
      // Receivables - what customers still owe us. The client asked for this
      // one tab of Finance, not the Payouts tab beside it.
      '/finance',
      '/account',
    ]) {
      const res = await go(path, token)
      expect(res.headers.get('location'), `${path} should be his`).toBeNull()
    }
  })

  it('walks him back to Orders from every page that is not his', async () => {
    production()
    const token = await asOperations()
    for (const path of [
      // The other Finance tab: Dintero's payouts, with the fee it took.
      '/finance/payouts',
      '/marketing',
      '/support',
      '/inbox',
      '/advisor',
      '/ambassadors',
      '/settings',
      '/settings/users',
      '/settings/costs',
      '/settings/shops',
    ]) {
      const res = await go(path, token)
      // Back to his first page, which is where he starts every morning.
      expect(res.headers.get('location'), `${path} is not his`).toBe(
        'https://panetti.vercel.app/dashboard',
      )
    }
  })

  /**
   * The five tabs were reachable without a session gate before this role
   * existed - each page carried its own guard and nothing else. They are
   * protected pages now, or the fence above would have no door to stand in.
   */
  it('sends a guest on the operations tabs to /login', async () => {
    production()
    for (const path of ['/dashboard', '/orders', '/delivery', '/products', '/inventory', '/b2b']) {
      const res = await go(path)
      expect(res.headers.get('location'), path).toBe('https://panetti.vercel.app/login')
    }
  })

  it('keeps an ambassador off the operations tabs', async () => {
    production()
    const res = await go('/orders', await asAmbassador())
    expect(res.headers.get('location')).toBe('https://panetti.vercel.app/portal')
  })

  it('keeps marketing off the operations tabs', async () => {
    production()
    const res = await go('/orders', await asMarketing())
    expect(res.headers.get('location')).toBe('https://panetti.vercel.app/ambassadors')
  })

  it('leaves the admin free to walk anywhere', async () => {
    production()
    const token = await asAdmin()
    for (const path of ['/dashboard', '/orders', '/settings/users', '/b2b', '/finance']) {
      const res = await go(path, token)
      expect(res.headers.get('location'), path).toBeNull()
    }
  })
})
