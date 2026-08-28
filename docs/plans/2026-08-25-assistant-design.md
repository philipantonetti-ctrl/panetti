# The assistant, on every page - design

Approved 2026-08-25.

## What it is

The Advisor page's chat becomes a floating assistant available on every admin
page: a round button bottom right, a panel above it. Same conversation follows
the user across pages. It can explain how any figure was calculated, including
the inventory forecast's order suggestion, by reading the same numbers the page
reads. It never estimates.

## What changes, and what deliberately does not

Reused unchanged: the `/api/advisor/chat` route (bounded 8-round tool loop,
prompt caching, transcript trimming, admin-only), the browser-side history, the
no-guessing system prompt. There is no new endpoint, no new table, no new model
call shape. One chat, not two: the Advisor page's inline chat is removed and the
widget serves that page too.

Three additions:

1. **A `get_inventory` tool.** Runs `loadInventory()` - the exact function the
   Inventory and forecasting page runs - and returns each product's working:
   stock and its source, incoming purchase orders, daily rate, seasonal
   adjustment and trend, run-out date, gap, order-by date, needed quantity, the
   quantity after MOQ and container rounding, and which rule raised it. So
   "how did you get one more container of pizza ovens?" is answered from the
   same numbers the page shows, or not at all.

2. **A methodology note in the system prompt** (`src/lib/advisor/methodology.ts`):
   the profit formula, how the forecast walks day by day, what the delivery
   states mean. Method comes from us, figures come from tools. Its own file so
   it is one stable cached block and can be tested for what it must never say.

3. **Page context.** The widget sends the current path; the route turns it into
   one sentence ("The user is looking at Inventory and forecasting") appended
   AFTER the cached system block, so the cache prefix stays byte-identical.

## Who sees it

Admins only, on pages inside the app shell. The ambassador portal renders the
shell with `nav={false}` and marketing with `role="MARKETING"`; neither gets the
widget, because the chat can read company money. That is the same rule the
Advisor page already enforces server-side, and the route's `assertAdmin` remains
the real gate - the widget is only the door.

## Testing, given this calls a paid API

No test ever calls Anthropic. Tool and methodology tests are pure or hit the
local database like the existing tool tests. Widget tests stub `fetch`. The one
e2e opens the widget and checks it is there; it never sends a message, so the
suite costs nothing. A real answer is verified once by hand in the browser.

## Not in this change

Streaming replies, a stored conversation history, voice, or letting the
assistant change anything. It reads and explains. Every tool stays read-only.
