// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { UsersClient } from './UsersClient'
import { ToastProvider } from '@/components/toast/ToastProvider'

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/users',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function renderPage(users: unknown[] = []) {
  const fetchMock = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
    if (String(url).includes('/api/users/reset-link')) return json({ link: 'https://panetti.vercel.app/reset/tok' })
    if (init?.method === 'POST') return json({ ok: true, id: 'new-1' })
    if (init?.method === 'DELETE') return json({ ok: true })
    return json({ users })
  })
  vi.stubGlobal('fetch', fetchMock)
  render(
    <ToastProvider>
      <UsersClient email="admin@test.local" myUserId="me-1" />
    </ToastProvider>,
  )
  return fetchMock
}

describe('UsersClient', () => {
  it('lists the staff logins with their roles', async () => {
    renderPage([
      { id: 'me-1', email: 'admin@test.local', role: 'ADMIN' },
      { id: 'u2', email: 'mkt@test.local', role: 'MARKETING' },
    ])
    // Scoped to the table: the admin nav carries a 'Marketing' link too.
    await waitFor(() => {
      const table = within(screen.getByRole('table'))
      expect(table.getByText('mkt@test.local')).toBeTruthy()
      expect(table.getByText('Marketing')).toBeTruthy()
      expect(table.getByText('Admin')).toBeTruthy()
    })
  })

  it('creates a login with a role and a starter password', async () => {
    const fetchMock = renderPage([])
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@x.local' } })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'MARKETING' } })
    fireEvent.change(screen.getByLabelText('Starter password'), { target: { value: 'longenough1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create login' }))

    await waitFor(() => expect(screen.getByText(/created/i)).toBeTruthy())
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')
    const body = JSON.parse(String((post?.[1] as RequestInit).body))
    expect(body).toEqual({ email: 'new@x.local', role: 'MARKETING', password: 'longenough1' })
  })

  it('never offers to remove your own login', async () => {
    renderPage([
      { id: 'me-1', email: 'admin@test.local', role: 'ADMIN' },
      { id: 'u2', email: 'mkt@test.local', role: 'MARKETING' },
    ])
    await waitFor(() => expect(screen.getByText('mkt@test.local')).toBeTruthy())
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1)
  })
})

describe('the operations login on the Users page', () => {
  it('offers Operations as a role, saying what it opens', async () => {
    renderPage()
    const option = await screen.findByRole('option', { name: /^Operations/ })
    expect(option.getAttribute('value')).toBe('OPERATIONS')
    expect(option.textContent).toMatch(/orders/i)
  })

  it('sends OPERATIONS when that role is chosen', async () => {
    const fetchMock = renderPage()

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ops@test.local' } })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'OPERATIONS' } })
    fireEvent.change(screen.getByLabelText('Starter password'), { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create login' }))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
      expect(post).toBeDefined()
      expect(JSON.parse((post![1] as RequestInit).body as string)).toMatchObject({
        email: 'ops@test.local',
        role: 'OPERATIONS',
      })
    })
  })

  it('labels an operations row in the table', async () => {
    renderPage([{ id: 'u3', email: 'ops@test.local', role: 'OPERATIONS' }])
    await waitFor(() => {
      const table = within(screen.getByRole('table'))
      expect(table.getByText('Operations')).toBeTruthy()
    })
  })
})

/**
 * The reset email can land in spam, or never be read. The admin can then hand
 * the same link over by any channel they like, the way they already hand over
 * an ambassador's invite link.
 */
describe('a reset link by hand', () => {
  const writeText = vi.fn(async () => {})
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    writeText.mockClear()
  })
  afterEach(() => {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard
  })

  it('copies a one-hour reset link for a login', async () => {
    const fetchMock = renderPage([{ id: 'u3', email: 'ops@test.local', role: 'OPERATIONS' }])
    const button = await screen.findByRole('button', { name: 'Copy reset link' })
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
    expect(writeText).toHaveBeenCalledWith('https://panetti.vercel.app/reset/tok')
    const post = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/users/reset-link'))
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({ email: 'ops@test.local' })
  })
})
