import { describe, expect, it, vi, beforeEach } from 'vitest'

const fetchTracking = vi.fn()
vi.mock('./client', () => ({ fetchTracking: (...a: unknown[]) => fetchTracking(...a) }))

const { resolveConsignments } = await import('./consignments')

const CREDS = { uid: 'a@b.test', key: 'k', clientUrl: 'https://example.test/' }

/** Shaped like Bring's real reply — see src/lib/bring/__fixtures__/. */
const reply = (
  consignmentId: string,
  packages: { packageNumber: string; recipientEmailAddress?: string }[],
  recipientName = 'Test Person',
) => ({ consignmentId, recipientName, packageSet: packages })

beforeEach(() => fetchTracking.mockReset())

describe('resolveConsignments', () => {
  it('asks for exactly one number per request — Bring answers about only one', async () => {
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

  it('reports a number Bring knows nothing about instead of inventing one', async () => {
    fetchTracking.mockResolvedValue([])
    const { consignments, unresolved } = await resolveConsignments(CREDS, ['999999999999999'])
    expect(consignments).toEqual([])
    expect(unresolved).toEqual(['999999999999999'])
  })

  it('keeps going when one lookup throws, and reports that number as unresolved', async () => {
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
    expect(unresolved).toEqual(['111111111111111'])
    expect(consignments).toHaveLength(1)
  })

  it('stops starting new lookups once the deadline has passed', async () => {
    fetchTracking.mockResolvedValue([])
    const { unresolved } = await resolveConsignments(
      CREDS,
      ['111111111111111', '222222222222222'],
      { deadline: Date.now() - 1 },
    )
    expect(fetchTracking).not.toHaveBeenCalled()
    expect(unresolved).toHaveLength(2)
  })

  it('records a consignment with no email so the caller can say why it did not link', async () => {
    fetchTracking.mockResolvedValue([
      reply('73325383667032998', [{ packageNumber: '373325386490923366' }]),
    ])
    const { consignments } = await resolveConsignments(CREDS, ['373325386490923366'])
    expect(consignments[0].recipientEmail).toBeNull()
  })
})
