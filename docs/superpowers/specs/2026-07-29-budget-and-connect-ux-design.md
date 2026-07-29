# Daily budgets, the client's Google column set, and connect buttons that explain themselves

Date: 2026-07-29
Status: approved for implementation. Follows 2026-07-29-ads-oauth-connect-design.md.

## Why

The client asked for exactly these Google Ads columns: Budget, Amount spent,
Conversions, Conversion value, ROAS, Avg. CPC, Clicks. Everything but Budget
already syncs. He also could not press "Connect with Facebook / Google" — on
production the one-time Platform setup is still empty, so the buttons rendered
disabled with only a hover tooltip to say why. Correct behavior, failed
explanation.

## Connect buttons

A button that cannot be pressed and cannot say why is a dead end. The buttons
are now always pressable: when the platform setup is missing, pressing one
shows a toast in plain words ("One-time setup needed first. Two minutes, the
steps are right below.") and scrolls to the Platform setup section. When setup
exists they stay links straight into the OAuth flow. The server-side guard
(redirect with an error) remains as the backstop.

## Daily budget

"Budget" in Ads Manager is the campaign's current daily budget — a setting,
not a day-by-day series. So it lives on the account, refreshed at every sync:
`AdAccount.dailyBudget Int?` (minor units, account currency).

- **Meta:** `GET /act_{id}/insights`' sibling `GET /act_{id}/campaigns?fields=
  daily_budget,effective_status` (paged, capped): sum `daily_budget` over
  ACTIVE campaigns. Meta returns budgets in the account currency's minor units.
- **Google:** GAQL `SELECT campaign.status, campaign_budget.resource_name,
  campaign_budget.amount_micros FROM campaign WHERE campaign.status = 'ENABLED'`;
  budgets deduped by resource name so a shared budget counts once; micros to
  minor units.
- Best-effort: a failed budget fetch keeps the previous value and never fails
  the spend sync. An account with no budget information stays null and shows a
  dash — never a zero pretending.

`buildMarketing` gains a `to: Date` argument and sums each account's budget
converted at the range-end rate (a current setting converts at the current
rate). Row and total gain `dailyBudget: number | null` (null when no account
in the row reports a budget).

## Table defaults

The everyday view becomes the client's own list plus the store context:
Ad spend, Daily budget, Purchases, Conv. value, P. ROAS, Cost/purchase,
Avg. CPC (relabelled from CPC), Clicks, Store ROAS, Gross revenue, Orders,
CPA. Everything else stays one tick away in Select metrics. A browser that
already saved its own column choice keeps it.

## Testing

Unit: both budget fetchers (ACTIVE/ENABLED filtering, shared-budget dedupe,
paging, minor-unit maths), buildMarketing budget summing + null + conversion at
range end. Integration: sync stores the budget, a budget failure leaves the
sync green and the old value standing; marketing route returns `dailyBudget`.
Component: connect button toast-and-scroll when unready, link when ready;
table default columns match the list above. E2E: existing specs stay green.
