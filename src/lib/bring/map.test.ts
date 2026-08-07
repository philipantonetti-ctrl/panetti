import { describe, expect, it } from 'vitest'
import { mapConsignments, milestonesFrom, type MappedEvent } from './map'

const ev = (status: string, iso: string): MappedEvent => ({
  status, occurredAt: new Date(iso), description: null, location: null,
})

const consignment = (packageNumber: string, events: { status: string; dateIso: string }[]) => ({
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

  // SKIPPED: needs src/lib/bring/__fixtures__/real-package.json, which does not
  // exist yet — the Phase 0 probe is blocked on the client supplying a
  // warehouse-booked tracking number. Everything above is synthetic and proves
  // the milestone rules; this is the only test that would prove our field
  // SELECTORS match what Bring actually sends. Enable it the moment the probe
  // runs, and treat the recording as authoritative over Bring's documentation.
  it.skip('maps the recorded real response', async () => {
    const real = (await import('./__fixtures__/real-package.json')).default as unknown
    const mapped = mapConsignments([real].flat())
    expect(mapped.length).toBeGreaterThan(0)
    expect(mapped[0].trackingNumber).toBeTruthy()
    expect(mapped[0].events.length).toBeGreaterThan(0)
  })
})
