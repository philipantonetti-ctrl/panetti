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
  await expect(page.getByText(/Use Default Rate \(Edit\) for now/i)).toBeVisible()

  // The info mark explains the method on hover.
  await page.getByRole('button', { name: /About Order Weight/ }).hover()
  await expect(page.getByText(/rate tiers by total order weight/i)).toBeVisible()

  await page.locator('section').getByRole('button', { name: 'Edit' }).click()

  // The rate toggles respond instead of playing dead.
  await page.getByRole('button', { name: 'Handling' }).click()
  await expect(page.getByText(/full per-order rate for now/i)).toBeVisible()

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

  // The fees live on their own page — the save button must fit its card.
  await page.goto('/settings/processing-fees')
  const feeCard = page.locator('section', { hasText: 'Dintero Checkout' })
  const saveFee = feeCard.getByRole('button', { name: 'Save fees' })
  await saveFee.waitFor()
  const feeBox = (await feeCard.boundingBox())!
  const feeBtnBox = (await saveFee.boundingBox())!
  expect(feeBtnBox.x + feeBtnBox.width).toBeLessThanOrEqual(feeBox.x + feeBox.width)

  // Every gateway row is ALIVE: type a rate, tick a box, add a cross border fee.
  await page.getByLabel('PayPal Account % of Transaction').fill('2.9')
  await page.getByLabel('Credit Card no fees apply').first().check()
  await page.getByRole('button', { name: 'Vorkasse add cross border fee' }).click()
  await page.getByLabel('Vorkasse cross border fee %').fill('1.5')
  await saveFee.click()
  await expect(page.getByText(/applies across all webshops/i)).toBeVisible()

  // Reload: every value came back from the database, not from page state.
  await page.reload()
  await expect(page.getByLabel('PayPal Account % of Transaction')).toHaveValue('2.9')
  await expect(page.getByLabel('Credit Card no fees apply').first()).toBeChecked()
  await expect(page.getByLabel('Vorkasse cross border fee %')).toHaveValue('1.5')

  // Remove undoes a cross border fee, and the add link comes back.
  await page.getByRole('button', { name: 'Vorkasse remove cross border fee' }).click()
  await expect(page.getByLabel('Vorkasse cross border fee %')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Vorkasse add cross border fee' })).toBeVisible()

  // Clean the scratch edits back off so reruns start fresh.
  await page.getByLabel('PayPal Account % of Transaction').fill('')
  await page.getByLabel('Credit Card no fees apply').first().uncheck()
  await feeCard.getByRole('button', { name: 'Save fees' }).click()
  await expect(page.getByText(/applies across all webshops/i).first()).toBeVisible()
})
