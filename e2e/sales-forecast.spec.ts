import { test, expect, type Page } from '@playwright/test'
import { PrismaClient } from '@prisma/client'
import { strToU8, zipSync } from 'fflate'

/**
 * Philip, 2026-11-14: "Please make sure I can send in my sales forecast excel
 * file into it ... it cant just say Average 9 a day". Upload his workbook,
 * link the product to its SKU, and the Forecast tab uses his number.
 */

const P = 'E2E-SFC'
const ITEM = { sku: `${P}-OVEN`, name: 'E2E Forecast Oven' }
const NAME = 'E2E Panetti Forecast Oven' // as the sheet writes it

const now = new Date()
const YEAR = now.getUTCFullYear()
const MONTH = now.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
const DAYS = new Date(Date.UTC(YEAR, now.getUTCMonth() + 1, 0)).getUTCDate()
const PER_DAY = 50

/** A workbook shaped like Philip's: a month tab with a "Panetti" table, and a "Total YYYY" tab. */
function workbook(year: number): Buffer {
  const shared = ['Panetti', 'Total Units sold (B2C)', 'Total Units sold (Everything)', NAME]
  const sheet = `<worksheet><sheetData>
    <row r="2"><c r="B2" t="s"><v>0</v></c><c r="C2" t="s"><v>1</v></c><c r="D2" t="s"><v>2</v></c></row>
    <row r="3"><c r="B3" t="s"><v>3</v></c><c r="C3"><v>1</v></c><c r="D3"><v>${PER_DAY * DAYS}</v></c></row>
  </sheetData></worksheet>`
  return Buffer.from(
    zipSync({
      'xl/workbook.xml': strToU8(
        `<workbook><sheets><sheet name="${MONTH}" sheetId="1" r:id="rId1"/><sheet name="Total ${year}" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(sheet),
      'xl/worksheets/sheet2.xml': strToU8('<worksheet><sheetData></sheetData></worksheet>'),
      'xl/sharedStrings.xml': strToU8(`<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`),
    }),
  )
}

async function sweep(db: PrismaClient) {
  await db.salesPlanLine.deleteMany({ where: { name: { startsWith: 'E2E ' } } })
  await db.salesPlanName.deleteMany({ where: { name: { startsWith: 'E2E ' } } })
  await db.vismaStock.deleteMany({ where: { sku: { startsWith: P } } })
  await db.supplyItem.deleteMany({ where: { sku: { startsWith: P } } })
}

test.beforeAll(async () => {
  const db = new PrismaClient()
  try {
    await sweep(db)
    await db.supplyItem.create({ data: ITEM })
    await db.vismaStock.create({
      data: { sku: ITEM.sku, quantityOnHand: 1000, available: 1000, availableForShipment: 1000 },
    })
  } finally {
    await db.$disconnect()
  }
})

test.afterAll(async () => {
  const db = new PrismaClient()
  try {
    await sweep(db)
  } finally {
    await db.$disconnect()
  }
})

async function openAsOperations(page: Page) {
  await page.goto('/admin')
  await page.getByLabel('Email').fill('operations@ecom.test')
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/dashboard/)
  await page.goto('/inventory')
  await page.getByRole('link', { name: 'Sales forecast' }).click()
  await page.waitForURL(/\/inventory\/sales-forecast/)
}

async function upload(page: Page, year: number, file: Buffer) {
  await page.getByLabel('Year').fill(String(year))
  await page.getByLabel('Sales forecast (.xlsx)').setInputFiles({
    name: 'Sales forecast.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: file,
  })
  await page.getByRole('button', { name: 'Upload' }).click()
}

test("the uploaded forecast drives this month's rate once its product is linked", async ({ page }) => {
  await openAsOperations(page)
  await upload(page, YEAR, workbook(YEAR))
  await expect(page.getByTestId('plan-message')).toContainText(`for ${YEAR}.`)
  await expect(page.getByRole('cell', { name: NAME })).toBeVisible()

  const link = page.waitForResponse((r) => r.url().includes('/api/inventory/plan') && r.request().method() === 'PATCH')
  await page.getByLabel(`SKU for ${NAME}`).selectOption(ITEM.sku)
  expect((await link).status()).toBe(200)

  await page.getByRole('link', { name: 'Forecast', exact: true }).click()
  await page.waitForURL(/\/inventory$/)
  const row = page.locator('tr', { hasText: ITEM.name })
  await expect(row).toContainText(`${PER_DAY.toFixed(1)} a day`)
  await expect(row).toContainText('your forecast')
})

test('a file for another year is refused, so it never overwrites this one', async ({ page }) => {
  await openAsOperations(page)
  await upload(page, YEAR, workbook(YEAR + 1))
  await expect(page.getByTestId('plan-error')).toHaveText(`This file is the ${YEAR + 1} forecast, but ${YEAR} was chosen.`)
})
