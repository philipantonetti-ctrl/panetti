import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { encryptSecret } from '../secrets'
import { configuredProviders, platformApp } from './platform-app'

/**
 * This file mocks the database boundary (`db.adPlatformApp.findUnique`) on
 * purpose. The table's `provider` column is uniquely constrained, so there is
 * exactly one meta row and one google row shared by three test files running
 * in parallel workers (`src/lib/ads/platform-app.test.ts`, `oauth.test.ts`,
 * and `connections/meta/route.test.ts`). Real rows here would race and fail
 * nondeterministically. The accessor's contract with the database is testable
 * without writing rows: which source wins (environment over database), whether
 * values are decrypted (still running `encryptSecret` and `decryptSecret` for
 * real), and what `configuredProviders` returns when neither source has it.
 * The fallback path is covered end-to-end by route tests against real rows.
 */

const ENV_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_DEVELOPER_TOKEN',
] as const

beforeEach(() => {
  for (const k of ENV_KEYS) vi.stubEnv(k, '')
  vi.spyOn(db.adPlatformApp, 'findUnique').mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('platformApp', () => {
  it('reads the environment and never touches the database row', async () => {
    vi.stubEnv('META_APP_ID', 'env-app')
    vi.stubEnv('META_APP_SECRET', 'env-secret')
    // The mock says something different, so a wrong answer is visible if the env is ignored.
    vi.mocked(db.adPlatformApp.findUnique).mockResolvedValue({
      id: 'mock-id',
      provider: 'meta',
      clientId: 'row-app',
      clientSecret: encryptSecret('row-secret'),
      developerToken: null,
      createdAt: new Date(),
    })

    expect(await platformApp('meta')).toEqual({ clientId: 'env-app', clientSecret: 'env-secret' })
    // Verify the database was not queried when environment was complete.
    expect(db.adPlatformApp.findUnique).not.toHaveBeenCalled()
  })

  it('decrypts an environment secret too, so a value copied out of the database still works', async () => {
    // The migration path: someone pastes the database row's encrypted value into Vercel.
    // This proves decryptSecret is called on environment secrets, not bypassed.
    vi.stubEnv('META_APP_ID', 'env-app')
    vi.stubEnv('META_APP_SECRET', encryptSecret('env-secret'))
    expect((await platformApp('meta'))?.clientSecret).toBe('env-secret')
  })

  it('falls back to the database row and decrypts it', async () => {
    vi.mocked(db.adPlatformApp.findUnique).mockResolvedValue({
      id: 'mock-id',
      provider: 'meta',
      clientId: 'row-app',
      clientSecret: encryptSecret('row-secret'),
      developerToken: null,
      createdAt: new Date(),
    })

    expect(await platformApp('meta')).toEqual({ clientId: 'row-app', clientSecret: 'row-secret' })
  })

  it('treats an empty environment variable as unset, not as a blank secret', async () => {
    // Vercel produces empty strings. Treating one as configured would send
    // somebody to Facebook with no client_id.
    vi.stubEnv('META_APP_ID', '')
    vi.stubEnv('META_APP_SECRET', '')
    vi.mocked(db.adPlatformApp.findUnique).mockResolvedValue({
      id: 'mock-id',
      provider: 'meta',
      clientId: 'row-app',
      clientSecret: encryptSecret('row-secret'),
      developerToken: null,
      createdAt: new Date(),
    })

    expect((await platformApp('meta'))?.clientId).toBe('row-app')
  })

  it('answers null when neither the environment nor a row has it', async () => {
    vi.mocked(db.adPlatformApp.findUnique).mockResolvedValue(null)
    expect(await platformApp('meta')).toBeNull()
  })

  it('carries the developer token for Google and omits it for Meta', async () => {
    vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'g-app')
    vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'g-secret')
    vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', 'g-dev')
    vi.stubEnv('META_APP_ID', 'm-app')
    vi.stubEnv('META_APP_SECRET', 'm-secret')

    expect(await platformApp('google')).toEqual({
      clientId: 'g-app',
      clientSecret: 'g-secret',
      developerToken: 'g-dev',
    })
    expect(await platformApp('meta')).not.toHaveProperty('developerToken')
  })

  it('still answers for Google when only the developer token is missing', async () => {
    // The login dialog needs no developer token; only the API calls do. The
    // callers that need it check for themselves.
    vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'g-app')
    vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'g-secret')
    const app = await platformApp('google')
    expect(app?.clientId).toBe('g-app')
    expect(app?.developerToken).toBeUndefined()
  })

  it('falls through to the database when only one environment variable is set', async () => {
    // If clientId is set but clientSecret is not, neither source is complete.
    vi.stubEnv('META_APP_ID', 'env-app')
    // META_APP_SECRET remains empty (stubbed to '' in beforeEach)
    vi.mocked(db.adPlatformApp.findUnique).mockResolvedValue({
      id: 'mock-id',
      provider: 'meta',
      clientId: 'row-app',
      clientSecret: encryptSecret('row-secret'),
      developerToken: null,
      createdAt: new Date(),
    })

    expect(await platformApp('meta')).toEqual({ clientId: 'row-app', clientSecret: 'row-secret' })
  })

  it('treats whitespace-only environment variables as unset', async () => {
    // env() calls .trim() to handle Vercel's whitespace-padded values.
    vi.stubEnv('META_APP_ID', '   ')
    vi.stubEnv('META_APP_SECRET', '\t\n')
    vi.mocked(db.adPlatformApp.findUnique).mockResolvedValue({
      id: 'mock-id',
      provider: 'meta',
      clientId: 'row-app',
      clientSecret: encryptSecret('row-secret'),
      developerToken: null,
      createdAt: new Date(),
    })

    expect(await platformApp('meta')).toEqual({ clientId: 'row-app', clientSecret: 'row-secret' })
  })
})

describe('configuredProviders', () => {
  it('calls Google configured only when the developer token is there too', async () => {
    vi.mocked(db.adPlatformApp.findUnique).mockResolvedValue(null)
    vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'g-app')
    vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'g-secret')
    expect((await configuredProviders()).google).toBe(false)

    vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', 'g-dev')
    expect((await configuredProviders()).google).toBe(true)
  })

  it('calls Meta configured on an id and a secret alone', async () => {
    vi.mocked(db.adPlatformApp.findUnique).mockResolvedValue(null)
    vi.stubEnv('META_APP_ID', 'm-app')
    vi.stubEnv('META_APP_SECRET', 'm-secret')
    expect((await configuredProviders()).meta).toBe(true)
  })

  it('reports both false when nothing is configured anywhere', async () => {
    vi.mocked(db.adPlatformApp.findUnique).mockResolvedValue(null)
    expect(await configuredProviders()).toEqual({ meta: false, google: false })
  })
})
