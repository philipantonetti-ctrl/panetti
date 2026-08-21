import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * What an invitation link says once its seven days are up.
 *
 * Ambassadors treat the invite link as their way in and keep coming back to it to
 * check their sales. Until this was fixed, day eight answered "This invite link is
 * not valid. Ask for a new one." — a dead end for someone whose account was fine and
 * waiting at /login, and the reason support kept hearing "my link stopped working".
 * The page could not tell the two apart because the name on the link lives inside the
 * token, and an expired token was being thrown away whole.
 *
 * Seven days cannot be waited out in a test, so only the token is fabricated, with an
 * expiry in the past. Everything else is real: a real admin creates a real ambassador
 * through the real form, who claims a real login, and comes back to the real page.
 */

// Unique per run: email and code are @unique, so a rerun must not collide.
const stamp = Date.now().toString().slice(-8)
const USED = { name: 'E2E Lapsed Used', email: `e2e-lapsed-used-${stamp}@example.local`, code: `EXPU${stamp}` }
const UNUSED = { name: 'E2E Lapsed New', email: `e2e-lapsed-new-${stamp}@example.local`, code: `EXPN${stamp}` }
const CHOSEN_PASSWORD = 'chosen-by-the-ambassador-1'

/**
 * Playwright does not load .env; importing Prisma does, and AUTH_SECRET comes with
 * it. The token has to be signed with the very secret the running server verifies
 * against, or this would prove nothing but that a stranger's link is refused.
 */
async function expiredInviteToken(ambassadorId: string): Promise<string> {
  await import('@prisma/client') // imported for that side effect alone
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error('AUTH_SECRET is not set — cannot mint a lapsed invite')

  const { SignJWT } = await import('jose')
  const now = Math.floor(Date.now() / 1000)
  // Issued eight days ago, dead for one: exactly the shape of a real link left to lapse.
  return new SignJWT({ ambassadorId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('ambassador-invite')
    .setIssuedAt(now - 8 * 24 * 60 * 60)
    .setExpirationTime(now - 24 * 60 * 60)
    .sign(new TextEncoder().encode(secret))
}

async function ambassadorIdFor(email: string): Promise<string> {
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient()
  try {
    const { id } = await db.ambassador.findFirstOrThrow({ where: { email }, select: { id: true } })
    return id
  } finally {
    await db.$disconnect()
  }
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The click only dispatches the DOM event — wait for the real signal that the
  // cookie landed, which is that we have left /login.
  await page.waitForURL(/\/(dashboard|portal)/)
}

/** Creates one through the admin's own form and returns the invite URL it hands out. */
async function createAmbassador(page: Page, who: typeof USED): Promise<string> {
  await page.goto('/settings/ambassadors')
  const form = page.getByTestId('add-ambassador')
  await form.getByPlaceholder('Name').fill(who.name)
  await form.getByPlaceholder('Email').fill(who.email)
  // A code belongs to a store: choose one, which unlocks the code field.
  await form.getByLabel('Store').selectOption({ index: 1 })
  await form.getByPlaceholder('Discount code').fill(who.code)
  // The tick list only exists once /api/ambassador-products has answered; until then
  // the same box holds "no products found for this store yet". It appears on its own
  // when the fetch lands, so this waits for the fetch rather than the default 5s,
  // which a cold dev route compile can outrun.
  const ticks = page.getByTestId('product-ticks')
  await expect(ticks).toBeVisible({ timeout: 20_000 })
  await ticks.getByRole('checkbox').first().check()
  await form.getByRole('button', { name: 'Add ambassador' }).click()

  const row = page.getByTestId('ambassador-row').filter({ hasText: who.email })
  await expect(row).toBeVisible()
  const copy = row.getByTestId('copy-invite')
  await expect(copy).toBeVisible()
  await copy.click()
  return page.evaluate(() => navigator.clipboard.readText())
}

test('a lapsed link for an ambassador who already signed up sends them to the login page', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await signIn(page, 'admin@ecom.test', 'password123')
  const inviteUrl = await createAmbassador(page, USED)

  // --- They redeem it for real, exactly as they did the week before ---
  await context.clearCookies()
  await page.goto(inviteUrl)
  await expect(page.getByText(`Welcome, ${USED.name}`)).toBeVisible()
  const invite = page.getByTestId('invite-form')
  await invite.getByLabel('Password', { exact: true }).fill(CHOSEN_PASSWORD)
  await invite.getByLabel('Confirm password').fill(CHOSEN_PASSWORD)
  await page.getByRole('button', { name: 'Set password' }).click()
  await page.waitForURL(/\/portal/)

  // --- A week goes by, and they open the same link again ---
  const lapsed = `/invite/${await expiredInviteToken(await ambassadorIdFor(USED.email))}`
  await context.clearCookies()
  await page.goto(lapsed)

  // It must say the link was spent, not that it is unusable.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/already been used/i)
  await expect(page.getByText(/not valid|ask for a new one/i)).toHaveCount(0)
  await expect(page.getByTestId('invite-form')).toHaveCount(0)

  // --- And the way out it offers actually works ---
  await page.getByRole('link', { name: /login page/i }).click()
  await page.waitForURL(/\/login/)
  await page.getByLabel('Email').fill(USED.email)
  await page.getByLabel('Password', { exact: true }).fill(CHOSEN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/portal/)
})

test('a lapsed link that was never used says it expired, and does not claim it was used', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await signIn(page, 'admin@ecom.test', 'password123')
  await createAmbassador(page, UNUSED)

  const lapsed = `/invite/${await expiredInviteToken(await ambassadorIdFor(UNUSED.email))}`
  await context.clearCookies()
  await page.goto(lapsed)

  // Nobody set a password here, so there is no account to send them to — and saying
  // "already used" would be a lie that stops them asking for the new link they need.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/has expired/i)
  await expect(page.getByText(/already been used/i)).toHaveCount(0)
  await expect(page.getByRole('link', { name: /login page/i })).toHaveCount(0)
  await expect(page.getByTestId('invite-form')).toHaveCount(0)
})

test('a forged link is still refused outright, expiry or no expiry', async ({ page }) => {
  // The signature is the only thing standing between a stranger and an ambassador's
  // name, now that expiry no longer ends the conversation on its own.
  const real = await expiredInviteToken('some-ambassador-id')
  await page.goto(`/invite/${real.slice(0, -3)}aaa`)

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/not valid/i)
  await expect(page.getByText(/already been used|has expired/i)).toHaveCount(0)
  await expect(page.getByTestId('invite-form')).toHaveCount(0)
})

test.afterAll(async () => {
  // This spec writes to the real database — clean up after itself. The login and the
  // discount code go with it: both cascade from the ambassador.
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient()
  await db.ambassador.deleteMany({ where: { email: { in: [USED.email, UNUSED.email] } } })
  await db.$disconnect()
})
