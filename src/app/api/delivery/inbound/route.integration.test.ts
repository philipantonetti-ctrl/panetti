import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'

const importWarehouseFile = vi.fn()
vi.mock('@/lib/bring/import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bring/import')>()
  return { ...actual, importWarehouseFile: (...a: unknown[]) => importWarehouseFile(...a) }
})

const { db } = await import('@/lib/db')
const { POST } = await import('./route')

const SECRET = 'inbound-secret-for-tests'
const FILES = ['eod.xlsx']

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

  it('imports the attachment and answers 200', async () => {
    importWarehouseFile.mockResolvedValue({
      importId: 'x', parsed: 3, linked: 3, unmatched: [], unaccounted: 0,
    })
    const res = await post(message('eod.xlsx'))
    expect(res.status).toBe(200)
    expect(importWarehouseFile).toHaveBeenCalledOnce()
    expect(importWarehouseFile.mock.calls[0][1]).toBe('eod.xlsx')
    expect(importWarehouseFile.mock.calls[0][2]).toBe('EMAIL')
  })

  it('skips an attachment type it cannot read, without failing the delivery', async () => {
    importWarehouseFile.mockClear()
    const res = await post(message('signature.png'))
    expect(res.status).toBe(200)
    expect(importWarehouseFile).not.toHaveBeenCalled()
  })

  it('answers 200 even when the import throws, so Postmark does not redeliver', async () => {
    importWarehouseFile.mockRejectedValue(new Error('bad file'))
    const res = await post(message('eod.xlsx'))
    expect(res.status).toBe(200)
  })

  it('records an email that carried no readable attachment at all', async () => {
    importWarehouseFile.mockClear()
    const res = await post({ Subject: 'hello', From: 'x@example.test', Attachments: [] })
    expect(res.status).toBe(200)
    const row = await db.trackingImport.findFirst({
      where: { source: 'EMAIL', error: { contains: 'no readable attachment' } },
      orderBy: { receivedAt: 'desc' },
    })
    expect(row).not.toBeNull()
    await db.trackingImport.deleteMany({ where: { id: row!.id } })
  })
})
