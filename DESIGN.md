# Design

## Theme

**Light.** The scene decides it: the owner reads these numbers at a desk on a large monitor in
daylight, next to a browser full of white shop admin pages. A dark instrument panel would be a
costume — it would look like a trading terminal for a job that is closer to reading a ledger.

## Color strategy

**Restrained.** Neutral surfaces carry the page; one accent, used only for interaction — never
decoration. Money is the only place colour is allowed to mean something.

Deliberately **not purple**: BeProfit's purple chrome is the named anti-reference.

### Roles (OKLCH)

| Token | Value | Use |
|---|---|---|
| `--canvas` | `oklch(0.985 0.002 250)` | App background |
| `--surface` | `oklch(1 0 0)` | Cards, tables, panels |
| `--panel` | `oklch(0.972 0.004 250)` | Second neutral layer: sidebar, toolbars, table headers |
| `--border` | `oklch(0.918 0.005 250)` | Hairlines |
| `--ink` | `oklch(0.24 0.012 255)` | Primary text, primary buttons |
| `--ink-muted` | `oklch(0.46 0.012 255)` | Secondary text — dark enough for 4.5:1 on surface |
| `--accent` | `oklch(0.52 0.11 233)` | Selection, focus, links, active nav. ≤10% of the surface |
| `--accent-soft` | `oklch(0.96 0.02 233)` | Selected row / active nav background |
| `--gain` | `oklch(0.47 0.12 155)` | Profit, positive delta — **numbers only** |
| `--loss` | `oklch(0.52 0.17 25)` | Loss, negative delta — **numbers only** |
| `--warn` | `oklch(0.55 0.13 75)` | Missing cost, unconvertible currency |

Primary buttons are **ink**, not accent: the serious, grounded move (and it keeps the accent scarce
enough to still mean "this is selected").

**Colour never carries meaning alone.** A loss is red *and* signed (`−$3,008`). Colour-blind users
lose nothing.

## Typography

**One family: Geist Sans.** Product UI does not need a display/body pair.

Fixed rem scale (no fluid clamps — the user's DPI does not change):

| Step | Size / weight | Use |
|---|---|---|
| Display | 2rem / 600 | The one hero figure |
| H1 | 1.25rem / 600 | Page title |
| H2 | 0.95rem / 600 | Section heading |
| Body | 0.875rem / 400 | Default |
| Small | 0.8125rem / 400 | Table cells, secondary |
| Micro | 0.6875rem / 500 | Labels, column headers |

**Every number uses `font-variant-numeric: tabular-nums`.** Columns of money must align digit for
digit; this is the single highest-leverage typographic decision in the product.

## Layout

**App shell.** A fixed left sidebar (nav + account) and a content column with a sticky page header.

**Filters live in the page header, not the app chrome.** Which shops and which dates you are looking
at is *page context*: it belongs with the numbers it changes, never next to "sign out". This is the
one structural rule that fixes the original complaint.

- Sidebar 232px, collapses below 1024px.
- Content max-width 1400px; tables may run full width and scroll inside their own container.
- Spacing scale: 4 / 8 / 12 / 16 / 24 / 32 / 48.

## Components

- **Cards**: 1px border, radius 12px, **no drop shadow**. Border *or* shadow — never both.
- **Popovers / dialogs**: shadow, no heavy border, radius 12px.
- **Inputs**: radius 8px, 1px border, visible focus ring in `--accent`.
- **Tables**: `--panel` header, hairline row separators, hover tint, numbers right-aligned and
  tabular. Sticky header on long tables.
- **Stat strip**: one surface divided by hairlines — *not* a grid of identical cards. The primary
  figure is visibly larger than the rest.
- **Loading**: skeletons in the shape of the content. Never a spinner in the middle of a table.
- **Empty states**: teach the next action ("No costs yet — add one and profit starts computing").

Every interactive element ships default / hover / focus / active / disabled states.

## Motion

150–200ms, `ease-out`. Motion conveys state (a popover opening, a row selecting, a number
refreshing) and nothing else. No page-load choreography — the user came to read a number.

`prefers-reduced-motion: reduce` → transitions collapse to instant.

## Z-scale

`--z-dropdown: 20` → `--z-sticky: 30` → `--z-backdrop: 40` → `--z-modal: 50` → `--z-toast: 60`.
No arbitrary 999s.
