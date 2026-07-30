import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { encryptSecret } from '../secrets'
import { configuredProviders, platformApp } from './platform-app'

/**
 * DB-backed for the fallback path. AdPlatformApp rows are per-provider
 * singletons shared with seed data, so this file borrows them and always
 * puts them back.
 */

const ENV_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_DEVELOPER_TOKEN',
] as const

async function restoreSeedApps() {
  await db.adPlatformApp.upsert({
    where: { provider: 'meta' },
    create: { provider: 'meta', clientId: 'seed-app', clientSecret: 'seed' },
    update: { clientId: 'seed-app', clientSecret: 'seed' },
  })
  await db.adPlatformApp.upsert({
    where: { provider: 'google' },
    create: { provider: 'google', clientId: 'seed-app', clientSecret: 'seed', developerToken: 'seed' },
    update: { clientId: 'seed-app', clientSecret: 'seed', developerToken: 'seed' },
  })
}

beforeEach(() => {
  for (const k of ENV_KEYS) vi.stubEnv(k, '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await restoreSeedApps()
})

describe('platformApp', () => {
  it('reads the environment and never touches the database row', async () => {
    vi.stubEnv('META_APP_ID', 'env-app')
    vi.stubEnv('META_APP_SECRET', 'env-secret')
    // The row says something different, so a wrong answer is visible.
    await db.adPlatformApp.upsert({
      where: { provider: 'meta' },
      create: { provider: 'meta', clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
      update: { clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
    })

    expect(await platformApp('meta')).toEqual({ clientId: 'env-app', clientSecret: 'env-secret' })
  })

  it('decrypts an environment secret too, so a value copied out of the database still works', async () => {
    // The migration path: someone pastes the database row's encrypted value into Vercel.
    // This proves decryptSecret is called on environment secrets, not bypassed.
    vi.stubEnv('META_APP_ID', 'env-app')
    vi.stubEnv('META_APP_SECRET', encryptSecret('env-secret'))
    expect((await platformApp('meta'))?.clientSecret).toBe('env-secret')
  })

  it('falls back to the database row and decrypts it', async () => {
    await db.adPlatformApp.upsert({
      where: { provider: 'meta' },
      create: { provider: 'meta', clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
      update: { clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
    })

    expect(await platformApp('meta')).toEqual({ clientId: 'row-app', clientSecret: 'row-secret' })
  })

  it('treats an empty environment variable as unset, not as a blank secret', async () => {
    // Vercel produces empty strings. Treating one as configured would send
    // somebody to Facebook with no client_id.
    vi.stubEnv('META_APP_ID', '')
    vi.stubEnv('META_APP_SECRET', '')
    await db.adPlatformApp.upsert({
      where: { provider: 'meta' },
      create: { provider: 'meta', clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
      update: { clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
    })

    expect((await platformApp('meta'))?.clientId).toBe('row-app')
  })

  it('answers null when neither the environment nor a row has it', async () => {
    await db.adPlatformApp.deleteMany({ where: { provider: 'meta' } })
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
    await db.adPlatformApp.upsert({
      where: { provider: 'meta' },
      create: { provider: 'meta', clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
      update: { clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
    })

    expect(await platformApp('meta')).toEqual({ clientId: 'row-app', clientSecret: 'row-secret' })
  })

  it('treats whitespace-only environment variables as unset', async () => {
    // env() calls .trim() to handle Vercel's whitespace-padded values.
    vi.stubEnv('META_APP_ID', '   ')
    vi.stubEnv('META_APP_SECRET', '\t\n')
    await db.adPlatformApp.upsert({
      where: { provider: 'meta' },
      create: { provider: 'meta', clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
      update: { clientId: 'row-app', clientSecret: encryptSecret('row-secret') },
    })

    expect(await platformApp('meta')).toEqual({ clientId: 'row-app', clientSecret: 'row-secret' })
  })
})

describe('configuredProviders', () => {
  it('calls Google configured only when the developer token is there too', async () => {
    await db.adPlatformApp.deleteMany({ where: { provider: 'google' } })
    vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'g-app')
    vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'g-secret')
    expect((await configuredProviders()).google).toBe(false)

    vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', 'g-dev')
    expect((await configuredProviders()).google).toBe(true)
  })

  it('calls Meta configured on an id and a secret alone', async () => {
    vi.stubEnv('META_APP_ID', 'm-app')
    vi.stubEnv('META_APP_SECRET', 'm-secret')
    expect((await configuredProviders()).meta).toBe(true)
  })

  it('reports both false when nothing is configured anywhere', async () => {
    await db.adPlatformApp.deleteMany({ where: { provider: { in: ['meta', 'google'] } } })
    expect(await configuredProviders()).toEqual({ meta: false, google: false })
  })
})
