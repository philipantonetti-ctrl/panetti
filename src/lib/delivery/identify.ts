import { db } from '../db'
import { matchByEmail } from '../bring/match'
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

export type IdentifyRow = { id: string; trackingNumber: string; orderId: string | null; createdAt: Date }

/**
 * A carrier answered. Write what it said, and try to attach the order.
 *
 * The link is attempted only for a row that has none: a row a person
 * attached, or an earlier night did, keeps its order whatever the carrier
 * now says about the email. Events are written the way the poller writes
 * them, so the next poll is an ordinary poll of a known parcel.
 */
export async function applyIdentification(
  row: IdentifyRow,
  facts: CarrierFacts,
  now: Date,
): Promise<{ linked: boolean }> {
  const m = facts.package?.milestones
  const base = {
    carrier: facts.carrier,
    consignmentId: facts.consignmentId,
    destinationCountry: facts.destinationCountry,
    weightKg: facts.weightKg,
    recipientEmail: facts.recipientEmail,
    recipientName: facts.recipientName,
    identifiedAt: now,
    lastError: null,
    ...(m
      ? {
          bookedAt: m.bookedAt, handedInAt: m.handedInAt, availableAt: m.availableAt,
          collectedAt: m.collectedAt, outcome: m.outcome, lastStatus: m.lastStatus,
        }
      : {}),
    // Due now: the poller's ordinary tiers take over from the next run.
    nextPollAt: now,
  }

  let link: { orderId: string; linkSource: string } | null = null
  let unlinkedReason: string | null = null

  if (row.orderId === null) {
    if (facts.carrier === 'BRING') {
      const outcome = await matchByEmail(facts.recipientEmail, now, {
        bookedAt: m?.bookedAt ?? null,
        consignmentId: facts.consignmentId,
      })
      if (outcome.orderId !== null) link = { orderId: outcome.orderId, linkSource: 'BRING_EMAIL' }
      else unlinkedReason = outcome.reason
    } else {
      // DHL Freight: the export path stored the 10-digit number with its
      // order; this piece is the same physical shipment. findMany, not
      // findFirst: a consignment can carry more than one such reference, and
      // when those references belong to two DIFFERENT orders there is no
      // way to choose between them by machine - findFirst was picking
      // whichever row the database happened to return first.
      const known = facts.references.length
        ? await db.shipment.findMany({
            where: { trackingNumber: { in: facts.references }, orderId: { not: null } },
            select: { orderId: true },
          })
        : []
      const orderIds = [...new Set(known.map((k) => k.orderId).filter((id): id is string => id !== null))]
      if (orderIds.length === 1) {
        link = { orderId: orderIds[0], linkSource: 'DHL_REF' }
      } else if (orderIds.length > 1) {
        unlinkedReason = `DHL parcel to ${facts.destinationCountry ?? 'an unknown country'}: its consignment numbers belong to ${orderIds.length} different orders, so a person must choose`
      } else {
        unlinkedReason = `DHL parcel to ${facts.destinationCountry ?? 'an unknown country'}: DHL gives no name or email, so no order could be matched by itself`
      }
    }
  }

  await db.$transaction(async (tx) => {
    if (facts.package) {
      await tx.shipmentEvent.createMany({
        data: facts.package.events.map((e) => ({
          shipmentId: row.id, status: e.status, occurredAt: e.occurredAt,
          description: e.description, location: e.location,
        })),
        skipDuplicates: true,
      })
    }
    await tx.shipment.update({
      where: { id: row.id },
      data: {
        ...base,
        ...(link ? { ...link, unlinkedReason: null } : {}),
        ...(row.orderId === null && !link ? { unlinkedReason } : {}),
      },
    })
  })

  return { linked: link !== null }
}

/** Neither carrier knows the number. Ask again tomorrow, or give up after the grace period. */
export async function applyUnknown(row: IdentifyRow, now: Date): Promise<void> {
  const next = unknownNext(row.createdAt, now)
  await db.shipment.update({
    where: { id: row.id },
    data: {
      terminal: next.terminal,
      nextPollAt: next.nextPollAt,
      lastError: next.lastError,
      ...(next.unlinkedReason ? { unlinkedReason: next.unlinkedReason } : {}),
    },
  })
}

/**
 * A refused Bring row, matched again under today's rules. The twin order may
 * have received its own parcel since, which is what resolves the common case.
 */
export async function rematchByEmail(
  row: { id: string; recipientEmail: string | null; bookedAt: Date | null; consignmentId: string | null },
  now: Date,
): Promise<{ linked: boolean }> {
  const outcome = await matchByEmail(row.recipientEmail, now, {
    bookedAt: row.bookedAt,
    consignmentId: row.consignmentId,
  })
  if (outcome.orderId !== null) {
    await db.shipment.update({
      where: { id: row.id },
      data: { orderId: outcome.orderId, linkSource: 'BRING_EMAIL', unlinkedReason: null },
    })
    return { linked: true }
  }
  await db.shipment.update({ where: { id: row.id }, data: { unlinkedReason: outcome.reason } })
  return { linked: false }
}
