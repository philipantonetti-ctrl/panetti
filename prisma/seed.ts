import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const db = new PrismaClient()

// Deterministic pseudo-random, so the seed produces the same data every run.
let s = 42
const rnd = () => {
  s = (s * 1103515245 + 12345) % 2147483648
  return s / 2147483648
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
const between = (lo: number, hi: number) => Math.floor(lo + rnd() * (hi - lo + 1))

const SHOPS = [
  { name: 'Panetti Norway', currency: 'NOK' },
  { name: 'Panetti Sweden', currency: 'SEK' },
  { name: 'Panetti Denmark', currency: 'DKK' },
  { name: 'Panetti Finland', currency: 'EUR' },
  { name: 'Panetti Germany', currency: 'EUR' },
  { name: 'Mazzetti.no', currency: 'NOK' },
  { name: 'Mazzetti.se', currency: 'SEK' },
  { name: 'Mazzetti Denmark', currency: 'DKK' },
  { name: 'Mazzetti Finland', currency: 'EUR' },
  { name: 'Massasjepistoler.no', currency: 'NOK' },
  { name: 'Bellino.no', currency: 'NOK' },
]

/**
 * Sample product thumbnails.
 *
 * These are tiny inline SVGs, so the sample data looks right with no network and no
 * image files to ship. When a real WooCommerce shop is connected, the sync overwrites
 * these with the shop's real product photos.
 */
function thumb(label: string, bg: string, fg: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">` +
    `<rect width="80" height="80" rx="12" fill="${bg}"/>` +
    `<text x="40" y="50" font-family="Arial" font-size="26" font-weight="bold" text-anchor="middle" fill="${fg}">${label}</text>` +
    `</svg>`
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

const CATALOGUE = [
  { sku: 'MACBL661', name: 'Mazzetti Advanced Comfort - Massasjestol (Svart)', price: 4499900, cost: 1599000, handling: 2400, image: thumb('AC', '#2e1a47', '#ffffff') },
  { sku: 'MACBE661', name: 'Mazzetti Advanced Comfort - Massasjestol (Beige)', price: 4499900, cost: 1599000, handling: 2400, image: thumb('AC', '#d8cfc0', '#5b4636') },
  { sku: 'MLCBL510', name: 'Mazzetti Lite Comfort - Massasjestol (Svart)', price: 2999900, cost: 821000, handling: 2400, image: thumb('LC', '#3f3f46', '#ffffff') },
  { sku: 'MLCBE510', name: 'Mazzetti Lite Comfort - Massasjestol (Beige)', price: 2999900, cost: 821000, handling: 2500, image: thumb('LC', '#e5ddd0', '#5b4636') },
  { sku: 'MPX-001', name: 'Massasjepistol Pro X', price: 249900, cost: 78000, handling: 1200, image: thumb('PX', '#6b4fc0', '#ffffff') },
  { sku: 'MPM-002', name: 'Massasjepistol Mini', price: 129900, cost: 41000, handling: 900, image: thumb('MI', '#0ea5e9', '#ffffff') },
]

const AMBASSADORS = [
  'Emma Nilsen', 'Johan Berg', 'Sofia Lind', 'Mats Haugen', 'Ida Solberg',
  'Lukas Dahl', 'Nora Vik', 'Oliver Strand', 'Maja Ruud', 'Elias Moen',
  'Thea Lunde', 'Filip Aas', 'Sara Holm', 'Jonas Ek', 'Live Sand',
  'Kasper Bo', 'Amalie Rye', 'Sander Fjell', 'Julie Nes', 'Tobias Kro',
  'Hanna Sten', 'Adrian Lie', 'Mia Foss', 'Noah Berge',
]

const EXPENSES = [
  { label: '3PL Warehouse', category: 'Fulfillment > Warehouse', amount: 1400000, recurrence: 'MONTHLY' },
  { label: 'Accounting', category: 'Overhead > Subscriptions', amount: 525000, recurrence: 'MONTHLY' },
  { label: 'Employees', category: 'Overhead > Employees', amount: 1750000, recurrence: 'MONTHLY' },
  { label: 'Shopify + tools', category: 'Overhead > Subscriptions', amount: 120000, recurrence: 'MONTHLY' },
  { label: 'Office', category: 'Overhead > Office', amount: 800000, recurrence: 'MONTHLY' },
]

const ORDER_STATUSES = ['completed', 'completed', 'completed', 'completed', 'processing', 'refunded']

async function main() {
  console.log('Clearing existing data...')
  await db.orderItem.deleteMany()
  await db.order.deleteMany()
  await db.productCost.deleteMany()
  await db.product.deleteMany()
  await db.operationalExpense.deleteMany()
  await db.ambassadorCode.deleteMany()
  await db.user.deleteMany()
  await db.ambassador.deleteMany()
  await db.shop.deleteMany()
  await db.fxRate.deleteMany()

  console.log('Creating shops...')
  const shops = []
  for (const s of SHOPS) {
    shops.push(await db.shop.create({ data: { name: s.name, currency: s.currency } }))
  }

  console.log('Creating ambassadors + logins...')
  const passwordHash = await bcrypt.hash('password123', 10)
  const ambassadors = []
  for (const name of AMBASSADORS) {
    const slug = name.split(' ')[0].toLowerCase()
    const a = await db.ambassador.create({
      data: {
        name,
        email: `${slug}@ambassador.test`,
        commissionRate: 0.1,
        codes: { create: { code: `${name.split(' ')[0].toUpperCase()}10` } },
      },
    })
    await db.user.create({
      data: { email: a.email, passwordHash, role: 'AMBASSADOR', ambassadorId: a.id },
    })
    ambassadors.push(a)
  }

  await db.user.create({
    data: { email: 'admin@ecom.test', passwordHash, role: 'ADMIN' },
  })

  console.log('Creating products, costs and expenses per shop...')
  // Carry sku+name alongside the id — two products share a price, so looking one up
  // by price alone would silently attach the wrong SKU to half the order lines.
  type SeedProduct = { id: string; price: number; sku: string; name: string }
  const productsByShop = new Map<string, SeedProduct[]>()

  for (const shop of shops) {
    const list: SeedProduct[] = []

    for (const [i, item] of CATALOGUE.entries()) {
      const product = await db.product.create({
        data: {
          shopId: shop.id,
          externalId: String(1000 + i),
          sku: item.sku,
          name: item.name,
          imageUrl: item.image,
          lastPrice: item.price,
        },
      })

      // A cost timeline: one cost from Jan, a price rise from June.
      // This exercises the effective-date logic with real data.
      await db.productCost.create({
        data: {
          productId: product.id,
          costPerItem: item.cost,
          handlingCost: item.handling,
          effectiveFrom: new Date('2026-01-01'),
        },
      })
      await db.productCost.create({
        data: {
          productId: product.id,
          costPerItem: Math.round(item.cost * 1.08), // 8% cost increase
          handlingCost: item.handling,
          effectiveFrom: new Date('2026-06-01'),
        },
      })

      list.push({ id: product.id, price: item.price, sku: item.sku, name: item.name })
    }
    productsByShop.set(shop.id, list)

    for (const e of EXPENSES) {
      await db.operationalExpense.create({
        data: {
          shopId: shop.id,
          label: e.label,
          category: e.category,
          amount: e.amount,
          currency: shop.currency,
          recurrence: e.recurrence,
          startDate: new Date('2026-01-01'),
          active: true,
        },
      })
    }
  }

  console.log('Creating orders across the last 6 months...')
  const today = new Date('2026-07-14')
  let orderNo = 1000

  for (const shop of shops) {
    const products = productsByShop.get(shop.id)!
    // Busier shops get more orders — the seed should look like the real thing.
    const busy = ['Panetti Norway', 'Mazzetti.no', 'Massasjepistoler.no'].includes(shop.name)
    const count = busy ? between(140, 200) : between(20, 70)

    for (let i = 0; i < count; i++) {
      const daysAgo = between(0, 180)
      const placedAt = new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000)

      // ~35% of orders carry an ambassador code.
      const ambassador = rnd() < 0.35 ? pick(ambassadors) : null

      const lines = between(1, 2)
      let gross = 0
      const items: { productId: string; sku: string; name: string; quantity: number; unitPrice: number; lineNetTotal: number }[] = []

      for (let l = 0; l < lines; l++) {
        const p = pick(products)
        const qty = between(1, 2)
        const line = p.price * qty
        gross += line
        items.push({
          productId: p.id,
          sku: p.sku,
          name: p.name,
          quantity: qty,
          unitPrice: p.price,
          lineNetTotal: line,
        })
      }

      // The ambassador's code gives the customer 10% off.
      const discount = ambassador ? Math.round(gross * 0.1) : 0
      const netSales = gross - discount
      // Spread the discount across the lines so line totals still add up to netSales.
      if (discount > 0) {
        let left = discount
        for (const [idx, item] of items.entries()) {
          const share = idx === items.length - 1 ? left : Math.round((item.lineNetTotal / gross) * discount)
          item.lineNetTotal -= share
          left -= share
        }
      }

      const shipping = rnd() < 0.5 ? 0 : between(4900, 9900)
      const tax = Math.round((netSales + shipping) * 0.25) // 25% VAT
      const status = pick(ORDER_STATUSES)

      await db.order.create({
        data: {
          shopId: shop.id,
          externalId: String(orderNo),
          number: `#${orderNo}`,
          placedAt,
          status,
          currency: shop.currency,
          grossSales: gross,
          discountTotal: discount,
          netSales,
          shippingCharged: shipping,
          taxTotal: tax,
          total: netSales + shipping + tax,
          couponCode: ambassador ? `${ambassador.name.split(' ')[0].toUpperCase()}10` : null,
          ambassadorId: ambassador?.id ?? null,
          items: { create: items },
        },
      })
      orderNo++
    }
  }

  console.log('Seeding exchange rates...')
  // Roughly realistic; the live fetcher will fill in and correct these.
  const RATES: Record<string, number> = { NOK: 0.097, SEK: 0.094, DKK: 0.145, EUR: 1.08, USD: 1 }
  for (let d = 0; d <= 200; d++) {
    const date = new Date(Date.UTC(2026, 0, 1) + d * 24 * 60 * 60 * 1000)
    for (const [currency, rate] of Object.entries(RATES)) {
      await db.fxRate.create({
        data: { date, base: currency, quote: 'USD', rate },
      })
    }
  }

  const orders = await db.order.count()
  console.log(`\nDone. ${shops.length} shops, ${ambassadors.length} ambassadors, ${orders} orders.`)
  console.log('Admin login:      admin@ecom.test / password123')
  console.log('Ambassador login: emma@ambassador.test / password123')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
