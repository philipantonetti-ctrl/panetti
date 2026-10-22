import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVismaTokenCache } from './client'
import { filesForPo, findPoFiles, poFilesSince, poNumberOf } from './po-files'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const C = '33333333-3333-3333-3333-333333333333'

/** A supplier invoice as `supplierInvoice?expandAttachment=true` sends it. */
const invoice = (ref: string, po: unknown, attachments: unknown[] = [], lineAttachments: unknown[] = []) => ({
  referenceNumber: ref,
  date: '2026-07-02T00:00:00',
  supplier: { number: '50001', name: 'Belgo' },
  attachments,
  invoiceLines: [
    { lineNumber: 1, inventoryNumber: 'PANPIZPRO', poNumber: po, attachments: lineAttachments },
  ],
})

describe('filesForPo', () => {
  it('lists the files of every supplier invoice whose lines name the PO', () => {
    const files = filesForPo(
      [
        invoice('INV-1', '500148', [{ id: A, name: 'invoice.pdf', revision: 1 }]),
        invoice('INV-2', { value: '500148' }, [], [{ id: B, name: 'packing-list.pdf', revision: 2 }]),
      ],
      '500148',
    )
    expect(files).toEqual([
      { id: A, name: 'invoice.pdf', invoice: 'INV-1', invoiceDate: '2026-07-02' },
      { id: B, name: 'packing-list.pdf', invoice: 'INV-2', invoiceDate: '2026-07-02' },
    ])
  })

  /**
   * Visma answers 200 with the wrong rows when it ignores a filter, so the
   * PO number is checked on every row this reads, never trusted to the query.
   */
  it('never shows a file from an invoice for another PO', () => {
    const files = filesForPo(
      [
        invoice('INV-1', '500149', [{ id: A, name: 'someone-else.pdf' }]),
        invoice('INV-2', null, [{ id: B, name: 'no-po.pdf' }]),
        invoice('INV-3', '5001480', [{ id: C, name: 'longer-number.pdf' }]),
      ],
      '500148',
    )
    expect(files).toEqual([])
  })

  it('lists a file once, however many matching lines repeat it', () => {
    const inv = invoice('INV-1', '500148', [{ id: A, name: 'invoice.pdf' }], [{ id: A, name: 'invoice.pdf' }])
    inv.invoiceLines.push({ lineNumber: 2, inventoryNumber: 'X', poNumber: '500148', attachments: [{ id: A, name: 'invoice.pdf' }] })
    expect(filesForPo([inv], '500148')).toHaveLength(1)
  })

  it('drops an attachment with no usable id rather than drawing a dead link', () => {
    const files = filesForPo(
      [invoice('INV-1', '500148', [{ id: 'not-a-uuid', name: 'x.pdf' }, { name: 'y.pdf' }, { id: A }])],
      '500148',
    )
    expect(files).toEqual([{ id: A, name: 'file', invoice: 'INV-1', invoiceDate: '2026-07-02' }])
  })
})

describe('poNumberOf', () => {
  it('reads the stored number first, then the one inside a Visma id, else none', () => {
    expect(poNumberOf({ poNumber: ' 500148 ', externalId: '500148-2' })).toBe('500148')
    expect(poNumberOf({ poNumber: null, externalId: '500148-2' })).toBe('500148')
    expect(poNumberOf({ poNumber: '', externalId: null })).toBeNull()
    expect(poNumberOf({ poNumber: null, externalId: 'oddid' })).toBeNull()
  })
})

describe('poFilesSince', () => {
  it('starts a month before the order, because a deposit can be invoiced first', () => {
    expect(poFilesSince(new Date('2026-06-15T00:00:00Z'))).toBe('2026-05-16')
  })
})

describe('findPoFiles', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const creds = { clientId: 'cid', clientSecret: 'sec', tenantId: 'tid' }

  beforeEach(() => resetVismaTokenCache())
  afterEach(() => vi.unstubAllGlobals())

  it('asks for the supplier invoices of that product since the order, with their files', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url))
        if (String(url).includes('connect/token')) return json({ access_token: 'tok', expires_in: 3600 })
        return json([invoice('INV-1', '500148', [{ id: A, name: 'invoice.pdf' }])])
      }),
    )

    const got = await findPoFiles(creds, { poNumber: '500148', sku: 'PANPIZPRO', orderedAt: new Date('2026-06-15T00:00:00Z') })

    expect(got).toEqual({
      files: [{ id: A, name: 'invoice.pdf', invoice: 'INV-1', invoiceDate: '2026-07-02' }],
      complete: true,
    })
    const read = calls.find((u) => u.includes('supplierinvoice'))!
    expect(read).toContain('https://api.finance.visma.net/v1/supplierinvoice?')
    expect(read).toContain('item=PANPIZPRO')
    expect(read).toContain('docDate=2026-05-16')
    expect(read).toContain('docDateCondition=%3E')
    expect(read).toContain('expandAttachment=true')
  })
})
