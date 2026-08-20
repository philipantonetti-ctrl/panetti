/**
 * What a parcel costs to send, per carrier.
 *
 * NOT from the carrier APIs. `api.bring.com/tracking` and
 * `api-eu.dhl.com/track/shipments` return where a parcel is, never what it
 * cost, and neither our Bring nor our DHL key reaches a rating endpoint. The
 * carriers' rate APIs would answer with a QUOTE computed from weight,
 * dimensions and service — none of which we store — and a quote drifts from
 * the invoice on every fuel surcharge, volumetric rounding and remote-area fee.
 *
 * So the money comes from the invoice, which is the only figure that is
 * actually true, and the count comes from the shipments we already hold.
 *
 * The one rule everything here follows: THE MONEY AND THE PARCELS MUST DESCRIBE
 * THE SAME MONTHS. A month whose invoice has not been entered is dropped from
 * both sides and named, never counted on one side only — 400 parcels divided by
 * an invoice covering 300 of them reads as a saving nobody made.
 */

/** Parcels a carrier moved in one calendar month. */
export type CarrierShipments = {
  carrier: string
  /** 'YYYY-MM'. */
  month: string
  count: number
}

/** One carrier invoice, for one calendar month. */
export type CarrierCostRow = {
  carrier: string
  /** 'YYYY-MM'. */
  month: string
  /** Minor units of `currency`. */
  amount: number
  currency: string
}

export type CarrierAverage = {
  carrier: string
  /** Parcels in the months that ALSO have an invoice — the divisor. */
  shipments: number
  /**
   * Every parcel in the range, invoiced or not. Reported separately because it
   * is a fact we hold: a page that showed nothing at all when the money is
   * missing would look like we had not counted either.
   */
  parcelsInRange: number
  /** Minor units, or null when nothing could be totalled. */
  cost: number | null
  currency: string | null
  /** Minor units per parcel, or null when it cannot be said. */
  averageMinor: number | null
  /** Months included in both figures. */
  monthsCounted: string[]
  /** Months with parcels but no invoice, so the reader can see the gap. */
  monthsMissingCost: string[]
  /** True when one carrier's invoices are not all in one currency. */
  mixedCurrency: boolean
}

/**
 * Per carrier, for whatever months were handed in.
 *
 * Ordered by carrier name so the panel keeps its rows in one place between
 * loads rather than reshuffling as counts change.
 */
export function carrierAverages(
  shipments: CarrierShipments[],
  costs: CarrierCostRow[],
): CarrierAverage[] {
  const carriers = [...new Set([...shipments, ...costs].map((r) => r.carrier))].sort()

  return carriers.map((carrier) => {
    const mine = shipments.filter((s) => s.carrier === carrier)
    const invoices = new Map(
      costs.filter((c) => c.carrier === carrier).map((c) => [c.month, c] as const),
    )

    const counted = mine.filter((s) => invoices.has(s.month)).sort((a, b) => a.month.localeCompare(b.month))
    const missing = mine.filter((s) => !invoices.has(s.month)).map((s) => s.month).sort()

    const parcelsInRange = mine.reduce((n, s) => n + s.count, 0)
    const shipmentCount = counted.reduce((n, s) => n + s.count, 0)

    const used = counted.map((s) => invoices.get(s.month)!)
    const currencies = [...new Set(used.map((c) => c.currency))]
    const mixedCurrency = currencies.length > 1

    // Adding NOK to EUR would need a rate this page never showed, so it
    // refuses instead — the same rule every other figure here follows.
    const cost = used.length > 0 && !mixedCurrency ? used.reduce((n, c) => n + c.amount, 0) : null

    return {
      carrier,
      shipments: shipmentCount,
      parcelsInRange,
      cost,
      currency: mixedCurrency ? null : (currencies[0] ?? null),
      // Rounded to the minor unit: a fraction of an øre is not a price, and
      // the figure is read beside real invoice totals.
      averageMinor: cost !== null && shipmentCount > 0 ? Math.round(cost / shipmentCount) : null,
      monthsCounted: counted.map((s) => s.month),
      monthsMissingCost: missing,
      mixedCurrency,
    }
  })
}
