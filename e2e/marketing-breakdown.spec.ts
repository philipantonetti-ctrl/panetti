import { test, expect } from '@playwright/test'

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/(dashboard|portal)/)
}

/**
 * The browser never talks to Meta or Google - the Next.js server does, from
 * inside `/api/marketing/breakdown` (src/lib/ads/breakdown.ts). So this stubs
 * OUR endpoint, keyed on the same `level`/`provider`/`parentId` the route
 * reads (src/app/api/marketing/breakdown/route.ts), and proves the journey a
 * unit test cannot: the page renders, a single store gates the table in, a
 * campaign opens into ad sets, an ad set into ads, and the switcher moves to
 * Google. It does NOT prove the route handler or the two platform drivers -
 * those already have DB-backed tests (loadBreakdown, Task 3) and
 * stubbed-fetch tests (the Meta/Google drivers, Tasks 1-2). This spec owns
 * the browser; those own the server.
 *
 * Row shape mirrors BreakdownRow (src/lib/ads/breakdown.ts). Money is integer
 * minor units. Spend/purchaseValue and clicks/impressions are chosen so ROAS
 * and CTR land on exact, easy-to-assert figures the way BreakdownTable.tsx
 * computes them: 62_800 / 10_000 = 6.28 -> "6.28×"; 180 / 10_000 = 1.8% ->
 * "1.8%".
 */
const META_CAMPAIGN = {
  id: 'meta-camp-1',
  name: 'Meta Summer Sale',
  accountId: 'acct-meta-1',
  accountName: 'Test Meta Ads',
  currency: 'USD',
  spend: 10_000,
  purchases: 20,
  purchaseValue: 62_800,
  impressions: 10_000,
  clicks: 180,
}
const META_ADSET = {
  id: 'meta-adset-1',
  name: 'Meta Ad Set A',
  accountId: 'acct-meta-1',
  accountName: 'Test Meta Ads',
  currency: 'USD',
  spend: 4_000,
  purchases: 8,
  purchaseValue: 20_000,
  impressions: 4_000,
  clicks: 60,
}
const META_AD = {
  id: 'meta-ad-1',
  name: 'Meta Ad Creative One',
  accountId: 'acct-meta-1',
  accountName: 'Test Meta Ads',
  currency: 'USD',
  spend: 1_000,
  purchases: 2,
  purchaseValue: 5_000,
  impressions: 1_000,
  clicks: 15,
}
// A name unique to the Google fixture on purpose: the one thing a stale Meta
// table could never show, so "the table reloads for Google" gets proven
// rather than assumed from a tab simply looking selected.
const GOOGLE_CAMPAIGN = {
  id: 'google-camp-1',
  name: 'Google Shopping Push',
  accountId: 'acct-google-1',
  accountName: 'Test Google Ads',
  currency: 'USD',
  spend: 8_000,
  purchases: 10,
  purchaseValue: 40_000,
  impressions: 8_000,
  clicks: 100,
}

type CapturedRequest = { level: string | null; provider: string | null; parentId: string | null }

/**
 * Deliberately not "generous": an unrecognised (level, provider, parentId)
 * combination gets an empty-but-valid response, never a plausible-looking
 * guess. If the page ever asked for the wrong thing, the row it expected
 * would simply never render - the assertion on that row fails instead of
 * being quietly satisfied by a stub that answered a different question.
 */
function fixtureFor(level: string | null, provider: string | null, parentId: string | null) {
  const empty = { rows: [], errors: [], accountsChecked: 1 }
  if (provider === 'meta') {
    if (level === 'campaign') return { rows: [META_CAMPAIGN], errors: [], accountsChecked: 1 }
    if (level === 'adset' && parentId === META_CAMPAIGN.id) return { rows: [META_ADSET], errors: [], accountsChecked: 1 }
    if (level === 'ad' && parentId === META_ADSET.id) return { rows: [META_AD], errors: [], accountsChecked: 1 }
    return empty
  }
  if (provider === 'google' && level === 'campaign') return { rows: [GOOGLE_CAMPAIGN], errors: [], accountsChecked: 1 }
  return empty
}

/** Fails with the whole request log, not a bare boolean, so a red run says what the page actually asked for. */
function assertRequested(requests: CapturedRequest[], expected: Partial<CapturedRequest>) {
  const found = requests.some(
    (r) =>
      (expected.level === undefined || r.level === expected.level) &&
      (expected.provider === undefined || r.provider === expected.provider) &&
      (expected.parentId === undefined || r.parentId === expected.parentId),
  )
  expect(found, `expected a request matching ${JSON.stringify(expected)}, got ${JSON.stringify(requests)}`).toBe(true)
}

test('a single store unlocks the breakdown; a campaign opens into ad sets, an ad set into ads, and Google reloads the table', async ({
  page,
}) => {
  const requests: CapturedRequest[] = []

  // Registered before sign-in so nothing can slip past it: this is the only
  // endpoint this test intercepts, and it must catch every call to it.
  await page.route('**/api/marketing/breakdown**', async (route) => {
    const url = new URL(route.request().url())
    const level = url.searchParams.get('level')
    const provider = url.searchParams.get('provider')
    const parentId = url.searchParams.get('parentId')
    requests.push({ level, provider, parentId })
    await route.fulfill({ json: fixtureFor(level, provider, parentId) })
  })

  await signIn(page, 'admin@ecom.test')
  await page.getByRole('link', { name: 'Marketing' }).click()
  await expect(page).toHaveURL(/\/marketing/)
  await expect(page.getByRole('heading', { name: 'Marketing' })).toBeVisible()

  // Gate: this deployment seeds 11 shops, so the default selection is "all"
  // of them - campaigns belong to one ad account, so the breakdown must not
  // guess at a total across stores. Neither the switcher nor a table exists.
  await expect(page.getByText(/Campaigns belong to one ad account/)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('tab', { name: 'Meta' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Shops' }).click()
  await page.getByRole('button', { name: 'Only Panetti Sweden' }).click()
  // ShopFilter's "Only" does not close its own panel - by design, so more
  // boxes can be ticked afterward. Its full-viewport click-away backdrop is
  // still up, and being position:fixed with a z-index above the static page
  // (globals.css --z-dropdown), it sits above everything, including a normal
  // click target - Playwright's own actionability check would correctly
  // refuse a plain .click() here as "obscured" and time out. `force: true`
  // is required to reach past the backdrop, not a shortcut: do NOT "tidy"
  // this into a plain click. The target is the page heading, chosen because
  // it is inert (no handler of its own) - if ShopFilter is ever fixed to
  // close its own panel, this simply clicks a heading that does nothing,
  // rather than a fixed pixel that might land on something live (e.g. the
  // sidebar's Wordmark link, one screen-corner over). Either way the click
  // lands on whichever element is actually topmost at that point, exactly
  // like a real user's click, which is what dismisses the backdrop.
  await page.getByRole('heading', { name: 'Marketing' }).click({ force: true })
  // Confirms the click actually closed the panel, rather than assuming it -
  // this button only exists while ShopFilter's panel is open.
  await expect(page.getByRole('button', { name: 'Only Panetti Sweden' })).toHaveCount(0)

  // The gate opens: campaigns are listed for the one selected store, ROAS
  // and CTR rendered on the same row as the campaign that earns them.
  const campaignRow = page.locator('tr', { hasText: 'Meta Summer Sale' })
  await expect(campaignRow).toBeVisible({ timeout: 10_000 })
  await expect(campaignRow.getByText('6.28×')).toBeVisible()
  await expect(campaignRow.getByText('1.8%')).toBeVisible()
  assertRequested(requests, { level: 'campaign', provider: 'meta', parentId: null })

  // Press the campaign - its ad sets appear beneath it, fetched for its id.
  await page.getByRole('button', { name: 'Meta Summer Sale' }).click()
  await expect(page.getByRole('button', { name: 'Meta Ad Set A' })).toBeVisible()
  assertRequested(requests, { level: 'adset', provider: 'meta', parentId: META_CAMPAIGN.id })

  // Press the ad set - its ads appear beneath it, fetched for ITS id, not
  // the campaign's. Ads are the last level: this row renders as plain text,
  // never a button, because there is nothing further beneath it to expand.
  await page.getByRole('button', { name: 'Meta Ad Set A' }).click()
  await expect(page.getByText('Meta Ad Creative One')).toBeVisible()
  assertRequested(requests, { level: 'ad', provider: 'meta', parentId: META_ADSET.id })

  // Switch to Google: a name only the Google fixture contains appears, and
  // the Meta campaign is gone. A stale Meta table sitting under a Google
  // label that merely looked selected could not pass both halves of this.
  await page.getByRole('tab', { name: 'Google' }).click()
  await expect(page.getByText('Google Shopping Push')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Meta Summer Sale')).toHaveCount(0)
  assertRequested(requests, { level: 'campaign', provider: 'google', parentId: null })
})
