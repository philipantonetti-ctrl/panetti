import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { vismaCredentials, vismaGet } from '@/lib/visma/client'
import { vismaGetPages } from '@/lib/visma/pages'
import { unwrap } from '@/lib/visma/purchase-orders'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

type Row = Record<string, unknown>
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : [])
const str = (v: unknown): string => String(unwrap<string | number>(v) ?? '').trim()
const num = (v: unknown): number => Number(unwrap<string | number>(v) ?? 0)

const who = (c: unknown): string => {
  const o = (c ?? {}) as Row
  return `${str(o.number)} ${str(o.name)}`.trim()
}

/**
 * Search EVERY customer for some webshop order numbers. A big order can be
 * invoiced to the buyer's own Visma customer instead of the shop's
 * "Webkunde" one, so "not on the house customer" is not yet "not in Visma".
 * Reads every sales order and invoice since the date and names, per number,
 * who holds it. Called after assertAdmin.
 */
async function searchEveryCustomer(params: URLSearchParams, wanted: string[]) {
  const since = params.get('since')?.trim() || defaultSince()
  if (!wanted.every((n) => /^\d+$/.test(n)) || wanted.length > 200 || !/^\d{4}-\d{2}-\d{2}$/.test(since))
    return NextResponse.json({ error: 'Send numbers=1,2,3 (at most 200) and optionally since (YYYY-MM-DD)' }, { status: 400, headers: NO_STORE })

  const creds = vismaCredentials()
  if (!creds) return NextResponse.json({ error: 'Visma is not configured here' }, { status: 503, headers: NO_STORE })

  const gt = encodeURIComponent('>')
  const so = await vismaGetPages(
    creds,
    `controller/api/v1/salesorderbasic?lastModifiedDateTime=${since}&lastModifiedDateTimeCondition=${gt}`,
    { pageSize: 500, maxPages: 40 },
  )
  const inv = await vismaGetPages(
    creds,
    `controller/api/v1/customerinvoice?documentDate=${since}&documentDateCondition=${gt}`,
    { pageSize: 500, maxPages: 40 },
  )

  const results = wanted.map((number) => {
    const salesOrders = rows(so.rows)
      .filter((o) => str(o.customerOrder) === number || str(o.customerRefNo) === number)
      .map((o) => ({
        orderType: str(o.orderType),
        orderNo: str(o.orderNo),
        status: str(o.status),
        total: num(o.orderTotal),
        currency: str(o.currency),
        customer: who(o.customer),
      }))
    const invoices = rows(inv.rows)
      .filter((i) => str(i.customerRefNumber) === number || str(i.externalReference) === number)
      .map((i) => ({
        referenceNumber: str(i.referenceNumber),
        status: str(i.status),
        amount: num(i.amountInCurrency),
        currency: str(i.currencyId),
        customer: who(i.customer),
      }))
    return { number, found: salesOrders.length > 0 || invoices.length > 0, salesOrders, invoices }
  })

  return NextResponse.json(
    {
      since,
      complete: so.complete && inv.complete,
      scanned: { salesOrders: so.rows.length, invoices: inv.rows.length },
      results,
    },
    { headers: NO_STORE },
  )
}

/** Yesterday's date, so a check made the morning after still sees last night. */
function defaultSince(): string {
  const d = new Date(Date.now() - 24 * 3_600_000)
  return d.toISOString().slice(0, 10)
}

/**
 * Is this webshop order in Visma?
 *
 * Asked the day the Visma connector was found switched off: the only way to
 * know whether an order resent to the connector arrived is to look in Visma,
 * and the credentials for that exist only in production. This is read only.
 *
 * The order number is never trusted to a Visma query parameter. Visma answers
 * an unknown parameter with 200 and the wrong rows (measured 2026-08-18), so
 * the rows come back for the house customer and the date - two filters that
 * are proven to work - and the match is made here, on what each row carries:
 * the sales order's customerOrder / customerRefNo, the invoice's
 * customerRefNumber / externalReference.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const wanted = (params.get('numbers') ?? '').split(',').map((n) => n.trim()).filter(Boolean)
    if (wanted.length > 0 && !params.get('customer')) return searchEveryCustomer(params, wanted)
    const customer = params.get('customer')?.trim() ?? ''
    const number = params.get('number')?.trim() ?? ''
    const since = params.get('since')?.trim() || defaultSince()
    const list = params.get('list') === '1'
    if (!/^\d+$/.test(customer) || (!list && !/^\d+$/.test(number)) || !/^\d{4}-\d{2}-\d{2}$/.test(since))
      return NextResponse.json(
        { error: 'Send customer (the Visma house customer number), number (the webshop order number) or list=1, and optionally since (YYYY-MM-DD)' },
        { status: 400, headers: NO_STORE },
      )

    const creds = vismaCredentials()
    if (!creds)
      return NextResponse.json({ error: 'Visma is not configured here' }, { status: 503, headers: NO_STORE })

    const gt = encodeURIComponent('>')

    // Every webshop order number Visma holds for this customer since the date:
    // one paged read of each list, so all nine shops can be checked without
    // tripping Visma's rate limit one number at a time.
    if (list) {
      const so = await vismaGetPages(
        creds,
        `controller/api/v1/customer/${customer}/salesorderbasic?lastModifiedDateTime=${since}&lastModifiedDateTimeCondition=${gt}`,
        { pageSize: 500, maxPages: 20 },
      )
      const inv = await vismaGetPages(
        creds,
        `controller/api/v1/customerinvoice?customer=${customer}&documentDate=${since}&documentDateCondition=${gt}`,
        { pageSize: 500, maxPages: 20 },
      )
      const numbers = (list: Row[], ...fields: string[]) =>
        [...new Set(list.flatMap((r) => fields.map((f) => str(r[f]))).filter((n) => /^\d+$/.test(n)))].sort()
      return NextResponse.json(
        {
          customer,
          since,
          complete: so.complete && inv.complete,
          scanned: { salesOrders: so.rows.length, invoices: inv.rows.length },
          inSalesOrders: numbers(rows(so.rows), 'customerOrder', 'customerRefNo'),
          inInvoices: numbers(rows(inv.rows), 'customerRefNumber', 'externalReference'),
        },
        { headers: NO_STORE },
      )
    }
    const orders = rows(
      await vismaGet(
        creds,
        `controller/api/v1/customer/${customer}/salesorderbasic?lastModifiedDateTime=${since}&lastModifiedDateTimeCondition=${gt}&pageSize=500`,
      ),
    )
    const invoices = rows(
      await vismaGet(
        creds,
        `controller/api/v1/customerinvoice?customer=${customer}&documentDate=${since}&documentDateCondition=${gt}&pageSize=500`,
      ),
    )

    const carries = (...fields: unknown[]) => fields.some((f) => str(f) === number)

    const salesOrders = orders
      .filter((o) => carries(o.customerOrder, o.customerRefNo))
      .map((o) => ({
        orderType: str(o.orderType),
        orderNo: str(o.orderNo),
        status: str(o.status),
        date: str(o.date),
        customerOrder: str(o.customerOrder),
        customerRefNo: str(o.customerRefNo),
        orderTotal: num(o.orderTotal),
        currency: str(o.currency),
        lastModified: str(o.lastModifiedDateTime),
      }))

    const found = invoices
      .filter((i) => carries(i.customerRefNumber, i.externalReference))
      .map((i) => ({
        referenceNumber: str(i.referenceNumber),
        documentDate: str(i.documentDate),
        status: str(i.status),
        customerRefNumber: str(i.customerRefNumber),
        externalReference: str(i.externalReference),
        amount: num(i.amountInCurrency),
        currency: str(i.currencyId),
      }))

    return NextResponse.json(
      {
        customer,
        number,
        since,
        scanned: { salesOrders: orders.length, invoices: invoices.length },
        found: salesOrders.length > 0 || found.length > 0,
        salesOrders,
        invoices: found,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    // A network failure says only "fetch failed"; the reason (DNS, TLS, a
    // reset) sits in `cause`, and without it this answer is a dead end.
    const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : ''
    return NextResponse.json(
      { error: e instanceof Error ? `${e.message}${cause}` : 'Could not read Visma' },
      { status: 500, headers: NO_STORE },
    )
  }
}
