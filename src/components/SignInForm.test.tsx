// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SignInForm } from './SignInForm'

vi.mock('next/navigation', () => ({
  usePathname: () => '/login',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const forgotLink = () => screen.getByRole('link', { name: /forgot/i })

describe('SignInForm', () => {
  /**
   * Until this existed there was no recovery path at all: /api/account/password
   * needs the current password, and the invite route refuses anyone who already
   * has a login. A locked-out ambassador could only be rescued by editing the
   * database by hand.
   */
  it('offers a way out to an ambassador who has forgotten their password', () => {
    render(<SignInForm mode="ambassador" />)
    expect(forgotLink().getAttribute('href')).toBe('/forgot')
  })

  it('offers the same way out at the admin door', () => {
    // The reset route works for every role, so the staff door must not be the
    // one place a forgotten password is a dead end.
    render(<SignInForm mode="admin" />)
    expect(forgotLink().getAttribute('href')).toBe('/forgot')
  })

  it('still points each door at the other', () => {
    const { unmount } = render(<SignInForm mode="ambassador" />)
    expect(screen.getByRole('link', { name: /admin sign in/i }).getAttribute('href')).toBe('/admin')
    unmount()

    render(<SignInForm mode="admin" />)
    expect(screen.getByRole('link', { name: /sign in here/i }).getAttribute('href')).toBe('/login')
  })
})
