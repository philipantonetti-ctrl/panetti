import { describe, expect, it, vi, beforeEach } from 'vitest'

const fetchTracking = vi.fn()
vi.mock('./client', () => ({ fetchTracking: (...a: unknown[]) => fetchTracking(...a) }))

const { resolveConsignments } = await import('./consignments')

const CREDS = { uid: 'a@b.test', key: 'k', clientUrl: 'https://example.test/' }

/** Shaped like Bring's real reply - see src/lib/bring/__fixtures__/. */
const reply = (
  consignmentId: string,
  packages: { packageNumber: string; recipientEmailAddress?: string }[],
  recipientName = 'Test Person',
) => ({ consignmentId, recipientName, packageSet: packages })

beforeEach(() => fetchTracking.mockReset())

describe('resolveConsignments', () => {
  it('asks for exactly one number per request - Bring answers about only one', async () => {
    fetchTracking.mockResolvedValue([])
    await resolveConsignments(CREDS, ['111111111111111', '222222222222222'])
    expect(fetchTracking).toHaveBeenCalledTimes(2)
    for (const call of fetchTracking.mock.calls) expect(call[1]).toHaveLength(1)
  })

  it('reads the recipient email off the first package', async () => {
    fetchTracking.mockResolvedValue([
      reply('73325383667032998', [
        { packageNumber: '373325386490923366', recipientEmailAddress: 'Buyer@Example.TEST' },
      ]),
    ])
    const { consignments } = await resolveConsignments(CREDS, ['373325386490923366'])
    expect(consignments).toEqual([
      {
        consignmentId: '73325383667032998',
        packageNumbers: ['373325386490923366'],
        recipientEmail: 'buyer@example.test',
        recipientName: 'Test Person',
      },
    ])
  })

  it('skips a number an earlier response already accounted for', async () => {
    // One consignment, two packages. The file lists both, plus the shipment ref.
    fetchTracking.mockResolvedValue([
      reply('73325383667043604', [
        { packageNumber: '373325386490957422', recipientEmailAddress: 'x@example.test' },
        { packageNumber: '373325386490957439' },
      ]),
    ])
    const { consignments, unresolved } = await resolveConsignments(CREDS, [
      '373325386490957422',
      '373325386490957439',
      '73325383667043604',
    ])
    expect(fetchTracking).toHaveBeenCalledTimes(1)
    expect(consignments).toHaveLength(1)
    expect(consignments[0].packageNumbers).toEqual([
      '373325386490957422',
      '373325386490957439',
    ])
    expect(unresolved).toEqual([])
  })

  // The three ways a number can fail to resolve each get their OWN words. A
  // bare list of numbers was indistinguishable between them, and the operator
  // reading the delivery page is exactly the person who has to tell "the
  // warehouse put a number in the file that is not a Bring parcel" apart from
  // "Bring was down for a moment" - one needs a conversation with the
  // warehouse, the other needs nothing at all.
  it('reports a number Bring knows nothing about instead of inventing one', async () => {
    fetchTracking.mockResolvedValue([])
    const { consignments, unresolved } = await resolveConsignments(CREDS, ['999999999999999'])
    expect(consignments).toEqual([])
    expect(unresolved).toEqual([
      { number: '999999999999999', reason: 'Bring has no parcel with this number' },
    ])
  })

  it('keeps going when one lookup throws, and says Bring is what failed', async () => {
    fetchTracking
      .mockRejectedValueOnce(new Error('Bring responded 503: nope'))
      .mockResolvedValueOnce([
        reply('73325383667032998', [
          { packageNumber: '373325386490923366', recipientEmailAddress: 'x@example.test' },
        ]),
      ])
    const { consignments, unresolved } = await resolveConsignments(CREDS, [
      '111111111111111',
      '373325386490923366',
    ])
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0].number).toBe('111111111111111')
    expect(unresolved[0].reason).toMatch(/Bring responded 503/)
    expect(consignments).toHaveLength(1)
  })

  it('stops starting new lookups once the deadline has passed, and says so', async () => {
    fetchTracking.mockResolvedValue([])
    const { unresolved } = await resolveConsignments(
      CREDS,
      ['111111111111111', '222222222222222'],
      { deadline: Date.now() - 1 },
    )
    expect(fetchTracking).not.toHaveBeenCalled()
    expect(unresolved).toHaveLength(2)
    // Distinct from "Bring has no parcel": this file was cut short, and the
    // parcel is fine. Reading the first message here would send someone to ask
    // the warehouse about a number that was never even looked up.
    for (const u of unresolved) expect(u.reason).toMatch(/ran out of time/i)
  })

  it('records a consignment with no email so the caller can say why it did not link', async () => {
    fetchTracking.mockResolvedValue([
      reply('73325383667032998', [{ packageNumber: '373325386490923366' }]),
    ])
    const { consignments } = await resolveConsignments(CREDS, ['373325386490923366'])
    expect(consignments[0].recipientEmail).toBeNull()
  })
})
