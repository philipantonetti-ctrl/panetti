import { describe, it, expect, afterEach, vi } from 'vitest'
import { resetLink, resetSender } from './reset-link'
import { verifyReset } from './reset'

afterEach(() => vi.unstubAllEnvs())

describe('resetLink', () => {
  it('points at the live site and carries a token for exactly that account', async () => {
    vi.stubEnv('APP_URL', 'https://panetti.vercel.app')
    const link = await resetLink({ id: 'user-1', passwordHash: '$2b$fake' })
    expect(link.startsWith('https://panetti.vercel.app/reset/')).toBe(true)
    const token = link.slice('https://panetti.vercel.app/reset/'.length)
    expect(await verifyReset(token)).toMatchObject({ userId: 'user-1' })
  })

  it('falls back to the live site when APP_URL is not set', async () => {
    vi.stubEnv('APP_URL', '')
    const link = await resetLink({ id: 'user-1', passwordHash: '$2b$fake' })
    expect(link.startsWith('https://panetti.vercel.app/reset/')).toBe(true)
  })

  it('does not double the slash when APP_URL ends in one', async () => {
    vi.stubEnv('APP_URL', 'https://panetti.vercel.app/')
    const link = await resetLink({ id: 'user-1', passwordHash: '$2b$fake' })
    expect(link.startsWith('https://panetti.vercel.app/reset/')).toBe(true)
    expect(link).not.toContain('//reset')
  })
})

describe('resetSender', () => {
  it("speaks in the product's name at the configured address", () => {
    vi.stubEnv('EMAIL_FROM', '"Philip Antonetti" <philip@example.no>')
    expect(resetSender()).toBe('"Panetti-analytics" <philip@example.no>')
  })

  it('accepts a bare address too', () => {
    vi.stubEnv('EMAIL_FROM', 'no-reply@example.no')
    expect(resetSender()).toBe('"Panetti-analytics" <no-reply@example.no>')
  })

  it('is undefined when no address is configured, so sendEmail names the missing variable', () => {
    vi.stubEnv('EMAIL_FROM', '')
    expect(resetSender()).toBeUndefined()
  })
})
