# B2B Order Edit, Void and Delete - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner correct, void or remove a hand-entered B2B order from the B2B page, reaching the `PATCH` and `DELETE` endpoints that already exist but have no UI caller.

**Architecture:** One new endpoint (`GET /api/b2b/orders/[id]`) returning an order in the shape the form speaks, because no existing endpoint carries the `productId`s and discount breakdown needed to reopen one. `OrderModal` gains an optional `order` prop and saves with `PATCH` when it has one. The B2B page's orders card gains an actions column.

**Tech Stack:** Next.js 16 (App Router), React 19, Prisma 6 + PostgreSQL, Zod 4, Tailwind 4, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-04-b2b-order-edit-delete-design.md`

## Global Constraints

- **All money is INTEGER minor units.** `toMinor`/`toMajor` from `src/lib/money.ts`; never divide or multiply by 100 by hand.
- **`discountValue` is stored two ways on purpose:** a plain number for `PERCENT` (10 means 10%), minor units for `AMOUNT`. Any conversion must respect that split - it exists at three call sites already (`OrderModal`'s `engineLines`, its payload, and `buildOrderWrite`).
- **Two currencies:** unit prices, discounts and `shippingCharged` are the **customer's**; `fulfillmentCost` is the **shop's**.
- **Admin-only:** `assertAdmin(await currentUser())` first inside the `try`, `AuthError` → 403, `Cache-Control: private, no-store` on **every** response including errors.
- **`ownB2bOrder` gates every verb** - a WooCommerce order must 404, never be edited, voided or deleted.
- Tests use `fireEvent`; `@testing-library/user-event` is not a dependency of this project and must not be reintroduced.
- **Edit files with the Edit/Write tools only** - PowerShell `Get-Content`/`Set-Content` corrupts the UTF-8 here.
- **Never run `git stash`, `git checkout --`, `git restore`, `git reset --hard`, `git clean`.**
- Never pipe `npm run dev` into anything; do not redirect test output into the repo.
- Tests run against the real local Postgres from `.env`. Fixtures clean up FK-safely: **orders → customers → shops** (`Order.b2bCustomer` is `onDelete: Restrict`). Use a marker verified unique by grep.
- Leave `next-env.d.ts` alone; never stage it.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` after a blank line.
- Baseline: **909 tests passing**, `tsc` clean. No pre-existing assertion may be edited.

## File Structure

| file | change |
|---|---|
| `src/app/api/b2b/orders/[id]/route.ts` | **add `GET`** beside the existing `PATCH`/`DELETE` |
| `src/app/api/b2b/orders/[id]/route.test.ts` | tests for it |
| `src/app/b2b/OrderModal.tsx` | optional `order` prop; load, prefill, `PATCH` |
| `src/app/b2b/OrderModal.test.tsx` | edit-mode tests |
| `src/app/b2b/B2bClient.tsx` | actions column: Edit + ⋯ menu |
| `src/app/b2b/B2bClient.test.tsx` | wiring tests |

---

### Task 1: `GET /api/b2b/orders/[id]`

**Files:**
- Modify: `src/app/api/b2b/orders/[id]/route.ts`
- Test: `src/app/api/b2b/orders/[id]/route.test.ts`

**Interfaces produced** (Task 2 consumes verbatim):

```ts
{ order: {
    id: string, number: string, status: string,
    placedAt: string,          // 'YYYY-MM-DD'
    customerId: string, customerName: string, currency: string,
    shippingCharged: number,   // minor, customer currency
    fulfillmentCost: number,   // minor, SHOP currency (0 when null)
    lines: { productId, quantity, unitPrice, discountValue, discountKind }[],
} }
```

`unitPrice` is minor units. `discountValue` is **as stored** - plain for `PERCENT`, minor for `AMOUNT`. `discountKind` falls back to `'PERCENT'` when null (webshop-shaped rows never reach here, but the column is nullable).

- [ ] **Step 1: Write the failing tests**

Append to `src/app/api/b2b/orders/[id]/route.test.ts`, reusing that file's existing scaffolding, `createOrder()` helper and cleanup:

```ts
describe('GET /api/b2b/orders/[id]', () => {
  it('returns the order in the shape the form needs to reopen it', async () => {
    await asAdmin()
    const id = await createOrder() // 10 x 89.00, 10% off

    const body = await (await GET(new Request('http://localhost/x'), params(id))).json()

    expect(body.order).toMatchObject({
      id, number: 'B-0001', status: 'completed',
      placedAt: '2026-07-01',
      customerId, currency: 'EUR',
    })
    // The line carries what the form cannot get from /api/orders: the
    // product's id and the discount as it was typed.
    expect(body.order.lines).toEqual([
      { productId, quantity: 10, unitPrice: 8900, discountValue: 10, discountKind: 'PERCENT' },
    ])
  })

  it('returns an AMOUNT discount in minor units, as stored', async () => {
    // PERCENT is a plain number, AMOUNT is money. Collapsing the two is the
    // 100x hazard this codebase guards at every other call site.
    await asAdmin()
    const res = await POST(new Request('http://localhost/api/b2b/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId, placedAt: '2026-07-02',
        lines: [{ productId, quantity: 4, unitPrice: 245, discountValue: 20, discountKind: 'AMOUNT' }],
      }),
    }))
    const { order } = await res.json()

    const body = await (await GET(new Request('http://localhost/x'), params(order.id))).json()
    expect(body.order.lines[0]).toMatchObject({ discountValue: 2000, discountKind: 'AMOUNT' })
  })

  it('refuses an anonymous caller', async () => {
    cookieValue.current = undefined
    const id = 'anything'
    expect((await GET(new Request('http://localhost/x'), params(id))).status).toBe(403)
  })

  it('404s a webshop order', async () => {
    await asAdmin()
    const woo = await db.order.create({
      data: {
        shopId, externalId: '9500', number: '9500', placedAt: new Date('2026-07-01'),
        status: 'completed', currency: 'NOK', grossSales: 1000, discountTotal: 0,
        netSales: 1000, shippingCharged: 0, taxTotal: 0, total: 1000,
      },
    })
    expect((await GET(new Request('http://localhost/x'), params(woo.id))).status).toBe(404)
  })
})
```

Add `GET` to the file's route import.

- [ ] **Step 2: Run to verify they fail**

`npx vitest run "src/app/api/b2b/orders/[id]/route.test.ts"` - expect failures on `GET` not being exported.

- [ ] **Step 3: Implement**

In `src/app/api/b2b/orders/[id]/route.ts`, add above `PATCH`:

```ts
/**
 * One B2B order, in the shape the ORDER FORM speaks rather than the shape the
 * database holds. The list endpoint cannot serve this: it returns product
 * names for display, not the ids and discount breakdown needed to rebuild the
 * form, and widening it would cost every row of every page.
 */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const order = await db.order.findFirst({
      where: { id, b2bCustomerId: { not: null } },
      select: {
        id: true, number: true, status: true, placedAt: true, currency: true,
        shippingCharged: true, fulfillmentCost: true, b2bCustomerId: true,
        b2bCustomer: { select: { name: true } },
        items: {
          select: {
            productId: true, quantity: true, unitPrice: true,
            discountValue: true, discountKind: true,
          },
        },
      },
    })
    if (!order)
      return NextResponse.json({ error: 'No such B2B order' }, { status: 404, headers: NO_STORE })

    return NextResponse.json(
      {
        order: {
          id: order.id,
          number: order.number,
          status: order.status,
          // The form's date input speaks 'YYYY-MM-DD'; placedAt is UTC midnight.
          placedAt: order.placedAt.toISOString().slice(0, 10),
          customerId: order.b2bCustomerId!,
          customerName: order.b2bCustomer?.name ?? '',
          currency: order.currency,
          shippingCharged: order.shippingCharged,
          // null means "webshop order, use the shop's rate", which a B2B order
          // never is - but the column is nullable, so say 0 rather than null.
          fulfillmentCost: order.fulfillmentCost ?? 0,
          lines: order.items.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            // As stored: plain for PERCENT, minor units for AMOUNT.
            discountValue: i.discountValue ?? 0,
            discountKind: i.discountKind ?? 'PERCENT',
          })),
        },
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the order' }, { status: 500, headers: NO_STORE })
  }
}
```

- [ ] **Step 4: Tests pass; full suite; commit**

`npx vitest run "src/app/api/b2b/orders/[id]/route.test.ts"`, then `npm test` (913), then:

```bash
git add "src/app/api/b2b/orders/[id]"
git commit -m "feat: read one B2B order back in the shape the form speaks"
```

---

### Task 2: `OrderModal` edits

**Files:**
- Modify: `src/app/b2b/OrderModal.tsx`
- Test: `src/app/b2b/OrderModal.test.tsx`

**Interfaces:**
- Consumes: `GET /api/b2b/orders/[id]` (Task 1).
- Produces: `OrderModal` takes an optional `order?: { id: string } | null`. Absent/null → creates. Present → loads, prefills, `PATCH`es. Task 3 passes it.

- [ ] **Step 1: Write the failing tests**

Append to `src/app/b2b/OrderModal.test.tsx`, following its existing `renderWithToast` and mock conventions. Extend the fetch mock to answer `/api/b2b/orders/<id>`:

```ts
describe('OrderModal in edit mode', () => {
  it('loads the order and prefills every field', async () => {
    mockFetch({ order: {
      id: 'o1', number: 'B-0007', status: 'completed', placedAt: '2026-07-05',
      customerId: 'c1', customerName: 'Nordic Retail AS', currency: 'EUR',
      shippingCharged: 5000, fulfillmentCost: 42000,
      lines: [{ productId: 'p1', quantity: 10, unitPrice: 8900, discountValue: 10, discountKind: 'PERCENT' }],
    } })

    renderWithToast(<OrderModal customers={customers} order={{ id: 'o1' }} onClose={() => {}} onSaved={() => {}} />)

    // Minor units on the wire, major in the fields - toMajor, not /100.
    expect(await screen.findByLabelText('Unit price 1')).toHaveValue(89)
    expect(screen.getByLabelText('Quantity 1')).toHaveValue(10)
    expect(screen.getByLabelText('Discount 1')).toHaveValue(10)
    expect(screen.getByLabelText('Shipping charged (EUR)')).toHaveValue(50)
    // The heading says which order you are editing.
    expect(screen.getByRole('heading', { name: /B-0007/ })).toBeInTheDocument()
  })

  it('converts an AMOUNT discount back to major units, and a PERCENT one not at all', async () => {
    // 2000 minor = 20.00 per unit. A PERCENT 10 must stay 10, not become 0.1.
    mockFetch({ order: {
      id: 'o2', number: 'B-0008', status: 'completed', placedAt: '2026-07-05',
      customerId: 'c1', customerName: 'Nordic Retail AS', currency: 'EUR',
      shippingCharged: 0, fulfillmentCost: 0,
      lines: [{ productId: 'p1', quantity: 4, unitPrice: 24500, discountValue: 2000, discountKind: 'AMOUNT' }],
    } })

    renderWithToast(<OrderModal customers={customers} order={{ id: 'o2' }} onClose={() => {}} onSaved={() => {}} />)

    expect(await screen.findByLabelText('Discount 1')).toHaveValue(20)
    expect(screen.getByLabelText('Discount kind 1')).toHaveValue('AMOUNT')
  })

  it('locks the customer picker, because the server refuses moving an order', async () => {
    mockFetch({ order: {
      id: 'o3', number: 'B-0009', status: 'completed', placedAt: '2026-07-05',
      customerId: 'c1', customerName: 'Nordic Retail AS', currency: 'EUR',
      shippingCharged: 0, fulfillmentCost: 0,
      lines: [{ productId: 'p1', quantity: 1, unitPrice: 8900, discountValue: 0, discountKind: 'PERCENT' }],
    } })

    renderWithToast(<OrderModal customers={customers} order={{ id: 'o3' }} onClose={() => {}} onSaved={() => {}} />)
    expect(await screen.findByLabelText('Customer')).toBeDisabled()
  })

  it('saves with PATCH to the order, not POST to the collection', async () => {
    const calls: { url: string; method?: string }[] = []
    mockFetchCapturing(calls, { order: { /* as above, id 'o4', number 'B-0010' */ } })

    renderWithToast(<OrderModal customers={customers} order={{ id: 'o4' }} onClose={() => {}} onSaved={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: /save/i }))

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/api/b2b/orders/o4') && c.method === 'PATCH')).toBe(true),
    )
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

`npx vitest run src/app/b2b/OrderModal.test.tsx` - the `order` prop does not exist yet.

- [ ] **Step 3: Implement**

Add the prop:

```tsx
export function OrderModal({
  customers,
  order,
  onClose,
  onSaved,
}: {
  customers: Customer[]
  /** Absent = creating. Present = editing that order. */
  order?: { id: string } | null
  onClose: () => void
  onSaved: () => void
}) {
```

Add state for the loaded order and a load effect. Note the ordering: `pickCustomer` deliberately clears rows, so it must run **before** the loaded lines are set.

```tsx
  const editing = order != null
  const [loaded, setLoaded] = useState<{ number: string } | null>(null)

  // Editing: pull the order back in the shape this form speaks. pickCustomer
  // clears the rows by design, so it runs first and the lines land after.
  useEffect(() => {
    if (!order) return
    fetch(`/api/b2b/orders/${order.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.order) {
          toast.error('Could not load that order')
          return
        }
        const o = d.order
        pickCustomer(o.customerId)
        setPlacedAt(o.placedAt)
        setShippingCharged(String(toMajor(o.shippingCharged)))
        setFulfillmentCost(String(toMajor(o.fulfillmentCost)))
        setRows(
          o.lines.map((l: LoadedLine) => ({
            productId: l.productId,
            quantity: String(l.quantity),
            unitPrice: String(toMajor(l.unitPrice)),
            // PERCENT is a plain number and must not be divided; AMOUNT is money.
            discountValue:
              l.discountKind === 'PERCENT' ? String(l.discountValue) : String(toMajor(l.discountValue)),
            discountKind: l.discountKind,
            // These prices are already what was agreed or already a recorded
            // one-off; re-saving them on an edit would be a surprise.
            savePrice: false,
          })),
        )
        setLoaded({ number: o.number })
      })
      .catch(() => toast.error('Could not load that order'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id])
```

with `type LoadedLine = { productId: string; quantity: number; unitPrice: number; discountValue: number; discountKind: DiscountKind }` beside the other local types.

In `save()`, branch the request:

```tsx
      const res = await fetch(
        editing ? `/api/b2b/orders/${order!.id}` : '/api/b2b/orders',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerId: customer.id,
            placedAt,
            shippingCharged: parseFloat(shippingCharged) || 0,
            fulfillmentCost: parseFloat(fulfillmentCost) || 0,
            lines: /* unchanged */,
          }),
        },
      )
```

Leave the success toast reading the created number only when creating; on an edit say `Order ${loaded?.number ?? ''} saved`.

Disable the customer select when editing, and title the dialog with the order number:

```tsx
        <h2 className="border-b border-line pb-3 text-base font-bold text-ink">
          {editing ? `Edit order ${loaded?.number ?? ''}` : 'Add other revenue'}
        </h2>
```

```tsx
            <select
              id="b2b-customer" aria-label="Customer" value={customerId}
              disabled={editing}
              onChange={(e) => pickCustomer(e.target.value)}
```

- [ ] **Step 4: Tests pass; full suite; commit**

```bash
git add src/app/b2b/OrderModal.tsx src/app/b2b/OrderModal.test.tsx
git commit -m "feat: reopen a B2B order in the form that created it"
```

---

### Task 3: The orders card's actions

**Files:**
- Modify: `src/app/b2b/B2bClient.tsx`
- Test: `src/app/b2b/B2bClient.test.tsx`

**Interfaces:**
- Consumes: `OrderModal`'s `order` prop (Task 2); `PATCH`/`DELETE /api/b2b/orders/[id]`; `GET /api/b2b/orders/[id]` (for void).

- [ ] **Step 1: Write the failing tests**

Append to `src/app/b2b/B2bClient.test.tsx`:

```ts
it('opens an order for editing from the card', async () => {
  mockFetch([customer], [b2bOrder])
  renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

  fireEvent.click(await screen.findByRole('button', { name: /edit order B-0001/i }))
  expect(await screen.findByRole('heading', { name: /edit order/i })).toBeInTheDocument()
})

it('voids an order by re-sending it with the new status', async () => {
  // PATCH takes the whole order, so voiding loads it first and returns it
  // unchanged but for the status. Assert the request, not just the click.
  const calls: { url: string; method?: string; body?: string }[] = []
  mockFetchCapturing(calls, [customer], [b2bOrder])
  renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

  fireEvent.click(await screen.findByRole('button', { name: /actions for B-0001/i }))
  fireEvent.click(screen.getByRole('button', { name: /mark refunded/i }))

  await waitFor(() => {
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch?.url).toMatch(/\/api\/b2b\/orders\/o1$/)
    expect(JSON.parse(patch!.body!).status).toBe('refunded')
  })
})

it('asks before deleting, because the Dashboard moves', async () => {
  const calls: { url: string; method?: string }[] = []
  mockFetchCapturing(calls, [customer], [b2bOrder])
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  renderWithToast(<B2bClient email="a@b.test" shops={shops} />)

  fireEvent.click(await screen.findByRole('button', { name: /actions for B-0001/i }))
  fireEvent.click(screen.getByRole('button', { name: /delete order/i }))

  expect(confirm).toHaveBeenCalled()
  // Declined means nothing was sent.
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  confirm.mockRestore()
})
```

- [ ] **Step 2: Run to verify they fail**

`npx vitest run src/app/b2b/B2bClient.test.tsx`

- [ ] **Step 3: Implement**

Add state and handlers to `B2bClient`:

```tsx
  const [editingOrder, setEditingOrder] = useState<{ id: string } | null>(null)
  const [orderMenuFor, setOrderMenuFor] = useState<string | null>(null)

  /**
   * Void = the order happened and earns nothing, which is what a refunded
   * webshop order already means. PATCH takes the whole order, so this reads
   * it back and returns it unchanged but for the status - two round trips,
   * rather than widening a contract that is already tested.
   */
  async function setOrderStatus(o: B2bOrder, status: 'refunded' | 'cancelled') {
    setOrderMenuFor(null)
    try {
      const loaded = await fetch(`/api/b2b/orders/${o.id}`).then((r) => (r.ok ? r.json() : null))
      if (!loaded?.order) {
        toast.error('Could not load that order')
        return
      }
      const d = loaded.order
      const res = await fetch(`/api/b2b/orders/${o.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: d.customerId,
          placedAt: d.placedAt,
          shippingCharged: toMajor(d.shippingCharged),
          fulfillmentCost: toMajor(d.fulfillmentCost),
          status,
          lines: d.lines.map((l: { productId: string; quantity: number; unitPrice: number; discountValue: number; discountKind: string }) => ({
            productId: l.productId,
            quantity: l.quantity,
            unitPrice: toMajor(l.unitPrice),
            discountValue: l.discountKind === 'PERCENT' ? l.discountValue : toMajor(l.discountValue),
            discountKind: l.discountKind,
          })),
        }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not change that order')
        return
      }
      toast.success(`${o.number} marked ${status}`)
      load()
    } catch {
      toast.error('Could not reach the server')
    }
  }

  /** The only irreversible action here, and it moves a reported figure. */
  async function removeOrder(o: B2bOrder) {
    setOrderMenuFor(null)
    if (!window.confirm(`Delete order ${o.number}? Its revenue and profit leave your figures.`)) return

    const res = await fetch(`/api/b2b/orders/${o.id}`, { method: 'DELETE' }).catch(() => null)
    if (!res?.ok) {
      toast.error('Could not delete that order')
      return
    }
    toast.success(`${o.number} deleted`)
    load()
  }
```

Add a header cell and an actions cell to the orders table, following the `⋯` menu pattern in `ExpensesClient.tsx`. The Edit button's accessible name must include the order number (`aria-label={\`Edit order ${o.number}\`}`), and the menu trigger's likewise (`aria-label={\`Actions for ${o.number}\`}`).

Mount the modal in edit mode beside the existing create mount:

```tsx
      {(orderOpen || editingOrder) && (
        <OrderModal
          customers={customers}
          order={editingOrder}
          onClose={() => { setOrderOpen(false); setEditingOrder(null) }}
          onSaved={() => { setOrderOpen(false); setEditingOrder(null); load() }}
        />
      )}
```

- [ ] **Step 4: Tests pass; full suite; lint; tsc; commit**

```bash
git add src/app/b2b/B2bClient.tsx src/app/b2b/B2bClient.test.tsx
git commit -m "feat: edit, void or delete a B2B order from the B2B page"
```

---

## Self-Review

**Spec coverage:** GET endpoint → Task 1; edit mode → Task 2; card actions, void and delete-with-confirm → Task 3. Every spec section maps.

**Riskiest:** Task 2's `discountValue` conversion - `PERCENT` must not be divided, `AMOUNT` must. Task 1's test asserts the stored form, Task 2's asserts the displayed form, so the pair pins both ends.

**Type consistency:** `order?: { id: string } | null` in Task 2 is what Task 3 passes (`editingOrder`, same shape). `GET`'s payload field names in Task 1 are consumed verbatim in Tasks 2 and 3.
