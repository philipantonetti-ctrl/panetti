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

// Sample buyers, so the Orders page shows who bought. A slice of orders stay
// nameless - real stores have guest checkouts, and the UI must cope.
const CUSTOMERS = [
  'Tino Skaarup', 'Anne Berg', 'Ola Nordmann', 'Kari Olsen', 'Jens Hansen',
  'Maria Virtanen', 'Lars Larsen', 'Sofia Andersson', 'Peter Madsen', 'Ingrid Dahl',
  'Mikael Koskinen', 'Astrid Holm', 'Erik Lund', 'Freja Nielsen', 'Henrik Berg',
]

async function main() {
  console.log('Clearing existing data...')
  await db.ticketAttachment.deleteMany()
  await db.ticketMessage.deleteMany()
  await db.ticket.deleteMany()
  await db.macro.deleteMany()
  await db.mailbox.deleteMany()
  await db.affiliateTransaction.deleteMany()
  await db.affiliateAccount.deleteMany()
  await db.adSpend.deleteMany()
  await db.adAccount.deleteMany()
  await db.adConnection.deleteMany()
  await db.adPlatformApp.deleteMany()
  await db.orderItem.deleteMany()
  await db.order.deleteMany()
  await db.productCost.deleteMany()
  await db.product.deleteMany()
  await db.operationalExpense.deleteMany()
  await db.ambassadorProduct.deleteMany()
  await db.ambassadorCode.deleteMany()
  await db.user.deleteMany()
  await db.ambassador.deleteMany()
  await db.shop.deleteMany()
  await db.fxRate.deleteMany()

  console.log('Creating shops...')
  const shops: { id: string; name: string; currency: string }[] = []
  for (const s of SHOPS) {
    shops.push(await db.shop.create({ data: { name: s.name, currency: s.currency } }))
  }

  console.log('Creating ambassadors + logins...')
  const passwordHash = await bcrypt.hash('password123', 10)
  const ambassadors = []
  for (const [i, name] of AMBASSADORS.entries()) {
    const slug = name.split(' ')[0].toLowerCase()
    // A code belongs to a store now; spread the sample ambassadors across shops.
    const a = await db.ambassador.create({
      data: {
        name,
        email: `${slug}@ambassador.test`,
        commissionRate: 0.1,
        codes: { create: { code: `${name.split(' ')[0].toUpperCase()}10`, shopId: shops[i % shops.length].id } },
      },
    })
    await db.user.create({
      data: { email: a.email, passwordHash, role: 'AMBASSADOR', ambassadorId: a.id },
    })
    ambassadors.push(a)
  }

  // A few ambassadors were sent product. Enough that the overview card has
  // something to say on a fresh database, and the e2e spec has a row to find.
  console.log('Handing out sample products...')
  const GIFTS: { to: number; sku: string; name: string; quantity: number; day: string }[] = [
    { to: 0, sku: 'MACBL661', name: 'Mazzetti Advanced Comfort - Massasjestol (Svart)', quantity: 1, day: '2026-03-12' },
    { to: 0, sku: 'MPX-001', name: 'Massasjepistol Pro X', quantity: 2, day: '2026-05-02' },
    { to: 1, sku: 'MPX-001', name: 'Massasjepistol Pro X', quantity: 1, day: '2026-04-18' },
    { to: 2, sku: 'MPX-001', name: 'Massasjepistol Pro X', quantity: 1, day: '2026-06-01' },
    { to: 3, sku: 'MLCBL510', name: 'Mazzetti Lite Comfort - Massasjestol (Svart)', quantity: 1, day: '2026-02-20' },
  ]
  for (const g of GIFTS) {
    await db.ambassadorProduct.create({
      data: {
        ambassadorId: ambassadors[g.to].id,
        sku: g.sku,
        name: g.name,
        quantity: g.quantity,
        receivedAt: new Date(`${g.day}T00:00:00Z`),
      },
    })
  }

  const admin = await db.user.create({
    data: { email: 'admin@ecom.test', passwordHash, role: 'ADMIN' },
  })
  await db.user.create({
    data: { email: 'marketing@ecom.test', passwordHash, role: 'MARKETING' },
  })

  console.log('Creating products, costs and expenses per shop...')
  // Carry sku+name alongside the id - two products share a price, so looking one up
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
    // Busier shops get more orders - the seed should look like the real thing.
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
      const customer = rnd() < 0.9 ? pick(CUSTOMERS) : null

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
          customerName: customer ?? '',
          customerEmail: customer ? `${customer.split(' ')[0].toLowerCase()}@customer.test` : '',
          customerPhone: customer ? `+47 9${String(1000000 + CUSTOMERS.indexOf(customer) * 7919).slice(-7)}` : '',
          items: { create: items },
        },
      })
      orderNo++
    }
  }

  console.log('Seeding exchange rates...')
  // Roughly realistic; the live fetcher will fill in and correct these. The
  // range runs well past "today" so sample data never looks stale enough to
  // send a dev machine (or a test) to the real currency API.
  const RATES: Record<string, number> = { NOK: 0.097, SEK: 0.094, DKK: 0.145, EUR: 1.08, USD: 1 }
  for (let d = 0; d <= 500; d++) {
    const date = new Date(Date.UTC(2026, 0, 1) + d * 24 * 60 * 60 * 1000)
    for (const [currency, rate] of Object.entries(RATES)) {
      await db.fxRate.create({
        data: { date, base: currency, quote: 'USD', rate },
      })
    }
  }

  console.log('Creating ad accounts and daily spend...')
  // Plaintext dummy secrets: decryptSecret passes non-encrypted values through,
  // and nothing in the sample data ever calls the real platforms.
  await db.adPlatformApp.create({
    data: { provider: 'meta', clientId: 'seed-app', clientSecret: 'seed' },
  })
  await db.adPlatformApp.create({
    data: { provider: 'google', clientId: 'seed-app', clientSecret: 'seed', developerToken: 'seed' },
  })
  const connection = await db.adConnection.create({
    data: { provider: 'meta', label: 'Philip (sample)', secret: 'seed' },
  })

  const AD_ACCOUNTS = [
    { shop: shops[0], provider: 'meta', externalId: '111222333444555', busy: true, connected: true },
    { shop: shops[0], provider: 'google', externalId: '1112223334', busy: true, connected: false },
    { shop: shops[1], provider: 'meta', externalId: '555444333222111', busy: false, connected: false },
  ]
  for (const a of AD_ACCOUNTS) {
    const account = await db.adAccount.create({
      data: {
        shopId: a.shop.id,
        provider: a.provider,
        externalId: a.externalId,
        name: `${a.shop.name} ${a.provider === 'meta' ? 'Meta' : 'Google'} Ads`,
        currency: a.shop.currency,
        // The sample data shows both roads: one account connected by login,
        // the others with pasted credentials.
        credentials: a.connected ? null : JSON.stringify({ accessToken: 'seed' }),
        connectionId: a.connected ? connection.id : null,
        lastSyncAt: today,
      },
    })

    // Daily delivery for the last 90 days, sized so ROAS and the platform
    // metrics land in a believable range against the sample orders.
    for (let d = 0; d < 90; d++) {
      const date = new Date(Date.UTC(2026, 6, 14) - d * 24 * 60 * 60 * 1000)
      const spend = a.busy ? between(50000, 400000) : between(20000, 150000)
      const impressions = Math.round(spend / 3)
      const clicks = Math.max(1, Math.round(impressions / 40))
      const conversions = Math.round(clicks * 0.6) / 10 // ~6% of clicks, one decimal
      await db.adSpend.create({
        data: {
          accountId: account.id,
          date,
          spend,
          impressions,
          clicks,
          linkClicks: Math.round(clicks * 0.8),
          conversions,
          conversionValue: Math.round(spend * (2 + rnd() * 6)),
          videoViews3s: a.provider === 'meta' ? Math.round(impressions * 0.25) : 0,
          thruplays: a.provider === 'meta' ? Math.round(impressions * 0.05) : 0,
          reach: Math.round(impressions * 0.6),
        },
      })
    }
  }

  console.log('Creating affiliate sales...')
  // The affiliate program: one Addrevenue brand with tracked sales across
  // three shops, so the Affiliate column, the Marketing section and the
  // settings page all have something true to show. Token 'seed' works because
  // decryptSecret passes unprefixed values through, and nothing here ever
  // calls the real platform.
  const affiliateAccount = await db.affiliateAccount.create({
    data: { externalId: '986851', name: 'Panetti (sample)', token: 'seed', lastSyncAt: today },
  })
  const CHANNELS = [
    { id: '3464435', name: 'Forbrukertesten.com' },
    { id: '3464436', name: 'Hjem og Hage' },
    { id: '3464437', name: 'Testsieger.de' },
  ]
  // Roughly the real mix: most paid out, a slice still working through.
  const AFFILIATE_STATUSES = ['paidOut', 'paidOut', 'invoiced', 'new']
  let affiliateId = 1
  for (let d = 0; d < 90; d += 2) {
    const shop = shops[d % 3] // Panetti Norway / Sweden / Denmark
    const channel = CHANNELS[d % CHANNELS.length]
    const orderValue = between(40000, 900000)
    const commission = Math.round(orderValue * 0.15)
    await db.affiliateTransaction.create({
      data: {
        accountId: affiliateAccount.id,
        externalId: String(affiliateId++),
        date: new Date(Date.UTC(2026, 6, 14) - d * 24 * 60 * 60 * 1000),
        market: ['NO', 'SE', 'DK'][d % 3],
        shopId: shop.id,
        channelId: channel.id,
        channelName: channel.name,
        status: AFFILIATE_STATUSES[d % AFFILIATE_STATUSES.length],
        commission,
        brokerageFee: Math.round(commission * 0.15),
        orderValue,
        currency: shop.currency,
        eventOrderId: String(19000 + d),
      },
    })
  }

  console.log('Creating the support inbox...')
  const byName = (name: string) => shops.find((s) => s.name === name)!
  const MAILBOXES = [
    { address: 'support@panetti.no', name: 'Panetti Norway', shop: byName('Panetti Norway'), language: 'nb', signature: 'Med vennlig hilsen\nPanetti kundeservice' },
    { address: 'support@panetti.de', name: 'Panetti Germany', shop: byName('Panetti Germany'), language: 'de', signature: 'Mit freundlichen Grüßen\nPanetti Kundenservice' },
    { address: 'support@mazzetti.no', name: 'Mazzetti Norway', shop: byName('Mazzetti.no'), language: 'nb', signature: 'Med vennlig hilsen\nMazzetti' },
  ]
  const mailboxes = []
  for (const m of MAILBOXES) {
    mailboxes.push(await db.mailbox.create({ data: { address: m.address, name: m.name, shopId: m.shop.id, language: m.language, signature: m.signature } }))
  }

  const MACROS: { name: string; language: string; body: string }[] = [
    { name: 'Where is my order?', language: 'en', body: 'Hi {{customer_name}},\n\nThank you for your message. Your order {{order_number}} is {{delivery_status}}. You can follow the parcel with tracking number {{tracking_number}}.\n\nKind regards,\n{{agent_name}}' },
    { name: 'Where is my order?', language: 'nb', body: 'Hei {{customer_name}},\n\nTakk for meldingen. Bestillingen din {{order_number}} er {{delivery_status}}. Du kan følge pakken med sporingsnummer {{tracking_number}}.\n\nMed vennlig hilsen,\n{{agent_name}}' },
    { name: 'Return instructions', language: 'en', body: 'Hi {{customer_name}},\n\nYou can return {{product_name}} within 14 days of delivery. Pack it in its original box, attach the return label we send you, and hand it in at your nearest pickup point. Quote order {{order_number}}.\n\nKind regards,\n{{agent_name}}' },
    { name: 'Warranty', language: 'en', body: 'Hi {{customer_name}},\n\n{{product_name}} carries a two-year warranty. Please reply with a short description of the fault and, if possible, a photo or video, and quote order {{order_number}}. We will get back to you within two working days.\n\nKind regards,\n{{agent_name}}' },
    { name: 'Damaged product', language: 'en', body: 'Hi {{customer_name}},\n\nWe are sorry {{product_name}} arrived damaged. Please send us a photo of the damage and of the packaging, quoting order {{order_number}}, and we will arrange a replacement or a refund straight away.\n\nKind regards,\n{{agent_name}}' },
    { name: 'Refund confirmation', language: 'en', body: 'Hi {{customer_name}},\n\nYour refund for order {{order_number}} has been issued. Depending on your bank it takes 3-5 working days to appear on your statement.\n\nKind regards,\n{{agent_name}}' },
    { name: 'Product instructions', language: 'en', body: 'Hi {{customer_name}},\n\nThank you for choosing {{product_name}}. The user guide is in the box; if it is missing, reply to this email and we will send it as a PDF.\n\nKind regards,\n{{agent_name}}' },
  ]
  for (const m of MACROS) await db.macro.create({ data: m })

  // Tickets from customers the seed already gave orders, so the sidebar has
  // real orders to show on day one. Read from the data rather than hard-coded:
  // the order numbers are whatever the loop above produced.
  const norway = mailboxes[0]
  const germany = mailboxes[1]
  const recentNorway = await db.order.findFirst({
    where: { shopId: byName('Panetti Norway').id, customerEmail: { not: '' }, status: 'completed' },
    orderBy: { placedAt: 'desc' },
  })
  if (!recentNorway) throw new Error('seed: expected a Panetti Norway order with a customer')
  const firstName = recentNorway.customerName!.split(' ')[0]

  await db.ticket.create({
    data: {
      mailboxId: norway.id, subject: `Hvor er ordre ${recentNorway.number}?`, customerEmail: recentNorway.customerEmail!, customerName: recentNorway.customerName!,
      category: 'shipping', language: 'nb', matchedOrderId: recentNorway.id, priority: 'HIGH', tags: ['late'],
      firstMessageAt: new Date('2026-07-13T09:12:00Z'), lastMessageAt: new Date('2026-07-13T09:12:00Z'),
      messages: { create: [{ direction: 'INBOUND', rfcMessageId: 'seed-1@customer.test', fromEmail: recentNorway.customerEmail!, toEmail: norway.address, subject: `Hvor er ordre ${recentNorway.number}?`,
        textBody: `Hei,\n\nJeg bestilte for over en uke siden (ordre ${recentNorway.number}) og har ikke fått noen sporing. Hva skjer?\n\n${firstName}`, sentAt: new Date('2026-07-13T09:12:00Z') }] },
    },
  })
  await db.ticket.create({
    data: {
      mailboxId: norway.id, subject: 'Spørsmål om varmefunksjonen', customerEmail: recentNorway.customerEmail!, customerName: recentNorway.customerName!,
      category: 'product', language: 'nb', status: 'CLOSED', closedAt: new Date('2026-06-21T10:00:00Z'),
      firstMessageAt: new Date('2026-06-20T14:00:00Z'), lastMessageAt: new Date('2026-06-21T10:00:00Z'),
      messages: { create: [
        { direction: 'INBOUND', rfcMessageId: 'seed-2@customer.test', fromEmail: recentNorway.customerEmail!, toEmail: norway.address, textBody: 'Hvordan slår jeg på varmen i stolen?', sentAt: new Date('2026-06-20T14:00:00Z') },
        { direction: 'OUTBOUND', rfcMessageId: 'seed-2r@panetti.no', authorUserId: admin.id, fromEmail: norway.address, toEmail: recentNorway.customerEmail!, textBody: 'Hei! Hold inne knappen med flammesymbolet i to sekunder.\n\nMed vennlig hilsen\nPanetti kundeservice', sentAt: new Date('2026-06-21T10:00:00Z') },
      ] },
    },
  })
  await db.ticket.create({
    data: {
      mailboxId: germany.id, subject: 'Rücksendung meiner Bestellung', customerEmail: 'jonas.weber@example.de', customerName: 'Jonas Weber',
      category: 'return', language: 'de',
      firstMessageAt: new Date('2026-07-12T16:40:00Z'), lastMessageAt: new Date('2026-07-12T16:40:00Z'),
      messages: { create: [{ direction: 'INBOUND', rfcMessageId: 'seed-3@example.de', fromEmail: 'jonas.weber@example.de', toEmail: germany.address, textBody: 'Hallo,\n\nich möchte meine Bestellung zurückschicken. Wie gehe ich vor?\n\nJonas Weber', sentAt: new Date('2026-07-12T16:40:00Z') }] },
    },
  })
  await db.ticket.create({
    data: {
      mailboxId: mailboxes[2].id, subject: 'Question about the massage chair', customerEmail: 'unknown@example.com', customerName: 'Sam',
      category: 'product', language: 'en', status: 'PENDING', assigneeUserId: admin.id,
      firstMessageAt: new Date('2026-07-11T08:00:00Z'), lastMessageAt: new Date('2026-07-11T12:00:00Z'),
      messages: { create: [
        { direction: 'INBOUND', rfcMessageId: 'seed-4@example.com', fromEmail: 'unknown@example.com', toEmail: mailboxes[2].address, textBody: 'Does the Lite Comfort fit under a 70 cm desk?', sentAt: new Date('2026-07-11T08:00:00Z') },
        { direction: 'NOTE', authorUserId: admin.id, fromEmail: 'admin@ecom.test', toEmail: '', textBody: 'Checked with the warehouse: 68 cm with the headrest down.', sentAt: new Date('2026-07-11T11:00:00Z') },
        { direction: 'OUTBOUND', rfcMessageId: 'seed-4r@mazzetti.no', authorUserId: admin.id, fromEmail: mailboxes[2].address, toEmail: 'unknown@example.com', textBody: 'Yes - 68 cm with the headrest down.\n\nMed vennlig hilsen\nMazzetti', sentAt: new Date('2026-07-11T12:00:00Z') },
      ] },
    },
  })

  const orders = await db.order.count()
  console.log(`\nDone. ${shops.length} shops, ${ambassadors.length} ambassadors, ${orders} orders.`)
  console.log('Admin login:      admin@ecom.test / password123')
  console.log('Marketing login:  marketing@ecom.test / password123')
  console.log('Ambassador login: emma@ambassador.test / password123')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
