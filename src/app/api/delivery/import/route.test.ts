import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'
import type { SessionUser } from '@/lib/auth/session'

// Mutable so tests can drive different auth states without re-mocking.
let mockUser: SessionUser | null = null

// Likewise for Bring's connectedness. Most tests here want getDeliveryConfig to
// FAIL, because that is the unexpected-failure seam described below; the
// deadline test wants it to succeed so the import gets far enough to reach
// resolveConsignments. Reset in beforeEach so no test inherits the other's.
let bringConnected = false

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))
vi.mock('@/lib/auth/current-user', () => ({ currentUser: async () => mockUser }))

// getDeliveryConfig is a seam inside importWarehouseFile's one guarded block
// (src/lib/bring/import.ts). Its own docstring promises it never throws, but it
// runs a findUnique, and import.ts guards it rather than trusting that on
// faith — so a dropped connection there is exactly the "unexpected failure"
// shape this file exists to pin. Forcing it to throw proves the route's
// catch-all hides such a failure from the client, including anything that looks
// like a connection string, instead of forwarding the caught error's message.
//
// Mocked rather than driven through the real DeliveryConfig singleton on
// purpose: this file runs in the parallel `app` project, and that singleton is
// a fixed-id row the `delivery` project's tests rewrite. Reading it for real
// would make these assertions depend on who ran last.
vi.mock('@/lib/delivery/config', () => ({
  getDeliveryConfig: async () => {
    if (bringConnected)
      return { creds: { uid: 'a@b.test', key: 'k', clientUrl: 'https://example.test/' }, slackWebhookUrl: null }
    throw new Error('Can’t reach database server at `10.0.0.5:5432`')
  },
}))

// The one place the upload's deadline is observable. Mocked rather than allowed
// to reach the network: this suite must never make a real Bring request.
const resolveConsignments = vi.fn()
vi.mock('@/lib/bring/consignments', () => ({
  resolveConsignments: (...a: unknown[]) => resolveConsignments(...a),
}))

const { POST } = await import('./route')
const { db } = await import('@/lib/db')

// Unique to THIS file's TrackingImport rows — see the Test data convention
// note in src/lib/bring/import.integration.test.ts. TrackingImport has no
// shop to tag, so scope by the filenames only this suite uses.
const FILENAMES = [
  'route-unexpected.csv', 'route-parse-error.docx', 'route-excel.xlsx', 'route-deadline.csv',
]

async function cleanup() {
  await db.trackingImport.deleteMany({ where: { filename: { in: FILENAMES } } })
}

beforeEach(async () => {
  await cleanup()
  mockUser = { userId: 'route-test-admin', email: 'admin@route-test.local', role: 'ADMIN', ambassadorId: null }
  bringConnected = false
  resolveConsignments.mockReset()
})

afterAll(cleanup)

function postFile(filename: string, body: string) {
  const form = new FormData()
  form.append('file', new File([body], filename))
  return POST(new Request('http://localhost/api/delivery/import', { method: 'POST', body: form }))
}

describe('POST /api/delivery/import', () => {
  it('hides an unexpected failure behind a generic message, and never forwards its text', async () => {
    const res = await postFile('route-unexpected.csv', 'no,known,numbers\n')
    expect(res.status).toBe(500)

    const text = await res.text()
    // Not just the exact message — nothing that even resembles what a raw
    // infrastructure error could contain, however the wording changes later.
    expect(text).not.toContain('10.0.0.5')
    expect(text).not.toContain('5432')
    expect(text).not.toMatch(/reach database server/i)
    expect(JSON.parse(text)).toEqual({
      error: 'Something went wrong reading this file. Please try again.',
    })
  })

  it('still shows a genuine parse error verbatim — it is written for the uploader', async () => {
    const res = await postFile('route-parse-error.docx', 'whatever')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Only Excel, PDF and CSV/)
  })

  // The manual button takes the SAME path as the emailed report. Before it was
  // rewired it called importTrackingFile, which reads the warehouse's own order
  // number — a column that matched the right order 0 times out of 27 — and
  // refused .xlsx outright, so the manual fallback could not even open the file
  // the warehouse sends. Both paths upsert on the one Shipment.trackingNumber
  // unique key, so the wrong path here could overwrite a correct BRING_EMAIL
  // link with a wrong FILE one and have the cron stamp real milestones onto the
  // wrong order.
  //
  // These bytes are not a real workbook, so the answer is still an error — but
  // it is the xlsx reader's error, which is only reachable on the new path.
  it('opens the Excel the warehouse actually sends, on the same path the email takes', async () => {
    const res = await postFile('route-excel.xlsx', 'not really a workbook')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/could not be read as an Excel file/i)
    expect(body.error).not.toMatch(/Only Excel, PDF and CSV/)
  })

  // Rewiring this route onto importWarehouseFile gave it the inbound route's
  // exposure: sequential Bring lookups, one HTTP call per parcel, under a
  // 60-second maxDuration. A platform kill is not a JS throw, so
  // importWarehouseFile's guard never runs — no TrackingImport row, no answer
  // to the operator, and the delivery page reads like a quiet day. On the one
  // screen someone opens precisely because the automatic feed already failed.
  it('bounds the whole upload with one deadline, so a slow Bring day stops cleanly', async () => {
    bringConnected = true
    resolveConsignments.mockResolvedValue({ consignments: [], unresolved: [] })

    const before = Date.now()
    const res = await postFile('route-deadline.csv', 'no,known,numbers\n')
    expect(res.status).toBe(200)

    // resolveConsignments checks this before every lookup — see
    // consignments.ts — so it has to actually arrive there for the protection
    // to exist at all. Derived from maxDuration (60) less 10s of headroom.
    const opts = resolveConsignments.mock.calls[0][2] as { deadline?: number }
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 49_000)
    expect(opts.deadline).toBeLessThanOrEqual(before + 51_000)
  })

  it('never lets an import response be cached: private, no-store on every outcome', async () => {
    const unexpected = await postFile('route-unexpected.csv', 'no,known,numbers\n')
    expect(unexpected.headers.get('cache-control')).toBe('private, no-store')

    const parseError = await postFile('route-parse-error.docx', 'whatever')
    expect(parseError.headers.get('cache-control')).toBe('private, no-store')

    mockUser = null
    const refused = await postFile('route-unexpected.csv', 'no,known,numbers\n')
    expect(refused.status).toBe(403)
    expect(refused.headers.get('cache-control')).toBe('private, no-store')
  })
})
