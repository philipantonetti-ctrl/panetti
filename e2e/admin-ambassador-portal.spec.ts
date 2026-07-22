import { test, expect } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

/**
 * The owner is both the admin AND an ambassador on the same email. They can open
 * their OWN ambassador portal from the dashboard, on top of the admin view. A
 * regular ambassador gains nothing — they still cannot reach any admin page.
 */

const ADMIN = 'admin@ecom.test'
const CODE = 'OWNERSELFE2E'

test.beforeAll(async () => {
  const db = new PrismaClient()
  try {
    await db.ambassador.deleteMany({ where: { email: ADMIN } })
    const shop = await db.shop.findFirstOrThrow()
    await db.ambassador.create({
      data: {
        name: 'Owner',
        email: ADMIN,
        commissionRate: 0.1,
        codes: { create: { code: CODE, shopId: shop.id } },
      },
    })
  } finally {
    await db.$disconnect()
  }
})

test.afterAll(async () => {
  const db = new PrismaClient()
  await db.ambassador.deleteMany({ where: { email: ADMIN } })
  await db.$disconnect()
})

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('an admin who is also an ambassador can open their own portal from the dashboard', async ({ page }) => {
  await signIn(page, ADMIN)
  await page.waitForURL(/\/dashboard/)

  // The link is offered because this admin has a matching ambassador.
  await page.getByRole('link', { name: 'View my ambassador portal' }).click()
  await page.waitForURL(/\/portal/)

  // Their own ambassador portal, with their own code.
  await expect(page.getByText('Your sales')).toBeVisible()
  await expect(page.getByText(CODE)).toBeVisible()

  // As an admin they keep the nav, so they can go straight back.
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await page.waitForURL(/\/dashboard/)
})

test('a regular ambassador still cannot reach the admin dashboard', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')
  await page.waitForURL(/\/portal/)

  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/portal/) // bounced by the guard
  await expect(page.getByText('Compare shops')).toHaveCount(0)
  // No admin nav leaked to them.
  await expect(page.getByRole('link', { name: 'Product costs' })).toHaveCount(0)
})
