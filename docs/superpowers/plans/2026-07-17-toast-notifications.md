# Toast Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One feedback system for every button that acts, and make the four components that currently discard every response actually notice failure.

**Architecture:** A hand-rolled React context (`ToastProvider`) mounted in the root layout, a `useToast()` hook with exactly two methods, and a `Toaster` that renders the stack at `var(--z-toast)`. No dependencies. Action results become toasts; form validation and page-load errors deliberately stay inline.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4, Vitest + jsdom + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-17-toast-notifications-design.md`

---

## Proven before planning

Two things were spiked and deleted; this plan depends on both:

1. **Component tests work** (established 2026-07-17): `// @vitest-environment jsdom` docblock per file, mocking `next/navigation` and `next/link`. The global `environment` stays `node` — do NOT change `vitest.config.ts`.
2. **Fake timers drive React state**, verified with React 19 + @testing-library/react:
   ```tsx
   vi.useFakeTimers()
   render(<Thing />)
   await act(async () => { vi.advanceTimersByTime(4000) })   // act() is required
   ```
   Advancing to 3999ms leaves it visible; 4000ms dismisses it. The assertion is precise, not approximate.

## House facts, verified — do not re-derive

- `globals.css:55-57`: `--z-backdrop: 40`, `--z-modal: 50`, **`--z-toast: 60`** — already declared, never used.
- All three modals hardcode Tailwind's `z-50` (`CostsClient.tsx:318`, `ExpensesClient.tsx:423`, `AmbassadorsClient.tsx:430`), not `var(--z-modal)`. Do not "fix" them; out of scope.
- Tones: `--color-gain` (green, success), `--color-loss` (red, error). Classes `text-gain` / `text-loss`.
- Surfaces: `bg-surface`, `border-line`, `text-ink`, `text-muted`, `rounded-[var(--radius-card)]`.
- Every API error response is `{ error: string }`. **Render that string** — the messages are written to be shown.

## File structure

| File | Responsibility |
|---|---|
| `src/components/toast/ToastProvider.tsx` | **Create.** Context, queue, timers. `'use client'`. |
| `src/components/toast/Toaster.tsx` | **Create.** Renders the stack at `var(--z-toast)`. |
| `src/components/toast/useToast.ts` | **Create.** The hook. Throws outside a provider. |
| `src/components/toast/ToastProvider.test.tsx` | **Create.** Provider behaviour. |
| `src/app/layout.tsx` | **Modify.** Wrap `{children}`. |
| `src/app/settings/ambassadors/AmbassadorsClient.tsx` | **Modify.** Migrate; delete the `scrollTo` hack. |
| `src/app/settings/costs/CostsClient.tsx` | **Modify.** Add `res.ok`. The day-one bug. |
| `src/app/settings/expenses/ExpensesClient.tsx` | **Modify.** Three unchecked fetches. |
| `src/components/shell/AppShell.tsx` | **Modify.** Do not navigate on failed sign-out. |
| `src/app/portal/PortalClient.tsx` | **Modify.** `res.ok` + `.catch()`. Inline, NOT a toast. |
| `src/app/account/AccountClient.tsx` | **Modify.** Migrate `infoNote`. |
| `src/app/settings/shops/ShopsClient.tsx` | **Modify.** Migrate `message`. |

---

## Task 1: The toast system

**Files:**
- Create: `src/components/toast/ToastProvider.tsx`, `src/components/toast/useToast.ts`, `src/components/toast/Toaster.tsx`
- Test: `src/components/toast/ToastProvider.test.tsx`
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/toast/ToastProvider.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { useToast } from './useToast'

afterEach(() => vi.useRealTimers())

function Buttons() {
  const toast = useToast()
  return (
    <>
      <button onClick={() => toast.success('Saved.')}>ok</button>
      <button onClick={() => toast.error('It broke.')}>bad</button>
      <button onClick={() => toast.error('Also broke.')}>bad2</button>
    </>
  )
}

const setup = () => render(<ToastProvider><Buttons /></ToastProvider>)

describe('ToastProvider', () => {
  it('shows a success toast when asked', () => {
    setup()
    fireEvent.click(screen.getByText('ok'))
    expect(screen.getByText('Saved.')).toBeDefined()
  })

  it('dismisses a success toast after 4 seconds, and not before', async () => {
    vi.useFakeTimers()
    setup()
    fireEvent.click(screen.getByText('ok'))

    await act(async () => { vi.advanceTimersByTime(3999) })
    expect(screen.queryByText('Saved.')).not.toBeNull() // still there at 3999ms

    await act(async () => { vi.advanceTimersByTime(1) })
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  // Errors carry the server's own wording and are long. 4s is not a read.
  it('keeps an error toast for 10 seconds, not 4', async () => {
    vi.useFakeTimers()
    setup()
    fireEvent.click(screen.getByText('bad'))

    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByText('It broke.')).not.toBeNull() // a success would be gone by now

    await act(async () => { vi.advanceTimersByTime(6000) })
    expect(screen.queryByText('It broke.')).toBeNull()
  })

  it('stacks two toasts rather than replacing the first', () => {
    setup()
    fireEvent.click(screen.getByText('bad'))
    fireEvent.click(screen.getByText('bad2'))
    expect(screen.queryByText('It broke.')).not.toBeNull()
    expect(screen.queryByText('Also broke.')).not.toBeNull()
  })

  it('dismisses when clicked, without waiting for the timer', () => {
    setup()
    fireEvent.click(screen.getByText('ok'))
    fireEvent.click(screen.getByText('Saved.'))
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  it('announces politely to screen readers', () => {
    setup()
    fireEvent.click(screen.getByText('ok'))
    const region = screen.getByRole('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
  })

  // The toast must clear the modals, which sit at z-50.
  it('renders above the modal layer', () => {
    setup()
    fireEvent.click(screen.getByText('ok'))
    const region = screen.getByRole('status')
    expect(region.style.zIndex).toBe('var(--z-toast)')
  })

  // A missing provider must fail loudly in development, never swallow messages.
  it('throws if used outside a provider', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Buttons />)).toThrow(/ToastProvider/)
    quiet.mockRestore()
  })
})
```

- [ ] **Step 2: Run it — CONFIRM IT FAILS**

Run: `npx vitest run src/components/toast/ToastProvider.test.tsx`
Expected: FAIL — cannot resolve `./ToastProvider`.

- [ ] **Step 3: Write `useToast.ts`**

```ts
// src/components/toast/useToast.ts
'use client'

import { createContext, useContext } from 'react'

export type ToastTone = 'success' | 'error'
export type Toast = { id: number; tone: ToastTone; text: string }

export type ToastApi = {
  success: (text: string) => void
  error: (text: string) => void
}

export const ToastContext = createContext<ToastApi | null>(null)

/** The only way to raise a toast. Throws rather than silently swallowing. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast must be used inside a ToastProvider')
  return api
}
```

- [ ] **Step 4: Write `ToastProvider.tsx`**

```tsx
// src/components/toast/ToastProvider.tsx
'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Toaster } from './Toaster'
import { ToastContext, type Toast, type ToastTone } from './useToast'

/** A success is a glance. An error carries the server's own wording and needs reading. */
const DURATION: Record<ToastTone, number> = { success: 4000, error: 10000 }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((current) => current.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (tone: ToastTone, text: string) => {
      const id = nextId.current++
      setToasts((current) => [...current, { id, tone, text }])
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DURATION[tone]),
      )
    },
    [dismiss],
  )

  // A timer firing after unmount is a state update on a dead component.
  // Copy the map into the effect body: a cleanup must not read `.current`,
  // which may have moved on by the time it runs.
  useEffect(() => {
    const map = timers.current
    return () => {
      map.forEach(clearTimeout)
      map.clear()
    }
  }, [])

  const api = useMemo(
    () => ({
      success: (text: string) => push('success', text),
      error: (text: string) => push('error', text),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}
```

- [ ] **Step 5: Write `Toaster.tsx`**

```tsx
// src/components/toast/Toaster.tsx
'use client'

import type { Toast } from './useToast'

export function Toaster({
  toasts,
  onDismiss,
}: {
  toasts: Toast[]
  onDismiss: (id: number) => void
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      // z-toast (60) sits above the modal layer (50): a toast reporting a
      // modal's own save failure must appear over it.
      style={{ zIndex: 'var(--z-toast)' }}
      className="pointer-events-none fixed bottom-4 right-4 flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className={`pointer-events-auto max-w-[360px] rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-left text-xs shadow-xl ${
            t.tone === 'error' ? 'text-loss' : 'text-gain'
          }`}
        >
          {t.text}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 6: Mount it in `src/app/layout.tsx`**

Wrap the body's children — NOT inside `AppShell`, because `/login` and `/invite/[token]` have no `AppShell` and both need feedback:

```tsx
import { ToastProvider } from "@/components/toast/ToastProvider";
...
<body className="min-h-full flex flex-col">
  <ToastProvider>{children}</ToastProvider>
</body>
```

- [ ] **Step 7: Run the tests — CONFIRM ALL 8 PASS**

- [ ] **Step 8: Prove the tests have teeth — THREE mutants**

For each: apply, run, record which test fails, revert, confirm green.

- **Mutant A:** change `error: 10000` to `error: 4000`. The "keeps an error toast for 10 seconds" test MUST fail.
- **Mutant B:** in `push`, replace `[...current, {…}]` with `[{…}]` (replace instead of stack). The stacking test MUST fail.
- **Mutant C:** remove the `if (!api) throw` from `useToast`. The "throws outside a provider" test MUST fail.

**Report each honestly. If any survives, say so plainly.** Verify with `git diff` that no mutant remains.

- [ ] **Step 9: Verify + commit**

`npm test` (baseline **235 across 29 files**; expect ~243/30) · `npx tsc --noEmit` exit 0 · `npm run build` exit 0

```bash
git add src/components/toast/ src/app/layout.tsx
git commit -m "feat: one toast system for every button that acts"
```

---

## Task 2: AmbassadorsClient — migrate, and delete the scrollTo hack

**Files:** Modify `src/app/settings/ambassadors/AmbassadorsClient.tsx`

This screen already checks `res.ok` properly. The problem is *where* the message lands: at the top of `PageBody`, ~1600px above the viewport on a long table. `remove()` currently carries `if (!ok) window.scrollTo({ top: 0, behavior: 'smooth' })` as a stopgap. **The toast is the real fix. Delete the hack.**

- [ ] **Step 1: Read the file.** Note `send()` (checks `res.ok`, sets `error`, `try`/`finally`), the keyed `pending` state, and the `ErrorNote`.

- [ ] **Step 2: Replace the error state with the toast**

- Call `const toast = useToast()`
- In `send()`, replace `setError(...)` with `toast.error(...)`
- Remove the `error` state, the `ErrorNote` render, **and the `window.scrollTo` line in `remove()`**
- Add success toasts for action results whose outcome is not self-evident:
  - Copy invite link → `toast.success('Invite link copied')` (replaces the transient "Copied" button label ONLY if that label is removed — otherwise keep the label and skip the toast; do not do both)
  - Delete → `toast.success(\`${name} deleted\`)` — the row vanishing is visible, but the confirmation matters after a destructive act
- Do NOT toast Add/Deactivate: the row appearing and the pill changing already say so. Redundant toasts train people to ignore them.

- [ ] **Step 3: Verify the 409 still reaches the user**

`npm test` — the existing ambassador tests must still pass. If a test asserted the `ErrorNote`'s presence, update it to assert the toast — **do not delete the assertion**.

- [ ] **Step 4: Commit**

```bash
git add src/app/settings/ambassadors/AmbassadorsClient.tsx
git commit -m "feat: ambassadors screen reports through the toast

Deletes the window.scrollTo stopgap — the error landed ~1600px above the
viewport on a long table, so a refusal read as nothing happening."
```

---

## Task 3: CostsClient — the day-one bug

**Files:** Modify `src/app/settings/costs/CostsClient.tsx`; test `src/app/settings/costs/CostsClient.test.tsx` (exists — read it first)

Current `save()` (~line 281):
```ts
async function save() {
  setBusy(true)
  await fetch(`/api/products/${product.id}/cost`, {...})   // result discarded
  setBusy(false)
  onSaved()      // fires whether it worked or not
}
```
A 400/403/500 closes the modal, reloads the old value, and shows **nothing**. Flagged in the first audit; still live.

- [ ] **Step 1: Write the failing test**

Add to `CostsClient.test.tsx`. Mock `fetch` to reject with a 400 `{error: 'Invalid cost'}`, render the modal, click Save, and assert:
1. The server's message is shown to the user
2. `onSaved` was NOT called
3. The modal did NOT close

Read the existing test file for its render/mocking shape. You will need the component wrapped in `<ToastProvider>` — if a test helper doesn't exist, write a small local `renderWithToast()`.

- [ ] **Step 2: Run — confirm it FAILS** (currently the message never appears and `onSaved` fires anyway)

- [ ] **Step 3: Fix `save()`**

```ts
async function save() {
  setBusy(true)
  try {
    const res = await fetch(`/api/products/${product.id}/cost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ costPerItem: parseFloat(cost) || 0, costApply, handlingCost: parseFloat(handling) || 0, handlingApply }),
    })
    if (!res.ok) {
      // Keep the modal open: their numbers are still in it, and closing would
      // silently discard the edit while showing the old value.
      toast.error((await res.json().catch(() => null))?.error ?? 'Could not save the cost')
      return
    }
    toast.success('Cost saved')
    onSaved()
  } catch {
    toast.error('Could not reach the server')
  } finally {
    setBusy(false) // always — the button must never stick on "Saving…"
  }
}
```

- [ ] **Step 4: Confirm GREEN, then prove teeth**

**Mutant:** remove the `if (!res.ok)` block. The test MUST fail. Revert; confirm `git diff` clean.

- [ ] **Step 5: Verify + commit**

```bash
git add src/app/settings/costs/CostsClient.tsx src/app/settings/costs/CostsClient.test.tsx
git commit -m "fix: the cost modal must not swallow a failed save

It never checked res.ok, so a rejected save closed the modal, reloaded the
old value, and showed nothing at all."
```

---

## Task 4: ExpensesClient — three unchecked fetches

**Files:** Modify `src/app/settings/expenses/ExpensesClient.tsx`; extend `src/app/settings/expenses/ExpensesClient.test.tsx`

Three fetches, none checked: `load()` (~line 78), the bulk delete (~line 94), and the modal's `save()` (~line 373).

- [ ] **Step 1: Write failing tests** — a failed save shows the server's message and does not close the modal; a failed bulk-delete says so rather than silently leaving rows.

- [ ] **Step 2: Confirm RED**

- [ ] **Step 3: Fix all three.** Same shape as Task 3: check `res.ok`, toast the `{error}`, `try`/`finally`. `load()`'s failure is a **load** failure — render it inline in the table body (matching the existing "No expenses." empty row), NOT as a toast.

- [ ] **Step 4: Mutant per fix. Report honestly.**

- [ ] **Step 5: Verify + commit**

```bash
git add src/app/settings/expenses/ExpensesClient.tsx src/app/settings/expenses/ExpensesClient.test.tsx
git commit -m "fix: the expenses screen must notice when a request fails"
```

---

## Task 5: AppShell — a failed sign-out must not pretend

**Files:** Modify `src/components/shell/AppShell.tsx`; create `src/components/shell/AppShell.test.tsx`

Current (`~line 142`):
```ts
async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST' })
  router.push('/login')      // navigates whether or not it worked
  router.refresh()
}
```

**The missing toast is not the bug. Navigating on failure is.** The user lands on the sign-in page believing they are signed out while their session cookie is still valid. On a shared machine that is not cosmetic.

- [ ] **Step 1: Write the failing test — this is the important one**

```tsx
it('does NOT navigate when the logout fails — the session may still be live', async () => {
  const push = vi.fn()
  // ...mock useRouter to return { push, refresh: vi.fn() }
  // ...mock fetch to resolve { ok: false, status: 500 }
  // ...render AppShell inside ToastProvider, click Sign out
  await waitFor(() => expect(screen.getByText(/could not sign you out/i)).toBeDefined())
  expect(push).not.toHaveBeenCalled()   // the assertion that matters
})
```

- [ ] **Step 2: Confirm RED** — `push` IS called today.

- [ ] **Step 3: Fix**

```ts
async function signOut() {
  try {
    const res = await fetch('/api/auth/logout', { method: 'POST' })
    if (!res.ok) {
      // Do NOT navigate. Landing on /login while the cookie is still valid
      // tells the user they are signed out when they are not.
      toast.error('Could not sign you out. Please try again.')
      return
    }
    router.push('/login')
    router.refresh()
  } catch {
    toast.error('Could not reach the server. You are still signed in.')
  }
}
```

- [ ] **Step 4: Mutant** — restore the unconditional `router.push`. The test MUST fail.

- [ ] **Step 5: Verify + commit**

```bash
git add src/components/shell/AppShell.tsx src/components/shell/AppShell.test.tsx
git commit -m "fix: do not navigate away when sign-out fails

The cookie may still be valid. Landing on /login tells the user they are
signed out when they are not."
```

---

## Task 6: PortalClient — inline, not a toast

**Files:** Modify `src/app/portal/PortalClient.tsx`; create `src/app/portal/PortalClient.test.tsx`

Current (`~line 63`):
```ts
fetch(`/api/portal?${params}`)
  .then((r) => r.json())
  .then(setData)        // a 403 pipes {error: "..."} in as if it were metrics
  .finally(() => setLoading(false))
```
No `res.ok`, no `.catch()` — a network drop is an unhandled rejection.

**This is a page-load failure, so it renders INLINE, not as a toast.** A toast that fades leaves an ambassador staring at a blank portal with no explanation.

- [ ] **Step 1: Write the failing test** — a 403 must show an inline message, and must NOT pipe the error object into `data`.

- [ ] **Step 2: Confirm RED**

- [ ] **Step 3: Fix** — add `res.ok` and `.catch()`; render an inline error where the figures would be. Match `DashboardClient`'s inline load-error shape (read it first).

- [ ] **Step 4: Mutant** — remove the `res.ok` check; the test MUST fail.

- [ ] **Step 5: Verify + commit**

---

## Task 7: AccountClient + ShopsClient — retire the bespoke shapes

**Files:** Modify `src/app/account/AccountClient.tsx`, `src/app/settings/shops/ShopsClient.tsx`

Both already check `res.ok`; both invented their own message shape (`infoNote({tone, text})`, `message`). Migrate **action results** to the toast and delete the bespoke state.

- [ ] **Step 1:** `AccountClient` — `setInfoNote({tone:'ok'|'bad'})` → `toast.success` / `toast.error`. Password change → `toast.success('Your password has been changed.')`.
- [ ] **Step 2:** `ShopsClient` — the `ConnectModal` save → toast.
- [ ] **Step 3: LEAVE `syncAll()` ALONE.** It is explicitly out of scope (spec §10). It reads `data.results ?? []` without checking `res.ok`, so a failed sync reports *"Synced 0 orders from 0 shop(s)"*. **Do not fix it, do not toast it — it needs its own change.** If you touch it by accident, revert.
- [ ] **Step 4:** Existing tests must still pass; update any that asserted the old shapes rather than deleting them.
- [ ] **Step 5: Verify + commit**

---

## Task 8: Full verification

- [ ] `npm test` — all green, including every new test
- [ ] `npx tsc --noEmit` — exit 0
- [ ] `npm run build` — exit 0
- [ ] `npx playwright test` — **all** specs. The `ToastProvider` now wraps every page; if any E2E asserted an inline error that is now a toast, **update the assertion, do not delete it**.
- [ ] **Grep proof:** every `fetch(` in `src/app` and `src/components` is followed by a `res.ok` check — except `syncAll()`, which is knowingly deferred. List any other exception you find.

---

## Definition of done

- [ ] Four suites green: test, tsc, build, playwright
- [ ] No button that acts can fail silently — **`CostsClient.save()` above all**
- [ ] A failed sign-out does **not** navigate
- [ ] Login and invite validation still render **inline** and still persist while retyping
- [ ] Dashboard and Portal load failures still render **inline**
- [ ] `window.scrollTo` is gone from `AmbassadorsClient`
- [ ] A toast reporting a modal's save failure renders **above** that modal

## Known limitations, deliberately not fixed here

`ShopsClient.syncAll()` still reports *"Synced 0 orders from 0 shop(s)"* when the whole request fails. Option C was offered and declined in favour of B. It wants fixing **before** the first real WooCommerce sync, since that is the button that pulls the client's real orders.
