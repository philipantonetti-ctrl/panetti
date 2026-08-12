import { fetchTracking, type BringCredentials } from './client'

export type ResolvedConsignment = {
  consignmentId: string
  /** Every package in this consignment. One Shipment row will be written per entry. */
  packageNumbers: string[]
  /** Lower-cased. Null when Bring holds no email for the parcel. */
  recipientEmail: string | null
  recipientName: string | null
}

export type ResolveResult = {
  consignments: ResolvedConsignment[]
  /** Input numbers Bring returned nothing for, or that failed. Reported, never guessed. */
  unresolved: string[]
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null

/**
 * Turn the numbers found in a warehouse file into consignments.
 *
 * ONE NUMBER PER REQUEST. Bring answers about a single `q` however many are
 * sent — measured against the live API on 2026-08-12: ten in returned one
 * consignment, two in returned none, one in returned the right parcel 27 times
 * out of 27. Batching here would look like it worked and silently lose parcels.
 *
 * A file lists both the package number and the shipment reference for the same
 * parcel, and a two-parcel order lists three numbers for one consignment. Since
 * a response names its consignment AND all of its packages, everything it
 * accounted for can be struck off before the next request. Measured by running
 * the committed parser over the real 2026-08-11 file, that is what takes its 61
 * distinct long numbers — 27 seventeen-digit shipment references plus 34
 * eighteen-digit package numbers — down to 27 lookups.
 */
export async function resolveConsignments(
  creds: BringCredentials,
  numbers: string[],
  opts: { deadline?: number } = {},
): Promise<ResolveResult> {
  const consignments: ResolvedConsignment[] = []
  const unresolved: string[] = []
  const accounted = new Set<string>()

  for (const number of numbers) {
    if (accounted.has(number)) continue

    // Checked before the request, not after: starting a lookup we have no time
    // to finish spends the budget for nothing. Same rule as sync.ts:120.
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
      unresolved.push(number)
      continue
    }

    let raw: unknown[]
    try {
      raw = await fetchTracking(creds, [number], { deadline: opts.deadline })
    } catch {
      // One dead lookup must not stop the file. The number is reported so a
      // half-read import is visible rather than silently short.
      unresolved.push(number)
      continue
    }

    const first = raw[0] as
      | { consignmentId?: unknown; recipientName?: unknown; packageSet?: unknown }
      | undefined
    const consignmentId = str(first?.consignmentId)
    const packages = Array.isArray(first?.packageSet) ? first.packageSet : []
    const packageNumbers: string[] = []
    let recipientEmail: string | null = null

    for (const pkg of packages) {
      const p = pkg as { packageNumber?: unknown; recipientEmailAddress?: unknown }
      const n = str(p?.packageNumber)
      if (n) packageNumbers.push(n)
      if (!recipientEmail) {
        const e = str(p?.recipientEmailAddress)
        if (e) recipientEmail = e.toLowerCase()
      }
    }

    if (!consignmentId || packageNumbers.length === 0) {
      unresolved.push(number)
      continue
    }

    accounted.add(number)
    accounted.add(consignmentId)
    for (const n of packageNumbers) accounted.add(n)

    consignments.push({
      consignmentId,
      packageNumbers,
      recipientEmail,
      recipientName: str(first?.recipientName),
    })
  }

  return { consignments, unresolved }
}
