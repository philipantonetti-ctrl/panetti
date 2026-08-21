import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'
import { zoneDayEndUtc, zoneDayStartUtc, zonedDayStr } from '@/lib/tz'
import { utcDay } from '@/lib/dates'
import { carrierAverages, type CarrierShipments } from '@/lib/delivery/carrier-cost'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * When the carrier's meter started for one parcel.
 *
 * `handedInAt` is the carrier physically taking it, which is the event it
 * bills for. Where a parcel never recorded one — a file import that gave us a
 * number before any carrier event arrived — the label date is the next best
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
 * The money is entered by hand on purpose — see carrier-cost.ts. No endpoint
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

    const perMonth: CarrierShipments[] = [...counts].map(([key, count]) => {
      const [carrier, month] = key.split('|')
      return { carrier, month, count }
    })

    const months = [...new Set(perMonth.map((r) => r.month))]
    const costs =
      months.length === 0 ? [] : await db.carrierCost.findMany({ where: { month: { in: months } } })

    const byKey = new Map(costs.map((c) => [`${c.carrier}|${c.month}`, c]))

    /**
     * How far the Bring invoice reader has got, and why it has stopped if it
     * has.
     *
     * Deliberately a WHOLE-TABLE count, not scoped to the range above. The
     * reader works through every invoice Bring holds, oldest first, on its own
     * schedule; scoping it to whatever fortnight is on screen would report
     * "0 found" during a backfill that is running perfectly.
     *
     * It sits on this endpoint rather than one of its own because it belongs
     * beside the figure it will eventually replace. Until it existed, a reader
     * that had failed on every one of 27 invoices looked exactly like one that
     * had never been switched on.
     */
    const runs = await db.bringReportRun.groupBy({ by: ['state'], _count: { _all: true } })
    const count = (state: string) => runs.find((r) => r.state === state)?._count._all ?? 0
    // The row that failed MOST RECENTLY, which is the one worth reporting.
    // Ordered by nextTryAt because every failure stamps one at the moment it
    // happens, so it is the only field that dates a failure.
    const lastFailure = await db.bringReportRun.findFirst({
      where: { state: 'FAILED', error: { not: null } },
      // `nulls: 'last'` is load-bearing, not tidiness: Postgres defaults a DESC
      // order to NULLS FIRST, so a FAILED row without a nextTryAt would beat
      // every dated one and pin an error nobody can date to the top of the
      // panel permanently. Reproduced as a test before this line existed.
      orderBy: { nextTryAt: { sort: 'desc', nulls: 'last' } },
      select: { error: true },
    })

    return NextResponse.json(
      {
        bringInvoices: {
          found: runs.reduce((t, r) => t + r._count._all, 0),
          read: count('STORED'),
          // PENDING and REQUESTED are one idea to a reader: asked for, not here
          // yet. The difference between them matters to the job, not to anyone
          // looking at this panel.
          waiting: count('PENDING') + count('REQUESTED'),
          // Bring itself says these can never be broken down. Counted apart
          // from failures so a permanent, blameless fact does not read as a
          // fault that someone should chase.
          noDetail: count('NO_SPEC'),
          failed: count('FAILED'),
          lastError: lastFailure?.error ?? null,
        },
        carriers: carrierAverages(
          perMonth,
          costs.map((c) => ({
            carrier: c.carrier,
            month: c.month,
            amount: c.amount,
            currency: c.currency,
          })),
        ),
        // One row per carrier per month, which is what the invoice covers and
        // therefore what the form asks for.
        months: perMonth
          .sort((a, b) => a.carrier.localeCompare(b.carrier) || b.month.localeCompare(a.month))
          .map((s) => ({
            carrier: s.carrier,
            month: s.month,
            parcels: s.count,
            amount: byKey.get(`${s.carrier}|${s.month}`)?.amount ?? null,
            currency: byKey.get(`${s.carrier}|${s.month}`)?.currency ?? null,
          })),
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
    // figure — "they billed us nothing" — and must stay sayable.
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
      create: { carrier, month, amount, currency },
      update: { amount, currency },
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
