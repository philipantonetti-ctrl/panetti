import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { vismaCredentials, vismaGet } from '@/lib/visma/client'
import { unwrap } from '@/lib/visma/purchase-orders'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

type Row = Record<string, unknown>
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : [])
const str = (v: unknown): string => String(unwrap<string | number>(v) ?? '').trim()
const num = (v: unknown): number => Number(unwrap<string | number>(v) ?? 0)

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
    const customer = params.get('customer')?.trim() ?? ''
    const number = params.get('number')?.trim() ?? ''
    const since = params.get('since')?.trim() || defaultSince()
    if (!/^\d+$/.test(customer) || !/^\d+$/.test(number) || !/^\d{4}-\d{2}-\d{2}$/.test(since))
      return NextResponse.json(
        { error: 'Send customer (the Visma house customer number), number (the webshop order number) and optionally since (YYYY-MM-DD)' },
        { status: 400, headers: NO_STORE },
      )

    const creds = vismaCredentials()
    if (!creds)
      return NextResponse.json({ error: 'Visma is not configured here' }, { status: 503, headers: NO_STORE })

    const gt = encodeURIComponent('>')
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
