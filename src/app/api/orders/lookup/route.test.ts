import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'ops@example.test', role: 'OPERATIONS' })),
}))
const findFirst = vi.fn()
vi.mock('@/lib/db', () => ({ db: { order: { findFirst: (...a: unknown[]) => findFirst(...a) } } }))

const { GET } = await import('./route')

describe('GET /api/orders/lookup', () => {
  it('turns a shop and a number into an order id', async () => {
    findFirst.mockResolvedValueOnce({ id: 'o1' })
    const res = await GET(new Request('http://localhost/api/orders/lookup?shop=s1&number=15866'))
    expect(await res.json()).toEqual({ orderId: 'o1' })
    expect(findFirst).toHaveBeenCalledWith({ where: { shopId: 's1', number: '15866' }, select: { id: true } })
  })

  it('says when there is no such order', async () => {
    findFirst.mockResolvedValueOnce(null)
    const res = await GET(new Request('http://localhost/api/orders/lookup?shop=s1&number=9'))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('No order 9 in that shop')
  })
})
