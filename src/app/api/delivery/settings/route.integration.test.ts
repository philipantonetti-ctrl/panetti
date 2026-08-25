import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'a@b.c', role: 'ADMIN' })),
}))

const { GET, PUT } = await import('./route')
const { currentUser } = await import('@/lib/auth/current-user')

const url = 'http://localhost/api/delivery/settings'
const put = (body: unknown) =>
  PUT(new Request(url, { method: 'PUT', body: JSON.stringify(body) }))

// The brief's Step 1 calls GET(new Request(url)) throughout, but Step 3's
// GET reads nothing off the request (no query params - this route's data is
// fixed) and is declared `export async function GET()` with zero
// parameters, the same shape as /api/shops and /api/settings. Vitest
// doesn't mind the extra argument (JS ignores it), but `npx tsc --noEmit`
// does: "Expected 0 arguments, but got 1." Calling GET() bare here matches
// the route as actually declared.

// Tagged and scoped - see "Test data convention" in the Global Constraints.
// DeliveryConfig is a fixed-id singleton and DeliveryPromise has no shop to
// tag, so neither can carry a per-file tag the way Shop and Order fixtures
// can; '*' and 'NO' are the only country codes any suite in the repo writes
// (src/app/api/delivery/route.integration.test.ts scopes its own cleanup the
// same way), so clearing both tables here is equivalent in practice. Shop
// fixtures below DO carry a tag, and are cleaned up by it.
const TAG = '[delivery-settings-test]'

async function cleanup() {
  await db.deliveryConfig.deleteMany()
  await db.deliveryPromise.deleteMany()
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

beforeEach(cleanup)
// The brief's own Step 1 test has no afterAll, which leaves the singleton
// row (fake email, encrypted 'super-secret') sitting in the shared DB after
// this file's last test runs - harmless to other suites (nothing else reads
// DeliveryConfig in a test), but untidy, and exactly the kind of leftover the
// Global Constraints ask fixtures to avoid. Added for hygiene.
afterAll(cleanup)
afterEach(() => vi.unstubAllEnvs())

describe('delivery settings', () => {
  /**
   * DHL's key is a Vercel environment variable, not a stored setting, so the
   * settings page has nothing in the database to read. Without this the DHL
   * panel could only ever say "press the button and find out".
   */
  it('says whether DHL is connected, without ever returning the key', async () => {
    vi.stubEnv('DHL_API_KEY', 'a-real-looking-dhl-key')
    const connected = await (await GET()).json()
    expect(connected.hasDhlKey).toBe(true)
    expect(JSON.stringify(connected)).not.toContain('a-real-looking-dhl-key')

    vi.stubEnv('DHL_API_KEY', '')
    expect((await (await GET()).json()).hasDhlKey).toBe(false)
  })

  it('refuses a non-admin on both verbs', async () => {
    vi.mocked(currentUser).mockResolvedValue({ id: 'u2', email: 'x@y.z', role: 'AMBASSADOR' } as never)
    expect((await GET()).status).toBe(403)
    expect((await put({})).status).toBe(403)
    vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'ADMIN' } as never)
  })

  it('stores the Bring key and the Slack URL encrypted, never in the clear', async () => {
    await put({
      bringApiUid: 'ops@example.com',
      bringApiKey: 'super-secret',
      bringClientUrl: 'https://panetti.vercel.app',
      slackWebhookUrl: 'https://hooks.slack.com/services/x',
    })
    const row = await db.deliveryConfig.findUniqueOrThrow({ where: { id: 'singleton' } })
    expect(row.bringApiKey).not.toContain('super-secret')
    expect(row.bringApiKey!.startsWith('enc:v1:')).toBe(true)
    expect(decryptSecret(row.bringApiKey!)).toBe('super-secret')
    expect(decryptSecret(row.slackWebhookUrl!)).toBe('https://hooks.slack.com/services/x')
  })

  it('never returns a secret to the browser, only whether one is set', async () => {
    await put({ bringApiUid: 'ops@example.com', bringApiKey: 'super-secret' })
    const body = await (await GET()).json()
    expect(JSON.stringify(body)).not.toContain('super-secret')
    expect(body.hasBringKey).toBe(true)
    expect(body.bringApiUid).toBe('ops@example.com')
  })

  it('keeps the stored key when the field is left blank on a later save', async () => {
    await put({ bringApiUid: 'ops@example.com', bringApiKey: 'super-secret' })
    await put({ bringApiUid: 'ops2@example.com', bringApiKey: '' })
    const row = await db.deliveryConfig.findUniqueOrThrow({ where: { id: 'singleton' } })
    expect(decryptSecret(row.bringApiKey!)).toBe('super-secret')
    expect(row.bringApiUid).toBe('ops2@example.com')
  })

  it('treats a whitespace-only secret as blank too - a stray paste must not wipe a good key', async () => {
    await put({ bringApiUid: 'ops@example.com', bringApiKey: 'super-secret', slackWebhookUrl: 'https://hooks.slack.com/services/x' })
    await put({ bringApiKey: '   ', slackWebhookUrl: '\t\n ' })
    const row = await db.deliveryConfig.findUniqueOrThrow({ where: { id: 'singleton' } })
    expect(decryptSecret(row.bringApiKey!)).toBe('super-secret')
    expect(decryptSecret(row.slackWebhookUrl!)).toBe('https://hooks.slack.com/services/x')
  })

  it('saves a promise per country on a timeline', async () => {
    await put({ promises: [
      { country: 'NO', days: 3, businessDays: true, effectiveFrom: '2026-01-01' },
      { country: '*', days: 6, businessDays: true, effectiveFrom: '2026-01-01' },
    ] })
    expect(await db.deliveryPromise.count()).toBe(2)
  })

  it('saves two shops their own promise for the same country', async () => {
    // The case this exists for: Panetti promises 3 days to Norway, Mazzetti 5,
    // and both are Norwegian webshops. Keyed on country alone, the second row
    // would collide with the first on [country, effectiveFrom].
    const panetti = await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'NOK' } })
    const mazzetti = await db.shop.create({ data: { name: `Mazzetti ${TAG}`, currency: 'NOK' } })

    const res = await put({
      promises: [
        { shopId: panetti.id, country: 'NO', days: 3, businessDays: true, effectiveFrom: '2026-01-01' },
        { shopId: mazzetti.id, country: 'NO', days: 5, businessDays: true, effectiveFrom: '2026-01-01' },
        { shopId: null, country: '*', days: 6, businessDays: true, effectiveFrom: '2026-01-01' },
      ],
    })
    expect(res.status).toBe(200)

    const saved = await db.deliveryPromise.findMany({ orderBy: { days: 'asc' } })
    expect(saved).toHaveLength(3)
    expect(saved.map((p) => [p.shopId, p.country, p.days])).toEqual([
      [panetti.id, 'NO', 3],
      [mazzetti.id, 'NO', 5],
      [null, '*', 6],
    ])
  })

  it('hands the shop back to the browser so the table can name it', async () => {
    const shop = await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'NOK' } })
    await put({
      promises: [
        { shopId: shop.id, country: 'NO', days: 3, businessDays: true, effectiveFrom: '2026-01-01' },
      ],
    })
    const body = await (await GET()).json()
    expect(body.promises[0].shopId).toBe(shop.id)
  })

  it('refuses a promise of zero days, which would make every order instantly late', async () => {
    const res = await put({ promises: [
      { country: 'NO', days: 0, businessDays: true, effectiveFrom: '2026-01-01' },
    ] })
    expect(res.status).toBe(400)
    expect(await db.deliveryPromise.count()).toBe(0)
  })
})

// Not part of the brief's Step 1 list, added alongside it: "which shops are
// tracked" (page section 4) has to write Shop.deliveryTrackingFrom through
// SOME endpoint, and the Interfaces line for this task names exactly one PUT
// (`GET/PUT /api/delivery/settings`) - no second route is declared. So the
// PUT body grows a `shopTracking` field to carry it, and that needs its own
// coverage: it is the feature's on/off switch, not a cosmetic field.
describe('which shops are tracked', () => {
  it('writes Shop.deliveryTrackingFrom, and a blank date clears it - untracked, not "unchanged"', async () => {
    const shop = await db.shop.create({ data: { name: `Test shop ${TAG}`, currency: 'NOK' } })

    await put({ shopTracking: [{ shopId: shop.id, date: '2026-02-01' }] })
    let row = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(row.deliveryTrackingFrom?.toISOString().slice(0, 10)).toBe('2026-02-01')

    const body = await (await GET()).json()
    const listed = body.shops.find((s: { id: string }) => s.id === shop.id)
    expect(listed.deliveryTrackingFrom).toBe('2026-02-01')

    // Dates are not secret - unlike bringApiKey above, the browser already
    // holds the true value, so blank here is a deliberate instruction, not
    // "leave what is stored".
    await put({ shopTracking: [{ shopId: shop.id, date: '' }] })
    row = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(row.deliveryTrackingFrom).toBeNull()
  })

  it('a shop id that does not exist is a no-op, not a failure', async () => {
    const res = await put({ shopTracking: [{ shopId: 'does-not-exist', date: '2026-02-01' }] })
    expect(res.status).toBe(200)
  })
})
