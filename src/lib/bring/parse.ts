import { pdfToText } from './pdf'

export type ParsedRow = { orderNumber: string; trackingNumber: string }

/**
 * How many tokens apart an order number and its tracking number may sit and
 * still be considered the same row. Generous enough to step over a date, a
 * city and a price; tight enough that the next row's number is out of reach.
 */
const MAX_TOKEN_DISTANCE = 12

/**
 * Does this token look like a carrier's parcel number?
 *
 * Deliberately loose on format and strict on shape. We do not know every
 * product Bring will ever use, but we do know a parcel number is long, mostly
 * digits, and carries no punctuation — which excludes the dates, prices and
 * postcodes that share a document with it.
 */
export function looksLikeTracking(token: string): boolean {
  if (!/^[A-Z0-9]{8,}$/i.test(token)) return false
  const digits = (token.match(/\d/g) ?? []).length
  return digits >= 8
}

/**
 * Find the order-number/tracking-number pairs in a document's text.
 *
 * The layout is the warehouse's and may change without warning, so this does
 * NOT parse a table. It looks for the order numbers WE ALREADY HOLD, then takes
 * the nearest tracking-shaped token to each. That removes every assumption
 * about column order, headings and order-number format — the things most
 * likely to change — and leaves only the one assumption that cannot: that the
 * two numbers appear near each other.
 *
 * A row that matches nothing is simply absent from the result. The caller
 * reports the shortfall; nothing is invented to fill it.
 */
export function extractPairs(text: string, knownOrderNumbers: Set<string>): ParsedRow[] {
  const tokens = text.split(/\s+/).filter(Boolean)

  const tokenCounts = new Map<string, number>()
  tokens.forEach((t) => tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1))

  const orderIndices: number[] = []
  const trackingIndices: number[] = []
  tokens.forEach((t, i) => {
    if (knownOrderNumbers.has(t)) {
      orderIndices.push(i)
    } else if (looksLikeTracking(t)) {
      // An order number we hold is never also a tracking number, whatever its shape.
      //
      // A parcel number is unique to one shipment; boilerplate (a support
      // line, a phone number) repeats. A tracking-shaped token seen more than
      // once in the document is therefore ambiguous, so it is refused rather
      // than guessed at — a missing pair shows up in the unmatched count, a
      // wrong pair silently poisons an order's delivery figure.
      if ((tokenCounts.get(t) ?? 0) > 1) return
      trackingIndices.push(i)
    }
  })

  // Every order/tracking token within reach of each other is a candidate pair.
  // Matching them nearest-distance-first (rather than scanning order numbers
  // left to right and grabbing whatever is closest at that moment) is what
  // stops a distant-but-earlier order number from stealing the tracking token
  // that actually belongs to a closer-but-later one.
  type Candidate = { orderIndex: number; trackingIndex: number; distance: number }
  const candidates: Candidate[] = []
  for (const orderIndex of orderIndices) {
    for (const trackingIndex of trackingIndices) {
      const distance = Math.abs(trackingIndex - orderIndex)
      if (distance <= MAX_TOKEN_DISTANCE) candidates.push({ orderIndex, trackingIndex, distance })
    }
  }
  candidates.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.trackingIndex - b.trackingIndex ||
      a.orderIndex - b.orderIndex,
  )

  const claimedOrders = new Set<number>()
  const claimedTracking = new Set<number>()
  const matches: { orderIndex: number; row: ParsedRow }[] = []

  for (const c of candidates) {
    if (claimedOrders.has(c.orderIndex) || claimedTracking.has(c.trackingIndex)) continue
    // One parcel belongs to one order, and one order gets one parcel. Claiming
    // both stops a second, farther candidate from reusing either token.
    claimedOrders.add(c.orderIndex)
    claimedTracking.add(c.trackingIndex)
    matches.push({
      orderIndex: c.orderIndex,
      row: { orderNumber: tokens[c.orderIndex], trackingNumber: tokens[c.trackingIndex] },
    })
  }

  // Report rows in the order the order numbers appeared in the document, not
  // in the order the greedy match happened to resolve them.
  matches.sort((a, b) => a.orderIndex - b.orderIndex)
  return matches.map((m) => m.row)
}

/**
 * Read whatever the warehouse sent. PDF is what they send today; CSV is
 * accepted too, because it costs nothing here and is far more robust if they
 * ever agree to switch.
 */
export async function parseTrackingFile(
  buf: Buffer,
  filename: string,
  knownOrderNumbers: Set<string>,
): Promise<ParsedRow[]> {
  const ext = filename.toLowerCase().split('.').pop() ?? ''

  if (ext === 'pdf') return extractPairs(await pdfToText(buf), knownOrderNumbers)
  if (ext === 'csv' || ext === 'txt') {
    // The same extractor: commas and semicolons become token boundaries, and
    // everything the PDF path learned about noise applies unchanged.
    return extractPairs(buf.toString('utf8').replace(/[;,]/g, ' '), knownOrderNumbers)
  }

  throw new Error('Only PDF and CSV files can be read. This one is a .' + ext)
}
