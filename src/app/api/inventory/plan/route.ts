import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertOperations, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { savePlan } from '@/lib/inventory/plan'
import { readPlanWorkbook } from '@/lib/inventory/plan-xlsx'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: NO_STORE })
const MAX_BYTES = 10 * 1024 * 1024

class BadRequest extends Error {}

function handle(e: unknown, what: string) {
  if (e instanceof AuthError) return fail(e.message, 403)
  if (e instanceof BadRequest) return fail(e.message, 400)
  console.error(e)
  return fail(`Could not ${what}`, 500)
}

/** The sales forecast for one year: every product name, its SKU, units per month. */
export async function GET(req: Request) {
  try {
    assertOperations(await currentUser())
    const years = (
      await db.salesPlanLine.findMany({ distinct: ['year'], select: { year: true }, orderBy: { year: 'desc' } })
    ).map((y) => y.year)
    const asked = Number(new URL(req.url).searchParams.get('year'))
    const year = Number.isInteger(asked) && asked > 0 ? asked : (years[0] ?? new Date().getUTCFullYear())

    const [lines, names, items] = await Promise.all([
      db.salesPlanLine.findMany({ where: { year }, select: { month: true, name: true, units: true } }),
      db.salesPlanName.findMany({ select: { name: true, sku: true } }),
      db.supplyItem.findMany({ where: { active: true }, select: { sku: true, name: true }, orderBy: { sku: 'asc' } }),
    ])
    const skuOf = new Map(names.map((n) => [n.name, n.sku]))
    const rows = new Map<string, { name: string; sku: string | null; months: Record<number, number>; total: number }>()
    for (const l of lines) {
      if (!rows.has(l.name)) rows.set(l.name, { name: l.name, sku: skuOf.get(l.name) ?? null, months: {}, total: 0 })
      const r = rows.get(l.name)!
      r.months[l.month] = l.units
      r.total += l.units
    }

    return NextResponse.json(
      { years, year, rows: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)), skus: items },
      { headers: NO_STORE },
    )
  } catch (e) {
    return handle(e, 'read the sales forecast')
  }
}

/** Upload the Excel file. Replaces that year's forecast. */
export async function POST(req: Request) {
  try {
    assertOperations(await currentUser())
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File) || file.size === 0) throw new BadRequest('Choose the forecast Excel file first.')
    if (file.size > MAX_BYTES) throw new BadRequest('That file is larger than 10 MB.')
    const year = Number(form.get('year'))
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new BadRequest('Type the year this forecast is for.')

    let plan
    try {
      plan = readPlanWorkbook(Buffer.from(await file.arrayBuffer()))
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : 'This file could not be read as an Excel file.')
    }
    if (plan.year !== null && plan.year !== year) {
      throw new BadRequest(`This file is the ${plan.year} forecast, but ${year} was chosen.`)
    }

    await savePlan(year, plan.months)
    const products = new Set(plan.months.flatMap((m) => m.lines.map((l) => l.name)))
    const unlinked = await db.salesPlanName.count({ where: { name: { in: [...products] }, sku: null } })
    return NextResponse.json(
      { year, months: plan.months.length, products: products.size, unlinked },
      { headers: NO_STORE },
    )
  } catch (e) {
    return handle(e, 'read the sales forecast')
  }
}

/** Link one product name from the file to a SKU, or unlink it (sku: null). */
export async function PATCH(req: Request) {
  try {
    assertOperations(await currentUser())
    const body = (await req.json().catch(() => null)) as { name?: unknown; sku?: unknown } | null
    const name = typeof body?.name === 'string' ? body.name : ''
    const sku = body?.sku === null ? null : typeof body?.sku === 'string' ? body.sku.trim() : undefined
    if (!name || sku === undefined) throw new BadRequest('Send a product name and a SKU.')
    if (!(await db.salesPlanName.findUnique({ where: { name } }))) throw new BadRequest(`"${name}" is not in the forecast.`)
    if (sku !== null && !(await db.supplyItem.findUnique({ where: { sku } }))) {
      throw new BadRequest(`${sku} is not a product here.`)
    }
    await db.salesPlanName.update({ where: { name }, data: { sku } })
    return NextResponse.json({ name, sku }, { headers: NO_STORE })
  } catch (e) {
    return handle(e, 'save that link')
  }
}
