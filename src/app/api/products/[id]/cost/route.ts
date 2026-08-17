import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { toMinor } from '@/lib/money'
import { applyCostChange, resolveEffectiveFrom, type ApplyFrom } from '@/lib/cost-timeline'
import { spreadCost } from '@/lib/cost-spread'
import { normaliseSku } from '@/lib/inventory/sku'
import { buildRateTable, crossFactor } from '@/lib/metrics/fx'
import { ensureRates, loadRates } from '@/lib/fx/rates'

const Apply = z.object({
  apply: z.enum(['FUTURE', 'LAST_60_DAYS', 'DATE_RANGE']),
  from: z.string().optional(),
})

const Body = z.object({
  costPerItem: z.number().min(0),
  costApply: Apply, // step 1 of 2 — when the new COGS starts applying
  handlingCost: z.number().min(0),
  handlingApply: Apply, // step 2 of 2 — when the new handling cost starts applying
})

/**
 * Save a product's costs, in every webshop that sells it.
 *
 * COGS and handling are chosen in two steps and can each start from a DIFFERENT
 * date, so we rebuild each product's cost timeline rather than overwrite it:
 * every earlier order keeps exactly the cost it already had.
 *
 * The fan-out is the point. `ProductCost` hangs off a `Product` and `Product` is
 * per shop, so the same physical item carried nine separate costs and the page
 * asked for the same figure nine times — the client's "we only need to see the
 * product one time" complaint, in the one place it was literally true. A unit
 * costs what it costs regardless of which store sold it: one warehouse, one
 * supplier invoice. So it is entered once and converted outward.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())

    const { id } = await params
    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid cost' }, { status: 400 })

    const product = await db.product.findUnique({
      where: { id },
      include: { shop: { select: { currency: true } } },
    })
    if (!product) return NextResponse.json({ error: 'No such product' }, { status: 404 })

    const today = new Date()
    const costFrom = resolveEffectiveFrom(parsed.data.costApply as ApplyFrom, today)
    const handlingFrom = resolveEffectiveFrom(parsed.data.handlingApply as ApplyFrom, today)

    /**
     * Every shop's row for this SKU, the source product's own included.
     *
     * Filtered in JavaScript rather than in SQL because `Product.sku` holds
     * whatever the shop typed — ` pzo-500 ` and `PZO-500` are one product — and a
     * case-sensitive `where` would silently leave a webshop on its old cost,
     * which is the failure this whole change exists to end. A few hundred rows
     * on a human-initiated save is not a cost worth being clever about.
     */
    const sku = normaliseSku(product.sku)
    const siblings = (
      await db.product.findMany({
        select: { id: true, sku: true, shop: { select: { name: true, currency: true } } },
      })
    )
      .filter((p) => normaliseSku(p.sku) === sku)
      .map((p) => ({ id: p.id, shopName: p.shop.name, currency: p.shop.currency }))

    /**
     * Best effort, and deliberately not fatal.
     *
     * Without a rate a shop is skipped and named, which is a safe outcome; but
     * fetching the rate first makes the skip rare rather than routine. A
     * Frankfurter outage must not stop someone entering a cost, so a failure here
     * degrades to "wrote eight shops, skipped one" instead of losing the save.
     */
    const currencies = [...new Set(siblings.map((s) => s.currency))]
    try {
      await ensureRates(costFrom, today, currencies)
    } catch {
      // Fall through to whatever rates we already hold.
    }
    const rates = buildRateTable(await loadRates())

    const { writes, skipped } = spreadCost({
      from: product.shop.currency,
      costPerItem: toMinor(parsed.data.costPerItem),
      handlingCost: toMinor(parsed.data.handlingCost),
      siblings,
      // Read on the day the cost starts applying, not today: that is the day
      // whose exchange rate this cost is actually a cost at.
      factor: (from, to) => crossFactor(from, to, costFrom, rates),
    })

    const existing = await db.productCost.findMany({
      where: { productId: { in: writes.map((w) => w.productId) } },
      orderBy: { effectiveFrom: 'asc' },
    })

    // Each shop's timeline is its own history and gets the change applied to
    // itself. Rebuilding them all from the source's timeline would overwrite
    // whatever the other shops already knew.
    const rows = writes.flatMap((w) =>
      applyCostChange(
        existing
          .filter((c) => c.productId === w.productId)
          .map((c) => ({
            costPerItem: c.costPerItem,
            handlingCost: c.handlingCost,
            effectiveFrom: c.effectiveFrom,
          })),
        {
          costPerItem: w.costPerItem,
          costFrom,
          handlingCost: w.handlingCost,
          handlingFrom,
        },
      ).map((r) => ({
        productId: w.productId,
        costPerItem: r.costPerItem,
        handlingCost: r.handlingCost,
        effectiveFrom: r.effectiveFrom,
      })),
    )

    // Every shop's timeline rewritten as one unit, so a half-applied cost can
    // never be read — one webshop on the new figure and eight on the old is
    // worse than none of them moving.
    await db.$transaction([
      db.productCost.deleteMany({ where: { productId: { in: writes.map((w) => w.productId) } } }),
      db.productCost.createMany({ data: rows }),
    ])

    return NextResponse.json({
      ok: true,
      points: rows.length,
      /** How many webshops now carry this cost. */
      shops: writes.length,
      /** Shops left on their old cost, and why it could not be converted. */
      skipped,
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the cost' }, { status: 500 })
  }
}
