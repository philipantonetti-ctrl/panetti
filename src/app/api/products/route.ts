import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { costOn } from '@/lib/metrics/costs'
import { isUsableSku, normaliseSku } from '@/lib/inventory/sku'
 import { oneRowPerSku } from '@/lib/inventory/sources'

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const shopId = params.get('shopId')

    /**
     * One row per product, from the shops named as stock sources.
     *
     * The client asked to see a product once rather than once per country, and
     * this page was the only list where it genuinely appeared nine times: a cost
     * is stored against a per-shop `Product` row. The write already fans out
     * across every shop selling the SKU, so any one row is now enough to cost
     * the product everywhere - this makes the LIST match that.
     *
     * Per-shop mode stays, and is the only way to reach a product no source shop
     * sells. Ten of the sixty-two are in that position and six of them sold this
     * quarter, so removing the dropdown would make them permanently uncostable.
     */
    const bySource = params.get('source') === '1'
    if (!shopId && !bySource) {
      return NextResponse.json({ error: 'shopId is required' }, { status: 400 })
    }

    const shop = shopId ? await db.shop.findUnique({ where: { id: shopId } }) : null
    if (shopId && !shop) return NextResponse.json({ error: 'No such shop' }, { status: 404 })

    const [found, hidden, everywhere] = await Promise.all([
      db.product.findMany({
        where: bySource ? { shop: { active: true, stockSource: true } } : { shopId: shopId! },
        include: {
          costs: { orderBy: { effectiveFrom: 'desc' } },
          shop: { select: { currency: true } },
        },
        orderBy: { name: 'asc' },
      }),
      db.supplyItem.findMany({ where: { active: false }, select: { sku: true } }),
      // Only needed to say how many products this view is NOT showing. A page
      // listing 52 of 62 and saying nothing reads as "that is all of them".
      bySource
        ? db.product.findMany({ where: { shop: { active: true } }, select: { sku: true } })
        : Promise.resolve([]),
    ])

    // Two source shops are two catalogues, so anything they both list would
    // appear twice - the same complaint arriving by a different road.
    const products = bySource ? oneRowPerSku(found) : found

    /**
     * Products the client has hidden on the Suppliers page - spare parts and the
     * like - so this page stops asking him to cost things he never buys.
     *
     * Hidden, never deleted. Deleting a Product would cascade its ProductCost
     * timeline away (schema.prisma:95) and silently change the profit on orders
     * that already happened, and it would not even stick: the Woo sync upserts
     * every product on every order it reads (lib/woo/sync.ts:148).
     *
     * Matched on the NORMALISED sku. SupplyItem stores it trimmed and uppercased
     * and is keyed on it; Product stores whatever the shop typed. Comparing the
     * two raw lets a lower-case listing escape hiding, which the client would
     * read as us ignoring him.
     *
     * A product whose SKU is blank or all zeros never gets a SupplyItem at all
     * (isUsableSku), so it can never be hidden and always appears here. That is
     * deliberate: an uncostable product loses money on every order.
     */
    const hiddenSkus = new Set(hidden.map((i) => i.sku))
    const visible = products.filter((p) => !hiddenSkus.has(normaliseSku(p.sku)))

    const today = new Date()

    /**
     * How many usable SKUs the active shops sell that this view leaves out.
     *
     * Zero in per-shop mode, where the question does not arise. In source mode
     * these are the products only the other webshops list - reachable by picking
     * that shop above, and named on the page so nobody reads a short list as a
     * complete one.
     */
    const shownSkus = new Set(visible.filter((p) => isUsableSku(p.sku)).map((p) => normaliseSku(p.sku)))
    const allSkus = new Set(
      everywhere.filter((p) => isUsableSku(p.sku)).map((p) => normaliseSku(p.sku)),
    )
    const onlyElsewhere = [...allSkus].filter((s) => !shownSkus.has(s) && !hiddenSkus.has(s)).length

    return NextResponse.json({
      // In source mode every source shop shares a currency in practice; the page
      // only offers this view when they do, and reads the figure it will label
      // its inputs with from here rather than guessing.
      currency: shop?.currency ?? visible[0]?.shop.currency ?? found[0]?.shop.currency ?? 'NOK',
      onlyElsewhere,
      products: visible.map((p) => {
        const current = costOn(p.costs, today)
        return {
          id: p.id,
          // Trimmed and uppercased, not the raw spelling one shop happened to
          // use. In source mode a row stands for the product in every webshop,
          // so wearing Mazzetti's " csr-shared " would put stray whitespace on
          // screen and make the row impossible to match against the SKU the rest
          // of the system keys on. Display only - the cost is saved against
          // `id`, which never changes.
          sku: normaliseSku(p.sku),
          name: p.name,
          imageUrl: p.imageUrl,
          // The store's own listed price (incl. VAT) when we have it; the
          // ex-VAT order-line price only until the first completed sync.
          sellingPrice: p.catalogPrice ?? p.lastPrice,
          costPerItem: current.costPerItem,
          handlingCost: current.handlingCost,
          // The flag the UI uses to highlight a product whose cost was never entered.
          missingCost: current.costPerItem === 0,
          history: p.costs.map((c) => ({
            costPerItem: c.costPerItem,
            handlingCost: c.handlingCost,
            effectiveFrom: c.effectiveFrom.toISOString(),
          })),
        }
      }),
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load products' }, { status: 500 })
  }
}
