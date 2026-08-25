import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'
import { zoneDayEndUtc, zoneDayStartUtc, zonedDayStr } from '@/lib/tz'
import { utcDay } from '@/lib/dates'
import { carrierAverages, firstFullMonth, type CarrierShipments } from '@/lib/delivery/carrier-cost'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * When the carrier's meter started for one parcel.
 *
 * `handedInAt` is the carrier physically taking it, which is the event it
 * bills for. Where a parcel never recorded one - a file import that gave us a
 * number before any carrier event arrived - the label date is the next best
 * claim, and the row's own creation is the last resort. Stated as one function
 * so the count and the WHERE clause below can never disagree about which
 * parcels belong to a month.
 */
const billableAt = (s: { handedInAt: Date | null; bookedAt: Date | null; createdAt: Date }) =>
  s.handedInAt ?? s.bookedAt ?? s.createdAt

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * Cost per parcel, per carrier, for the range on screen.
 *
 * The money is entered by hand on purpose - see carrier-cost.ts. No endpoint
 * either carrier exposes to us returns what a shipment actually cost.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { timezone, displayCurrency } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)

    const start = zoneDayStartUtc(utcDay(from).toISOString().slice(0, 10), timezone)
    const end = zoneDayEndUtc(utcDay(to).toISOString().slice(0, 10), timezone)

    // The three branches mirror billableAt exactly. Filtering on createdAt
    // alone would count a parcel into the month we first heard about it, which
    // for a backfilled import is not the month the carrier moved it.
    const shipments = await db.shipment.findMany({
      where: {
        OR: [
          { handedInAt: { gte: start, lte: end } },
          { handedInAt: null, bookedAt: { gte: start, lte: end } },
          { handedInAt: null, bookedAt: null, createdAt: { gte: start, lte: end } },
        ],
      },
      select: { carrier: true, handedInAt: true, bookedAt: true, createdAt: true },
    })

    const counts = new Map<string, number>()
    for (const s of shipments) {
      const month = zonedDayStr(billableAt(s), timezone).slice(0, 7)
      const key = `${s.carrier}|${month}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    /**
     * When the parcel record began, by the system's own declaration: the
     * earliest deliveryTrackingFrom any active shop carries - the same "judge
     * nothing older than this" the rest of the Delivery page obeys. NOT
     * min(Shipment date), deliberately: production holds one stray parcel
     * dated July in a record that otherwise starts 12 August, so a
     * data-derived start would call August fully counted when eleven days of
     * it were never recorded. Months from before the first full month show
     * their bill but are never divided. No declared start means no boundary,
     * which is the pre-tracking behaviour unchanged.
     */
    const era = await db.shop.aggregate({
      where: { active: true, deliveryTrackingFrom: { not: null } },
      _min: { deliveryTrackingFrom: true },
    })
    const firstMonth = era._min.deliveryTrackingFrom
      ? firstFullMonth(era._min.deliveryTrackingFrom)
      : null
    const complete = (month: string) => firstMonth === null || month >= firstMonth

    const perMonth: CarrierShipments[] = [...counts].map(([key, count]) => {
      const [carrier, month] = key.split('|')
      return { carrier, month, count, complete: complete(month) }
    })

    /**
     * Every stored bill, not just the on-screen months' - the whole point of
     * reading Bring's invoices automatically is that the money is VISIBLE, and
     * a bill for a month with no counted parcels (June and July hold real
     * totals and no parcels at all) has no shipment row to earn it a place.
     * The table is a handful of rows per carrier per year, so unbounded is a
     * dozen rows, not a scan.
     */
    const costs = await db.carrierCost.findMany()

    const byKey = new Map(costs.map((c) => [`${c.carrier}|${c.month}`, c]))

    return NextResponse.json(
      {
        // The first month whose parcel count covers the whole month, so the
        // page can say out loud when a cost per parcel will first exist
        // instead of pointing at boxes that cannot produce one yet.
        firstMonth,
        carriers: carrierAverages(
          perMonth,
          costs.map((c) => ({
            carrier: c.carrier,
            month: c.month,
            amount: c.amount,
            currency: c.currency,
          })),
        ),
        // One row per carrier per month: every month that moved parcels, plus
        // every month holding a bill - read or typed - even where no parcel
        // was counted. `counted: false` marks a month whose parcel figures
        // must not be shown or divided: its bill covers the whole month and
        // its count does not.
        months: [
          ...perMonth.map((s) => ({
            carrier: s.carrier,
            month: s.month,
            parcels: s.count,
            counted: s.complete !== false,
            amount: byKey.get(`${s.carrier}|${s.month}`)?.amount ?? null,
            currency: byKey.get(`${s.carrier}|${s.month}`)?.currency ?? null,
            // 'bring' means nobody typed this - it was read from the invoice
            // archive. The page says so, because a figure that appeared by
            // itself needs to explain where it came from.
            source: byKey.get(`${s.carrier}|${s.month}`)?.source ?? null,
          })),
          ...costs
            .filter((c) => !counts.has(`${c.carrier}|${c.month}`))
            .map((c) => ({
              carrier: c.carrier,
              month: c.month,
              parcels: 0,
              counted: false,
              amount: c.amount,
              currency: c.currency,
              source: c.source,
            })),
        ].sort((a, b) => a.carrier.localeCompare(b.carrier) || b.month.localeCompare(a.month)),
        defaultCurrency: displayCurrency,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json(
      { error: 'Could not load carrier costs' },
      { status: 500, headers: NO_STORE },
    )
  }
}

/** Record, change or clear one carrier's invoice for one month. */
export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())

    const body = (await req.json()) as {
      carrier?: unknown
      month?: unknown
      amount?: unknown
      currency?: unknown
    }

    const carrier = typeof body.carrier === 'string' ? body.carrier.trim().toUpperCase() : ''
    const month = typeof body.month === 'string' ? body.month.trim() : ''
    if (carrier === '' || !MONTH.test(month)) {
      return NextResponse.json(
        { error: 'A carrier and a month like 2026-08 are both required' },
        { status: 400, headers: NO_STORE },
      )
    }

    // Null clears the invoice rather than storing a zero. Zero is a real
    // figure - "they billed us nothing" - and must stay sayable.
    if (body.amount === null) {
      await db.carrierCost.deleteMany({ where: { carrier, month } })
      return NextResponse.json({ ok: true }, { headers: NO_STORE })
    }

    const amount = typeof body.amount === 'number' ? body.amount : NaN
    const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : ''
    if (!Number.isInteger(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) {
      return NextResponse.json(
        { error: 'An amount in minor units and a three-letter currency are both required' },
        { status: 400, headers: NO_STORE },
      )
    }

    await db.carrierCost.upsert({
      where: { carrier_month: { carrier, month } },
      // 'typed' is what stops the Bring importer overwriting this on the next
      // tick. A person who corrects a figure knows something the archive does
      // not, and it has to survive.
      create: { carrier, month, amount, currency, source: 'typed' },
      update: { amount, currency, source: 'typed' },
    })

    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json(
      { error: 'Could not save the carrier cost' },
      { status: 500, headers: NO_STORE },
    )
  }
}
