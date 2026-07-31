import { test, expect } from '@playwright/test'

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The click only dispatches the DOM event. Wait for the real signal: we have
  // left /login and the session cookie is genuinely set.
  await page.waitForURL(/\/(dashboard|portal|ambassadors)/)
}

test('an admin records a product, and the ambassador sees it', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/ambassadors')

  // The seeded gifts are already counted.
  const overview = page.getByTestId('product-overview-row')
  await expect(overview.first()).toBeVisible()

  // Pro X went to three of the seeded ambassadors.
  const proX = page.getByTestId('product-overview-row').filter({ hasText: 'MPX-001' })
  await expect(proX).toContainText('3')

  // Emma's row carries her chips.
  const emma = page.getByTestId('ambassador-row').filter({ hasText: 'Emma Nilsen' })
  await expect(emma).toContainText('Massasjepistol Pro X')
})

test('an admin adds a product and it lands on the roster', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/ambassadors')

  const johan = page.getByTestId('ambassador-row').filter({ hasText: 'Johan Berg' })
  await johan.getByRole('button', { name: 'Edit' }).click()

  // exact: true matters. Playwright's getByRole name matching is SUBSTRING by
  // default, so a bare 'Product' also matches the 'Add product' submit button
  // sitting in the same section, and the locator resolves to two elements.
  // Testing Library's getByRole is exact by default, which is why the Task 5
  // unit test uses the same words without this flag — do not "harmonise" them.
  await page.getByRole('button', { name: 'Product', exact: true }).click()
  // exact: true matters here too, for a state-dependent reason a first read of
  // this file won't reveal: once this spec has run once against the shared
  // database, Johan already has this product, so his ledger row carries a
  // 'Remove Mazzetti Lite Comfort - Massasjestol (Beige) received <date>'
  // button whose accessible name CONTAINS this product's full name as a
  // substring. Without exact: true, that Remove button and this picker option
  // both match, and the locator resolves to two elements — but only from the
  // second run onward.
  await page.getByRole('button', { name: 'Mazzetti Lite Comfort - Massasjestol (Beige)', exact: true }).click()

  // No quantity box any more: a gift is one product, and an ambassador who
  // also got accessories records the accessories.
  await expect(page.getByLabel('Quantity')).toHaveCount(0)
  await page.getByLabel('Note').fill('sent for the summer campaign')
  // exact: true, because Playwright's getByRole name matching is substring by
  // default and the page carries other buttons containing these words.
  await page.getByRole('button', { name: 'Add product', exact: true }).click()

  // The modal stays open and the ledger refreshes in place.
  await expect(page.getByText('sent for the summer campaign')).toBeVisible()

  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(johan).toContainText('Mazzetti Lite Comfort - Massasjestol (Beige)')

  // Clean up what we just added. AmbassadorProduct carries no unique
  // constraint, so a spec that adds and never removes would keep growing this
  // shared table by one row on every run forever — not re-runnable in any
  // real sense. This also gives DELETE /api/ambassador-products/[id] its only
  // end-to-end coverage; it otherwise has unit tests but no browser-level proof.
  await johan.getByRole('button', { name: 'Edit' }).click()
  const receivedToday = new Date().toISOString().slice(0, 10)
  await page
    .getByRole('button', {
      name: `Remove Mazzetti Lite Comfort - Massasjestol (Beige) received ${receivedToday}`,
    })
    .click()
  await expect(page.getByText('sent for the summer campaign')).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(johan).not.toContainText('Mazzetti Lite Comfort - Massasjestol (Beige)')
})

test('an admin ticks products while creating the ambassador', async ({ page }) => {
  const NAME = 'E2E Create With Products'
  const EMAIL = 'e2e-create-products@example.test'
  const CODE = 'E2ECREATE1'

  // window.confirm guards Delete, and an unhandled dialog blocks the click.
  page.on('dialog', (d) => void d.accept())

  async function removeIfPresent() {
    const row = page.getByTestId('ambassador-row').filter({ hasText: NAME })
    if ((await row.count()) === 0) return
    await row.first().getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByTestId('ambassador-row').filter({ hasText: NAME })).toHaveCount(0)
  }

  await signIn(page, 'admin@ecom.test')
  await page.goto('/ambassadors')

  // A run that died before its cleanup would otherwise leave a 409 behind and
  // this spec would never pass again.
  await removeIfPresent()

  const form = page.getByTestId('add-ambassador')
  const submit = form.getByRole('button', { name: 'Add ambassador' })

  // The section is there without being asked for, and says what it wants.
  await expect(page.getByText(/Products they got from us/).first()).toBeVisible()
  await expect(page.getByText(/Pick a store first/)).toBeVisible()

  await form.getByLabel('Name').fill(NAME)
  await form.getByLabel('Email').fill(EMAIL)
  await form.getByLabel('Store').selectOption({ label: 'Panetti Norway' })
  await form.getByLabel('Discount code').fill(CODE)

  // Everything else is filled, so only the missing product is holding it shut.
  await expect(submit).toBeDisabled()

  const ticks = page.getByTestId('product-ticks')
  await expect(ticks).toBeVisible()
  await ticks.getByRole('checkbox', { name: 'Massasjepistol Pro X' }).check()
  await ticks.getByRole('checkbox', { name: 'Mazzetti Lite Comfort - Massasjestol (Beige)' }).check()

  await expect(submit).toBeEnabled()
  await submit.click()

  // Both ticked products land on the roster, and neither wears a quantity.
  const row = page.getByTestId('ambassador-row').filter({ hasText: NAME })
  await expect(row).toContainText('Massasjepistol Pro X')
  await expect(row).toContainText('Mazzetti Lite Comfort - Massasjestol (Beige)')
  await expect(row).not.toContainText('×1')

  await removeIfPresent()
})

test('the product list follows the store that was chosen', async ({ page }) => {
  await signIn(page, 'admin@ecom.test')
  await page.goto('/ambassadors')

  const form = page.getByTestId('add-ambassador')
  const ticks = page.getByTestId('product-ticks')

  await form.getByLabel('Store').selectOption({ label: 'Panetti Norway' })
  await expect(ticks).toBeVisible()
  const norway = await ticks.getByRole('checkbox').count()
  expect(norway).toBeGreaterThan(0)

  // Ticking, then switching store, must not carry the choice across: those
  // products belong to the store that offered them.
  await ticks.getByRole('checkbox').first().check()
  await form.getByLabel('Store').selectOption({ label: 'Panetti Sweden' })
  await expect(ticks.getByRole('checkbox', { checked: true })).toHaveCount(0)
  await expect(form.getByRole('button', { name: 'Add ambassador' })).toBeDisabled()
})

test('an ambassador sees what we sent them, and cannot change it', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')

  await expect(page).toHaveURL(/\/portal/)
  await expect(page.getByText('Products we sent you')).toBeVisible()
  await expect(page.getByText('Massasjepistol Pro X').first()).toBeVisible()

  // Read only: nothing on this page can add or remove one.
  await expect(page.getByRole('button', { name: /Add product/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Remove/ })).toHaveCount(0)
})

test('an ambassador cannot reach the staff product API', async ({ page }) => {
  await signIn(page, 'emma@ambassador.test')

  const read = await page.request.get('/api/ambassador-products')
  expect(read.status()).toBe(403)

  const write = await page.request.post('/api/ambassador-products', {
    data: { ambassadorId: 'anything', sku: 'X', name: 'X', quantity: 1, receivedAt: '2026-01-01' },
  })
  expect(write.status()).toBe(403)
})
