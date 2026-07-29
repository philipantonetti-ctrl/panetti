import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildGoogleAuthUrl, exchangeGoogleCode, type PlatformApp } from './oauth'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const APP: PlatformApp = { clientId: 'app-1', clientSecret: 'shh' }
const REDIRECT = 'https://panetti.vercel.app/api/ads/oauth/google/callback'

afterEach(() => vi.unstubAllGlobals())

describe('auth URLs', () => {
  it('sends the state and the right scopes to Google', () => {
    const google = buildGoogleAuthUrl('app-2', REDIRECT, 'st-2')
    expect(google).toContain('accounts.google.com/o/oauth2/v2/auth')
    expect(google).toContain('state=st-2')
    expect(google).toContain(encodeURIComponent('https://www.googleapis.com/auth/adwords'))
    expect(google).toContain('access_type=offline')
    expect(google).toContain('prompt=consent')
  })
})

// ensureMetaApp and exchangeMetaCode were tested here at length: the domain
// write, the "healed" answer, the refused write, the token exchange. All of
// it went when Meta stopped using the login dialog. What proves a Meta
// credential now lives in ./token.test.ts.

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
