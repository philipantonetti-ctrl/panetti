import { describe, expect, it } from 'vitest'
import { mapConsignments, milestonesFrom, type MappedEvent } from './map'

const ev = (status: string, iso: string): MappedEvent => ({
  status, occurredAt: new Date(iso), description: null, location: null,
})

const consignment = (
  packageNumber: string,
  events: {
    status: string
    dateIso: string
    description?: string
    city?: string
    countryCode?: string
  }[],
) => ({
  packageSet: [{ packageNumber, eventSet: events }],
})

describe('milestonesFrom', () => {
  it('reads a pickup-point parcel: available on READY_FOR_PICKUP, collected later', () => {
    const m = milestonesFrom([
      ev('PRE_NOTIFIED', '2026-08-01T08:00:00Z'),
      ev('HANDED_IN', '2026-08-01T16:00:00Z'),
      ev('IN_TRANSIT', '2026-08-02T06:00:00Z'),
      ev('READY_FOR_PICKUP', '2026-08-03T09:00:00Z'),
      ev('COLLECTED', '2026-08-07T17:00:00Z'),
    ])
    expect(m.bookedAt).toEqual(new Date('2026-08-01T08:00:00Z'))
    expect(m.handedInAt).toEqual(new Date('2026-08-01T16:00:00Z'))
    expect(m.availableAt).toEqual(new Date('2026-08-03T09:00:00Z'))
    expect(m.collectedAt).toEqual(new Date('2026-08-07T17:00:00Z'))
    expect(m.outcome).toBe('DELIVERED')
  })

  it('does not move availableAt when the customer finally collects', () => {
    const withoutCollection = milestonesFrom([ev('READY_FOR_PICKUP', '2026-08-03T09:00:00Z')])
    const withCollection = milestonesFrom([
      ev('READY_FOR_PICKUP', '2026-08-03T09:00:00Z'),
      ev('COLLECTED', '2026-08-09T12:00:00Z'),
    ])
    expect(withCollection.availableAt).toEqual(withoutCollection.availableAt)
  })

  it('reads a home delivery: DELIVERED sets both available and collected', () => {
    const m = milestonesFrom([
      ev('HANDED_IN', '2026-08-01T16:00:00Z'),
      ev('DELIVERED', '2026-08-04T11:00:00Z'),
    ])
    expect(m.availableAt).toEqual(new Date('2026-08-04T11:00:00Z'))
    expect(m.collectedAt).toEqual(new Date('2026-08-04T11:00:00Z'))
    expect(m.outcome).toBe('DELIVERED')
  })

  it('never marks a returned parcel available, so it cannot count as delivered', () => {
    const m = milestonesFrom([
      ev('HANDED_IN', '2026-08-01T16:00:00Z'),
      ev('RETURN', '2026-08-06T10:00:00Z'),
      ev('DELIVERED_SENDER', '2026-08-08T10:00:00Z'),
    ])
    expect(m.availableAt).toBeNull()
    expect(m.outcome).toBe('RETURNED')
  })

  it('marks a cancelled delivery cancelled, not returned', () => {
    expect(milestonesFrom([ev('DELIVERY_CANCELLED', '2026-08-06T10:00:00Z')]).outcome)
      .toBe('CANCELLED')
  })

  it('leaves outcome null while the parcel is still moving', () => {
    expect(milestonesFrom([ev('IN_TRANSIT', '2026-08-02T06:00:00Z')]).outcome).toBeNull()
  })

  it('takes the earliest of a repeated milestone, not the latest', () => {
    const m = milestonesFrom([
      ev('READY_FOR_PICKUP', '2026-08-05T09:00:00Z'),
      ev('READY_FOR_PICKUP', '2026-08-03T09:00:00Z'),
    ])
    expect(m.availableAt).toEqual(new Date('2026-08-03T09:00:00Z'))
  })

  it('reports the latest event as lastStatus whatever order they arrived in', () => {
    expect(milestonesFrom([
      ev('IN_TRANSIT', '2026-08-05T09:00:00Z'),
      ev('HANDED_IN', '2026-08-01T09:00:00Z'),
    ]).lastStatus).toBe('IN_TRANSIT')
  })

  it('has no milestones and no status at all when nothing has happened', () => {
    const m = milestonesFrom([])
    expect(m).toEqual({
      bookedAt: null, handedInAt: null, availableAt: null,
      collectedAt: null, outcome: null, lastStatus: null,
    })
  })
})

describe('mapConsignments', () => {
  it('pulls one package per parcel with its events', () => {
    const [p] = mapConsignments([
      consignment('370000000001', [
        { status: 'HANDED_IN', dateIso: '2026-08-01T18:00:00+02:00' },
        { status: 'DELIVERED', dateIso: '2026-08-04T13:00:00+02:00' },
      ]),
    ])
    expect(p.trackingNumber).toBe('370000000001')
    expect(p.events).toHaveLength(2)
    expect(p.milestones.availableAt).toEqual(new Date('2026-08-04T11:00:00Z'))
  })

  it('skips an event with no usable timestamp rather than storing an Invalid Date', () => {
    const [p] = mapConsignments([
      consignment('370000000002', [
        { status: 'HANDED_IN', dateIso: 'not a date' },
        { status: 'DELIVERED', dateIso: '2026-08-04T13:00:00+02:00' },
      ]),
    ])
    expect(p.events).toHaveLength(1)
    expect(p.milestones.handedInAt).toBeNull()
  })

  it('survives junk without throwing, because a malformed reply must not stop the run', () => {
    expect(mapConsignments([null, {}, { packageSet: null }, { packageSet: [{}] }])).toEqual([])
  })

  it('carries the description and builds a location from city and country', () => {
    const [p] = mapConsignments([
      consignment('370000000010', [
        { status: 'IN_TRANSIT', dateIso: '2026-08-02T06:00:00Z',
          description: 'Sendingen er på vei', city: 'Oslo', countryCode: 'NO' },
      ]),
    ])
    expect(p.events[0].description).toBe('Sendingen er på vei')
    expect(p.events[0].location).toBe('Oslo, NO')
  })

  it('builds a location from the country alone, with no stray comma, when there is no city', () => {
    const [p] = mapConsignments([
      consignment('370000000011', [
        { status: 'IN_TRANSIT', dateIso: '2026-08-02T06:00:00Z', countryCode: 'NO' },
      ]),
    ])
    expect(p.events[0].location).toBe('NO')
    expect(p.events[0].description).toBeNull()
  })

  it('has no location at all when Bring sends neither city nor country', () => {
    const [p] = mapConsignments([
      consignment('370000000012', [{ status: 'IN_TRANSIT', dateIso: '2026-08-02T06:00:00Z' }]),
    ])
    expect(p.events[0].location).toBeNull()
  })

  it('keeps a parcel that has no events yet, with no milestones', () => {
    const [p] = mapConsignments([{ packageSet: [{ packageNumber: '370000000013' }] }])
    expect(p.trackingNumber).toBe('370000000013')
    expect(p.events).toEqual([])
    expect(p.milestones.lastStatus).toBeNull()
  })

  // The one test that proves our field SELECTORS match what Bring actually
  // sends, rather than what its documentation claims. Recorded from
  // api.bring.com on 2026-08-07 with the client's own credentials, against a
  // parcel genuinely in transit at the time. Personal details in the response
  // (sender name, street, phone) are redacted — the mapper reads none of them.
  //
  // If Bring ever changes a field name, this is the test that fails.
  it('maps the recorded real response', async () => {
    // Read at runtime, NOT imported. A static import of a file that does not
    // exist is a COMPILE error even inside `it.skip` — skipping affects the
    // runner, not the typechecker — and `next build` typechecks test files,
    // so an import here breaks the deployment while the suite stays green.
    // Same pattern parse.test.ts uses for its warehouse PDF fixture.
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(
      new URL('./__fixtures__/real-package.json', import.meta.url),
      'utf8',
    )
    // `consignmentSet` is what fetchTracking hands the mapper — the client
    // unwraps the envelope, so the mapper never sees `apiVersion` and friends.
    const real = (JSON.parse(raw) as { consignmentSet: unknown[] }).consignmentSet
    const [p] = mapConsignments(real)

    expect(p.trackingNumber).toBe('370722152545632402')
    expect(p.events).toHaveLength(8)

    // Milestones derived from real events, not invented ones.
    expect(p.milestones.bookedAt).toEqual(new Date('2026-07-30T15:07:59+02:00'))
    expect(p.milestones.handedInAt).toEqual(new Date('2026-08-05T17:10:36+02:00'))
    // Genuinely still moving when this was recorded: no availability, no
    // outcome, and the clock therefore still running.
    expect(p.milestones.availableAt).toBeNull()
    expect(p.milestones.collectedAt).toBeNull()
    expect(p.milestones.outcome).toBeNull()
    expect(p.milestones.lastStatus).toBe('TRANSPORT_TO_RECIPIENT')

    // description/city/countryCode all read correctly off a real event.
    const latest = p.events.find((e) => e.status === 'TRANSPORT_TO_RECIPIENT')!
    expect(latest.description).toMatch(/on its way/i)
    expect(latest.location).toBe('OSLO, NO')

    // Bring repeats IN_TRANSIT at three different times. They are three
    // distinct events, and the unique constraint keys on the timestamp too, so
    // all three survive rather than collapsing into one.
    expect(p.events.filter((e) => e.status === 'IN_TRANSIT')).toHaveLength(3)
  })
})
