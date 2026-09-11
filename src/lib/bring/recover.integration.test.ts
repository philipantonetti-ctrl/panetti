import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { recoverDroppedRefusals } from './recover'

// Unique to this file: a filename for import rows and an 18-digit Bring-shaped
// range (373888888...) no other suite uses, so every cleanup is scoped.
const FILE = 'recover-test.xlsx'
const N = (i: number) => `373888888${String(i).padStart(9, '0')}`
const now = new Date('2026-09-11T12:00:00Z')

const imp = (unmatched: string | null, recoveredAt: Date | null = null) =>
  db.trackingImport.create({
    data: { filename: FILE, source: 'EMAIL', rowsParsed: 1, rowsLinked: 0, rowsUnmatched: 1, unmatched, recoveredAt },
  })

async function cleanup() {
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: '373888888' } } })
  await db.trackingImport.deleteMany({ where: { filename: FILE } })
}

beforeEach(cleanup)
afterAll(cleanup)

describe('recoverDroppedRefusals', () => {
  it('stores every Bring-shaped number of a refusal list as an UNKNOWN row due now, and leaves other carriers alone', async () => {
    const rec = await imp(JSON.stringify([
      { orderNumber: 'A Person', trackingNumber: N(1), reason: 'a@example.test matched 2 orders in the last 30 days: 1, 2' },
      { orderNumber: 'B Person', trackingNumber: N(2), reason: 'No order for b@example.test' },
      { orderNumber: '(not identified)', trackingNumber: '5818074780501065', reason: 'Bring has no parcel with this number' },
      { orderNumber: '(not identified)', trackingNumber: '44109904175099437829845', reason: 'Bring has no parcel with this number' },
    ]))

    const r = await recoverDroppedRefusals({ now })

    expect(r).toEqual({ imports: 1, recovered: 2 })
    const rows = await db.shipment.findMany({ where: { trackingNumber: { in: [N(1), N(2)] } } })
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.carrier).toBe('UNKNOWN')
      expect(row.nextPollAt).toEqual(now)
      expect(row.orderId).toBeNull()
    }
    expect(await db.shipment.count({ where: { trackingNumber: { in: ['5818074780501065', '44109904175099437829845'] } } })).toBe(0)
    const after = await db.trackingImport.findUnique({ where: { id: rec.id } })
    expect(after?.recoveredAt).toEqual(now)
  })

  it('never touches a number that already has a row, and counts only what it stored', async () => {
    await db.shipment.create({ data: { trackingNumber: N(3), carrier: 'BRING', recipientEmail: 'kept@example.test', nextPollAt: null } })
    await imp(JSON.stringify([
      { orderNumber: 'C Person', trackingNumber: N(3), reason: 'No order for c@example.test' },
      { orderNumber: 'D Person', trackingNumber: N(4), reason: 'No order for d@example.test' },
    ]))

    const r = await recoverDroppedRefusals({ now })

    expect(r).toEqual({ imports: 1, recovered: 1 })
    const kept = await db.shipment.findUnique({ where: { trackingNumber: N(3) } })
    expect(kept?.carrier).toBe('BRING')
    expect(kept?.recipientEmail).toBe('kept@example.test')
    expect(kept?.nextPollAt).toBeNull()
  })

  it('reads each list once', async () => {
    await imp(JSON.stringify([{ orderNumber: 'E', trackingNumber: N(5), reason: 'No order for e@example.test' }]), now)

    const r = await recoverDroppedRefusals({ now })

    expect(r).toEqual({ imports: 0, recovered: 0 })
    expect(await db.shipment.count({ where: { trackingNumber: N(5) } })).toBe(0)
  })

  it('stamps a list it cannot read so it is not tried every tick, and stores nothing from it', async () => {
    const rec = await imp('not json at all')

    const r = await recoverDroppedRefusals({ now })

    expect(r).toEqual({ imports: 1, recovered: 0 })
    const after = await db.trackingImport.findUnique({ where: { id: rec.id } })
    expect(after?.recoveredAt).toEqual(now)
  })
})
