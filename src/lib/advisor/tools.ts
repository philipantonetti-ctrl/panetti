import { db } from '../db'
import { getSetting } from '../settings'
import { loadMetricsInput } from '../data/load'
import { loadProductsInput, MixedCurrencyError } from '../data/load-products'
import { loadDelivery } from '../delivery/load'
import { computeMetrics } from '../metrics'
import { productFigures } from '../metrics/products'
import { deliveryStats } from '../delivery/stats'
import { buildMarketing } from '../ads/marketing'
import { accountIdsForShops, accountSpendRows } from '../ads/attribution'

/**
 * What the chat is allowed to ask.
 *
 * Five read-only tools, every one of them calling the same loader a page calls.
 * SQL access was rejected deliberately: a model writing its own SELECT against
 * Order would sooner or later sum netSales without excluding refunded and
 * cancelled rows, and produce a figure that contradicts every screen in the
 * product. Routing every question through the engine makes that impossible
 * rather than merely unlikely.
 */

/** One question must not be able to scan the whole history. */
const MAX_WINDOW_DAYS = 366
const DAY_MS = 24 * 60 * 60 * 1000

export type ToolInput = Record<string, unknown>

export function parseWindow(input: ToolInput): { from: Date; to: Date } {
  const from = new Date(`${String(input.from)}T00:00:00.000Z`)
  const to = new Date(`${String(input.to)}T00:00:00.000Z`)

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new RangeError('Dates must be written as yyyy-mm-dd.')
  }
  if (to.getTime() < from.getTime()) {
    throw new RangeError('The end of the range is before its start.')
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw new RangeError('That range is longer than a year. Ask about a shorter one.')
  }
  return { from, to }
}

const shopIdsOf = (input: ToolInput): string[] | undefined =>
  Array.isArray(input.shopIds) && input.shopIds.length ? (input.shopIds as string[]) : undefined

const DATE_PROPS = {
  from: { type: 'string', description: 'First day of the range, yyyy-mm-dd.' },
  to: { type: 'string', description: 'Last day of the range, inclusive, yyyy-mm-dd.' },
  shopIds: {
    type: 'array',
    items: { type: 'string' },
    description: 'Shop ids to limit to. Omit for every active shop.',
  },
} as const

/**
 * An explicit index signature, not the inferred literal shape.
 *
 * Without it, TypeScript infers one distinct object type per tool (their
 * `properties` keys differ), and the test that walks every tool's
 * `properties` by key - `Object.keys(...).map((key) => properties[key])` -
 * cannot index a string-keyed union of types that each name only their own
 * fixed keys. The values below are unchanged; only the type they are read
 * back as gets an index signature.
 */
type ToolProperty = { type: string; description: string; items?: { type: string } }
type ToolDefinition = {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, ToolProperty>
    required: string[]
  }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_metrics',
    description:
      'Revenue, profit, COGS, marketing, affiliate, fees and margin for a date range, per shop and in total. Call this when the question is about money. Also returns the list of shops and their ids.',
    input_schema: {
      type: 'object' as const,
      properties: { ...DATE_PROPS },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_marketing',
    description:
      'Ad spend, ROAS, CPA, CPM, impressions and clicks for a date range, per shop. Call this when the question is about advertising or why revenue moved.',
    input_schema: {
      type: 'object' as const,
      properties: { ...DATE_PROPS },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_delivery',
    description:
      'Median delivery days, on-time rate and the count of orders late right now, per shop and per destination country. Call this when the question is about shipping or Bring.',
    input_schema: {
      type: 'object' as const,
      properties: { ...DATE_PROPS },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_products',
    description:
      'Units sold, revenue, cost and profit per product, for ONE shop. Takes a single shopId because shops in different currencies cannot be added together.',
    input_schema: {
      type: 'object' as const,
      properties: {
        from: DATE_PROPS.from,
        to: DATE_PROPS.to,
        shopId: { type: 'string', description: 'The single shop to report on.' },
      },
      required: ['from', 'to', 'shopId'],
    },
  },
  {
    name: 'get_orders',
    description:
      'Individual orders in a range: number, date, status, customer, country and value. Call this only when the question is about specific orders - use get_metrics for totals.',
    input_schema: {
      type: 'object' as const,
      properties: {
        ...DATE_PROPS,
        limit: { type: 'integer', description: 'How many orders to return, at most 50. Default 20.' },
      },
      required: ['from', 'to'],
    },
  },
]

export async function runTool(name: string, input: ToolInput): Promise<unknown> {
  const { timezone } = await getSetting()

  if (name === 'get_metrics') {
    const { from, to } = parseWindow(input)
    const loaded = await loadMetricsInput({ shopIds: shopIdsOf(input), from, to, timezone })
    const result = computeMetrics(loaded)
    return { ...result, note: 'Money is in minor units (cents/øre) of displayCurrency.' }
  }

  if (name === 'get_marketing') {
    const { from, to } = parseWindow(input)
    const loaded = await loadMetricsInput({ shopIds: shopIdsOf(input), from, to, timezone })
    const engine = computeMetrics(loaded)
    const shopIds = engine.byShop.map((s) => s.shopId)
    // Through accountIdsForShops, so a split account's in-scope campaigns are
    // not dropped - see the same note in collect.ts.
    const accountIds = await accountIdsForShops(shopIds)
    const accounts = await db.adAccount.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, shopId: true, provider: true, currency: true, dailyBudget: true },
    })
    const spend = await accountSpendRows(
      accounts.map((a) => a.id),
      shopIds,
      from,
      to,
    )
    return buildMarketing({ accounts, spend, engine, series: [], rates: loaded.rates, to })
  }

  if (name === 'get_delivery') {
    const { from, to } = parseWindow(input)
    const shopIds =
      shopIdsOf(input) ?? (await db.shop.findMany({ where: { active: true }, select: { id: true } })).map((s) => s.id)
    const { rows } = await loadDelivery(shopIds, from, to)
    return deliveryStats(
      rows.map((r) => r.view),
      rows.map((r) => r.order.shippingCountry),
    )
  }

  if (name === 'get_products') {
    const { from, to } = parseWindow(input)
    const shopId = String(input.shopId ?? '')
    if (!shopId) throw new RangeError('get_products needs a single shopId.')
    try {
      return productFigures(await loadProductsInput({ shopIds: [shopId], from, to, timezone }))
    } catch (e) {
      // Cannot happen for one shop, but a caller passing a stale id deserves a
      // sentence rather than a stack trace.
      if (e instanceof MixedCurrencyError) throw new RangeError(e.message)
      throw e
    }
  }

  if (name === 'get_orders') {
    const { from, to } = parseWindow(input)
    const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 50)
    const shopIds = shopIdsOf(input)
    return db.order.findMany({
      where: {
        placedAt: { gte: from, lte: to },
        ...(shopIds ? { shopId: { in: shopIds } } : {}),
      },
      orderBy: { placedAt: 'desc' },
      take: limit,
      select: {
        number: true,
        placedAt: true,
        status: true,
        currency: true,
        netSales: true,
        total: true,
        customerName: true,
        shippingCountry: true,
        shop: { select: { name: true } },
      },
    })
  }

  throw new RangeError(`Unknown tool: ${name}`)
}
