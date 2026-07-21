import { test, expect } from '@playwright/test'

/**
 * The fees page must FIT: a form whose save button is clipped by its card is
 * broken, whatever the unit tests say. So this asserts real geometry, then
 * exercises the whole flow against the real API and database.
 */

test('the fees page fits its forms and saves a fulfillment rate end to end', async ({ page }) => {
  await page.goto('/admin')
  await page.getByLabel('Email').fill('admin@ecom.test')
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/dashboard/)

  // BeProfit-style flow: rules list -> Create New Rule -> profile -> Edit -> rates.
  await page.goto('/settings/fees')
  await page.getByRole('button', { name: '+ Create New Rule' }).click()
  await expect(page.getByText('Create Dynamic Fulfillment Rates')).toBeVisible()

  // The methods are REAL radios: selectable, and Next answers honestly.
  const weight = page.getByRole('radio', { name: /Order Weight/ })
  await weight.check()
  await expect(weight).toBeChecked()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByText(/coming in a later phase/i)).toBeVisible()

  await page.locator('section').getByRole('button', { name: 'Edit' }).click()

  const card = page.locator('section', { hasText: 'Rates' }).first()
  const save = card.getByRole('button', { name: 'Save' })
  await save.waitFor()

  // The whole button must sit INSIDE its card — clipped means broken.
  const cardBox = (await card.boundingBox())!
  const saveBox = (await save.boundingBox())!
  expect(saveBox.x + saveBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)

  // The form genuinely works: save a Worldwide rate, land back on the list, see it.
  await card.getByLabel(/Worldwide/).fill('25')
  await card.getByLabel('From date').fill('2020-01-01')
  await save.click()
  await expect(page.getByText('Fulfillment rate saved')).toBeVisible()
  await expect(page.getByText(/Default rate - 2020-01-01/).first()).toBeVisible()

  // And a rule can be deleted again (also keeps this test self-cleaning).
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: 'Delete rate from 2020-01-01' }).first().click()
  await expect(page.getByText('Rate deleted')).toBeVisible()

  // The fee lives on its own page now, Dintero only — its button must fit too.
  await page.goto('/settings/processing-fees')
  const feeCard = page.locator('section', { hasText: 'Dintero Checkout' })
  const saveFee = feeCard.getByRole('button', { name: 'Save fee' })
  await saveFee.waitFor()
  const feeBox = (await feeCard.boundingBox())!
  const feeBtnBox = (await saveFee.boundingBox())!
  expect(feeBtnBox.x + feeBtnBox.width).toBeLessThanOrEqual(feeBox.x + feeBox.width)
})
