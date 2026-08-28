/**
 * How this system works out its figures, in the assistant's own words.
 *
 * The client asked to be able to ask "how did you calculate that?" anywhere in
 * the product. A model answering that from its own idea of how e-commerce
 * accounting usually works would be inventing our method, which is a subtler
 * and worse failure than inventing a number: it sounds right and cannot be
 * checked. So the METHOD is stated here, once, from the engine's own
 * documentation, and every FIGURE still has to come back from a tool.
 *
 * Deliberately free of figures. The two that appear (the 10% commission rate
 * and the 90-day default cover) are fixed rules of the system rather than
 * measurements, and methodology.test.ts pins that list so a stray number
 * cannot be cached into every request unnoticed.
 */
export const METHODOLOGY = `HOW THIS SYSTEM CALCULATES, so you can explain any figure on any page.
State the method from here; get every NUMBER from a tool.

Profit, per shop, for a date range:
  gross sales (line value before discount, excluding VAT)
  minus discounts = NET SALES, which is what an ambassador's commission is a
    percentage of (10% unless that ambassador is set otherwise)
  plus shipping charged = NET REVENUE
  minus COGS (each line's quantity times the product's cost plus handling, at
    the cost in force ON THE ORDER'S OWN DATE, not today's cost)
  minus fulfilment (the order's own shipping cost if one was entered, else the
    per-SKU shipping rates, else the shop's flat per-order rate for that date)
  minus payment gateway fees (a percentage of what the customer paid, plus a
    fixed amount; invoiced B2B orders pay none)
  minus advertising spend attributed to that shop
  minus affiliate commission and its brokerage fee
  minus operational expenses, spread evenly across the days of the period
  minus ambassador commission
  = NET PROFIT.
VAT is never revenue. Refunded and cancelled orders count for nothing at all.
Every shop keeps its own currency; totals are converted at each order's own
date's exchange rate, never at today's.

The inventory forecast:
  Stock comes from Visma where Visma holds the SKU, otherwise from the shops,
  which are mirrors of one warehouse and are made to agree rather than summed.
  The daily sales rate is measured over the last 60 days across every shop, with
  the season taken out of it, then projected forward against last year's shape
  for each future date. Stock is then walked forward DAY BY DAY, never
  divided: purchase orders with an arrival date lift the line back up on the day
  they land, and demand itself rises and falls with the season, neither of which
  a division can express. The run-out date reported is the one no booked arrival
  rescues. An order is placed so it arrives by then, counting production and
  shipping time backwards, and the quantity is the deepest shortfall across the
  cover window (the supplier's own cover days, otherwise 90), then raised to the
  supplier's minimum if lower, then rounded up to whole containers.
  A purchase order with no arrival date moves nothing, because counting stock
  whose arrival nobody knows would fake coverage.

Delivery:
  The clock starts when the order is placed and stops when the parcel is with
  the customer or waiting at their pickup point. Late means past the promise in
  force for that shop and destination country on the day of the order, counting
  business days. A shop that is not tracked, or an order placed before tracking
  began, is not judged at all rather than counted as on time.

When a figure is missing, the tools say so and so must you. Say what is not
known instead of filling the gap.`
