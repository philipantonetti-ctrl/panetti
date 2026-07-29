import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildGoogleAuthUrl,
  buildMetaAuthUrl,
  exchangeGoogleCode,
  exchangeMetaCode,
  validateMetaApp,
  type PlatformApp,
} from './oauth'
import { AdApiError } from './types'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const APP: PlatformApp = { clientId: 'app-1', clientSecret: 'shh' }
const REDIRECT = 'https://panetti.vercel.app/api/ads/oauth/meta/callback'

afterEach(() => vi.unstubAllGlobals())

describe('auth URLs', () => {
  it('sends the state and the right scopes to each platform', () => {
    const meta = buildMetaAuthUrl('app-1', REDIRECT, 'st-1')
    expect(meta).toContain('facebook.com/v25.0/dialog/oauth')
    expect(meta).toContain('state=st-1')
    expect(meta).toContain(encodeURIComponent('ads_read,business_management'))

    const google = buildGoogleAuthUrl('app-2', REDIRECT, 'st-2')
    expect(google).toContain('accounts.google.com/o/oauth2/v2/auth')
    expect(google).toContain('state=st-2')
    expect(google).toContain(encodeURIComponent('https://www.googleapis.com/auth/adwords'))
    expect(google).toContain('access_type=offline')
    expect(google).toContain('prompt=consent')
  })
})

describe('validateMetaApp', () => {
  it("throws Facebook's words for a wrong App ID or secret", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: { message: 'Error validating client secret.' } }, 400)),
    )
    await expect(validateMetaApp(APP, 'panetti.vercel.app')).rejects.toThrow(
      new AdApiError('Error validating client secret.'),
    )
  })

  it('stays quiet when the app already lists the domain', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ access_token: 'app-1|apptoken' }))
        .mockResolvedValueOnce(json({ app_domains: ['panetti.vercel.app'], website_url: 'https://panetti.vercel.app' })),
    )
    expect(await validateMetaApp(APP, 'panetti.vercel.app')).toEqual({})
  })

  it('warns with the exact links and values when the domain is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ access_token: 'app-1|apptoken' }))
        .mockResolvedValueOnce(json({ app_domains: [] })),
    )
    const { warning } = await validateMetaApp(APP, 'panetti.vercel.app')
    expect(warning).toContain('add panetti.vercel.app under App Domains')
    expect(warning).toContain('https://panetti.vercel.app/api/ads/oauth/meta/callback')
    expect(warning).toContain(`https://developers.facebook.com/apps/${APP.clientId}/fb-login/settings/`)
  })

  it('treats a MISSING app_domains field as not configured, never as fine', async () => {
    // Meta omits the field entirely when no domain was ever set — the exact
    // false-green that let a half-finished app look ready.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ access_token: 'app-1|apptoken' }))
        .mockResolvedValueOnce(json({ website_url: 'https://x.example' })),
    )
    const { warning } = await validateMetaApp(APP, 'panetti.vercel.app')
    expect(warning).toContain("Can't load URL")
  })

  it('treats an unreadable settings answer as no news, not bad news', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ access_token: 'app-1|apptoken' }))
        .mockResolvedValueOnce(json({ error: { message: 'no' } }, 400)),
    )
    expect(await validateMetaApp(APP, 'panetti.vercel.app')).toEqual({})
  })
})

describe('exchangeMetaCode', () => {
  it('trades the code for a long-lived token and reads who logged in', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'short' }))
      .mockResolvedValueOnce(json({ access_token: 'long', expires_in: 5_184_000 }))
      .mockResolvedValueOnce(json({ name: 'Philip Antonetti' }))
    vi.stubGlobal('fetch', fetchMock)

    const before = Date.now()
    const result = await exchangeMetaCode(APP, REDIRECT, 'code-1')
    expect(result.token).toBe('long')
    expect(result.label).toBe('Philip Antonetti')
    const days = (result.expiresAt.getTime() - before) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(59)
    expect(days).toBeLessThan(61)

    // The long-lived exchange carried the short token, not the code.
    expect(String(fetchMock.mock.calls[1][0])).toContain('fb_exchange_token=short')
  })

  it("surfaces Facebook's own words on a rejected code", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: { message: 'This authorization code has expired.' } }, 400)),
    )
    await expect(exchangeMetaCode(APP, REDIRECT, 'old')).rejects.toThrow(
      new AdApiError('This authorization code has expired.'),
    )
  })
})

describe('exchangeGoogleCode', () => {
  it('returns the refresh token and the account label', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'at', refresh_token: 'rt' }))
      .mockResolvedValueOnce(json({ name: 'Philip', email: 'p@x.com' }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await exchangeGoogleCode(APP, REDIRECT, 'code')).toEqual({
      refreshToken: 'rt',
      label: 'Philip',
    })
    const form = String((fetchMock.mock.calls[0][1] as RequestInit).body)
    expect(form).toContain('grant_type=authorization_code')
    expect(form).toContain('code=code')
  })

  it('refuses to continue without a refresh token, with the fix in the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ access_token: 'at' })))
    await expect(exchangeGoogleCode(APP, REDIRECT, 'code')).rejects.toThrow(/refresh token/)
  })
})
