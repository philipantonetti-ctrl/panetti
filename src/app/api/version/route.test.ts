import { describe, it, expect } from 'vitest'
import { GET } from './route'

describe('GET /api/version', () => {
  it('names the running build, uncacheably, to anyone who asks', async () => {
    const res = GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')

    const { id } = (await res.json()) as { id: string }
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })
})
