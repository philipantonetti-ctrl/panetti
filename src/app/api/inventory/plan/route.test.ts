import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'

vi.mock('@/lib/auth/current-user', () => ({ currentUser: vi.fn() }))

import { currentUser } from '@/lib/auth/current-user'
import { db } from '@/lib/db'
import { GET, PATCH, POST } from './route'

/** Philip uploads his sales forecast; each product name is linked to a SKU once. */

const YEAR = 2091
const TAG = `TEST-PLANAPI-${Date.now()}`
const SKU = `${TAG}-OVEN`

/** One month tab, "Panetti" table with an Everything column; optional "Total YYYY" tab. */
function book(month: string, rows: [string, number][], totalTab?: string): Buffer {
  const shared: string[] = []
  const s = (t: string) => (shared.includes(t) ? shared.indexOf(t) : shared.push(t) - 1)
  const head = `<row r="2"><c r="B2" t="s"><v>${s('Panetti')}</v></c><c r="C2" t="s"><v>${s('Total Units sold (Everything)')}</v></c></row>`
  const body = rows
    .map(([n, u], i) => `<row r="${i + 3}"><c r="B${i + 3}" t="s"><v>${s(n)}</v></c><c r="C${i + 3}"><v>${u}</v></c></row>`)
    .join('')
  const tabs = [month, ...(totalTab ? [totalTab] : [])]
  return Buffer.from(
    zipSync({
      'xl/workbook.xml': strToU8(
        `<workbook><sheets>${tabs.map((t, i) => `<sheet name="${t}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        `<Relationships>${tabs.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
      ),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${head}${body}</sheetData></worksheet>`),
      'xl/worksheets/sheet2.xml': strToU8('<worksheet><sheetData></sheetData></worksheet>'),
      'xl/sharedStrings.xml': strToU8(`<sst>${shared.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`),
    }),
  )
}

const upload = (file: Buffer | null, year: string) => {
  const form = new FormData()
  if (file) form.set('file', new File([new Uint8Array(file)], 'forecast.xlsx'))
  form.set('year', year)
  return POST(new Request('http://x/api/inventory/plan', { method: 'POST', body: form }))
}

const as = (role: string) =>
  vi.mocked(currentUser).mockResolvedValue({ id: 'u1', email: 'a@b.c', role } as never)

beforeEach(async () => {
  as('OPERATIONS')
  await db.supplyItem.create({ data: { sku: SKU, name: 'Pizza oven' } })
})

afterEach(async () => {
  await db.salesPlanLine.deleteMany({ where: { year: YEAR } })
  await db.salesPlanName.deleteMany({ where: { name: { startsWith: TAG } } })
  await db.supplyItem.deleteMany({ where: { sku: { startsWith: TAG } } })
})

describe('/api/inventory/plan', () => {
  it('refuses anyone outside operations', async () => {
    as('MARKETING')
    expect((await upload(book('November', [[`${TAG} Oven`, 2910]]), String(YEAR))).status).toBe(403)
    expect((await GET(new Request(`http://x/api/inventory/plan?year=${YEAR}`))).status).toBe(403)
  })

  it('reads the file into the year and lists each product with its months', async () => {
    const res = await upload(book('November', [[`${TAG} Oven`, 2910], [`${TAG} Brush`, 415]]), String(YEAR))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ year: YEAR, months: 1, products: 2, unlinked: 2 })

    const view = await (await GET(new Request(`http://x/api/inventory/plan?year=${YEAR}`))).json()
    expect(view.years).toContain(YEAR)
    expect(view.rows.find((r: { name: string }) => r.name === `${TAG} Oven`)).toEqual({
      name: `${TAG} Oven`, sku: null, months: { 11: 2910 }, total: 2910,
    })
    expect(view.skus).toContainEqual({ sku: SKU, name: 'Pizza oven' })
  })

  it('links a product name to a SKU, and unlinks it', async () => {
    await upload(book('November', [[`${TAG} Oven`, 2910]]), String(YEAR))
    const link = (sku: string | null) =>
      PATCH(new Request('http://x/api/inventory/plan', { method: 'PATCH', body: JSON.stringify({ name: `${TAG} Oven`, sku }) }))

    expect((await link(SKU)).status).toBe(200)
    expect((await db.salesPlanName.findUnique({ where: { name: `${TAG} Oven` } }))?.sku).toBe(SKU)
    expect((await link(null)).status).toBe(200)
    expect((await db.salesPlanName.findUnique({ where: { name: `${TAG} Oven` } }))?.sku).toBeNull()
  })

  it('refuses a SKU that is not a product', async () => {
    await upload(book('November', [[`${TAG} Oven`, 2910]]), String(YEAR))
    const res = await PATCH(
      new Request('http://x/api/inventory/plan', { method: 'PATCH', body: JSON.stringify({ name: `${TAG} Oven`, sku: 'NOPE-NOT-A-SKU' }) }),
    )
    expect(res.status).toBe(400)
  })

  it('refuses a file whose own "Total" tab names another year, so 2027 never overwrites 2026', async () => {
    const res = await upload(book('November', [[`${TAG} Oven`, 1]], `Total ${YEAR + 1}`), String(YEAR))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(`This file is the ${YEAR + 1} forecast, but ${YEAR} was chosen.`)
    expect(await db.salesPlanLine.count({ where: { year: YEAR } })).toBe(0)
  })

  it('needs a file and a year', async () => {
    expect((await upload(null, String(YEAR))).status).toBe(400)
    expect((await upload(book('November', [[`${TAG} Oven`, 1]]), '')).status).toBe(400)
  })

  it('says why a file could not be read', async () => {
    const res = await upload(Buffer.from('not excel'), String(YEAR))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('This file could not be read as an Excel file.')
  })
})
