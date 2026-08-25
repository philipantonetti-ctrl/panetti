import { describe, it, expect } from 'vitest'
import { loginFor } from './page'

const at = (iso: string) => new Date(iso)

const LOGINS = [
  { provider: 'meta', label: 'Jacob Kjos Hanssen', expiresAt: at('2026-09-29T00:00:00.000Z') },
  { provider: 'google', label: 'Philip Antonetti', expiresAt: null },
]

describe('which login is in force', () => {
  it('is null for a platform nobody has logged into', () => {
    expect(loginFor(LOGINS, 'tiktok')).toBeNull()
  })

  it('reports a token still in date as not expired', () => {
    expect(loginFor(LOGINS, 'meta', at('2026-07-31T00:00:00.000Z'))?.expired).toBe(false)
  })

  it('reports a token past its date as expired', () => {
    expect(loginFor(LOGINS, 'meta', at('2026-10-01T00:00:00.000Z'))?.expired).toBe(true)
  })

  // The boundary is the moment it lapses, not some point after it.
  it('counts the expiry moment itself as expired', () => {
    expect(loginFor(LOGINS, 'meta', at('2026-09-29T00:00:00.000Z'))?.expired).toBe(true)
  })

  // A Google refresh token lives as long as the client stays published, so it
  // has no expiry - and a missing expiry must never read as a lapsed one.
  it('never calls a token without an expiry expired', () => {
    expect(loginFor(LOGINS, 'google', at('2099-01-01T00:00:00.000Z'))?.expired).toBe(false)
  })

  // The query orders newest first, so the first match is the login in force.
  // Older rows are leftovers from earlier logins and must not win.
  it('takes the first match for the platform', () => {
    const two = [
      { provider: 'meta', label: 'Newest', expiresAt: null },
      { provider: 'meta', label: 'Older', expiresAt: null },
    ]
    expect(loginFor(two, 'meta')?.label).toBe('Newest')
  })
})
