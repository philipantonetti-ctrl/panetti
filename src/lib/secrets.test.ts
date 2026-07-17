import { describe, it, expect, beforeAll } from 'vitest'
import { encryptSecret, decryptSecret } from './secrets'

beforeAll(() => {
  // Real runs use the .env value; make the suite self-sufficient anyway.
  process.env.AUTH_SECRET ??= 'test-only-secret-for-crypto-round-trips'
})

describe('secrets', () => {
  it('round-trips a WooCommerce key', () => {
    const stored = encryptSecret('ck_live_abc123')
    expect(stored.startsWith('enc:v1:')).toBe(true)
    expect(stored).not.toContain('ck_live_abc123')
    expect(decryptSecret(stored)).toBe('ck_live_abc123')
  })

  it('encrypts the same value differently every time (fresh IV)', () => {
    const a = encryptSecret('cs_same')
    const b = encryptSecret('cs_same')
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe('cs_same')
    expect(decryptSecret(b)).toBe('cs_same')
  })

  it('throws on a tampered value instead of returning garbage', () => {
    const stored = encryptSecret('cs_live_secret')
    const tampered = stored.slice(0, -4) + 'AAAA'
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it('passes a pre-encryption plaintext value through unchanged', () => {
    // Local dev rows created before this module keep working.
    expect(decryptSecret('ck_plain_old_row')).toBe('ck_plain_old_row')
  })

  it('refuses to run without AUTH_SECRET', () => {
    const orig = process.env.AUTH_SECRET
    delete process.env.AUTH_SECRET
    try {
      expect(() => encryptSecret('x')).toThrow(/AUTH_SECRET/)
    } finally {
      process.env.AUTH_SECRET = orig
    }
  })
})
