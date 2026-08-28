/**
 * Which page the question was asked from, in a sentence.
 *
 * The client's example is asking "how did you calculate that?" while looking at
 * the forecast. Without this the model has to guess which of six tools the word
 * "that" refers to; with it, the question lands on the right data first time.
 *
 * A fixed map rather than the raw path: a path is an implementation detail, and
 * handing the model an unknown one would invite it to invent what that page
 * shows. An unrecognised path simply says nothing.
 */
const PAGES: Record<string, string> = {
  '/dashboard': 'the Dashboard: revenue, profit and the shop comparison',
  '/advisor': "the Advisor: this morning's briefing",
  '/inbox': 'the support Inbox: customer email conversations',
  '/orders': 'the Orders list',
  '/finance': 'Finance: unpaid customer invoices from Visma',
  '/delivery': 'Delivery: parcel times, on-time rate and late orders',
  '/marketing': 'Marketing: ad spend, ROAS and campaigns',
  '/products': 'Products: units, revenue and profit per product',
  '/inventory': 'Inventory and forecasting: stock, run-out dates and what to order',
  '/b2b': 'B2B: business customers and their invoiced orders',
  '/ambassadors': 'Ambassadors: their sales and commission',
}

export function pageContext(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null
  // Longest first, so /inventory/purchase-orders is not read as /inventory
  // when a more specific entry exists for it.
  const match = Object.keys(PAGES)
    .sort((a, b) => b.length - a.length)
    .find((p) => path === p || path.startsWith(`${p}/`))
  return match ? `The user is looking at ${PAGES[match]}.` : null
}
