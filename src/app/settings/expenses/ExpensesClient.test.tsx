// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ExpensesClient } from './ExpensesClient'
import { ToastProvider } from '@/components/toast/ToastProvider'

// AppShell is a client component: it reads the current route and pushes on sign-out.
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/expenses',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

function renderWithToast(ui: ReactNode) {
  return render(<ToastProvider>{ui}</ToastProvider>)
}

describe('ExpensesClient with no shops (the live production state)', () => {
  it('stops loading instead of spinning forever', async () => {
    renderWithToast(<ExpensesClient email="admin@test.local" shops={[]} />)

    // The bug: loading starts true and load() bails before clearing it,
    // so "Loading…" never goes away and the page lies about its state.
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull()
    })
  })

  it('says why the table is empty, and points at connecting a shop', async () => {
    renderWithToast(<ExpensesClient email="admin@test.local" shops={[]} />)

    await waitFor(() => {
      expect(screen.getByText('No shops connected yet.')).toBeTruthy()
    })

    const link = screen.getByRole('link', { name: 'connect one first' })
    expect(link.getAttribute('href')).toBe('/settings/shops')
  })

  it('does not offer an Add button that could not possibly save', async () => {
    renderWithToast(<ExpensesClient email="admin@test.local" shops={[]} />)

    // An expense needs a shopId and a category list. With no shop there is
    // neither, so the modal could never save — do not offer the door.
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull()
    })
    expect(screen.queryByRole('button', { name: '+ Add expense' })).toBeNull()
  })
})

const SHOP = { id: 'shop-1', name: 'Test Shop', currency: 'NOK' }

const CATEGORY_GROUPS = [{ group: 'Overhead', options: ['Software subscriptions'] }]

const EXPENSE_A = {
  id: 'exp-a',
  label: 'Office rent',
  category: 'Overhead > Software subscriptions',
  amount: 500000,
  currency: 'NOK',
  recurrence: 'MONTHLY',
  startDate: '2024-01-01',
  endDate: null,
  active: true,
  createdAt: '2024-01-01T00:00:00.000Z',
}

const EXPENSE_B = {
  id: 'exp-b',
  label: 'Software license',
  category: 'Overhead > Software subscriptions',
  amount: 20000,
  currency: 'NOK',
  recurrence: 'MONTHLY',
  startDate: '2024-01-01',
  endDate: null,
  active: true,
  createdAt: '2024-01-01T00:00:00.000Z',
}

describe('ExpensesClient — load() fails (a page-load failure)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockFailingList() {
    return vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Database is unreachable' }),
      } as unknown as Response),
    )
  }

  // The bug: load() discarded res.ok, so `d.expenses ?? []` quietly became `[]`
  // and the table said "No expenses." — a lie when the fetch actually failed.
  it('shows the server error inline in the table, not a toast that fades', async () => {
    vi.stubGlobal('fetch', mockFailingList())

    renderWithToast(<ExpensesClient email="admin@test.local" shops={[SHOP]} />)

    await waitFor(() => {
      expect(screen.getByText('Database is unreachable')).toBeTruthy()
    })

    // Inline, in the table body, matching the existing empty-row convention —
    // not a toast that fades and leaves an unexplained blank table.
    const cell = screen.getByText('Database is unreachable').closest('td')
    expect(cell?.getAttribute('colspan')).toBe('10')
  })

  it('does not claim "No expenses." when the load actually failed', async () => {
    vi.stubGlobal('fetch', mockFailingList())

    renderWithToast(<ExpensesClient email="admin@test.local" shops={[SHOP]} />)

    await waitFor(() => {
      expect(screen.getByText('Database is unreachable')).toBeTruthy()
    })
    expect(screen.queryByText('No expenses.')).toBeNull()
  })
})

describe('ExpensesClient — bulk delete fails', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockListThenTotalDeleteFailure() {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/expenses?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ expenses: [EXPENSE_A], categoryGroups: CATEGORY_GROUPS }),
        } as unknown as Response)
      }
      if (url === `/api/expenses/${EXPENSE_A.id}` && init?.method === 'DELETE') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: 'Could not delete' }),
        } as unknown as Response)
      }
      return Promise.reject(new Error(`ExpensesClient.test: unexpected fetch to ${url}`))
    })
  }

  // The bug: remove() awaited Promise.all and ignored every result, so a failed
  // DELETE was reported exactly like a successful one — nothing told the user.
  it('says the delete failed, rather than silently leaving the row', async () => {
    vi.stubGlobal('fetch', mockListThenTotalDeleteFailure())

    renderWithToast(<ExpensesClient email="admin@test.local" shops={[SHOP]} />)

    await waitFor(() => expect(screen.getByText('Office rent')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Select Office rent'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1' }))

    await waitFor(() => {
      expect(screen.queryByText(/could not delete/i)).not.toBeNull()
    })

    // The row is still there — the delete did not actually happen, and the
    // reload (ground truth from the server) proves it.
    expect(screen.getByText('Office rent')).toBeTruthy()
  })

  function mockListThenPartialDeleteFailure() {
    let expenses = [EXPENSE_A, EXPENSE_B]
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/expenses?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ expenses, categoryGroups: CATEGORY_GROUPS }),
        } as unknown as Response)
      }
      if (url === `/api/expenses/${EXPENSE_A.id}` && init?.method === 'DELETE') {
        // This one succeeds.
        expenses = expenses.filter((e) => e.id !== EXPENSE_A.id)
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as unknown as Response)
      }
      if (url === `/api/expenses/${EXPENSE_B.id}` && init?.method === 'DELETE') {
        // This one does not.
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: 'Could not delete' }),
        } as unknown as Response)
      }
      return Promise.reject(new Error(`ExpensesClient.test: unexpected fetch to ${url}`))
    })
  }

  // Partial failure must be reported honestly — not folded into a blanket
  // success, and not folded into a blanket failure either.
  it('reports a partial bulk-delete failure honestly', async () => {
    vi.stubGlobal('fetch', mockListThenPartialDeleteFailure())

    renderWithToast(<ExpensesClient email="admin@test.local" shops={[SHOP]} />)

    await waitFor(() => expect(screen.getByText('Office rent')).toBeTruthy())
    expect(screen.getByText('Software license')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Select Office rent'))
    fireEvent.click(screen.getByLabelText('Select Software license'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 2' }))

    // Says 1 succeeded and 1 failed — not "deleted" and not "failed" outright.
    await waitFor(() => {
      expect(screen.queryByText(/1 of 2|1 could not be deleted/i)).not.toBeNull()
    })

    // Ground truth after the reload: the one that succeeded is gone, the one
    // that failed is still there.
    await waitFor(() => {
      expect(screen.queryByText('Office rent')).toBeNull()
    })
    expect(screen.getByText('Software license')).toBeTruthy()
  })
})

describe('ExpensesClient — the add-expense modal save() fails', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockListThenFailingSave() {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/expenses?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ expenses: [], categoryGroups: CATEGORY_GROUPS }),
        } as unknown as Response)
      }
      if (url === '/api/expenses' && init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({ error: 'Amount must be positive' }),
        } as unknown as Response)
      }
      return Promise.reject(new Error(`ExpensesClient.test: unexpected fetch to ${url}`))
    })
  }

  // The bug: save() awaited the POST and threw the response away entirely, so a
  // 400 closed the modal exactly like a success and the entry vanished silently.
  it('shows the server error and keeps the modal open with what they typed', async () => {
    const fetchMock = mockListThenFailingSave()
    vi.stubGlobal('fetch', fetchMock)

    renderWithToast(<ExpensesClient email="admin@test.local" shops={[SHOP]} />)

    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '+ Add expense' }))

    fireEvent.change(screen.getByLabelText('Expense Label'), {
      target: { value: 'Warehouse rent' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Category' }))
    fireEvent.click(screen.getByRole('button', { name: 'Software subscriptions' }))
    fireEvent.change(screen.getByLabelText('Expense Amount'), { target: { value: '100' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save and close' }))

    // 1. The server's own message reaches the user.
    await waitFor(() => {
      expect(screen.getByText('Amount must be positive')).toBeTruthy()
    })

    // 2. The modal did not close: what they typed is still in it.
    expect(screen.getByDisplayValue('Warehouse rent')).toBeTruthy()

    // 3. onSaved was NOT called: it is the only thing that reloads the list, so
    //    a second GET would mean it fired despite the failure.
    const reloadCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('/api/expenses?'),
    )
    expect(reloadCalls).toHaveLength(1)
  })
})
