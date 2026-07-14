# Product

## Register

product

## Users

**The owner/operator (primary).** Runs a group of regional WooCommerce shops (Panetti, Mazzetti,
Massasjepistoler, Bellino) across Norway, Sweden, Denmark, Finland and Germany. Sits at a desk on a
large screen, in daylight, and asks one question before anything else: *did we actually make money,
and where?* They already live in BeProfit and know what good looks like. They are not a developer.

**Ambassadors (secondary).** ~24 people who promote the shops with a personal discount code. They
log in occasionally — often on a phone — to see one thing: *how much have I sold and what have I
earned?* They must never see company costs, profit, or each other.

## Product Purpose

One place to see whether the business is making money, per shop and in total, and to see exactly
which ambassadors are driving it.

It replaces the reporting the owner gets from BeProfit and adds what BeProfit cannot do: ambassadors
logging in to see their own numbers. Success is the owner opening the dashboard each morning,
trusting the number, and knowing what to do next — without exporting anything to a spreadsheet.

Later phases add ad platforms (Meta, Google), web analytics, shipping and customer service. The
design must hold when those columns and pages arrive.

## Brand Personality

**Calm. Precise. Trustworthy.**

The voice of a good financial instrument: it states the number, shows what it is made of, and gets
out of the way. It never celebrates, never nags, never decorates. When a figure is uncertain
(a missing product cost, a currency we hold no rate for) it says so plainly rather than showing a
confident wrong number.

Emotionally: the user should feel *in control and unhurried* — the opposite of squinting at a
spreadsheet at midnight.

## Anti-references

- **BeProfit's heavy purple chrome** — the dark purple sidebar and purple-everywhere skin. We keep
  its good ideas (the multi-shop compare table, the date-range presets) and drop the costume.
- **Generic template admin** — identical cards in a grid, stock icons, no point of view.
- **Toy/startup playful** — pastel gradients, oversized radii, emoji as decoration. This is money.
- **Cluttered enterprise** — everything on screen at once with no hierarchy.

## Design Principles

1. **The number is the interface.** Money is the content. Everything else — chrome, labels, nav —
   recedes so figures can be scanned and compared without effort. Tabular numerals, aligned columns,
   consistent currency formatting, always.
2. **Say when you don't know.** A missing cost, an unconvertible currency, a refunded order: surface
   it. A confident wrong number is the worst thing this product could ship.
3. **Filters are page context, not account chrome.** What you are looking at (which shops, which
   dates) belongs with the content it changes — never buried next to "sign out".
4. **Earned familiarity.** Standard app-shell patterns, standard controls. The user should never
   have to learn our invention for a task they already know how to do.
5. **Density with hierarchy.** Show a lot — 11 shops, 10 columns — but make the one number that
   matters unmistakably the loudest thing on the page.

## Accessibility & Inclusion

- Body text ≥ 4.5:1 contrast; large text ≥ 3:1. No light-grey-on-white "elegance".
- Profit and loss are never communicated by colour alone — a sign (−) and position carry the meaning
  too, so red/green colour-blindness never hides a loss.
- Full keyboard operation for the filters, tables and dialogs; visible focus rings.
- `prefers-reduced-motion` honoured: transitions become instant, nothing animates on load.
- Screens are read in daylight on a bright display → light theme by default.
