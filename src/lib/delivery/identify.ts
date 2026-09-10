import { mapConsignments } from '../bring/map'
import { mapShipments } from '../dhl/map'
import { str, type MappedPackage } from './milestones'

/**
 * Who has a parcel, and what they said about it.
 *
 * The warehouse prints one label series for every carrier it ships with, so
 * a number from its file says who packed the parcel, not who carries it. On
 * 2026-09-10, 17 of 17 "Bring" numbers Bring had never heard of were DHL's.
 * So an unlinked number is asked of Bring, then DHL, and the first to answer
 * owns the row. This file turns each carrier's raw answer into the same
 * facts; the database side (applyIdentification, applyUnknown) lives below.
 */

export type CarrierFacts = {
  carrier: 'BRING' | 'DHL'
  consignmentId: string | null
  destinationCountry: string | null
  weightKg: number | null
  recipientEmail: string | null
  recipientName: string | null
  /** DHL Freight's 10-digit consignment numbers; [] for Bring and for DHL eCommerce. */
  references: string[]
  /** Events and milestones for the tracking number asked about. */
  package: MappedPackage | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Bring's answer for one number: the consignment it belongs to, or null. */
export function bringFacts(raw: unknown[], trackingNumber: string): CarrierFacts | null {
  const first = raw[0] as
    | { consignmentId?: unknown; recipientName?: unknown; packageSet?: unknown }
    | undefined
  const consignmentId = str(first?.consignmentId)
  const packages = Array.isArray(first?.packageSet) ? first.packageSet : []
  if (!consignmentId || packages.length === 0) return null

  let recipientEmail: string | null = null
  let destinationCountry: string | null = null
  let weightKg: number | null = null
  for (const pkg of packages) {
    const p = pkg as {
      packageNumber?: unknown
      recipientEmailAddress?: unknown
      weightInKgs?: unknown
      recipientAddress?: { countryCode?: unknown }
    }
    if (!recipientEmail) recipientEmail = str(p?.recipientEmailAddress)?.toLowerCase() ?? null
    if (!destinationCountry) destinationCountry = str(p?.recipientAddress?.countryCode)?.toUpperCase() ?? null
    // The weight of THIS package when it is the one asked about; else the first.
    if (str(p?.packageNumber) === trackingNumber || weightKg === null) {
      const w = num(p?.weightInKgs)
      if (w !== null) weightKg = w
    }
  }

  const mapped = mapConsignments(raw)
  const pkg = mapped.find((m) => m.trackingNumber === trackingNumber) ?? mapped[0] ?? null

  return {
    carrier: 'BRING',
    consignmentId,
    destinationCountry,
    weightKg,
    recipientEmail,
    recipientName: str(first?.recipientName),
    references: [],
    package: pkg,
  }
}

/** DHL's answer for one number: the first shipment, or null. */
export function dhlFacts(raw: unknown, trackingNumber: string): CarrierFacts | null {
  const shipments = (raw as { shipments?: unknown })?.shipments
  if (!Array.isArray(shipments) || shipments.length === 0) return null
  const s = shipments[0] as {
    id?: unknown
    destination?: { address?: { countryCode?: unknown } }
    details?: {
      weight?: { value?: unknown }
      references?: { number?: unknown; type?: unknown }[]
    }
  }
  const refs = Array.isArray(s.details?.references) ? s.details.references : []
  const references = refs
    .filter((r) => str(r?.type) === 'domestic-consignment-id')
    .map((r) => str(r?.number))
    .filter((n): n is string => n !== null)

  // mapShipments names the package by DHL's shipment id ("JKG-HI-0001643",
  // "00473325380023179098"), which is not the number on our row. The events
  // are the row's regardless; the name is put back so callers never compare
  // it and wonder.
  const mapped = mapShipments(raw)[0] ?? null
  const pkg = mapped ? { ...mapped, trackingNumber } : null

  return {
    carrier: 'DHL',
    consignmentId: str(s?.id),
    destinationCountry: str(s?.destination?.address?.countryCode)?.toUpperCase() ?? null,
    weightKg: num(s?.details?.weight?.value),
    recipientEmail: null,
    recipientName: null,
    references,
    package: pkg,
  }
}

/** How long a number nobody knows is asked about before it is given up on. */
export const UNKNOWN_GRACE_DAYS = 14

const DAY = 24 * 60 * 60 * 1000

/**
 * What happens to a row neither carrier knows.
 *
 * Asked again tomorrow, not in six hours: a label whose parcel has not been
 * handed to any carrier will not appear within the hour, and the DHL half of
 * the question is metered. After the grace period the row stops asking and
 * says why, but stays listed - a person can still link or dismiss it.
 */
export function unknownNext(
  createdAt: Date,
  now: Date,
): { terminal: boolean; nextPollAt: Date | null; lastError: string; unlinkedReason: string | null } {
  const lastError = 'Neither Bring nor DHL knows this number'
  if (now.getTime() - createdAt.getTime() > UNKNOWN_GRACE_DAYS * DAY) {
    return { terminal: true, nextPollAt: null, lastError, unlinkedReason: `No carrier knew this number in ${UNKNOWN_GRACE_DAYS} days` }
  }
  return { terminal: false, nextPollAt: new Date(now.getTime() + DAY), lastError, unlinkedReason: null }
}
