import { pdfToText } from './pdf'
import { xlsxToText } from './xlsx'

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
 * digits, and carries no punctuation - which excludes the dates, prices and
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
 * about column order, headings and order-number format - the things most
 * likely to change - and leaves only the one assumption that cannot: that the
 * two numbers appear near each other.
 *
 * A row that matches nothing is simply ABSENT from the result - there is no
 * "unmatched" entry for it, because a row we could not read leaves nothing to
 * describe. That is why `countParcelNumbers` exists: it is the only way the
 * caller can tell a file we read completely from one we half-understood.
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
      // than guessed at - a missing pair shows up in the unmatched count, a
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
 * How many DISTINCT parcel-shaped numbers the document contains, including the
 * ones `extractPairs` refuses to pair.
 *
 * This is what makes a shortfall visible. `extractPairs` returns only its
 * successes, so a file whose layout we half-understood reads as a complete
 * success while most of its parcels are silently dropped - and each dropped
 * parcel leaves its order looking never-shipped, which eventually fires a Slack
 * alert about a parcel that shipped perfectly normally.
 *
 * Distinct VALUES, not occurrences: the same number printed twice is one
 * parcel, and counting occurrences would inflate the total against which the
 * matched count is compared.
 */
export function countParcelNumbers(text: string, knownOrderNumbers: Set<string>): number {
  const seen = new Set<string>()
  for (const t of text.split(/\s+/).filter(Boolean)) {
    if (!knownOrderNumbers.has(t) && looksLikeTracking(t)) seen.add(t)
  }
  return seen.size
}

export type ParseResult = {
  rows: ParsedRow[]
  /** Distinct parcel-shaped numbers in the document - see countParcelNumbers. */
  seen: number
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
): Promise<ParseResult> {
  const ext = filename.toLowerCase().split('.').pop() ?? ''

  const read = (text: string): ParseResult => ({
    rows: extractPairs(text, knownOrderNumbers),
    seen: countParcelNumbers(text, knownOrderNumbers),
  })

  if (ext === 'pdf') return read(await pdfToText(buf))
  if (ext === 'csv' || ext === 'txt') {
    // The same extractor: commas and semicolons become token boundaries, and
    // everything the PDF path learned about noise applies unchanged.
    return read(buf.toString('utf8').replace(/[;,]/g, ' '))
  }

  throw new Error('Only PDF and CSV files can be read. This one is a .' + ext)
}

/**
 * The fewest digits a parcel or shipment number can have.
 *
 * KolliID is 18 and Sändningsref is 17, so both clear it. The floor is set here
 * rather than lower because of one specific near miss: `Datum` reads
 * "2026-08-11 08:19:24", which is 14 digits once punctuation goes. Fourteen is
 * one below fifteen on purpose.
 *
 * `looksLikeTracking` above is deliberately NOT reused. It accepts 8-plus
 * digits, which is right for a PDF full of prose and wrong here, where it would
 * take that timestamp on every row of every file.
 */
const MIN_DIGITS = 15

/**
 * Every distinct long number in a document, in the order first seen.
 *
 * This is the whole of what we read from the warehouse's report. Not the order
 * number, which is theirs and not ours; not the columns, which they may
 * reorder; not the headings, which they may rename. Bring will tell us
 * everything else, and it cannot be talked into telling us the wrong thing.
 *
 * Both a package number and a shipment reference are valid lookups, so there is
 * no need to know which column a number came from.
 */
export function extractLongNumbers(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const token of text.split(/\s+/)) {
    if (!token) continue
    const digits = token.replace(/\D/g, '')
    if (digits.length < MIN_DIGITS) continue
    if (seen.has(digits)) continue
    seen.add(digits)
    out.push(digits)
  }
  return out
}

/**
 * Read whatever the warehouse sent and return the numbers in it.
 *
 * xlsx is what they send today. The others cost nothing to keep and mean a
 * change of format on their side is not an outage on ours.
 */
export async function parseTrackingNumbers(buf: Buffer, filename: string): Promise<string[]> {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (ext === 'xlsx') return extractLongNumbers(xlsxToText(buf))
  if (ext === 'pdf') return extractLongNumbers(await pdfToText(buf))
  if (ext === 'csv' || ext === 'txt')
    return extractLongNumbers(buf.toString('utf8').replace(/[;,]/g, ' '))
  throw new Error('Only Excel, PDF and CSV files can be read. This one is a .' + ext)
}
