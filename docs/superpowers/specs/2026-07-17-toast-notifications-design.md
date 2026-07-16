# ecom-analytics — Toast Notifications Design

**Date:** 2026-07-17
**Status:** Approved for implementation
**Scope:** One feedback system for every button, and making the buttons that currently fail silently tell the truth

---

## 1. Purpose

Every button that talks to the server must tell the user what happened. Today, most of them don't.

---

## 2. What exists today

Audited on 2026-07-17. Ten client components write to the server:

| Component | fetches | checks `res.ok` | shows an error |
|---|---|---|---|
| `CostsClient` | 2 | **0** | **0** |
| `ExpensesClient` | 3 | **0** | **0** |
| `PortalClient` | 1 | **0** | **0** |
| `AppShell` | 1 | **0** | **0** |
| `AccountClient` | 3 | 2 | 0 (uses its own `infoNote`) |
| `ShopsClient` | 2 | 2 | 0 (uses its own `message`) |
| `DashboardClient` | 1 | 1 | 3 |
| `InviteClient` | 1 | 1 | 7 |
| `AmbassadorsClient` | 2 | 3 | 10 |
| `SignInForm` | 1 | 1 | 4 |

**Four components discard the result of every request they make.** Their buttons cannot fail, because nothing looks. And among those that do report, there are already **three competing shapes**: `setError(string)`, `setMessage(string)`, and `setInfoNote({tone, text})`.

`globals.css:57` already declares `--z-toast: 60`. The design system reserved a layer for this and nothing was ever put in it.

### Specific defects this closes

- **`CostsClient.save()`** never inspects `res.ok` and has no `catch`. A rejected save closes the modal, reloads the old value, and shows nothing. Flagged in the first audit; still live.
- **`AppShell.signOut()`** navigates to `/login` whether or not the logout succeeded. The user believes they are signed out while their session cookie is still valid — on a shared machine, that is not cosmetic.
- **`PortalClient`** does `.then((r) => r.json()).then(setData)` with no `res.ok` and no `.catch()`. A 403 pipes `{error: "…"}` into state as though it were metrics; a network drop is an unhandled rejection.
- **`AmbassadorsClient`** renders its error at the top of the page. With a long table the message lands ~1600px above the viewport, so a refusal reads as "nothing happened". A `window.scrollTo` was added as a stopgap. The toast is the real fix, and that stopgap is deleted here.

---

## 3. Guiding constraint

The owner's standing rule is that this project stays simple. This design adds **no dependencies**. The app runs on eight runtime packages and nothing for UI beyond `recharts`; a toast library would arrive with opinions about a design system that already has its own, and `--z-toast` shows the house intended a bespoke one.

---

## 4. Architecture

Three files, no dependencies:

| File | Responsibility |
|---|---|
| `src/components/toast/ToastProvider.tsx` | Context, the queue, auto-dismiss timers |
| `src/components/toast/Toaster.tsx` | Renders the stack. Uses `--z-toast: 60` |
| `src/components/toast/useToast.ts` | The hook consumers call |

`ToastProvider` wraps `{children}` in `src/app/layout.tsx`. It is a client component inside the server layout, which is why it must be mounted there and not in `AppShell`: **`/login` and `/invite/[token]` have no `AppShell`**, and both need feedback.

---

## 5. The API

```tsx
const toast = useToast()
toast.success('Invite link copied')
toast.error(serverMessage)
```

Two methods. That is the entire surface. `useToast()` outside a provider throws — a missing provider must fail loudly at development time, not silently swallow messages in production.

---

## 6. Behaviour

- **Position:** bottom-right — clear of the sidebar and of the table rows being acted on.
- **Success: 4 seconds. Error: 10 seconds.** Errors carry the server's own wording, and *"This ambassador has sales on record, so deleting them would erase that history. Deactivate them instead."* is not a four-second read.
- Both are **dismissible by click**.
- Toasts **stack**, newest at the bottom. A feedback system that drops messages under rapid clicks is the disease it was built to cure.
- The region carries `role="status"` and `aria-live="polite"`.
- Timers are cleared on unmount — a dismiss timer firing after unmount is a state update on a dead component.

---

## 7. What is a toast, and what stays where it is

There are **three** kinds of message, not two:

| Kind | Where it lives | Which |
|---|---|---|
| **Action result** — the user clicked something | **Toast** | Ambassadors, Account, Shops, Costs, Expenses, sign-out |
| **Form validation** | **Inline, unchanged** | `SignInForm`, `InviteClient` |
| **Page-load failure** | **Inline, unchanged** | `DashboardClient`, `PortalClient` |

**Why form validation stays inline:** "Wrong email or password" must sit under the field and **persist while the user retypes**. A toast counting down to nothing is strictly worse there.

**Why load failures stay inline:** they replace the content. A toast that fades leaves the user staring at a blank dashboard with no explanation of why.

The rule in one line: **a toast reports what an action did; it never carries the state of a page or a field.**

---

## 8. Making every button honest

A toast can only show a failure that something caught. Wiring toasts into the four silent components changes nothing on its own — their failures are discarded before anything can notice. So each gets its missing check:

- **`CostsClient.save()`** — check `res.ok`; **do not close the modal on failure**; toast the server's error. Use `try`/`finally` so the button cannot stick on "Saving…".
- **`ExpensesClient`** — three unchecked fetches (load, delete, save). Add checks; toast action results.
- **`PortalClient`** — add `res.ok` and `.catch()`. Its failure is a **load** failure, so it renders **inline**, not as a toast.
- **`AppShell.signOut()`** — **do not navigate if the logout failed.** Toast instead. Navigating on failure is the actual bug; the missing toast is only how it stayed invisible.

The three components with their own message shapes (`AccountClient`'s `infoNote`, `ShopsClient`'s `message`, `AmbassadorsClient`'s `error`) migrate to the toast for **action results**. `AmbassadorsClient`'s `window.scrollTo` stopgap is deleted.

---

## 9. Testing

- **Provider** (`ToastProvider.test.tsx`, jsdom + fake timers): a toast appears; success auto-dismisses at 4s; error persists to 10s; click dismisses; two toasts stack rather than replace; timers are cleared on unmount.
- **Per fixed button:** a test proving a **failed** request now surfaces a message. Each pinned by a mutant that removes the `res.ok` check — the test must fail without it, or it is worth nothing.
- **`AppShell.signOut`:** a failed logout must **not** navigate. This is the one where a passing test matters most.
- Component tests use the pattern established on 2026-07-17: `// @vitest-environment jsdom` per-file docblock (the global environment stays `node`), mocking `next/navigation` and `next/link`.

---

## 10. Explicitly out of scope

No toast library. No positioning options, themes, or per-call duration overrides. No promise/loading toasts. No undo actions. No queue limit or de-duplication — with one admin and ten call sites, neither earns its complexity yet.

**`ShopsClient.syncAll()` is deliberately left alone.** It reads `data.results ?? []` without checking `res.ok`, so a failed sync reports *"Synced 0 orders from 0 shop(s)"* — a total failure presented as a successful sync of nothing. This was offered and explicitly deferred. It wants fixing before the first real WooCommerce sync, but not here.

---

## 11. Risks

- **Toasts vanish.** Anything a user must act on, or read at their own pace, does not belong in one — which is exactly why sections 7 keeps form and load errors inline. If a future message is important enough to need re-reading, it is not a toast.
- **The toast must clear the modals.** Verified: `globals.css:55-57` declares `--z-backdrop: 40`, `--z-modal: 50`, `--z-toast: 60`, so the scale is already right. But all three modals (`CostsClient.tsx:318`, `ExpensesClient.tsx:423`, `AmbassadorsClient.tsx:430`) **hardcode the Tailwind class `z-50` rather than `var(--z-modal)`** — the tokens are declared and unused, and only happen to agree. The `Toaster` uses `var(--z-toast)`, which is what the token was declared for, and a test must pin that a toast reporting a modal's own save failure renders **above** it. Migrating the modals onto their token is a separate, unrelated tidy-up and is not done here.
- **Timing is not covered by fake timers alone.** The auto-dismiss durations are asserted with fake timers, which proves the logic, not the feel. Real durations need a human to judge.
