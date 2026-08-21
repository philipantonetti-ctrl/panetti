const DAY = 86_400_000

/** How long one order should last once it lands, when nobody has said. */
export const DEFAULT_COVER_DAYS = 90

/** Nobody plans a kitchen appliance more than a year out. */
export const HORIZON_DAYS = 365

export type Arrival = {
  /** Null = on order with no expected date. Deliberately not counted. */
  eta: Date | null
  quantity: number
}

export type ForecastInput = {
  /** Null = no shop reported a figure. NOT zero. */
  stock: number | null
  /**
   * The daily rate with the season taken OUT of it — `seasonalLevel`, not
   * `dailyBurn`. It is multiplied by `index` below, so handing it a rate that
   * still carries its own season would apply the season twice.
   */
  level: number
  index: (day: Date) => number
  arrivals: Arrival[]
  productionDays: number | null
  deliveryDays: number | null
  moq: number | null
  unitsPerContainer: number | null
  coverDays: number | null
}

export type Forecast = {
  /**
   * The day stock finally STAYS gone: the stockout no booked arrival heals.
   * A stockout an arrival rescues is a `gap`, not a run-out - MACBE661 stood
   * empty with 41 chairs on order and the first-stockout reading of this
   * field told the client "order 10 now, 105 days late".
   */
  runsOutOn: Date | null
  /**
   * An out-of-stock window a booked arrival heals: empty from `from`,
   * covered again on `until`. Null when stock holds until the terminal
   * run-out. Only the first such window is named; one is enough to act on.
   */
  gap: { from: Date; until: Date } | null
  /**
   * Units on order whose date has passed with nothing received. In limbo on
   * purpose: counting them as stock on a guessed day fakes coverage (one
   * open order is two years past its date), dropping them silently loses
   * real goods. Reported, and a person decides.
   */
  overdueArrivals: { quantity: number; since: Date } | null
  orderBy: Date | null
  /** Days the order-by date is already in the past. Null when it is not. */
  daysLate: number | null
  quantity: number | null
  /**
   * What demand alone called for, before the supplier's minimum and container
   * rounding. Equal to `quantity` when neither of those moved it.
   *
   * Carried so a reorder tip can show its working: "order 500" on its own is a
   * number nobody can sanity-check, and the client asked for suggestions he can
   * weigh against the minimum rather than obey.
   */
  needed: number | null
  /** Which rule lifted the order above `needed`. Null when demand set it. */
  raisedBy: 'minimum' | 'container' | null
  /** Units on order that carry no ETA, so they moved nothing. */
  onOrderWithoutEta: number
  /** Why a figure is missing. Null when everything computed. */
  note: string | null
}

const startOfDay = (d: Date) => new Date(Math.floor(d.getTime() / DAY) * DAY)

/**
 * When this product runs out, when to order, and how many.
 *
 * The run-out date is walked day by day rather than divided, because stock does
 * not fall in a straight line: a container landing on a date lifts it back up,
 * and demand itself is seasonal. Dividing stock by a rate cannot express either.
 *
 * Every missing answer says WHY. A blank cell on a page like this is read as
 * "nothing to worry about", which is the one thing it must never mean.
 */
export function forecast(input: ForecastInput, today: Date): Forecast {
  const from = startOfDay(today)

  const onOrderWithoutEta = input.arrivals
    .filter((a) => a.eta === null)
    .reduce((n, a) => n + a.quantity, 0)

  // Overdue before anything else, so even a blank row can say it.
  const overdue = input.arrivals.filter(
    (a) => a.eta !== null && startOfDay(a.eta).getTime() < from.getTime() && a.quantity > 0,
  )
  const overdueArrivals =
    overdue.length === 0
      ? null
      : {
          quantity: overdue.reduce((n, a) => n + a.quantity, 0),
          since: startOfDay(
            overdue.reduce((d, a) => (a.eta! < d ? a.eta! : d), overdue[0].eta!),
          ),
        }

  const blank = (note: string): Forecast => ({
    runsOutOn: null, gap: null, overdueArrivals, orderBy: null, daysLate: null,
    quantity: null, needed: null, raisedBy: null, onOrderWithoutEta, note,
  })

  if (input.stock === null) return blank('no stock data')
  if (input.level <= 0) return blank('not selling')

  const landing = new Map<number, number>()
  for (const a of input.arrivals) {
    if (!a.eta) continue // no date, no effect — a guessed arrival is worse than none
    const k = startOfDay(a.eta).getTime()
    if (k < from.getTime()) continue // overdue: reported above, never counted
    landing.set(k, (landing.get(k) ?? 0) + a.quantity)
  }

  const demandOn = (d: Date) => input.level * input.index(d)

  // The whole horizon, not to the first empty day: a booked arrival RESCUES a
  // stockout, and stopping early is what read an empty shelf with three
  // containers coming as "order more now". The run-out that should drive an
  // order is the day stock finally stays gone.
  //
  // Stock runs NEGATIVE through a gap on purpose: demand missed while empty
  // stays owed, so the next arrival serves it first. That errs on ordering
  // earlier rather than later, which is the right side for a page whose job
  // is to stop the shelf going empty again.
  let stock = input.stock
  let openSince: Date | null = null
  let gap: { from: Date; until: Date } | null = null
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const d = new Date(from.getTime() + i * DAY)
    stock += landing.get(d.getTime()) ?? 0
    stock -= demandOn(d)
    if (stock <= 0) {
      if (!openSince) openSince = d
    } else if (openSince) {
      // Healed: the shelf was empty from openSince and an arrival refilled
      // it today. Only the first window is kept - one gap is enough to act
      // on, and a row listing three reads as a fault, not a forecast.
      if (!gap) gap = { from: openSince, until: d }
      openSince = null
    }
  }
  const runsOutOn = openSince

  if (!runsOutOn) {
    return { ...blank('no risk within a year'), gap }
  }

  if (input.productionDays === null || input.deliveryDays === null) {
    return {
      runsOutOn, gap, overdueArrivals, orderBy: null, daysLate: null, quantity: null,
      needed: null, raisedBy: null, onOrderWithoutEta, note: 'set lead times',
    }
  }

  const leadDays = input.productionDays + input.deliveryDays
  const orderBy = new Date(runsOutOn.getTime() - leadDays * DAY)
  const late = Math.ceil((from.getTime() - orderBy.getTime()) / DAY)

  // Cover the lead time and then the cover period, counted from when the shelf
  // empties — that is the stretch the new stock has to carry.
  // Net of what is already on the water: the deepest shortfall the window
  // reaches once booked arrivals are counted in. With none it is plain summed
  // demand, as before; with some it stops the suggestion re-ordering goods a
  // supplier has already been paid to send.
  const horizon = leadDays + (input.coverDays ?? DEFAULT_COVER_DAYS)
  let balance = 0
  let shortfall = 0
  for (let i = 0; i < horizon; i++) {
    const d = new Date(runsOutOn.getTime() + i * DAY)
    balance += landing.get(d.getTime()) ?? 0
    balance -= demandOn(d)
    if (balance < shortfall) shortfall = balance
  }
  const needed = Math.ceil(-shortfall)

  // MOQ first, containers second. Doing it the other way round could round a
  // quantity back under the minimum the supplier will accept.
  let quantity = needed
  if (input.moq !== null) quantity = Math.max(quantity, input.moq)
  // Recorded BEFORE the container rounding, because that rounding is what
  // produces the final number and would otherwise take the credit. When a
  // minimum of 500 forces a second 400-unit container, the minimum is what
  // bound the order; the container merely tidied it.
  const raisedByMinimum = quantity > needed
  if (input.unitsPerContainer !== null && input.unitsPerContainer > 0) {
    quantity = Math.ceil(quantity / input.unitsPerContainer) * input.unitsPerContainer
  }

  return {
    runsOutOn,
    gap,
    overdueArrivals,
    orderBy,
    daysLate: late > 0 ? late : null,
    quantity,
    needed,
    raisedBy: raisedByMinimum ? 'minimum' : quantity > needed ? 'container' : null,
    onOrderWithoutEta,
    note: null,
  }
}
