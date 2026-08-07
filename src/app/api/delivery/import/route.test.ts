import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'
import type { SessionUser } from '@/lib/auth/session'

// Mutable so tests can drive different auth states without re-mocking.
let mockUser: SessionUser | null = null

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))
vi.mock('@/lib/auth/current-user', () => ({ currentUser: async () => mockUser }))

// linkRows is the exact seam Finding 1's fix guards (src/lib/bring/import.ts).
// Forcing it to throw here proves the route's catch-all (Finding 2) hides an
// unexpected failure from the client — including anything that looks like a
// connection string — instead of forwarding the caught error's own message.
// knownOrderNumbers is left real: nothing here depends on its answer, since
// the file below matches no known order and the mocked linkRows throws
// regardless of what rows (even zero) it is given.
vi.mock('@/lib/bring/link', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bring/link')>()
  return {
    ...actual,
    linkRows: async () => {
      throw new Error('Can’t reach database server at `10.0.0.5:5432`')
    },
  }
})

const { POST } = await import('./route')
const { db } = await import('@/lib/db')

// Unique to THIS file's TrackingImport rows — see the Test data convention
// note in src/lib/bring/import.integration.test.ts. TrackingImport has no
// shop to tag, so scope by the filenames only this suite uses.
const FILENAMES = ['route-unexpected.csv', 'route-parse-error.docx']

async function cleanup() {
  await db.trackingImport.deleteMany({ where: { filename: { in: FILENAMES } } })
}

beforeEach(async () => {
  await cleanup()
  mockUser = { userId: 'route-test-admin', email: 'admin@route-test.local', role: 'ADMIN', ambassadorId: null }
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
    expect(body.error).toMatch(/Only PDF and CSV/)
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
