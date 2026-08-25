import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { ingestInbound, type InboundPayload } from './ingest'

const DOMAIN = 'ingest.inbox-test.invalid'
const SUPPORT = `support@${DOMAIN}`
const KARI = 'kari.ingest@example.com'
const TAG = '[inbox-test-ingest]'
let shopId: string, mailboxId: string

async function cleanup() {
  await db.ticket.deleteMany({ where: { mailbox: { address: { endsWith: DOMAIN } } } })
  await db.mailbox.deleteMany({ where: { address: { endsWith: DOMAIN } } })
  await db.order.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)

const payload = (over: Partial<InboundPayload> = {}): InboundPayload => ({
  From: KARI, FromName: 'Kari Olsen', FromFull: { Email: KARI, Name: 'Kari Olsen' },
  To: SUPPORT, ToFull: [{ Email: SUPPORT, Name: '' }], Cc: '', CcFull: [], OriginalRecipient: SUPPORT,
  Subject: 'Hvor er ordre #1042?', MessageID: 'pm-uuid-1', Date: 'Thu, 20 Aug 2026 10:00:00 +0200',
  TextBody: 'Hei, hvor er pakken min? Ordre #1042. Takk, Kari',
  HtmlBody: '<p>Hei, hvor er pakken min? Ordre #1042.</p>', StrippedTextReply: '',
  Headers: [{ Name: 'Message-ID', Value: '<m1@gmail.com>' }, { Name: 'X-Spam-Score', Value: '0.1' }],
  Attachments: [],
  ...over,
})

beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'NOK' } })).id
  mailboxId = (await db.mailbox.create({ data: { address: SUPPORT, name: 'Panetti NO', shopId, language: 'nb' } })).id
  await db.order.create({
    data: { shopId, externalId: 'i1', number: '#1042', placedAt: new Date('2026-08-10'), status: 'completed', currency: 'NOK',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName: 'Kari Olsen', customerEmail: KARI },
  })
})

describe('ingestInbound', () => {
  it('creates a ticket on the mailbox the mail was sent to, matched, classified, with the message stored', async () => {
    const r = await ingestInbound(payload())
    expect(r.outcome).toBe('created')
    if (r.outcome !== 'created') throw new Error('unreachable')
    const t = await db.ticket.findUniqueOrThrow({ where: { id: r.ticketId }, include: { messages: true, matchedOrder: true } })
    expect(t.mailboxId).toBe(mailboxId)
    expect(t.status).toBe('OPEN')
    expect(t.customerEmail).toBe(KARI)
    expect(t.customerName).toBe('Kari Olsen')
    expect(t.category).toBe('shipping')
    expect(t.language).toBe('nb')
    expect(t.matchedOrder?.number).toBe('#1042')
    expect(t.messages).toHaveLength(1)
    expect(t.messages[0]).toMatchObject({ direction: 'INBOUND', rfcMessageId: 'm1@gmail.com', fromEmail: KARI, toEmail: SUPPORT, spamScore: 0.1 })
  })

  it('a redelivered webhook is a no-op', async () => {
    const a = await ingestInbound(payload())
    const b = await ingestInbound(payload())
    if (a.outcome !== 'created') throw new Error('unreachable')
    expect(b).toEqual({ outcome: 'duplicate', ticketId: a.ticketId })
    expect(await db.ticketMessage.count({ where: { ticketId: a.ticketId } })).toBe(1)
  })

  it('a reply carrying our id in References continues the ticket and reopens it', async () => {
    const a = await ingestInbound(payload())
    if (a.outcome !== 'created') throw new Error('unreachable')
    await db.ticketMessage.create({ data: { ticketId: a.ticketId, direction: 'OUTBOUND', rfcMessageId: 'ours1@' + DOMAIN, fromEmail: SUPPORT, toEmail: KARI, textBody: 'On its way', sentAt: new Date() } })
    await db.ticket.update({ where: { id: a.ticketId }, data: { status: 'CLOSED', closedAt: new Date() } })

    const b = await ingestInbound(payload({
      Subject: 'Re: Hvor er ordre #1042?', TextBody: 'Fortsatt ikke kommet',
      Headers: [{ Name: 'Message-ID', Value: '<m2@gmail.com>' }, { Name: 'In-Reply-To', Value: `<ours1@${DOMAIN}>` }, { Name: 'References', Value: `<m1@gmail.com> <ours1@${DOMAIN}>` }],
    }))
    expect(b).toEqual({ outcome: 'continued', ticketId: a.ticketId, messageId: expect.any(String) })
    const t = await db.ticket.findUniqueOrThrow({ where: { id: a.ticketId } })
    expect(t.status).toBe('OPEN')
    expect(t.closedAt).toBeNull()
    expect(await db.ticketMessage.count({ where: { ticketId: a.ticketId } })).toBe(3)
  })

  it('a reply with stripped headers still finds the ticket by our subject token', async () => {
    const a = await ingestInbound(payload())
    if (a.outcome !== 'created') throw new Error('unreachable')
    const number = (await db.ticket.findUniqueOrThrow({ where: { id: a.ticketId } })).number
    const b = await ingestInbound(payload({ Subject: `Re: Hvor er ordre #1042? [PA-${number}]`, Headers: [{ Name: 'Message-ID', Value: '<m3@gmail.com>' }] }))
    expect(b.outcome).toBe('continued')
    if (b.outcome !== 'continued') throw new Error('unreachable')
    expect(b.ticketId).toBe(a.ticketId)
  })

  it('a second mail from the same sender on the same mailbox within 14 days continues the open ticket', async () => {
    const a = await ingestInbound(payload())
    if (a.outcome !== 'created') throw new Error('unreachable')
    const b = await ingestInbound(payload({ Subject: 'Hallo?', Headers: [{ Name: 'Message-ID', Value: '<m4@gmail.com>' }] }))
    expect(b.outcome).toBe('continued')
    if (b.outcome !== 'continued') throw new Error('unreachable')
    expect(b.ticketId).toBe(a.ticketId)
  })

  it('never merges across mailboxes: same token, other brand, is refused and a new ticket made', async () => {
    const other = await db.mailbox.create({ data: { address: `support@other.${DOMAIN}`, name: 'Other', language: 'de' } })
    const a = await ingestInbound(payload())
    if (a.outcome !== 'created') throw new Error('unreachable')
    const number = (await db.ticket.findUniqueOrThrow({ where: { id: a.ticketId } })).number
    const b = await ingestInbound(payload({ To: other.address, ToFull: [{ Email: other.address, Name: '' }], OriginalRecipient: other.address,
      Subject: `Re: x [PA-${number}]`, Headers: [{ Name: 'Message-ID', Value: '<m5@gmail.com>' }] }))
    expect(b.outcome).toBe('created')
    if (b.outcome !== 'created') throw new Error('unreachable')
    expect(b.ticketId).not.toBe(a.ticketId)
  })

  it('an autoresponder never opens a ticket', async () => {
    const r = await ingestInbound(payload({ Headers: [{ Name: 'Message-ID', Value: '<ooo@x>' }, { Name: 'Auto-Submitted', Value: 'auto-replied' }] }))
    expect(r).toEqual({ outcome: 'automated' })
    expect(await db.ticket.count({ where: { mailboxId } })).toBe(0)
  })

  it('mail from our own support address is dropped - the self-loop', async () => {
    const r = await ingestInbound(payload({ From: SUPPORT, FromFull: { Email: SUPPORT, Name: 'us' }, Headers: [{ Name: 'Message-ID', Value: '<self@x>' }] }))
    expect(r).toEqual({ outcome: 'ignored_own' })
  })

  it('mail to an address nobody connected is reported, not stored', async () => {
    const r = await ingestInbound(payload({ To: 'nobody@elsewhere.invalid', ToFull: [{ Email: 'nobody@elsewhere.invalid', Name: '' }], OriginalRecipient: 'nobody@elsewhere.invalid' }))
    expect(r).toEqual({ outcome: 'no_mailbox' })
  })

  it('stores attachments under the cap and skips a whale, without failing the mail', async () => {
    const small = Buffer.from('hello').toString('base64')
    const r = await ingestInbound(payload({ Attachments: [
      { Name: 'photo.jpg', ContentType: 'image/jpeg', ContentLength: 5, Content: small },
      { Name: 'huge.bin', ContentType: 'application/octet-stream', ContentLength: 11 * 1024 * 1024, Content: 'x'.repeat(15 * 1024 * 1024) },
    ] }))
    if (r.outcome !== 'created') throw new Error('unreachable')
    const files = await db.ticketAttachment.findMany({ where: { message: { ticketId: r.ticketId } } })
    expect(files.map((f) => f.filename)).toEqual(['photo.jpg'])
    expect(Buffer.from(files[0].content).toString()).toBe('hello')
  })

  it('an email with no Message-ID header still dedupes on the id Postmark itself assigned', async () => {
    const a = await ingestInbound(payload({ Headers: [] }))
    const b = await ingestInbound(payload({ Headers: [] }))
    expect(a.outcome).toBe('created')
    expect(b.outcome).toBe('duplicate')
  })
})
