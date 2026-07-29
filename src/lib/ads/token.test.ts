import { describe, it, expect, vi, afterEach } from 'vitest'
import { tokenVerdict, inspectMetaToken } from './token'
import { AdApiError } from './types'

afterEach(() => vi.unstubAllGlobals())

const APP = { clientId: '1526277315425302', clientSecret: 'shh' }

describe('tokenVerdict', () => {
  it('accepts a never-expiring token and reports no expiry', () => {
    expect(tokenVerdict({ is_valid: true, expires_at: 0, scopes: ['ads_read'] }, APP.clientId))
      .toEqual({ ok: true, expiresAt: null })
  })

  it('reads a dated expiry into a Date', () => {
    const verdict = tokenVerdict(
      { is_valid: true, expires_at: 1790000000, scopes: ['ads_read'] },
      APP.clientId,
    )
    expect(verdict).toEqual({ ok: true, expiresAt: new Date(1790000000 * 1000) })
  })

  it('refuses a token Facebook calls invalid', () => {
    expect(tokenVerdict({ is_valid: false }, APP.clientId)).toEqual({
      ok: false,
      reason: 'Facebook says this token is not valid. Generate it again.',
    })
  })

  it('refuses a token from a different app, before looking at scopes', () => {
    expect(tokenVerdict({ is_valid: true, app_id: '999', scopes: [] }, APP.clientId)).toEqual({
      ok: false,
      reason: 'This token belongs to a different Facebook app.',
    })
  })

  it('refuses a token that never got ads_read', () => {
    expect(
      tokenVerdict({ is_valid: true, app_id: APP.clientId, scopes: ['email'] }, APP.clientId),
    ).toEqual({
      ok: false,
      reason: 'This token has no ads_read permission. Generate it again and tick ads_read.',
    })
  })

  it('holds no opinion when Facebook says nothing useful', () => {
    // An unreadable answer must never block: only /me proves a token.
    expect(tokenVerdict(null, APP.clientId)).toEqual({ ok: true, expiresAt: null })
    expect(tokenVerdict({}, APP.clientId)).toEqual({ ok: true, expiresAt: null })
    // Scopes absent or empty is silence, not a missing permission.
    expect(tokenVerdict({ is_valid: true, scopes: [] }, APP.clientId)).toEqual({
      ok: true,
      expiresAt: null,
    })
  })
})

describe('inspectMetaToken', () => {
  it('returns the label from /me and the verdict from debug_token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('grant_type=client_credentials'))
          return Response.json({ access_token: 'APP|TOKEN' })
        if (url.includes('/debug_token'))
          return Response.json({ data: { is_valid: true, expires_at: 0, scopes: ['ads_read'] } })
        return Response.json({ name: 'Philip Antonetti' })
      }),
    )

    await expect(inspectMetaToken(APP, 'EAABpasted')).resolves.toEqual({
      label: 'Philip Antonetti',
      expiresAt: null,
    })
  })

  it('throws the verdict reason without ever calling /me', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('grant_type=client_credentials'))
        return Response.json({ access_token: 'APP|TOKEN' })
      if (url.includes('/debug_token'))
        return Response.json({ data: { is_valid: true, scopes: ['email'] } })
      throw new Error('/me must not be called once the token is already refused')
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(inspectMetaToken(APP, 'EAABpasted')).rejects.toThrow(/ads_read/)
  })

  it('still accepts the token when debug_token itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('grant_type=client_credentials'))
          return Response.json({ access_token: 'APP|TOKEN' })
        if (url.includes('/debug_token')) return new Response('nope', { status: 500 })
        return Response.json({ name: 'Philip Antonetti' })
      }),
    )

    await expect(inspectMetaToken(APP, 'EAABpasted')).resolves.toEqual({
      label: 'Philip Antonetti',
      expiresAt: null,
    })
  })

  it('fails with Facebook words when /me refuses the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('grant_type=client_credentials'))
          return Response.json({ access_token: 'APP|TOKEN' })
        if (url.includes('/debug_token')) return new Response('nope', { status: 500 })
        return Response.json({ error: { message: 'Malformed access token' } }, { status: 400 })
      }),
    )

    await expect(inspectMetaToken(APP, 'bad')).rejects.toThrow(AdApiError)
    await expect(inspectMetaToken(APP, 'bad')).rejects.toThrow('Malformed access token')
  })
})
