/**
 * What the shops named as stock sources carry, and what they call it.
 *
 * The Forecast tab has read its product list and its product names from those
 * shops since the day the flag existed - which is what stopped Norwegian
 * products appearing under their Finnish and Swedish names. Suppliers & lead
 * times never did: it lists every `SupplyItem` ever created, one per usable SKU
 * from every shop ever synced, under whichever name was snapshotted first.
 *
 * These three functions are that scoping, pulled out where both pages can share
 * it, so the two lists cannot drift into disagreeing about what a product is
 * called or whether we sell it.
 */

import { isUsableSku, normaliseSku } from './sku'

/**
 * SKU to the name the source shops use.
 *
 * First non-blank name wins. First, so two source shops carrying one SKU cannot
 * make the winner depend on the order Postgres returned them in; non-blank, so a
 * shop that carries the product with an empty title cannot blank out a name
 * another source shop does have.
 */
export function catalogueOf(products: { sku: string; name: string }[]): Map<string, string> {
  const catalogue = new Map<string, string>()
  for (const p of products) {
    if (!isUsableSku(p.sku)) continue
    const sku = normaliseSku(p.sku)
    if (!catalogue.has(sku) && p.name.trim() !== '') catalogue.set(sku, p.name)
  }
  return catalogue
}

/**
 * SKU to the photo the source shops show for it.
 *
 * The companion to `catalogueOf`, one field along. A photo is how someone
 * recognises a product without translating its name first, which is why the
 * Forecast and Stock tabs have built this exact map for as long as they have
 * shown one.
 *
 * First non-null wins, not first row. A source shop that lists the product
 * without a picture must not blank out a picture another source shop does
 * have - the same reason a blank title cannot win in `catalogueOf`.
 */
export function imagesOf(
  products: { sku: string; imageUrl: string | null }[],
): Map<string, string> {
  const images = new Map<string, string>()
  for (const p of products) {
    if (!isUsableSku(p.sku)) continue
    const sku = normaliseSku(p.sku)
    if (!images.has(sku) && p.imageUrl) images.set(sku, p.imageUrl)
  }
  return images
}

/**
 * Split purchasing rows into what the source shops sell and what only the other
 * webshops do.
 *
 * `null` means nobody has named a source, so everything is carried and the
 * caller behaves exactly as it did before this existed. Order is preserved:
 * these lists arrive sorted by name and must stay that way.
 *
 * Nothing is dropped. A product the .no shops do not list is still a product we
 * may buy - its lead times, its supplier and its open orders are all real - so
 * it moves out of the working list, never out of the page.
 */
export function splitBySource<T extends { sku: string }>(
  items: T[],
  catalogue: Map<string, string> | null,
): { carried: T[]; elsewhere: T[] } {
  if (catalogue === null) return { carried: items, elsewhere: [] }

  const carried: T[] = []
  const elsewhere: T[] = []
  for (const i of items) {
    if (catalogue.has(normaliseSku(i.sku))) carried.push(i)
    else elsewhere.push(i)
  }
  return { carried, elsewhere }
}

/**
 * One row per product, out of a list that may carry it several times.
 *
 * The source shops are two catalogues, not one, and a page that lists both shows
 * anything they share twice - which is the client's complaint arriving by a
 * different road. First one wins, so the caller's ordering decides, and an
 * alphabetical list stays alphabetical.
 *
 * A SKU that cannot identify a product is never collapsed. Six live products
 * share the SKU "0", spanning a pizza oven and a massage chair, and folding them
 * into one row would hide five products that each need costing - worse than
 * showing a duplicate.
 */
export function oneRowPerSku<T extends { sku: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  const kept: T[] = []
  for (const r of rows) {
    if (!isUsableSku(r.sku)) {
      kept.push(r)
      continue
    }
    const sku = normaliseSku(r.sku)
    if (seen.has(sku)) continue
    seen.add(sku)
    kept.push(r)
  }
  return kept
}

/**
 * What the source shops call one product, or its stored name when they do not
 * carry it.
 *
 * The single-row form, for the places a name is nested inside something else -
 * a purchase order carries its product, not a list of them. `namedFromSource`
 * is this applied across a list, so the two can never disagree about the rule.
 */
export function nameOf(
  catalogue: Map<string, string> | null,
  item: { sku: string; name: string },
): string {
  return catalogue?.get(normaliseSku(item.sku)) ?? item.name
}

/**
 * The photo a source shop shows for one product, or null when none does.
 *
 * The single-row form of `imagesOf`, exactly as `nameOf` is of `catalogueOf`,
 * so a page never has to know how a SKU is normalised. Null rather than
 * undefined because that is what `Thumb` takes, and it draws a placeholder.
 */
export function imageOf(images: Map<string, string>, item: { sku: string }): string | null {
  return images.get(normaliseSku(item.sku)) ?? null
}

/**
 * Retitle each row with what the source shop calls it.
 *
 * `SupplyItem.name` is a snapshot taken once, from whichever shop the database
 * returned first, and never updated - so Norwegian products are listed under
 * their Finnish and Swedish names. Reading the name from the source shop instead
 * fixes every existing row with no migration, and keeps following the listing if
 * it is renamed. A row the source shops do not carry keeps its stored name,
 * because there is no better one to be had.
 */
export function namedFromSource<T extends { sku: string; name: string }>(
  items: T[],
  catalogue: Map<string, string> | null,
): T[] {
  if (catalogue === null) return items
  return items.map((i) => {
    const name = nameOf(catalogue, i)
    return name === i.name ? i : { ...i, name }
  })
}
