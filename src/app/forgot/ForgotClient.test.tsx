// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ForgotClient } from './ForgotClient'

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

const answers = (status: number, body: unknown = { ok: true }) =>
  vi.fn<Fetch>(async () => new Response(JSON.stringify(body), { status }))

function submit(email: string) {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } })
  fireEvent.submit(screen.getByTestId('forgot-form'))
}

afterEach(() => vi.unstubAllGlobals())

describe('ForgotClient', () => {
  it('asks the API for a link and then confirms', async () => {
    const fn = answers(200)
    vi.stubGlobal('fetch', fn)
    render(<ForgotClient />)

    submit('amb@example.com')

    await waitFor(() => expect(fn).toHaveBeenCalled())
    const [url, init] = fn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/auth/forgot')
    expect(JSON.parse(init.body as string)).toEqual({ email: 'amb@example.com' })
  })

  /**
   * The screen has to keep the promise the route makes. If the confirmation
   * said "we have sent you an email", anyone could type an address and learn
   * from the wording whether it has a login. The conditional phrasing is the
   * whole point, so it is asserted rather than left to a future edit.
   */
  it('confirms without revealing whether the address has a login', async () => {
    vi.stubGlobal('fetch', answers(200))
    render(<ForgotClient />)

    submit('stranger@example.com')

    expect((await screen.findByRole('status')).textContent).toMatch(/if that email has a login/i)
  })

  it('puts the form away once it has been sent, so it is not submitted twice', async () => {
    vi.stubGlobal('fetch', answers(200))
    render(<ForgotClient />)

    submit('amb@example.com')

    await screen.findByRole('status')
    expect(screen.queryByTestId('forgot-form')).toBeNull()
  })

  it('shows the refusal when the address is not an address', async () => {
    vi.stubGlobal('fetch', answers(400, { error: 'Enter a valid email address' }))
    render(<ForgotClient />)

    submit('nonsense')

    expect((await screen.findByRole('alert')).textContent).toMatch(/valid email address/i)
    // Still on the form, so it can be corrected rather than started over.
    expect(screen.getByTestId('forgot-form')).toBeTruthy()
  })

  it('says so when the server cannot be reached at all', async () => {
    vi.stubGlobal('fetch', vi.fn<Fetch>(async () => { throw new Error('offline') }))
    render(<ForgotClient />)

    submit('amb@example.com')

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i)
  })

  it('offers the way back to signing in', () => {
    vi.stubGlobal('fetch', answers(200))
    render(<ForgotClient />)
    expect(screen.getByRole('link', { name: /sign in/i }).getAttribute('href')).toBe('/login')
  })
})
