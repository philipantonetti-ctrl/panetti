// src/lib/inventory/forecast.ts

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
  burn: number
  index: (day: Date) => number
  arrivals: Arrival[]
  productionDays: number | null
  deliveryDays: number | null
  moq: number | null
  unitsPerContainer: number | null
  coverDays: number | null
}

export type Forecast = {
  runsOutOn: Date | null
  orderBy: Date | null
  /** Days the order-by date is already in the past. Null when it is not. */
  daysLate: number | null
  quantity: number | null
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
  const onOrderWithoutEta = input.arrivals
    .filter((a) => a.eta === null)
    .reduce((n, a) => n + a.quantity, 0)

  const blank = (note: string): Forecast => ({
    runsOutOn: null, orderBy: null, daysLate: null, quantity: null, onOrderWithoutEta, note,
  })

  if (input.stock === null) return blank('no stock data')
  if (input.burn <= 0) return blank('not selling')

  const from = startOfDay(today)
  const landing = new Map<number, number>()
  for (const a of input.arrivals) {
    if (!a.eta) continue // no date, no effect — a guessed arrival is worse than none
    const k = startOfDay(a.eta).getTime()
    landing.set(k, (landing.get(k) ?? 0) + a.quantity)
  }

  const demandOn = (d: Date) => input.burn * input.index(d)

  let stock = input.stock
  let runsOutOn: Date | null = null
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const d = new Date(from.getTime() + i * DAY)
    stock += landing.get(d.getTime()) ?? 0
    stock -= demandOn(d)
    if (stock <= 0) {
      runsOutOn = d
      break
    }
  }
  if (!runsOutOn) return blank('no risk within a year')

  if (input.productionDays === null || input.deliveryDays === null) {
    return { runsOutOn, orderBy: null, daysLate: null, quantity: null, onOrderWithoutEta, note: 'set lead times' }
  }

  const leadDays = input.productionDays + input.deliveryDays
  const orderBy = new Date(runsOutOn.getTime() - leadDays * DAY)
  const late = Math.ceil((from.getTime() - orderBy.getTime()) / DAY)

  // Cover the lead time and then the cover period, counted from when the shelf
  // empties — that is the stretch the new stock has to carry.
  const horizon = leadDays + (input.coverDays ?? DEFAULT_COVER_DAYS)
  let quantity = 0
  for (let i = 0; i < horizon; i++) {
    quantity += demandOn(new Date(runsOutOn.getTime() + i * DAY))
  }
  quantity = Math.ceil(quantity)

  // MOQ first, containers second. Doing it the other way round could round a
  // quantity back under the minimum the supplier will accept.
  if (input.moq !== null) quantity = Math.max(quantity, input.moq)
  if (input.unitsPerContainer !== null && input.unitsPerContainer > 0) {
    quantity = Math.ceil(quantity / input.unitsPerContainer) * input.unitsPerContainer
  }

  return {
    runsOutOn,
    orderBy,
    daysLate: late > 0 ? late : null,
    quantity,
    onOrderWithoutEta,
    note: null,
  }
}
