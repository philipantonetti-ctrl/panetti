import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest'

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
// (filename '(none)') and any filename we invent below need covering here -
// listed anyway, defensively, so a future change to the route cannot leak a
// row this file doesn't clean up.
const FILES = [
  'eod.xlsx', 'eod.xls', 'notes.txt', 'signature.png', '(none)', '(unnamed attachment)',
  // These two must never produce a row. Listed so that if the inline-image
  // skip ever regresses, the rows it starts writing are still cleaned up here
  // rather than left behind for every other suite to trip over.
  'image001.png', 'image002.png',
]

/** Rows this suite is responsible for. Used to prove a request wrote none. */
const rowCount = () => db.trackingImport.count({ where: { filename: { in: FILES } } })

/**
 * A logo in an email signature, as Postmark actually delivers it: in the same
 * Attachments array as a real file, told apart only by ContentID.
 */
const inlineImage = (name: string) => ({
  Name: name,
  Content: Buffer.from('PNG').toString('base64'),
  ContentType: 'image/png',
  ContentID: `${name}@01DA0000.00000001`,
})

const enclosure = (name: string, contentType = 'application/octet-stream') => ({
  Name: name,
  Content: Buffer.from('x').toString('base64'),
  ContentType: contentType,
  // Some mailers do leave this empty on a genuine enclosure. Gmail does NOT -
  // see gmailEnclosure below, which is the shape that broke production.
  ContentID: '',
})

/**
 * A real attachment exactly as GMAIL sends one.
 *
 * Measured from the raw MIME of a message delivered to the live inbound address
 * on 2026-08-14. The warehouse report arrived as:
 *
 *   Content-Type: application/vnd...spreadsheetml.sheet; name="LTAS_Eod_Report_20260811.xlsx"
 *   Content-Disposition: attachment; filename="LTAS_Eod_Report_20260811.xlsx"
 *   X-Attachment-Id: f_mssm65ae0
 *   Content-ID: <f_mssm65ae0>
 *
 * `Content-Disposition: attachment` and a Content-ID, together, on one file.
 * Every other fixture in this file hand-writes `ContentID: ''` for a real
 * attachment, which is what let the suite stay green while production dropped
 * the report on the floor.
 */
const gmailEnclosure = (name: string) => ({
  Name: name,
  Content: Buffer.from('x').toString('base64'),
  ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ContentID: 'f_mssm65ae0',
})

const email = (attachments: unknown[]) => ({
  Subject: 'EOD report',
  From: 'warehouse@example.test',
  Attachments: attachments,
})

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
  // only ever exercises the length early-return in authorised() - never
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
    // before every lookup - see consignments.ts - so it has to actually reach
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
  // on its own - `results` is the JSON body handed back to Postmark, and no
  // human ever reads it. An email whose ONLY attachment is unreadable must
  // still leave a TrackingImport row, or it is exactly as invisible as
  // before - the warehouse renames the report `eod.xls`, sends it alone, and
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
    // The row names the file AND why it was refused. An operator reading the
    // delivery page has to be able to act on it - "a .png arrived instead of
    // the report" is actionable, "something went wrong" is not.
    expect(row?.error).toMatch(/signature\.png/)
    expect(row?.error).toMatch(/not a file type/i)
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

    // The load-bearing half. `results` goes back to Postmark and nobody reads
    // it; the delivery page reads TrackingImport. Asserting only on the body
    // above pinned the partial fix - the renamed report still vanished from the
    // only place a human would ever look for it.
    const row = await db.trackingImport.findFirst({
      where: { source: 'EMAIL', filename: 'eod.xls' },
      orderBy: { receivedAt: 'desc' },
    })
    expect(row).not.toBeNull()
    expect(row?.error).toMatch(/not a file type/i)
  })

  /**
   * The cost of recording every refusal, if the gate keys only on the filename.
   *
   * Postmark delivers an email signature's logo INSIDE the Attachments array,
   * so an ordinary good morning would write "image001.png is not a file type
   * this route can read" next to its successful import, every single day. The
   * delivery page shows the ten most recent imports: it would be permanently
   * red on good mornings and would hold about three days of history instead of
   * ten - alarm fatigue on the exact surface this design's promise rests on.
   */
  it('records nothing at all for a signature image riding along with a good report', async () => {
    importWarehouseFile.mockReset()
    importWarehouseFile.mockResolvedValue({
      importId: 'x', parsed: 27, linked: 27, unmatched: [], unaccounted: 0,
    })
    const before = await rowCount()

    const res = await post(email([enclosure('eod.xlsx'), inlineImage('image001.png')]))
    expect(res.status).toBe(200)

    // The report is imported; the logo is not even mentioned.
    const body = await res.json()
    expect(body.results).toEqual([{ filename: 'eod.xlsx', linked: 27 }])
    expect(importWarehouseFile).toHaveBeenCalledOnce()

    // And nothing was written. Not a refusal for the logo, and not the
    // "nothing readable arrived" row either - the report did arrive.
    expect(await rowCount()).toBe(before)
  })

  /**
   * The bug the fixtures above hid, and the reason this file exists in this shape.
   *
   * Gmail stamps a Content-ID on EVERY attachment, not only on inline images.
   * Keying "is this part of the body?" on a non-empty ContentID therefore skipped
   * the warehouse report itself: `recorded` stayed 0, importWarehouseFile was
   * never called, and the delivery page showed
   * "(none) - This email carried no readable attachment" on 2026-08-14 while the
   * spreadsheet sat in the payload untouched.
   *
   * A file this route can read is never part of the message body. No email
   * signature is an .xlsx, .csv, .txt or .pdf.
   */
  it('imports a report Gmail stamped a ContentID on, instead of taking it for a signature image', async () => {
    importWarehouseFile.mockReset()
    importWarehouseFile.mockResolvedValue({
      importId: 'x', parsed: 27, linked: 27, unmatched: [], unaccounted: 0,
    })
    const beforeNone = await db.trackingImport.count({ where: { filename: '(none)' } })

    const res = await post(email([gmailEnclosure('eod.xlsx')]))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.results).toEqual([{ filename: 'eod.xlsx', linked: 27 }])
    expect(importWarehouseFile).toHaveBeenCalledOnce()

    // And emphatically NOT the "nothing readable arrived" row: the report did
    // arrive, and that row claiming otherwise is the production symptom.
    expect(await db.trackingImport.count({ where: { filename: '(none)' } })).toBe(beforeNone)
  })

  // A signature logo must STILL be skipped once the filename decides first,
  // otherwise this fix simply trades one permanently-red delivery page for the
  // other. Gmail's own Content-ID shape, on a file we could never import.
  it('still ignores a signature image that carries the same Gmail-style ContentID', async () => {
    importWarehouseFile.mockReset()
    importWarehouseFile.mockResolvedValue({
      importId: 'x', parsed: 27, linked: 27, unmatched: [], unaccounted: 0,
    })
    const before = await rowCount()

    const res = await post(
      email([gmailEnclosure('eod.xlsx'), { ...gmailEnclosure('image001.png'), ContentType: 'image/png' }]),
    )
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.results).toEqual([{ filename: 'eod.xlsx', linked: 27 }])
    expect(await rowCount()).toBe(before)
  })

  // The interaction that pulls against the test above: skipping inline images
  // must not also swallow a REAL attachment we could not read. Item 2's whole
  // point - the report renamed eod.xls - still has to leave a durable row, and
  // a signature image in the same email must not change that.
  it('still records a genuinely unreadable attachment when a signature image rides along', async () => {
    importWarehouseFile.mockReset()
    const before = await db.trackingImport.count({ where: { filename: 'eod.xls' } })

    const res = await post(email([inlineImage('image001.png'), enclosure('eod.xls')]))
    expect(res.status).toBe(200)
    expect(importWarehouseFile).not.toHaveBeenCalled()

    const body = await res.json()
    expect(body.results).toEqual([{ filename: 'eod.xls', error: expect.any(String) }])

    expect(await db.trackingImport.count({ where: { filename: 'eod.xls' } })).toBe(before + 1)
    const row = await db.trackingImport.findFirst({
      where: { source: 'EMAIL', filename: 'eod.xls' },
      orderBy: { receivedAt: 'desc' },
    })
    expect(row?.error).toMatch(/not a file type/i)

    // The logo still leaves nothing behind, even beside a failure.
    expect(await db.trackingImport.findFirst({ where: { filename: 'image001.png' } })).toBeNull()
  })

  // The other half of the same interaction. An email carrying only a signature
  // is a morning where the report did not come, and it must not be allowed to
  // look like a quiet day just because the images were skipped silently.
  it('records that nothing arrived when the only attachments are inline images', async () => {
    importWarehouseFile.mockReset()
    const before = await db.trackingImport.count({ where: { filename: '(none)' } })

    const res = await post(email([inlineImage('image001.png'), inlineImage('image002.png')]))
    expect(res.status).toBe(200)
    expect(importWarehouseFile).not.toHaveBeenCalled()

    const body = await res.json()
    expect(body.results).toEqual([])

    // Exactly one row, not one per skipped image and not none at all.
    expect(await db.trackingImport.count({ where: { filename: '(none)' } })).toBe(before + 1)
    const row = await db.trackingImport.findFirst({
      where: { source: 'EMAIL', filename: '(none)' },
      orderBy: { receivedAt: 'desc' },
    })
    expect(row?.error).toMatch(/no readable attachment/i)
    await db.trackingImport.deleteMany({ where: { id: row!.id } })
  })

  // Two readable attachments used to claim 50 seconds EACH against a 60-second
  // maxDuration for the whole request. A platform timeout is not a JS throw, so
  // importWarehouseFile's guard never runs: no row written, no 200 returned,
  // and Postmark redelivers the identical payload forever.
  it('spends one deadline across the whole request, not one per attachment', async () => {
    importWarehouseFile.mockReset()
    importWarehouseFile.mockResolvedValue({
      importId: 'x', parsed: 1, linked: 1, unmatched: [], unaccounted: 0,
    })
    const content = Buffer.from('x').toString('base64')
    await post({
      Subject: 'EOD report',
      From: 'warehouse@example.test',
      Attachments: [
        { Name: 'eod.xlsx', Content: content, ContentType: 'application/octet-stream' },
        { Name: 'notes.txt', Content: content, ContentType: 'text/plain' },
      ],
    })
    expect(importWarehouseFile).toHaveBeenCalledTimes(2)
    const first = importWarehouseFile.mock.calls[0][3] as { deadline: number }
    const second = importWarehouseFile.mock.calls[1][3] as { deadline: number }
    expect(second.deadline).toBe(first.deadline)
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

  /**
   * WHO SENT IT.
   *
   * Anyone who learns the Postmark inbound address can post a spreadsheet
   * straight into the shipment data, because until now nothing read `From` at
   * all - the URL token authenticates POSTMARK, not the person who emailed it.
   * And the address has to be handed to the warehouse for any of this to work,
   * so it cannot stay secret forever.
   *
   * Deliberately a WARNING and not a refusal. The warehouse has never sent a
   * single email yet (Postmark: 3 inbound ever, all internal tests), so the
   * very first real report is the one most likely to arrive from an address
   * slightly different from the one we were told. Refusing it would drop the
   * file we have been waiting weeks for; importing it and saying so loudly
   * loses nothing and still surfaces the surprise.
   *
   * The note lands on the import's own row rather than a second one, so the
   * Imports list shows one line per email: what arrived, whether it worked,
   * and anything odd about it.
   */
  describe('sender check', () => {
    /** A real row for the route to annotate - the mock's id must point at one. */
    async function seedImport() {
      const row = await db.trackingImport.create({
        data: { filename: 'eod.xlsx', source: 'EMAIL', rowsParsed: 3, rowsLinked: 3, rowsUnmatched: 0 },
      })
      importWarehouseFile.mockReset()
      importWarehouseFile.mockResolvedValue({
        importId: row.id, parsed: 3, linked: 3, unmatched: [], unaccounted: 0,
      })
      return row.id
    }

    const from = (address: string) => ({
      Subject: 'EOD report',
      From: address,
      FromFull: { Email: address, Name: 'Warehouse', MailboxHash: '' },
      Attachments: [{ Name: 'eod.xlsx', Content: Buffer.from('x').toString('base64') }],
    })

    afterEach(() => vi.unstubAllEnvs())

    it('still imports a file from an unexpected sender, and says so on the row', async () => {
      vi.stubEnv('WAREHOUSE_SENDER', 'noreply@selected3pl.se')
      const id = await seedImport()

      const res = await post(from('someone-else@evil.test'))
      expect(res.status).toBe(200)
      // Imported: the file was not dropped.
      expect(importWarehouseFile).toHaveBeenCalledTimes(1)

      const row = await db.trackingImport.findUniqueOrThrow({ where: { id } })
      expect(row.error).toContain('someone-else@evil.test')
      expect(row.error).toContain('noreply@selected3pl.se')
    })

    it('says nothing when the sender is the expected one, whatever its case', async () => {
      vi.stubEnv('WAREHOUSE_SENDER', 'noreply@selected3pl.se')
      const id = await seedImport()

      // Mail addresses are not case sensitive, and a mailer that upper-cases
      // the domain must not raise an alarm every morning.
      await post(from('NoReply@Selected3PL.se'))

      expect((await db.trackingImport.findUniqueOrThrow({ where: { id } })).error).toBeNull()
    })

    it('checks nothing at all until an expected sender is configured', async () => {
      // The state this ships in. Nobody has set WAREHOUSE_SENDER yet, and an
      // unconfigured check must not start flagging every ordinary email.
      vi.stubEnv('WAREHOUSE_SENDER', '')
      const id = await seedImport()

      await post(from('anyone@anywhere.test'))

      expect((await db.trackingImport.findUniqueOrThrow({ where: { id } })).error).toBeNull()
    })
  })
})
