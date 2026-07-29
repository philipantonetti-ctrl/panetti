import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildGoogleAuthUrl,
  buildMetaAuthUrl,
  exchangeGoogleCode,
  exchangeMetaCode,
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
