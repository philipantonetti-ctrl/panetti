import { test, expect } from '@playwright/test'

/**
 * The whole journey, end to end: an admin creates an ambassador, hands them a link,
 * and they turn it into a login of their own — without ever seeing company figures.
 */

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The click only dispatches the DOM event — it does not wait for the async
  // login request (bcrypt compare + cookie set) that follows. Without this,
  // an immediate page.goto() elsewhere in a test can race ahead of the
  // cookie actually being set. Wait for the real signal: we've left /login.
  await page.waitForURL(/\/(dashboard|portal)/)
}

// Unique per run: email and code are @unique, so a rerun must not collide.
const stamp = Date.now().toString().slice(-8)
const NAME = 'E2E Onboard'
const EMAIL = `e2e-onboard-${stamp}@example.local`
const CODE = `E2E${stamp}`
const CHOSEN_PASSWORD = 'chosen-by-the-ambassador-1'

test('an admin creates an ambassador, who claims a login and sees only their own data', async ({
  page,
  context,
}) => {
  // --- Admin creates the ambassador ---
  await signIn(page, 'admin@ecom.test')
  await page.goto('/settings/ambassadors')

  const form = page.getByTestId('add-ambassador')
  await form.getByPlaceholder('Name').fill(NAME)
  await form.getByPlaceholder('Email').fill(EMAIL)
  await form.getByPlaceholder('Discount code').fill(CODE)
  await form.getByRole('button', { name: 'Add ambassador' }).click()

  const row = page.getByTestId('ambassador-row').filter({ hasText: EMAIL })
  await expect(row).toBeVisible()
  // They have no login yet — so the invite is offered and the status says so.
  await expect(row).toContainText('Not set up yet')

  // --- Admin copies the invite link ---
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const copy = row.getByTestId('copy-invite')
  await expect(copy).toBeVisible()
  await copy.click()
  const inviteUrl = await page.evaluate(() => navigator.clipboard.readText())
  expect(inviteUrl).toContain('/invite/')

  // --- The ambassador redeems it in a clean session ---
  await context.clearCookies()
  await page.goto(inviteUrl)
  await expect(page.getByText(`Welcome, ${NAME}`)).toBeVisible()

  const invite = page.getByTestId('invite-form')
  await invite.getByLabel('Password', { exact: true }).fill(CHOSEN_PASSWORD)
  await invite.getByLabel('Confirm password').fill(CHOSEN_PASSWORD)
  await page.getByRole('button', { name: 'Set password' }).click()

  // --- They land in their own portal, already signed in ---
  await page.waitForURL(/\/portal/)

  // --- They cannot reach company data ---
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/portal/) // bounced by the guard

  // --- The link is single use ---
  await context.clearCookies()
  await page.goto(inviteUrl)
  await expect(page.getByText(/already have a login/i)).toBeVisible()

  // --- And the password they chose actually works ---
  await context.clearCookies()
  await page.goto('/login')
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(CHOSEN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/portal/)

  // --- Back on the admin screen, they now read as onboarded ---
  await context.clearCookies()
  await signIn(page, 'admin@ecom.test')
  await page.goto('/settings/ambassadors')
  const after = page.getByTestId('ambassador-row').filter({ hasText: EMAIL })
  await expect(after).toContainText('Active')
  // No invite link is ever minted for someone who already has a login.
  await expect(after.getByTestId('copy-invite')).toHaveCount(0)
})

test.afterAll(async () => {
  // This test writes to the real database — clean up after itself. The login and the
  // discount code go with it: both cascade from the ambassador.
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient()
  await db.ambassador.deleteMany({ where: { email: EMAIL } })
  await db.$disconnect()
})
