// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
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
