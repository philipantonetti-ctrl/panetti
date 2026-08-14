// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ResetClient } from './ResetClient'

const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  usePathname: () => '/reset/tok',
  useRouter: () => ({ push, refresh: vi.fn() }),
}))

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

const answers = (status: number, body: unknown) =>
  vi.fn<Fetch>(async () => new Response(JSON.stringify(body), { status }))

function fill(password: string, confirm: string = password) {
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  fireEvent.change(screen.getByLabelText(/confirm/i), { target: { value: confirm } })
  fireEvent.submit(screen.getByTestId('reset-form'))
}

beforeEach(() => push.mockReset())
afterEach(() => vi.unstubAllGlobals())

describe('ResetClient', () => {
  it('sends the token with the new password and goes where the API says', async () => {
    const fn = answers(200, { ok: true, redirectTo: '/portal' })
    vi.stubGlobal('fetch', fn)
    render(<ResetClient token="the-token" />)

    fill('a good long one')

    await waitFor(() => expect(push).toHaveBeenCalledWith('/portal'))
    const [url, init] = fn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/auth/reset')
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'the-token',
      password: 'a good long one',
    })
  })

  /**
   * Answered in the browser as well as by the route. The route is the rule —
   * it applies them regardless — but a mistyped confirmation is the single most
   * likely thing to happen here, and spending a one-time link on it would mean
   * asking for another email.
   */
  it('refuses two passwords that do not match, without spending the link', async () => {
    const fn = answers(200, { ok: true, redirectTo: '/portal' })
    vi.stubGlobal('fetch', fn)
    render(<ResetClient token="the-token" />)

    fill('a good long one', 'a good long onf')

    expect((await screen.findByRole('alert')).textContent).toMatch(/do not match/i)
    expect(fn).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('refuses a password below the minimum, without spending the link', async () => {
    const fn = answers(200, { ok: true, redirectTo: '/portal' })
    vi.stubGlobal('fetch', fn)
    render(<ResetClient token="the-token" />)

    fill('short')

    expect((await screen.findByRole('alert')).textContent).toMatch(/at least 8 characters/i)
    expect(fn).not.toHaveBeenCalled()
  })

  it('shows the route’s own words when the link has already been used', async () => {
    vi.stubGlobal(
      'fetch',
      answers(400, { error: 'This reset link has already been used. Ask for a new one.' }),
    )
    render(<ResetClient token="spent" />)

    fill('a good long one')

    expect((await screen.findByRole('alert')).textContent).toMatch(/already been used/i)
    expect(push).not.toHaveBeenCalled()
  })

  it('offers a way to ask for a fresh link when this one is dead', async () => {
    vi.stubGlobal('fetch', answers(400, { error: 'This reset link has expired. Ask for a new one.' }))
    render(<ResetClient token="stale" />)

    fill('a good long one')

    await screen.findByRole('alert')
    expect(screen.getByRole('link', { name: /new link/i }).getAttribute('href')).toBe('/forgot')
  })

  it('says so when the server cannot be reached at all', async () => {
    vi.stubGlobal('fetch', vi.fn<Fetch>(async () => { throw new Error('offline') }))
    render(<ResetClient token="the-token" />)

    fill('a good long one')

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i)
  })
})
