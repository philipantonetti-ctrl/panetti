import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'

const importWarehouseFile = vi.fn()
vi.mock('@/lib/bring/import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bring/import')>()
  return { ...actual, importWarehouseFile: (...a: unknown[]) => importWarehouseFile(...a) }
})

const { db } = await import('@/lib/db')
const { POST } = await import('./route')

const SECRET = 'inbound-secret-for-tests'
// Every filename this file's requests can cause the route to attach to a
// TrackingImport row. importWarehouseFile itself is mocked, so it never
// touches the table; only the route's own "nothing readable at all" write
// (filename '(none)') and any filename we invent below need covering here —
// listed anyway, defensively, so a future change to the route cannot leak a
// row this file doesn't clean up.
const FILES = ['eod.xlsx', 'eod.xls', 'notes.txt', 'signature.png', '(none)']

beforeAll(() => {
  process.env.DELIVERY_INBOUND_SECRET = SECRET
})

afterAll(async () => {
  await db.trackingImport.deleteMany({ where: { filename: { in: FILES } } })
})

const post = (body: unknown, token = SECRET) =>
  POST(
    new Request(`https://x.test/api/delivery/inbound?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const message = (name: string, content = Buffer.from('x').toString('base64')) => ({
  Subject: 'EOD report',
  From: 'warehouse@example.test',
  Attachments: [{ Name: name, Content: content, ContentType: 'application/octet-stream' }],
})

describe('POST /api/delivery/inbound', () => {
  it('rejects a wrong token', async () => {
    const res = await post(message('eod.xlsx'), 'not-the-secret')
    expect(res.status).toBe(401)
    expect(importWarehouseFile).not.toHaveBeenCalled()
  })

  it('rejects a missing token', async () => {
    const res = await POST(
      new Request('https://x.test/api/delivery/inbound', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message('eod.xlsx')),
      }),
    )
    expect(res.status).toBe(401)
  })

  // 'not-the-secret' above is 14 chars against a 24-char SECRET, so that test
  // only ever exercises the length early-return in authorised() — never
  // reaches timingSafeEqual itself. A same-length wrong token is the only way
  // to actually run the comparison.
  it('rejects a same-length wrong token', async () => {
    const wrong = SECRET.split('').reverse().join('')
    expect(wrong).not.toBe(SECRET)
    expect(wrong.length).toBe(SECRET.length)
    const res = await post(message('eod.xlsx'), wrong)
    expect(res.status).toBe(401)
    expect(importWarehouseFile).not.toHaveBeenCalled()
  })

  // The most dangerous misconfiguration: a deployment that forgot to set the
  // secret must refuse, not stand open to anyone who knows the URL.
  it('refuses every request when DELIVERY_INBOUND_SECRET is not set', async () => {
    const previous = process.env.DELIVERY_INBOUND_SECRET
    delete process.env.DELIVERY_INBOUND_SECRET
    try {
      const res = await post(message('eod.xlsx'))
      expect(res.status).toBe(401)
      expect(importWarehouseFile).not.toHaveBeenCalled()
    } finally {
      process.env.DELIVERY_INBOUND_SECRET = previous
    }
  })

  it('imports the attachment and answers 200', async () => {
    importWarehouseFile.mockReset()
    importWarehouseFile.mockResolvedValue({
      importId: 'x', parsed: 3, linked: 3, unmatched: [], unaccounted: 0,
    })
    const before = Date.now()
    const res = await post(message('eod.xlsx'))
    expect(res.status).toBe(200)
    expect(importWarehouseFile).toHaveBeenCalledOnce()
    expect(importWarehouseFile.mock.calls[0][1]).toBe('eod.xlsx')
    expect(importWarehouseFile.mock.calls[0][2]).toBe('EMAIL')

    // A slow Bring day must stop cleanly inside the platform's 60s ceiling,
    // not get killed mid-write. resolveConsignments checks this deadline
    // before every lookup — see consignments.ts — so it has to actually reach
    // the call for that protection to exist.
    const opts = importWarehouseFile.mock.calls[0][3] as { deadline: number }
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 49_000)
    expect(opts.deadline).toBeLessThanOrEqual(before + 51_000)
  })

  it('skips an attachment type it cannot read, without failing the delivery', async () => {
    importWarehouseFile.mockReset()
    const res = await post(message('signature.png'))
    expect(res.status).toBe(200)
    expect(importWarehouseFile).not.toHaveBeenCalled()

    // A bare `continue` used to drop this with no trace at all. Now it must
    // show up in the response, not vanish silently.
    const body = await res.json()
    expect(body.results).toEqual([
      { filename: 'signature.png', error: expect.any(String) },
    ])
  })

  // Pins a regression: recording the skip in `results` (above) is not enough
  // on its own — `results` is the JSON body handed back to Postmark, and no
  // human ever reads it. An email whose ONLY attachment is unreadable must
  // still leave a TrackingImport row, or it is exactly as invisible as
  // before — the warehouse renames the report `eod.xls`, sends it alone, and
  // the delivery page shows a quiet morning that never happened.
  it('leaves a TrackingImport row when the only attachment is unreadable, not just a response entry', async () => {
    importWarehouseFile.mockReset()
    const res = await post(message('signature.png'))
    expect(res.status).toBe(200)
    expect(importWarehouseFile).not.toHaveBeenCalled()

    const row = await db.trackingImport.findFirst({
      where: { source: 'EMAIL', filename: 'signature.png' },
      orderBy: { receivedAt: 'desc' },
    })
    expect(row).not.toBeNull()
    expect(row?.error).toMatch(/no readable attachment/i)
  })

  // The scenario the review actually found: a report renamed to the wrong
  // extension riding along with an attachment that DOES succeed. The skip
  // must not disappear behind the sibling's success.
  it('does not let a successful sibling attachment hide a skipped one', async () => {
    importWarehouseFile.mockReset()
    importWarehouseFile.mockResolvedValue({
      importId: 'x', parsed: 1, linked: 1, unmatched: [], unaccounted: 0,
    })
    const content = Buffer.from('x').toString('base64')
    const res = await post({
      Subject: 'EOD report',
      From: 'warehouse@example.test',
      Attachments: [
        { Name: 'eod.xls', Content: content, ContentType: 'application/octet-stream' },
        { Name: 'notes.txt', Content: content, ContentType: 'text/plain' },
      ],
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual([
      { filename: 'eod.xls', error: expect.any(String) },
      { filename: 'notes.txt', linked: 1 },
    ])
  })

  it('answers 200 even when the import throws, so Postmark does not redeliver', async () => {
    importWarehouseFile.mockReset()
    importWarehouseFile.mockRejectedValue(new Error('bad file'))
    const res = await post(message('eod.xlsx'))
    expect(res.status).toBe(200)
  })

  it('records an email that carried no readable attachment at all', async () => {
    importWarehouseFile.mockReset()
    const res = await post({ Subject: 'hello', From: 'x@example.test', Attachments: [] })
    expect(res.status).toBe(200)
    // Scoped by filename too: an unscoped source+error query on the shared
    // database can match, and this test would then delete, a row it did not
    // create.
    const row = await db.trackingImport.findFirst({
      where: { source: 'EMAIL', filename: '(none)', error: { contains: 'no readable attachment' } },
      orderBy: { receivedAt: 'desc' },
    })
    expect(row).not.toBeNull()
    await db.trackingImport.deleteMany({ where: { id: row!.id } })
  })
})
