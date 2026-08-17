import { describe, expect, it } from 'vitest'
import { mapShipments } from './map'
import real from './__fixtures__/real-shipment.json'

/** One DHL event, in DHL's own shape. */
const event = (over: Record<string, unknown> = {}) => ({
  timestamp: '2026-08-17T12:19:54',
  location: { address: { addressLocality: 'Oslo, NO' } },
  statusCode: 'pre-transit',
  status: 'ACT-2',
  description: 'Consignment created',
  ...over,
})

const body = (events: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
  shipments: [{ id: '9599861672', service: 'freight', events, ...over }],
})

describe('mapShipments', () => {
  /**
   * The recording wins over the documentation. This is a real response from
   * api-eu.dhl.com, captured 2026-08-17 with the client's own key and scrubbed
   * of addresses — so these selectors are proven, not assumed.
   */
  it('maps the recorded real response', () => {
    const [parcel] = mapShipments(real)

    expect(parcel.trackingNumber).toBe('9599861672')
    expect(parcel.events).toHaveLength(1)
    expect(parcel.events[0]).toMatchObject({
      status: 'PRE_NOTIFIED',
      description: 'Consignment created',
      location: 'Oslo, NO',
    })
    expect(parcel.milestones.bookedAt).not.toBeNull()
    expect(parcel.milestones.availableAt).toBeNull()
    expect(parcel.milestones.outcome).toBeNull()
  })

  /**
   * DHL sends "2026-08-17T12:19:54" with no zone at all. Handed to `new Date()`
   * as-is that is parsed as LOCAL time, so the same parcel would sit at 12:19 on
   * Vercel and 04:19 on a machine in Manila — a delivery median that changes
   * with the reader's laptop. Read as UTC it is the same everywhere, and it is
   * exactly right in production, where the server clock is UTC.
   */
  it('reads a zoneless timestamp as UTC, not as the reader’s local time', () => {
    const [parcel] = mapShipments(body([event()]))
    expect(parcel.events[0].occurredAt.toISOString()).toBe('2026-08-17T12:19:54.000Z')
  })

  it('does not double-stamp a timestamp that already carries a zone', () => {
    const [parcel] = mapShipments(body([event({ timestamp: '2026-08-17T12:19:54Z' })]))
    expect(parcel.events[0].occurredAt.toISOString()).toBe('2026-08-17T12:19:54.000Z')
  })

  /**
   * DHL's statusCode enum into the vocabulary delivery/milestones.ts judges. A
   * carrier that keeps its own words would make the delivery median mean one
   * thing for Bring parcels and another for DHL ones.
   */
  it('translates DHL’s vocabulary into ours', () => {
    const codes = ['pre-transit', 'transit', 'delivered'] as const
    const got = codes.map(
      (statusCode) => mapShipments(body([event({ statusCode })]))[0].events[0].status,
    )
    expect(got).toEqual(['PRE_NOTIFIED', 'HANDED_IN', 'DELIVERED'])
  })

  it('marks a delivered parcel available and delivered', () => {
    const [parcel] = mapShipments(
      body([
        event({ statusCode: 'pre-transit', timestamp: '2026-08-10T09:00:00' }),
        event({ statusCode: 'delivered', timestamp: '2026-08-14T15:30:00' }),
      ]),
    )
    expect(parcel.milestones.availableAt?.toISOString()).toBe('2026-08-14T15:30:00.000Z')
    expect(parcel.milestones.outcome).toBe('DELIVERED')
    expect(parcel.milestones.lastStatus).toBe('DELIVERED')
  })

  /**
   * A failed delivery attempt is not a return and not a delivery. It is
   * recorded so it can be seen, and moves no milestone — claiming either would
   * be inventing an outcome we were not told.
   */
  it('records a failure without calling it delivered or returned', () => {
    const [parcel] = mapShipments(body([event({ statusCode: 'failure' })]))
    expect(parcel.events[0].status).toBe('FAILURE')
    expect(parcel.milestones.outcome).toBeNull()
    expect(parcel.milestones.availableAt).toBeNull()
  })

  it('drops an event with an unusable timestamp rather than storing a wrong one', () => {
    const [parcel] = mapShipments(body([event({ timestamp: 'not a date' }), event()]))
    expect(parcel.events).toHaveLength(1)
  })

  it('keeps a parcel whose events are missing entirely', () => {
    const [parcel] = mapShipments({ shipments: [{ id: '123' }] })
    expect(parcel.trackingNumber).toBe('123')
    expect(parcel.events).toEqual([])
  })

  it('skips a shipment with no tracking number to key it by', () => {
    expect(mapShipments({ shipments: [{ service: 'freight' }] })).toEqual([])
  })

  it('survives a reply that is not the shape we expect', () => {
    expect(mapShipments(null)).toEqual([])
    expect(mapShipments({})).toEqual([])
    expect(mapShipments({ shipments: 'nope' })).toEqual([])
  })

  /**
   * KNOWN GAP, deliberately unmapped. `returnFlag` sits on the shipment and is
   * false in the only real response we hold, so what a true one looks like — and
   * whether the return also arrives as an event — is undetermined. Guessing
   * would risk marking a live parcel returned, which nulls its availableAt and
   * removes it from the late list. Unskip when a returned DHL parcel has been
   * recorded.
   */
  it.skip('treats a return as returned', () => {
    const [parcel] = mapShipments(body([event({ statusCode: 'transit' })], { returnFlag: true }))
    expect(parcel.milestones.outcome).toBe('RETURNED')
  })
})
