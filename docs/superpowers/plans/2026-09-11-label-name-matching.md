# Label-Name Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A parcel whose warehouse label names a customer attaches itself to that customer's order automatically, for every carrier, and the Delivery page lists only the parcels no rule could place, each with one dropdown.

**Architecture:** Orders get a folded name key (`customerNameKey`). The warehouse xlsx reader gains a label reader that maps every long number on a row to the row's `Namn`. A `matchByName` sits beside `matchByEmail` with the same window and exclusion rules. One module, `attach.ts`, decides email-then-name for a row and is called by the importer, the carrier identification step and an hourly sweep. The page section is rewritten around a `<select>`.

**Tech Stack:** Next.js 15 app routes, Prisma on PostgreSQL, vitest (projects `app` and `delivery`), Playwright, fflate for xlsx.

**Spec:** `docs/superpowers/specs/2026-09-11-label-name-matching-design.md`

## Global Constraints

- Work in the worktree `C:/Users/Acer Philippines/OneDrive/Desktop/Philip project/panetti/.claude/worktrees/label-name` on branch `feat/label-name-matching`. Never run `git stash`, `git checkout --`, `git checkout <branch>`, `git switch`, `git reset`, `git restore` or `git clean`: other agents share this repository and those commands have silently reverted work before. Commit with `git add <files>` and `git commit`.
- Edit files with the Edit/Write tools only. Never rewrite a file through PowerShell `Get-Content`/`Set-Content` (it corrupts UTF-8).
- Dependencies are installed and `npx prisma generate` has been run. After Task 1 changes the schema, run `npx prisma generate` and `node scripts/db-push.mjs` (it retries constraint-only warnings) in the worktree.
- Test data convention: every integration test tags what it creates with a string unique to that file (for example `[label-match-test]`) and deletes only what carries the tag, so files can run beside each other. Tracking numbers in tests start with a prefix unique to the file.
- Integration tests under `src/lib/{delivery,bring,dhl}/**/*.integration.test.ts` and `src/app/api/delivery/**` belong to the vitest `delivery` project: `npx vitest run --project delivery <path>`. Unit tests and `.test.tsx` files run in the `app` project: `npx vitest run --project app <path>`. Under load, 5 s timeouts flake; re-run a red file alone with `--testTimeout=20000` before calling it a bug.
- The local Postgres must be running: `"$LOCALAPPDATA/panetti-pg/pgsql/bin/pg_isready.exe"` (start with `cmd //c "%LOCALAPPDATA%\panetti-pg\start-pg.cmd"`). Never point tests at a Neon URL.
- No em dashes anywhere, in code, comments, copy or commit messages. Use a plain hyphen. In regexes write Unicode ranges as escapes (`\u0300-\u036f`), never as literal characters.
- Customer emails are never sent to the browser on a parcel row. Recipient NAME may be shown.
- `Shipment.linkSource` gains `FILE_NAME` (the label's name matched one order) beside `FILE | BRING_EMAIL | NYCE | WOO | MANUAL | DHL_FILE | DHL_REF`.
- Copy, verbatim from the spec: section heading **"Parcels that need a person"**; subtitle **"Parcels are matched to orders by the customer's email or by the name on the label, automatically. These are the ones no rule could place, each with the reason."**; select placeholder **"Choose the order"**; option suffixes **" · same name as the label"** and **" · already has a parcel"**; buttons **"Link"**, **"Not a customer parcel"**, **"Other order"**; no-name text **"no name yet"**; reasons **"The label carries no name"**, **"The label says {name} and no order in the last 30 days has that name"** (plus **" in {country}"** when a country was applied), **"The label says {name} and {count} orders in the last 30 days have that name: {list}"**, DHL no-name reason **"DHL parcel to {country}: DHL gives no name or email, and no warehouse file has named this parcel yet. Upload the file for its day and it will match itself."**, Bring no-email-no-name reason **"Bring holds no email for this parcel and no warehouse file has named it"**; imports line **"{n} names"** and **"no names read from this file"**.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01RTqrz3yhJWDA9tWTNPtD3K
  ```
  The model name in that trailer is part of the requirement: it is "Claude Fable 5.1", whatever model you believe you are.

---

## File structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` | `Order.customerNameKey` + index, `TrackingImport.namesRead`, `linkSource` comment. |
| `src/lib/delivery/name-key.ts` (new) | Pure: fold a name to its key. |
| `src/lib/delivery/name-key-backfill.ts` (new) | Compute keys for orders that have none, newest first, in bulk. |
| `src/lib/woo/map.ts`, `src/lib/woo/sync.ts`, `src/lib/visma/import.ts`, `src/app/api/b2b/orders/route.ts`, `src/app/api/b2b/orders/[id]/route.ts` | Write the key wherever a customer name is written. |
| `src/app/api/cron/sync/route.ts` | Runs the backfill before the parcel poll. |
| `src/lib/bring/labels.ts` (new) | Read `Namn` per long number from the warehouse xlsx. |
| `src/lib/bring/match.ts` | `matchByName`, sharing the window and exclusion clauses with `matchByEmail`. |
| `src/lib/delivery/attach.ts` (new) | Decide email-then-name for a row; write the link or the reason; hourly sweep. |
| `src/lib/delivery/identify.ts` | Keep the file's name; link via `attach` decisions; new DHL reason; `rematchByEmail` removed. |
| `src/lib/delivery/sync.ts` | Sweep at the start of a run; selects `recipientName`; no per-poll re-match. |
| `src/lib/bring/import.ts` | Reads labels, names rows, name-matches, records `namesRead`. |
| `src/lib/delivery/candidates.ts` | Same-name candidates first; limit 30. |
| `src/app/api/delivery/route.ts` | `namesRead` on import rows. |
| `src/app/delivery/DeliveryClient.tsx` | The rewritten section and the imports line. |
| `e2e/delivery-link-by-hand.spec.ts` | Dropdown flow, same-name option first. |
| `docs/delivery-tracking-guide.md` | The section in the new words; re-reading old files. |

---

### Task 1: The name key, on every order

**Files:**
- Modify: `prisma/schema.prisma` (model `Order`, model `TrackingImport`, the `linkSource` comment on `Shipment`)
- Create: `src/lib/delivery/name-key.ts`, `src/lib/delivery/name-key.test.ts`
- Create: `src/lib/delivery/name-key-backfill.ts`, `src/lib/delivery/name-key-backfill.integration.test.ts`
- Modify: `src/lib/woo/map.ts:64,125`, `src/lib/woo/map.test.ts`, `src/lib/woo/sync.ts:206,373`, `src/lib/visma/import.ts:448`, `src/app/api/b2b/orders/route.ts:170`, `src/app/api/b2b/orders/[id]/route.ts:86,167`, `src/app/api/cron/sync/route.ts:455`

**Interfaces:**
- Produces: `nameKey(name: string | null | undefined): string`; `backfillNameKeys(limit?: number): Promise<number>`; `Order.customerNameKey: string | null`; `TrackingImport.namesRead: number | null`.

- [ ] **Step 1: Schema**

In `prisma/schema.prisma`, model `Order`, directly under `customerName      String?`, add:

```prisma
  /// customerName folded for matching: accents stripped, lower-cased, words
  /// sorted (see lib/delivery/name-key.ts). Same tri-state as customerName:
  /// null = not computed yet (the sync tick backfills), '' = computed, no name.
  customerNameKey   String?
```

and among the indexes of `Order` add `@@index([customerNameKey, placedAt])`.

Model `TrackingImport`, under `unmatched     String?`, add:

```prisma
  /// Rows of the warehouse file that carried a recipient name (column Namn).
  /// 0 = the file was read but had no readable names; null = a path that does
  /// not read names (the DHL export, the old order-number path).
  namesRead     Int?
```

On `Shipment.linkSource` extend the comment list to `FILE | BRING_EMAIL | NYCE | WOO | MANUAL | DHL_FILE | DHL_REF | FILE_NAME` and add the line `/// FILE_NAME: the name on the warehouse label matched exactly one order.`

Run:

```bash
npx prisma generate && node scripts/db-push.mjs
```

- [ ] **Step 2: Failing unit test for the key**

`src/lib/delivery/name-key.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { nameKey } from './name-key'

describe('nameKey', () => {
  it('folds case, accents, punctuation and word order', () => {
    expect(nameKey('Röthke, Martin')).toBe('martin rothke')
    expect(nameKey('martin ROTHKE')).toBe('martin rothke')
    expect(nameKey('  Anitta   Airi ')).toBe('airi anitta')
    expect(nameKey('Jörg Schladweiler')).toBe('jorg schladweiler')
    expect(nameKey('Rei\u2019tetty Pizzalapio')).toBe('pizzalapio rei tetty')
  })
  it('maps the letters NFD cannot decompose', () => {
    expect(nameKey('Søren Ø. Kjærgaard')).toBe('kjaergaard o soren')
    expect(nameKey('Großmann Straße')).toBe('grossmann strasse')
    expect(nameKey('Łukasz Đorđević')).toBe('dordevic lukasz')
  })
  it('keeps digits and gives an empty key for nothing', () => {
    expect(nameKey('Firma 24 GmbH')).toBe('24 firma gmbh')
    expect(nameKey('')).toBe('')
    expect(nameKey('   ')).toBe('')
    expect(nameKey('---')).toBe('')
    expect(nameKey(null)).toBe('')
    expect(nameKey(undefined)).toBe('')
  })
})
```

Run: `npx vitest run --project app src/lib/delivery/name-key.test.ts` - expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/lib/delivery/name-key.ts`:

```ts
/**
 * A customer's name folded to the form two spellings of it share.
 *
 * The warehouse prints the recipient's name on the label from the order, so
 * the two strings are the same name; but one side may be upper-cased,
 * "Last, First", or typed without the accent. Folding both sides the same
 * way is what lets equality do the matching, and measured on 90 linked
 * parcels (2026-09-11) it agreed 90 times.
 *
 * NFD splits an accented letter into the letter and a combining mark, and
 * the mark is dropped. The letters NFD cannot split (ø, æ, ß, œ, ł, đ) are
 * mapped by hand; without that "Søren" would fold to "s ren".
 */
const SINGLE: Record<string, string> = {
  '\u00f8': 'o', '\u00e6': 'ae', '\u00df': 'ss', '\u0153': 'oe', '\u0142': 'l', '\u0111': 'd', '\u00f0': 'd', '\u00fe': 'th',
}

export function nameKey(name: string | null | undefined): string {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u00f8\u00e6\u00df\u0153\u0142\u0111\u00f0\u00fe]/g, (c) => SINGLE[c] ?? c)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ')
}
```

Run the test again - expected: PASS.

- [ ] **Step 4: Write the key wherever a name is written**

`src/lib/woo/map.ts`: in `MappedOrder` (line 64) under `customerName: string` add `customerNameKey: string`; in `mapOrder` compute the name once and key it:

```ts
  const customerName = [woo.billing?.first_name, woo.billing?.last_name].filter(Boolean).join(' ').trim()
```

before the `return`, then in the returned object replace the `customerName:` line with:

```ts
    customerName,
    customerNameKey: nameKey(customerName),
```

and add `import { nameKey } from '../delivery/name-key'` at the top. In `src/lib/woo/map.test.ts` beside the existing `expect(o.customerName).toBe('Tino Skaarup')` (line 85) add `expect(o.customerNameKey).toBe('skaarup tino')`, and beside each `expect(o.customerName).toBe('')` (lines 93 and 99) add `expect(o.customerNameKey).toBe('')`.

`src/lib/woo/sync.ts` line 206 area: after `customerName: o.customerName,` add `customerNameKey: o.customerNameKey,`. In `backfillCustomers` (line 373 area) compute the final name first:

```ts
    const customerName = o?.customerName ?? m.customerName ?? ''
    await db.order.update({
      where: { id: m.id },
      data: {
        customerName,
        customerNameKey: nameKey(customerName),
        customerEmail: o?.customerEmail ?? m.customerEmail ?? '',
        customerPhone: o?.customerPhone ?? m.customerPhone ?? '',
      },
    })
```

(keep the existing comment above it) and add the import `import { nameKey } from '../delivery/name-key'`.

`src/lib/visma/import.ts` line 448: after `customerName: customer.name,` add `customerNameKey: nameKey(customer.name),` with the import `import { nameKey } from '../delivery/name-key'`.

`src/app/api/b2b/orders/route.ts` line 170 and `src/app/api/b2b/orders/[id]/route.ts` line 167: after `customerName: w.customer.name,` add `customerNameKey: nameKey(w.customer.name),`. `[id]/route.ts` line 86 is a GET response field, not a write: leave it. Import with `import { nameKey } from '@/lib/delivery/name-key'`.

Run `npx tsc --noEmit -p .` - expected: clean (fix any spot where `MappedOrder` is constructed by hand in a test by adding `customerNameKey`).

- [ ] **Step 5: Failing integration test for the backfill**

`src/lib/delivery/name-key-backfill.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { backfillNameKeys } from './name-key-backfill'

const TAG = '[name-key-backfill-test]'
const scoped = { shop: { name: { contains: TAG } } }
let shopId: string

async function cleanup() {
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Shop ${TAG}`, currency: 'NOK' } })).id
})

const order = (number: string, customerName: string | null, placedAt: string, customerNameKey: string | null = null) =>
  db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(placedAt), status: 'completed', currency: 'NOK',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName, customerNameKey,
    },
  })

describe('backfillNameKeys', () => {
  it('keys the rows that have a name and no key, newest first, and leaves the rest alone', async () => {
    const old = await order('NK-OLD', 'Røthke Martin', '2026-01-01T00:00:00Z')
    const fresh = await order('NK-NEW', 'Anitta Airi', '2026-09-01T00:00:00Z')
    const empty = await order('NK-EMPTY', '', '2026-08-01T00:00:00Z')
    const noName = await order('NK-NONAME', null, '2026-08-02T00:00:00Z')
    const keyed = await order('NK-KEYED', 'Someone Else', '2026-08-03T00:00:00Z', 'kept as is')

    expect(await backfillNameKeys(2)).toBe(2)
    const after = async (id: string) => (await db.order.findUnique({ where: { id }, select: { customerNameKey: true } }))?.customerNameKey
    expect(await after(fresh.id)).toBe('airi anitta')
    expect(await after(empty.id)).toBe('')
    expect(await after(old.id)).toBeNull()
    expect(await after(noName.id)).toBeNull()
    expect(await after(keyed.id)).toBe('kept as is')

    expect(await backfillNameKeys()).toBeGreaterThanOrEqual(1)
    expect(await after(old.id)).toBe('martin rothke')
    expect(await after(noName.id)).toBeNull()
  })
})
```

Run: `npx vitest run --project delivery src/lib/delivery/name-key-backfill.integration.test.ts` - expected: FAIL, module not found.

- [ ] **Step 6: Implement the backfill**

`src/lib/delivery/name-key-backfill.ts`:

```ts
import { db } from '../db'
import { nameKey } from './name-key'

/**
 * Orders synced before the key existed get theirs here, newest first, so the
 * 30-day window the matcher reads is keyed within the first tick. No
 * WooCommerce call: the name is already stored, only the fold is missing.
 *
 * Batches go down as ONE statement each. Row-by-row updates cost the tick
 * seconds per thousand on the pooled connection; unnest costs it one round
 * trip. Once history is keyed this is a single cheap read per tick.
 */
export const NAME_KEY_BACKFILL_PER_TICK = 5000
const BATCH = 1000

export async function backfillNameKeys(limit = NAME_KEY_BACKFILL_PER_TICK): Promise<number> {
  let done = 0
  while (done < limit) {
    const rows = await db.order.findMany({
      where: { customerNameKey: null, customerName: { not: null } },
      orderBy: { placedAt: 'desc' },
      take: Math.min(BATCH, limit - done),
      select: { id: true, customerName: true },
    })
    if (rows.length === 0) break
    const ids = rows.map((r) => r.id)
    const keys = rows.map((r) => nameKey(r.customerName))
    await db.$executeRaw`
      UPDATE "Order" AS o SET "customerNameKey" = v.key
      FROM unnest(${ids}::text[], ${keys}::text[]) AS v(id, key)
      WHERE o.id = v.id`
    done += rows.length
    if (rows.length < BATCH) break
  }
  return done
}
```

If Prisma refuses the array parameter, fall back to `Prisma.join` of `Prisma.sql\`(${id}, ${key})\`` pairs inside `FROM (VALUES ...) AS v(id, key)`; the test decides.

Run the test - expected: PASS.

- [ ] **Step 7: Call it from the cron tick**

`src/app/api/cron/sync/route.ts`: import `backfillNameKeys` from `@/lib/delivery/name-key-backfill`. Directly above the `// Parcel tracking, last of the data pulls.` comment (line 452 area) add:

```ts
  // Name keys for orders synced before the key existed. Newest first and
  // bounded, so the parcel matcher's 30-day window is keyed on the first
  // tick and history follows over the next few. No network call.
  let nameKeys = 0
  try {
    nameKeys = await backfillNameKeys()
  } catch {
    // Next tick retries; the matcher simply finds fewer names until then.
  }
```

and add `nameKeys,` to the object passed to `NextResponse.json` where `shipments` is reported (search for `shipments,` in that object; place it on the next line).

Run `npx tsc --noEmit -p .` and `npx vitest run --project app src/app/api/cron` - expected: clean and green.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma src/lib/delivery/name-key.ts src/lib/delivery/name-key.test.ts src/lib/delivery/name-key-backfill.ts src/lib/delivery/name-key-backfill.integration.test.ts src/lib/woo/map.ts src/lib/woo/map.test.ts src/lib/woo/sync.ts src/lib/visma/import.ts src/app/api/b2b/orders/route.ts "src/app/api/b2b/orders/[id]/route.ts" src/app/api/cron/sync/route.ts
git commit -m "feat(orders): a folded name key on every order, backfilled by the sync tick"
```

---

### Task 2: The label reader

**Files:**
- Create: `src/lib/bring/labels.ts`, `src/lib/bring/labels.test.ts`

**Interfaces:**
- Consumes: `xlsxToRows(buf: Buffer): Record<string, string>[]` from `src/lib/dhl/sheet.ts`; `nameKey` from Task 1.
- Produces: `readLabels(buf: Buffer, filename: string): Labels | null` with `type Labels = { names: Map<string, string>; rows: number }`. Keys of `names` are digit strings (15+ digits); values are trimmed names.

- [ ] **Step 1: Failing test**

`src/lib/bring/labels.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { readLabels } from './labels'

/**
 * The warehouse's LTAS end-of-day report. Column names are the real ones;
 * every value is invented. Long numbers are stored as shared strings, which
 * is how Excel keeps an 18-digit id intact.
 */
const HEADERS = ['Datum', 'Antal', 'Order', 'Namn', 'KolliID', 'S\u00e4ndningsref', 'Levs\u00e4tt', 'Vikt']
type Row = Partial<Record<string, string>>
const col = (i: number) => String.fromCharCode(65 + i)

const book = (rows: Row[], headers: string[] = HEADERS) => {
  const strings: string[] = []
  const idx = (v: string) => {
    const at = strings.indexOf(v)
    return at === -1 ? strings.push(v) - 1 : at
  }
  const cells = (values: string[], r: number) =>
    values
      .map((v, i) => (v === '' ? `<c r="${col(i)}${r}" s="1"/>` : `<c r="${col(i)}${r}" t="s"><v>${idx(v)}</v></c>`))
      .join('')
  const body = rows
    .map((row, n) => `<row r="${n + 2}">${cells(headers.map((h) => row[h] ?? ''), n + 2)}</row>`)
    .join('')
  const head = `<row r="1">${cells(headers, 1)}</row>`
  return Buffer.from(
    zipSync({
      'xl/sharedStrings.xml': strToU8(`<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${head}${body}</sheetData></worksheet>`),
    }),
  )
}

const row = (over: Row = {}): Row => ({
  Datum: '2026-09-10 08:19:24', Antal: '1', Order: '027286', Namn: 'Martin R\u00f6thke',
  KolliID: '473325380030453648', 'S\u00e4ndningsref': '73325380030453641', 'Levs\u00e4tt': 'BOXHD_NO', Vikt: '16.4',
  ...over,
})

describe('readLabels', () => {
  it('maps the KolliID and the S\u00e4ndningsref of a row to its name', () => {
    const r = readLabels(book([row()]), 'LTAS_EoD_Exp_Report_20260910_18-00.xlsx')
    expect(r?.rows).toBe(1)
    expect(r?.names.get('473325380030453648')).toBe('Martin R\u00f6thke')
    expect(r?.names.get('73325380030453641')).toBe('Martin R\u00f6thke')
    expect(r?.names.size).toBe(2)
  })

  it('reads the header however it is cased and skips rows with no name or no long number', () => {
    const headers = HEADERS.map((h) => (h === 'Namn' ? 'NAMN' : h))
    const r = readLabels(
      book(
        [
          row({ NAMN: 'Anitta Airi', Namn: undefined }),
          row({ NAMN: '', Namn: undefined, KolliID: '473325380030453655', 'S\u00e4ndningsref': '' }),
          row({ NAMN: 'No Number', Namn: undefined, KolliID: '', 'S\u00e4ndningsref': '' }),
          row({ NAMN: '---', Namn: undefined, KolliID: '473325380030453662', 'S\u00e4ndningsref': '' }),
        ],
        headers,
      ),
      'x.xlsx',
    )
    expect(r?.rows).toBe(1)
    expect(r?.names.get('473325380030453648')).toBe('Anitta Airi')
    expect(r?.names.has('473325380030453655')).toBe(false)
    expect(r?.names.has('473325380030453662')).toBe(false)
  })

  it('ignores short numbers such as the date and the warehouse counter', () => {
    const r = readLabels(book([row({ Order: '999999999999', Datum: '2026-09-10 08:19:24' })]), 'x.xlsx')
    expect([...r!.names.keys()].every((k) => k.length >= 15)).toBe(true)
  })

  it('returns null without a Namn column, with no rows, or for a file that is not xlsx', () => {
    expect(readLabels(book([row()], HEADERS.filter((h) => h !== 'Namn')), 'x.xlsx')).toBeNull()
    expect(readLabels(book([]), 'x.xlsx')).toBeNull()
    expect(readLabels(Buffer.from('Datum;Namn;KolliID\n2026;Someone;473325380030453648\n'), 'x.csv')).toBeNull()
    expect(readLabels(Buffer.from('not a zip'), 'x.xlsx')).toBeNull()
  })
})
```

Run: `npx vitest run --project app src/lib/bring/labels.test.ts` - expected: FAIL, module not found.

- [ ] **Step 2: Implement**

`src/lib/bring/labels.ts`:

```ts
import { xlsxToRows } from '../dhl/sheet'
import { nameKey } from '../delivery/name-key'

/**
 * The recipient's name for every long number in the warehouse's report.
 *
 * `parseTrackingNumbers` reads the same file as a bag of long numbers on
 * purpose, so a change of column order or heading is not an outage. This
 * reader keeps that promise as far as it can: the ONE heading it depends on
 * is `Namn`, found by its folded spelling, and the numbers on a row are
 * taken from every cell rather than from a named column. The KolliID (18
 * digits) and the S\u00e4ndningsref (17 digits) both map to the row's name, so
 * whichever number Bring or DHL later answers to finds it.
 *
 * Null means "this file gives no names": a csv, a sheet with no such column,
 * or an archive that will not open. The number path reports its own error
 * for the last; here null simply means the import goes on without names.
 */
export type Labels = { names: Map<string, string>; rows: number }

/** The same floor as extractLongNumbers: a timestamp is 14 digits, a parcel is 17 or 18. */
const MIN_DIGITS = 15

export function readLabels(buf: Buffer, filename: string): Labels | null {
  if (!filename.toLowerCase().endsWith('.xlsx')) return null
  let rows: Record<string, string>[]
  try {
    rows = xlsxToRows(buf)
  } catch {
    return null
  }
  if (rows.length === 0) return null
  const header = Object.keys(rows[0]).find((h) => nameKey(h) === 'namn')
  if (!header) return null

  const names = new Map<string, string>()
  let counted = 0
  for (const row of rows) {
    const name = (row[header] ?? '').trim()
    if (!name || nameKey(name) === '') continue
    let found = false
    for (const [column, value] of Object.entries(row)) {
      if (column === header) continue
      const digits = (value ?? '').replace(/\D/g, '')
      if (digits.length < MIN_DIGITS) continue
      names.set(digits, name)
      found = true
    }
    if (found) counted++
  }
  return { names, rows: counted }
}
```

Run the test - expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/bring/labels.ts src/lib/bring/labels.test.ts
git commit -m "feat(delivery): read the recipient name off every row of the warehouse file"
```

---

### Task 3: Match by name

**Files:**
- Modify: `src/lib/bring/match.ts`
- Modify: `src/lib/bring/match.integration.test.ts`

**Interfaces:**
- Produces: `matchByName(name: string | null, receivedAt: Date, scope?: NameScope): Promise<MatchOutcome>`; `export type NameScope = MatchScope & { country?: string | null }`. `MatchOutcome`, `MatchScope`, `MATCH_WINDOW_DAYS`, `matchByEmail` unchanged.

- [ ] **Step 1: Failing tests**

Append to `src/lib/bring/match.integration.test.ts` (inside the file, after the `matchByEmail` describe; it reuses `order`, `trackedShopId`, `untrackedShopId`, `RECEIVED`, `DAY` from the top of the file - if `DAY` is not defined there, add `const DAY = 24 * 60 * 60 * 1000`):

```ts
describe('matchByName', () => {
  const named = (shopId: string, number: string, name: string, placedAt: string, extra: Record<string, unknown> = {}) =>
    order(shopId, number, `${number.toLowerCase()}@example.test`, placedAt, {
      customerName: name, customerNameKey: nameKey(name), shippingCountry: 'NO', ...extra,
    })

  it('links the one order whose folded name equals the label, whatever the case, accents or order', async () => {
    const o = await named(trackedShopId, 'N-1', 'Martin R\u00f6thke', '2026-08-05T10:00:00Z')
    await expect(matchByName('ROTHKE, MARTIN', RECEIVED)).resolves.toEqual({ orderId: o.id })
  })

  it('refuses two orders with that name, naming both, and refuses none', async () => {
    await named(trackedShopId, 'N-2A', 'Anna Hansen', '2026-08-01T10:00:00Z')
    await named(trackedShopId, 'N-2B', 'Anna Hansen', '2026-08-03T10:00:00Z')
    const r = await matchByName('Anna Hansen', RECEIVED)
    expect(r.orderId).toBeNull()
    expect((r as { reason: string }).reason).toBe(
      `The label says Anna Hansen and 2 orders in the last ${MATCH_WINDOW_DAYS} days have that name: N-2A, N-2B`,
    )
    const none = await matchByName('Nobody Here', RECEIVED)
    expect((none as { reason: string }).reason).toBe(
      `The label says Nobody Here and no order in the last ${MATCH_WINDOW_DAYS} days has that name`,
    )
    expect(await matchByName('', RECEIVED)).toEqual({ orderId: null, reason: 'The label carries no name' })
    expect(await matchByName(null, RECEIVED)).toEqual({ orderId: null, reason: 'The label carries no name' })
  })

  it('applies the country only when given, and says so in the reason', async () => {
    const no = await named(trackedShopId, 'N-3', 'Kari Nordmann', '2026-08-05T10:00:00Z', { shippingCountry: 'NO' })
    await expect(matchByName('Kari Nordmann', RECEIVED, { country: 'no' })).resolves.toEqual({ orderId: no.id })
    const r = await matchByName('Kari Nordmann', RECEIVED, { country: 'DE' })
    expect((r as { reason: string }).reason).toBe(
      `The label says Kari Nordmann and no order in the last ${MATCH_WINDOW_DAYS} days has that name in DE`,
    )
  })

  it('ignores untracked shops, voided orders, orders outside the window, and orders holding another consignment', async () => {
    await named(untrackedShopId, 'N-4U', 'Ola Nordmann', '2026-08-05T10:00:00Z')
    await named(trackedShopId, 'N-4V', 'Ola Nordmann', '2026-08-05T10:00:00Z', { voidedAt: new Date('2026-08-06') })
    await named(trackedShopId, 'N-4OLD', 'Ola Nordmann', new Date(RECEIVED.getTime() - (MATCH_WINDOW_DAYS + 1) * DAY).toISOString())
    await named(trackedShopId, 'N-4AFTER', 'Ola Nordmann', new Date(RECEIVED.getTime() + DAY).toISOString())
    const held = await named(trackedShopId, 'N-4H', 'Ola Nordmann', '2026-08-04T10:00:00Z')
    await db.shipment.create({ data: { trackingNumber: 'TNAME-HELD-1', orderId: held.id, consignmentId: 'OTHER' } })
    const r = await matchByName('Ola Nordmann', RECEIVED, { consignmentId: 'MINE' })
    expect((r as { reason: string }).reason).toMatch(/no order in the last/)
    // The second box of the SAME consignment still finds the order.
    await expect(matchByName('Ola Nordmann', RECEIVED, { consignmentId: 'OTHER' })).resolves.toEqual({ orderId: held.id })
    await db.shipment.deleteMany({ where: { trackingNumber: 'TNAME-HELD-1' } })
  })
})
```

Add to the imports at the top: `import { matchByEmail, matchByName, MATCH_WINDOW_DAYS } from './match'` and `import { nameKey } from '@/lib/delivery/name-key'`. Add `await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: 'TNAME-' } } })` as the first line of `cleanup()`.

Run: `npx vitest run --project delivery src/lib/bring/match.integration.test.ts` - expected: FAIL, `matchByName` is not exported.

- [ ] **Step 2: Implement, sharing the clauses with the email match**

In `src/lib/bring/match.ts` add `import { nameKey } from '../delivery/name-key'`. Extract the shared clauses into a helper placed above `matchByEmail`:

```ts
/**
 * The clauses both matchers share: a delivery-tracked shop, placed within the
 * window before the parcel was booked (or the file arrived), not cancelled,
 * and not already holding a parcel from another consignment.
 */
function candidateWhere(upper: Date, scope: MatchScope) {
  const heldByAnother = scope.consignmentId
    ? { OR: [{ consignmentId: null }, { consignmentId: { not: scope.consignmentId } }] }
    : {}
  return {
    shop: { deliveryTrackingFrom: { not: null } },
    placedAt: {
      gte: new Date(upper.getTime() - MATCH_WINDOW_DAYS * DAY),
      lte: upper,
    },
    voidedAt: null,
    NOT: { shipments: { some: heldByAnother } },
  }
}

/** "4 or more" and "and others" once the list runs past what is spelled out. */
function describe(orders: { number: string }[]): { count: string; list: string } {
  const overflowed = orders.length > CANDIDATES_NAMED
  const named = orders.slice(0, CANDIDATES_NAMED).map((o) => o.number)
  return {
    count: overflowed ? `${CANDIDATES_NAMED} or more` : String(orders.length),
    list: overflowed ? `${named.join(', ')} and others` : named.join(', '),
  }
}
```

Rewrite `matchByEmail`'s query to `where: { customerEmail: { equals: email, mode: 'insensitive' }, ...candidateWhere(upper, scope) }` and its refusal to use `describe(orders)` (the wording stays exactly `${email} matched ${count} orders in the last ${MATCH_WINDOW_DAYS} days: ${list}`); keep its doc comment, moving the `heldByAnother` explanation to the helper. Then add:

```ts
export type NameScope = MatchScope & { country?: string | null }

/**
 * Find the order a parcel belongs to from the name on its label.
 *
 * Second choice after the email, and the only choice for DHL, which returns
 * no recipient at all. The warehouse prints the label from the order, so the
 * two names are the same name; nameKey folds the spelling. Measured on 90
 * linked parcels on 2026-09-11: 90 folded equal, 90 unique in the window.
 *
 * Same refusal rule as the email: two candidates are refused, not resolved.
 * The country, when the caller knows it, is one more thing that must agree;
 * when it is unknown (a number no carrier has answered for yet) the name
 * alone decides, which the measurement above also covered.
 */
export async function matchByName(
  name: string | null,
  receivedAt: Date,
  scope: NameScope = {},
): Promise<MatchOutcome> {
  const key = nameKey(name)
  if (!key) return { orderId: null, reason: 'The label carries no name' }
  const label = (name ?? '').trim()
  const upper = scope.bookedAt ?? receivedAt
  const country = scope.country?.trim().toUpperCase() || null

  const orders = await db.order.findMany({
    where: {
      customerNameKey: key,
      ...(country ? { shippingCountry: { equals: country, mode: 'insensitive' } } : {}),
      ...candidateWhere(upper, scope),
    },
    select: { id: true, number: true },
    take: CANDIDATES_NAMED + 1,
    orderBy: { placedAt: 'asc' },
  })

  const where = country ? ` in ${country}` : ''
  if (orders.length === 0)
    return { orderId: null, reason: `The label says ${label} and no order in the last ${MATCH_WINDOW_DAYS} days has that name${where}` }
  if (orders.length > 1) {
    const { count, list } = describe(orders)
    return { orderId: null, reason: `The label says ${label} and ${count} orders in the last ${MATCH_WINDOW_DAYS} days have that name${where}: ${list}` }
  }
  return { orderId: orders[0].id }
}
```

Run the whole file - expected: PASS, including the untouched `matchByEmail` tests.

- [ ] **Step 3: Commit**

```bash
git add src/lib/bring/match.ts src/lib/bring/match.integration.test.ts
git commit -m "feat(delivery): match a parcel to its order by the name on the label"
```

---

### Task 4: One place that attaches a row, used by the poller

**Files:**
- Create: `src/lib/delivery/attach.ts`, `src/lib/delivery/attach.integration.test.ts`
- Modify: `src/lib/delivery/identify.ts`, `src/lib/delivery/identify.integration.test.ts`, `src/lib/delivery/sync.ts`, `src/lib/delivery/sync.integration.test.ts`

**Interfaces:**
- Consumes: `matchByEmail`, `matchByName` (Task 3).
- Produces:
  ```ts
  export type AttachRow = {
    id: string; trackingNumber: string; orderId: string | null
    recipientEmail: string | null; recipientName: string | null
    bookedAt: Date | null; createdAt: Date
    consignmentId: string | null; destinationCountry: string | null
  }
  export type AttachDecision =
    | { orderId: string; source: 'BRING_EMAIL' | 'FILE_NAME' }
    | { orderId: null; reason: string | null }
  export type AttachResult =
    | { linked: true; source: 'BRING_EMAIL' | 'FILE_NAME' }
    | { linked: false; source: null; reason: string | null }
  export function decideAttach(row: AttachRow): Promise<AttachDecision>
  export function attach(row: AttachRow): Promise<AttachResult>
  export const SWEEP_LIMIT = 50
  export function sweepUnlinked(now: Date): Promise<{ tried: number; linked: number }>
  ```
  `IdentifyRow` gains `recipientName: string | null`. `rematchByEmail` is deleted. `ShipmentSyncResult` gains `swept?: number; sweptLinked?: number`.

- [ ] **Step 1: Failing tests for attach and the sweep**

`src/lib/delivery/attach.integration.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { nameKey } from './name-key'
import { attach, decideAttach, sweepUnlinked, SWEEP_LIMIT } from './attach'

const TAG = '[attach-test]'
const TRACK = 'TATT'
const scoped = { shop: { name: { contains: TAG } } }
const now = new Date('2026-09-11T12:00:00Z')
const HOUR = 60 * 60 * 1000
let shopId: string

async function cleanup() {
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: TRACK } } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Shop ${TAG}`, currency: 'EUR', deliveryTrackingFrom: new Date('2026-01-01') } })).id
})

const order = (number: string, name: string, email: string, placedAt = '2026-09-08T10:00:00Z', country = 'DE') =>
  db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(placedAt), status: 'completed', currency: 'EUR',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName: name, customerNameKey: nameKey(name), customerEmail: email, shippingCountry: country,
    },
  })

const row = (n: string, over: Record<string, unknown> = {}) =>
  db.shipment.create({
    data: { trackingNumber: `${TRACK}${n}`, carrier: 'DHL', createdAt: now, ...over },
    select: { id: true, trackingNumber: true, orderId: true, recipientEmail: true, recipientName: true, bookedAt: true, createdAt: true, consignmentId: true, destinationCountry: true, updatedAt: true },
  })

describe('decideAttach and attach', () => {
  it('prefers the email, falls back to the name, and writes the link with its source', async () => {
    const byMail = await order('A-MAIL', 'Some Body', 'mail@example.test')
    const byName = await order('A-NAME', 'Martin R\u00f6thke', 'other@example.test')
    const r1 = await row('1', { recipientEmail: 'mail@example.test', recipientName: 'Martin R\u00f6thke', destinationCountry: 'DE' })
    await expect(decideAttach(r1)).resolves.toEqual({ orderId: byMail.id, source: 'BRING_EMAIL' })
    const r2 = await row('2', { recipientName: 'ROTHKE MARTIN', destinationCountry: 'DE' })
    await expect(attach(r2)).resolves.toEqual({ linked: true, source: 'FILE_NAME' })
    const after = await db.shipment.findUnique({ where: { id: r2.id } })
    expect(after?.orderId).toBe(byName.id)
    expect(after?.linkSource).toBe('FILE_NAME')
    expect(after?.unlinkedReason).toBeNull()
  })

  it('keeps the email reason when Bring gave an email, else the name reason, and never writes a null reason over a real one', async () => {
    await order('A-2A', 'Anna Hansen', 'anna@example.test', '2026-09-01T10:00:00Z')
    await order('A-2B', 'Anna Hansen', 'anna@example.test', '2026-09-02T10:00:00Z')
    const both = await row('3', { recipientEmail: 'anna@example.test', recipientName: 'Anna Hansen', destinationCountry: 'DE' })
    const d = await decideAttach(both)
    expect(d.orderId).toBeNull()
    expect((d as { reason: string }).reason).toMatch(/^anna@example.test matched 2 orders/)
    const nameOnly = await row('4', { recipientName: 'Anna Hansen', destinationCountry: 'DE' })
    const r = await attach(nameOnly)
    expect(r.linked).toBe(false)
    expect((r as { reason: string | null }).reason).toMatch(/^The label says Anna Hansen and 2 orders/)
    const kept = await row('5', { unlinkedReason: 'kept' })
    await expect(attach(kept)).resolves.toEqual({ linked: false, source: null, reason: null })
    expect((await db.shipment.findUnique({ where: { id: kept.id } }))?.unlinkedReason).toBe('kept')
  })

  it('never moves a row that already has an order', async () => {
    const a = await order('A-3A', 'Ola Nordmann', 'ola@example.test')
    const b = await order('A-3B', 'Someone Else', 'else@example.test')
    const linked = await row('6', { orderId: b.id, linkSource: 'MANUAL', recipientName: 'Ola Nordmann' })
    await expect(attach(linked)).resolves.toEqual({ linked: false, source: null, reason: null })
    expect((await db.shipment.findUnique({ where: { id: linked.id } }))?.orderId).toBe(b.id)
    expect(a.id).not.toBe(b.id)
  })

  it('uses the booking time, else the row creation time, as the upper bound', async () => {
    const late = await order('A-4', 'Kari Nordmann', 'kari@example.test', '2026-09-10T10:00:00Z')
    const r = await row('7', { recipientName: 'Kari Nordmann', createdAt: new Date('2026-09-09T18:00:00Z') })
    const d = await decideAttach(r)
    expect(d.orderId).toBeNull()
    expect(late.placedAt.getTime()).toBeGreaterThan(r.createdAt.getTime())
  })
})

describe('sweepUnlinked', () => {
  it('retries only unlinked, undismissed rows older than an hour that carry an email or a name, at most SWEEP_LIMIT', async () => {
    const o = await order('S-1', 'Petri Niskanen', 'petri@example.test')
    const old = new Date(now.getTime() - 2 * HOUR)
    await row('S1', { recipientName: 'Petri Niskanen', updatedAt: old })
    await row('S2', { recipientName: 'Nobody Known', updatedAt: old })
    await row('S3', { recipientName: 'Petri Niskanen', updatedAt: now })
    await row('S4', { updatedAt: old })
    await row('S5', { recipientName: 'Petri Niskanen', dismissedAt: now, updatedAt: old })
    const r = await sweepUnlinked(now)
    expect(r).toEqual({ tried: 2, linked: 1 })
    const rows = await db.shipment.findMany({ where: { trackingNumber: { startsWith: `${TRACK}S` } }, orderBy: { trackingNumber: 'asc' } })
    expect(rows[0].orderId).toBe(o.id)
    expect(rows[1].orderId).toBeNull()
    expect(rows[1].unlinkedReason).toMatch(/Nobody Known/)
    expect(rows[2].orderId).toBeNull()
    expect(rows[2].unlinkedReason).toBeNull()
    expect(SWEEP_LIMIT).toBe(50)
  })
})
```

Note on `updatedAt`: Prisma lets `create` set `updatedAt` explicitly; the sweep test depends on that.

Run: `npx vitest run --project delivery src/lib/delivery/attach.integration.test.ts` - expected: FAIL, module not found.

- [ ] **Step 2: Implement attach.ts**

```ts
import { db } from '../db'
import { matchByEmail, matchByName } from '../bring/match'

/**
 * The one place a parcel with no order tries to find one.
 *
 * Email first, when a carrier gave one (Bring does, DHL never does); then
 * the name on the label, which the warehouse file gives for every carrier.
 * The same rules on both: 30 days, tracked shops, not cancelled, not already
 * holding another consignment's parcel, and exactly one order or nothing.
 *
 * Called from three places on purpose - the importer for every number in a
 * file, the identification step once a carrier has said which country, and
 * the hourly sweep - so a parcel that could not be placed today is placed
 * the day the missing fact arrives, with nobody pressing anything.
 */
export type AttachRow = {
  id: string
  trackingNumber: string
  orderId: string | null
  recipientEmail: string | null
  recipientName: string | null
  bookedAt: Date | null
  createdAt: Date
  consignmentId: string | null
  destinationCountry: string | null
}

export type AttachDecision =
  | { orderId: string; source: 'BRING_EMAIL' | 'FILE_NAME' }
  | { orderId: null; reason: string | null }

export type AttachResult =
  | { linked: true; source: 'BRING_EMAIL' | 'FILE_NAME' }
  | { linked: false; source: null; reason: string | null }

/** Reads only. The upper bound is the booking time, else when the row was first stored. */
export async function decideAttach(row: AttachRow): Promise<AttachDecision> {
  if (row.orderId !== null) return { orderId: null, reason: null }
  const scope = { bookedAt: row.bookedAt, consignmentId: row.consignmentId }
  let emailReason: string | null = null
  if (row.recipientEmail) {
    const byEmail = await matchByEmail(row.recipientEmail, row.createdAt, scope)
    if (byEmail.orderId !== null) return { orderId: byEmail.orderId, source: 'BRING_EMAIL' }
    emailReason = byEmail.reason
  }
  let nameReason: string | null = null
  if (row.recipientName) {
    const byName = await matchByName(row.recipientName, row.createdAt, { ...scope, country: row.destinationCountry })
    if (byName.orderId !== null) return { orderId: byName.orderId, source: 'FILE_NAME' }
    nameReason = byName.reason
  }
  // The email's reason names the repeat customer's orders, which is the more
  // useful sentence; the name's reason only when there was no email to try.
  return { orderId: null, reason: emailReason ?? nameReason }
}

/** Decide, then write. A row that already has an order is left exactly as it is. */
export async function attach(row: AttachRow): Promise<AttachResult> {
  const d = await decideAttach(row)
  if (d.orderId !== null) {
    await db.shipment.update({
      where: { id: row.id },
      data: { orderId: d.orderId, linkSource: d.source, unlinkedReason: null },
    })
    return { linked: true, source: d.source }
  }
  // A real reason replaces the old one; nothing to say leaves the old one.
  if (d.reason !== null) {
    await db.shipment.update({ where: { id: row.id }, data: { unlinkedReason: d.reason } })
  }
  return { linked: false, source: null, reason: d.reason }
}

export const SWEEP_LIMIT = 50
const HOUR = 60 * 60 * 1000

export const ATTACH_SELECT = {
  id: true, trackingNumber: true, orderId: true, recipientEmail: true, recipientName: true,
  bookedAt: true, createdAt: true, consignmentId: true, destinationCountry: true,
} as const

/**
 * Every unlinked parcel that has something to match on, tried again.
 *
 * Hourly per row, not per run: each attempt rewrites the reason, which moves
 * updatedAt, so a row comes round again an hour later at the earliest. Fifty
 * per run spreads a backlog over ticks. Rows with neither email nor name
 * have nothing to try and are not read; a dismissed row is not a customer
 * parcel and is not read either.
 */
export async function sweepUnlinked(now: Date): Promise<{ tried: number; linked: number }> {
  const rows = await db.shipment.findMany({
    where: {
      orderId: null,
      dismissedAt: null,
      updatedAt: { lt: new Date(now.getTime() - HOUR) },
      OR: [{ recipientEmail: { not: null } }, { recipientName: { not: null } }],
    },
    orderBy: { updatedAt: 'asc' },
    take: SWEEP_LIMIT,
    select: ATTACH_SELECT,
  })
  let linked = 0
  for (const r of rows) {
    try {
      if ((await attach(r)).linked) linked++
    } catch {
      // One row's failure must not end the sweep; it comes round next hour.
    }
  }
  return { tried: rows.length, linked }
}
```

Run the test - expected: PASS.

- [ ] **Step 3: Failing identify tests**

In `src/lib/delivery/identify.integration.test.ts`: change the import line to `import { applyIdentification, applyUnknown, type CarrierFacts } from './identify'` (drop `rematchByEmail`), add `import { nameKey } from './name-key'`, and change `unknownRow` to accept the name:

```ts
const unknownRow = (trackingNumber: string, createdAt = now, recipientName: string | null = null) =>
  db.shipment.create({ data: { trackingNumber, carrier: 'UNKNOWN', nextPollAt: now, createdAt, recipientName } })
```

Every existing call of `applyIdentification(row, ...)` passes a row created by `unknownRow`, which now carries `recipientName`, so `IdentifyRow` is satisfied. Delete the `describe('rematchByEmail', ...)` block if there is one. Add a `named` order helper next to `order`:

```ts
const named = (number: string, name: string, placedAt: string, country = 'DE') =>
  db.order.create({
    data: {
      shopId, externalId: number, number, placedAt: new Date(placedAt), status: 'completed', currency: 'EUR',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      customerName: name, customerNameKey: nameKey(name), customerEmail: `${number.toLowerCase()}@example.test`, shippingCountry: country,
    },
  })
```

and, inside `describe('applyIdentification', ...)`, add:

```ts
  it('links a DHL parcel by the name the warehouse file gave, and keeps that name', async () => {
    const o = await named('ID-N1', 'Martin R\u00f6thke', '2026-09-06T10:00:00Z')
    const row = await unknownRow(`${TRACK}7`, now, 'ROTHKE MARTIN')
    const facts: CarrierFacts = {
      carrier: 'DHL', consignmentId: 'JKG-1', destinationCountry: 'DE', weightKg: 16.4,
      recipientEmail: null, recipientName: null, references: [],
      package: { trackingNumber: `${TRACK}7`, events, milestones: milestonesFrom(events) },
    }
    await expect(applyIdentification(row, facts, now)).resolves.toEqual({ linked: true })
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.orderId).toBe(o.id)
    expect(after?.linkSource).toBe('FILE_NAME')
    expect(after?.recipientName).toBe('ROTHKE MARTIN')
    expect(after?.carrier).toBe('DHL')
  })

  it('a DHL parcel with no name says what would make it match', async () => {
    const row = await unknownRow(`${TRACK}8`)
    const facts: CarrierFacts = {
      carrier: 'DHL', consignmentId: 'JKG-2', destinationCountry: 'FI', weightKg: 154,
      recipientEmail: null, recipientName: null, references: [], package: null,
    }
    await expect(applyIdentification(row, facts, now)).resolves.toEqual({ linked: false })
    expect((await db.shipment.findUnique({ where: { id: row.id } }))?.unlinkedReason).toBe(
      'DHL parcel to FI: DHL gives no name or email, and no warehouse file has named this parcel yet. Upload the file for its day and it will match itself.',
    )
  })

  it('a DHL parcel whose references point at two orders still needs a person, name or not', async () => {
    const a = await named('ID-R1', 'Lotta Sillanp\u00e4\u00e4', '2026-09-06T10:00:00Z')
    const b = await named('ID-R2', 'Jouni Myllykangas', '2026-09-06T10:00:00Z')
    await db.shipment.create({ data: { trackingNumber: `${TRACK}R1`, carrier: 'DHL', orderId: a.id } })
    await db.shipment.create({ data: { trackingNumber: `${TRACK}R2`, carrier: 'DHL', orderId: b.id } })
    const row = await unknownRow(`${TRACK}9`, now, 'Lotta Sillanp\u00e4\u00e4')
    const facts: CarrierFacts = {
      carrier: 'DHL', consignmentId: 'JKG-3', destinationCountry: 'FI', weightKg: 154,
      recipientEmail: null, recipientName: null, references: [`${TRACK}R1`, `${TRACK}R2`], package: null,
    }
    await expect(applyIdentification(row, facts, now)).resolves.toEqual({ linked: false })
    expect((await db.shipment.findUnique({ where: { id: row.id } }))?.unlinkedReason).toMatch(/2 different orders, so a person must choose/)
  })

  it('a Bring parcel whose email matches nothing falls through to the name', async () => {
    const o = await named('ID-B1', 'Anitta Airi', '2026-09-06T10:00:00Z', 'FI')
    const row = await unknownRow(`${TRACK}10`, now, 'Airi Anitta')
    await expect(applyIdentification(row, bringFacts({ recipientEmail: 'unknown@example.test', recipientName: null, destinationCountry: 'FI' }), now)).resolves.toEqual({ linked: true })
    const after = await db.shipment.findUnique({ where: { id: row.id } })
    expect(after?.orderId).toBe(o.id)
    expect(after?.linkSource).toBe('FILE_NAME')
  })

  it('a Bring parcel with neither email nor name says so', async () => {
    const row = await unknownRow(`${TRACK}11`)
    await expect(applyIdentification(row, bringFacts({ recipientEmail: null, recipientName: null }), now)).resolves.toEqual({ linked: false })
    expect((await db.shipment.findUnique({ where: { id: row.id } }))?.unlinkedReason).toBe(
      'Bring holds no email for this parcel and no warehouse file has named it',
    )
  })
```

If an existing test asserts the old DHL reason text `DHL gives no name or email, so no order could be matched by itself`, change it to the new sentence above.

Run: `npx vitest run --project delivery src/lib/delivery/identify.integration.test.ts` - expected: FAIL (type error on `IdentifyRow`, then behaviour).

- [ ] **Step 4: Implement identify.ts changes**

In `src/lib/delivery/identify.ts`:

- Replace `import { matchByEmail } from '../bring/match'` with `import { decideAttach } from './attach'`.
- `export type IdentifyRow = { id: string; trackingNumber: string; orderId: string | null; createdAt: Date; recipientName: string | null }`.
- In `applyIdentification`, `base.recipientName` becomes `facts.recipientName ?? row.recipientName` with the comment `// A carrier that gives no name (DHL) must not wipe the one the warehouse file gave.`
- Replace the whole `if (row.orderId === null) { ... }` linking block with:

```ts
  if (row.orderId === null) {
    const attachRow = {
      id: row.id, trackingNumber: row.trackingNumber, orderId: null,
      recipientEmail: facts.recipientEmail,
      recipientName: facts.recipientName ?? row.recipientName,
      bookedAt: m?.bookedAt ?? null, createdAt: row.createdAt,
      consignmentId: facts.consignmentId, destinationCountry: facts.destinationCountry,
    }
    if (facts.carrier === 'BRING') {
      const d = await decideAttach(attachRow)
      if (d.orderId !== null) link = { orderId: d.orderId, linkSource: d.source }
      else unlinkedReason = d.reason ?? 'Bring holds no email for this parcel and no warehouse file has named it'
    } else {
      // DHL Freight: the export path stored the 10-digit number with its
      // order; this piece is the same physical shipment. findMany, not
      // findFirst: a consignment can carry more than one such reference, and
      // when those references belong to two DIFFERENT orders there is no
      // way to choose between them by machine.
      const known = facts.references.length
        ? await db.shipment.findMany({
            where: { trackingNumber: { in: facts.references }, orderId: { not: null } },
            select: { orderId: true },
          })
        : []
      const orderIds = [...new Set(known.map((k) => k.orderId).filter((id): id is string => id !== null))]
      const country = facts.destinationCountry ?? 'an unknown country'
      if (orderIds.length === 1) {
        link = { orderId: orderIds[0], linkSource: 'DHL_REF' }
      } else if (orderIds.length > 1) {
        unlinkedReason = `DHL parcel to ${country}: its consignment numbers belong to ${orderIds.length} different orders, so a person must choose`
      } else {
        // DHL gives no email; the name, when a warehouse file gave one, is
        // the only key left, and it is enough (lib/bring/match.ts).
        const d = await decideAttach({ ...attachRow, recipientEmail: null })
        if (d.orderId !== null) link = { orderId: d.orderId, linkSource: d.source }
        else unlinkedReason = d.reason ?? `DHL parcel to ${country}: DHL gives no name or email, and no warehouse file has named this parcel yet. Upload the file for its day and it will match itself.`
      }
    }
  }
```

- Delete `rematchByEmail` entirely.

Run the identify test file - expected: PASS.

- [ ] **Step 5: The poller: sweep first, select the name, drop the per-poll re-match**

In `src/lib/delivery/sync.ts`:

- Import line: `import { applyIdentification, applyUnknown, bringFacts, dhlFacts } from './identify'` and add `import { sweepUnlinked } from './attach'`.
- `ShipmentSyncResult` gains, after `identified?: number`:
  ```ts
  /** Unlinked rows the hourly sweep tried again this run, and how many it attached. */
  swept?: number
  sweptLinked?: number
  ```
- After the `if (!trackers.BRING && !trackers.DHL) { ... }` early return and before `const promises = ...`, add:
  ```ts
  // Unlinked parcels first, before the due rows are read, so one attached
  // here polls as a linked parcel in the same run. Best-effort like the rest.
  const sweep = await sweepUnlinked(now).catch(() => ({ tried: 0, linked: 0 }))
  ```
- In the `due` select add `recipientName: true,` after `recipientEmail: true,`.
- The `idRow` becomes `{ id: s.id, trackingNumber: s.trackingNumber, orderId: s.orderId, createdAt: s.createdAt, recipientName: s.recipientName }`.
- Delete the block that starts `// A refused Bring row, matched again under today's rules` through the `.catch(() => {})` of `rematchByEmail(...)` (line 455 to 462 area).
- The final return becomes `return { polled, updated, failed, dhlCalls, dhlSkippedNoKey, identified, swept: sweep.tried, sweptLinked: sweep.linked }`.

In `src/lib/delivery/sync.integration.test.ts`: if a test asserts the per-poll re-match (search for `rematch` or `BRING_EMAIL` after a poll of an unlinked row), rewrite it to set the row's `updatedAt` two hours before `now` and assert the sweep linked it (`result.sweptLinked` is 1). If no such test exists, add one:

```ts
  it('the sweep at the start of a run attaches an unlinked row the rules can now place', async () => {
    // Uses this file's shop, order and Bring mock helpers. The row carries a
    // name, no order, and was last touched two hours ago.
    ...
    expect(result.swept).toBeGreaterThanOrEqual(1)
    expect(result.sweptLinked).toBe(1)
  })
```

Fill the `...` with this file's own fixture helpers (create an order with `customerNameKey: nameKey('Petri Niskanen')`, a shipment row `carrier: 'DHL', terminal: true, recipientName: 'Petri Niskanen', updatedAt: <now - 2h>`; `terminal: true` keeps it out of the poll loop so only the sweep touches it).

Run: `npx vitest run --project delivery src/lib/delivery/sync.integration.test.ts src/lib/delivery/identify.integration.test.ts src/lib/delivery/attach.integration.test.ts` - expected: PASS. Then `npx tsc --noEmit -p .` - expected: clean (fix any other constructor of `IdentifyRow`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/delivery/attach.ts src/lib/delivery/attach.integration.test.ts src/lib/delivery/identify.ts src/lib/delivery/identify.integration.test.ts src/lib/delivery/sync.ts src/lib/delivery/sync.integration.test.ts
git commit -m "feat(delivery): one place attaches a parcel by email then by label name, swept hourly"
```

---

### Task 5: The importer names rows and matches by name

**Files:**
- Modify: `src/lib/bring/import.ts`
- Modify: `src/lib/bring/import-email.integration.test.ts`

**Interfaces:**
- Consumes: `readLabels` (Task 2), `matchByName` (Task 3), `attach`, `ATTACH_SELECT` (Task 4).
- Produces: `ImportResult.namesRead: number | null`; `TrackingImport.namesRead` written.

- [ ] **Step 1: Failing tests**

In `src/lib/bring/import-email.integration.test.ts` add imports `import { nameKey } from '@/lib/delivery/name-key'` and a second builder next to `book`, producing a real sheet with a `Namn` column (the same builder as `labels.test.ts`, copied here because the two files must stay independent):

```ts
const HEADERS = ['Datum', 'Antal', 'Order', 'Namn', 'KolliID', 'S\u00e4ndningsref', 'Levs\u00e4tt', 'Vikt']
const col = (i: number) => String.fromCharCode(65 + i)
const sheet = (rows: Partial<Record<string, string>>[], headers: string[] = HEADERS) => {
  const strings: string[] = []
  const idx = (v: string) => {
    const at = strings.indexOf(v)
    return at === -1 ? strings.push(v) - 1 : at
  }
  const cells = (values: string[], r: number) =>
    values
      .map((v, i) => (v === '' ? `<c r="${col(i)}${r}" s="1"/>` : `<c r="${col(i)}${r}" t="s"><v>${idx(v)}</v></c>`))
      .join('')
  const body = rows.map((row, n) => `<row r="${n + 2}">${cells(headers.map((h) => row[h] ?? ''), n + 2)}</row>`).join('')
  const head = `<row r="1">${cells(headers, 1)}</row>`
  return Buffer.from(
    zipSync({
      'xl/sharedStrings.xml': strToU8(`<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${head}${body}</sheetData></worksheet>`),
    }),
  )
}
const ltasRow = (kolli: string, name: string, ref = '') => ({
  Datum: '2026-09-10 08:19:24', Antal: '1', Order: '027286', Namn: name, KolliID: kolli, 'S\u00e4ndningsref': ref, 'Levs\u00e4tt': 'BOXHD_NO', Vikt: '16.4',
})
```

Add `'named.xlsx'` and `'nameless.xlsx'` to `FILES`. Then add, inside `describe('importWarehouseFile', ...)`:

```ts
  it('names an already-stored UNKNOWN row from the file and links it by that name', async () => {
    const o = await db.order.create({
      data: {
        shopId, externalId: 'N1', number: 'N1', placedAt: new Date(Date.now() - 2 * 24 * 3600_000), status: 'completed', currency: 'NOK',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
        customerName: 'Martin R\u00f6thke', customerNameKey: nameKey('Martin R\u00f6thke'), customerEmail: 'martin@example.test', shippingCountry: 'DE',
      },
    })
    const number = '473999999000000011'
    await db.shipment.create({ data: { trackingNumber: number, carrier: 'DHL', destinationCountry: 'DE', unlinkedReason: 'old reason' } })
    resolveConsignments.mockResolvedValue({
      consignments: [],
      unresolved: [{ number, reason: 'Bring has no parcel with this number' }],
    })
    const result = await importWarehouseFile(sheet([ltasRow(number, 'ROTHKE MARTIN')]), 'named.xlsx', 'UPLOAD')
    expect(result.namesRead).toBe(1)
    expect(result.linked).toBe(1)
    expect(result.unaccounted).toBe(0)
    expect(result.parsed).toBe(result.linked + result.unaccounted)
    const row = await db.shipment.findUnique({ where: { trackingNumber: number } })
    expect(row?.orderId).toBe(o.id)
    expect(row?.linkSource).toBe('FILE_NAME')
    expect(row?.recipientName).toBe('ROTHKE MARTIN')
    expect(row?.unlinkedReason).toBeNull()
    expect(row?.carrier).toBe('DHL')
    const record = await db.trackingImport.findFirst({ where: { filename: 'named.xlsx' }, orderBy: { receivedAt: 'desc' } })
    expect(record?.namesRead).toBe(1)
  })

  it('a resolved consignment whose email matches nothing links by the name, and Bring\u2019s own name wins over the file\u2019s', async () => {
    const o = await db.order.create({
      data: {
        shopId, externalId: 'N2', number: 'N2', placedAt: new Date(Date.now() - 2 * 24 * 3600_000), status: 'completed', currency: 'NOK',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
        customerName: 'Anitta Airi', customerNameKey: nameKey('Anitta Airi'), customerEmail: 'anitta@example.test', shippingCountry: 'FI',
      },
    })
    resolveConsignments.mockResolvedValue({
      consignments: [{
        consignmentId: `${PREFIX}C9`, packageNumbers: [`${PREFIX}0009`],
        recipientEmail: 'different@example.test', recipientName: 'Anitta Airi', destinationCountry: 'FI', weightKg: 1.6, bookedAt: null,
      }],
      unresolved: [],
    })
    const result = await importWarehouseFile(sheet([ltasRow(`${PREFIX}0009`, 'Wrong Name In File')]), 'named.xlsx', 'UPLOAD')
    expect(result.linked).toBe(1)
    const row = await db.shipment.findUnique({ where: { trackingNumber: `${PREFIX}0009` } })
    expect(row?.orderId).toBe(o.id)
    expect(row?.linkSource).toBe('FILE_NAME')
    expect(row?.recipientName).toBe('Anitta Airi')
  })

  it('a file with no Namn column still links by email and records that no names were read', async () => {
    resolveConsignments.mockResolvedValue({
      consignments: [{
        consignmentId: `${PREFIX}C10`, packageNumbers: [`${PREFIX}0010`],
        recipientEmail: 'buyer@example.test', recipientName: 'Buyer', destinationCountry: 'NO', weightKg: 1, bookedAt: null,
      }],
      unresolved: [],
    })
    const result = await importWarehouseFile(
      sheet([{ Datum: '2026-09-10', KolliID: `${PREFIX}0010` }], ['Datum', 'KolliID']), 'nameless.xlsx', 'UPLOAD',
    )
    expect(result.linked).toBe(1)
    expect(result.namesRead).toBe(0)
    const record = await db.trackingImport.findFirst({ where: { filename: 'nameless.xlsx' }, orderBy: { receivedAt: 'desc' } })
    expect(record?.namesRead).toBe(0)
  })

  it('a named row the rules cannot place keeps its line, with the name reason appended', async () => {
    const number = '473999999000000012'
    resolveConsignments.mockResolvedValue({
      consignments: [],
      unresolved: [{ number, reason: 'Bring has no parcel with this number' }],
    })
    const result = await importWarehouseFile(sheet([ltasRow(number, 'Nobody Ordered')]), 'named.xlsx', 'UPLOAD')
    expect(result.linked).toBe(0)
    expect(result.unmatched).toHaveLength(1)
    expect(result.unmatched[0].reason).toMatch(/asks Bring again, then DHL - The label says Nobody Ordered and no order/)
    expect((await db.shipment.findUnique({ where: { trackingNumber: number } }))?.recipientName).toBe('Nobody Ordered')
  })
```

The `resolveConsignments` mock's consignment objects must carry every field `ResolvedConsignment` has (`consignmentId, packageNumbers, recipientEmail, recipientName, destinationCountry, weightKg, bookedAt`); update the file's existing mocks if TypeScript complains.

Run: `npx vitest run --project delivery src/lib/bring/import-email.integration.test.ts` - expected: FAIL (`namesRead` undefined, no name link).

- [ ] **Step 2: Implement**

In `src/lib/bring/import.ts`:

- Imports: add `import { readLabels } from './labels'`, change the match import to `import { matchByEmail, matchByName, type MatchOutcome } from './match'`, add `import { attach, ATTACH_SELECT } from '../delivery/attach'`.
- `ImportResult` gains:
  ```ts
  /**
   * Rows of the warehouse file that carried a recipient name. 0 means the
   * file was read and had none we could find, which is the thing to look at
   * when parcels stop attaching; null means this path does not read names.
   */
  namesRead: number | null
  ```
  `importTrackingFile` returns `namesRead: null`; the DHL-export branch of `importWarehouseFile` returns `namesRead: null`.
- In `importWarehouseFile`, directly after `numbers = await parseTrackingNumbers(buf, filename)` succeeds (inside the same try is fine; it never throws), add:
  ```ts
  // The names on the labels, keyed by every long number on their row. Null
  // when this file gives none; the import then goes on exactly as before.
  const labels = readLabels(buf, filename)
  const nameFor = (candidates: (string | null)[]): string | null => {
    for (const n of candidates) {
      const v = n ? labels?.names.get(n) : undefined
      if (v) return v
    }
    return null
  }
  ```
- In the consignment loop, `recipientName: c.recipientName ?? nameFor([...c.packageNumbers, c.consignmentId])` in `facts`, and replace the `const outcome = await matchByEmail(...)` with:
  ```ts
      let outcome: MatchOutcome = await matchByEmail(c.recipientEmail, receivedAt, {
        bookedAt: c.bookedAt,
        consignmentId: c.consignmentId,
      })
      let linkSource: 'BRING_EMAIL' | 'FILE_NAME' = 'BRING_EMAIL'
      if (outcome.orderId === null && facts.recipientName) {
        // The name is the second key, and for a customer Bring holds no
        // email for it is the only one. The email's refusal is the more
        // useful sentence when there was an email, so it is kept then.
        const byName = await matchByName(facts.recipientName, receivedAt, {
          bookedAt: c.bookedAt, consignmentId: c.consignmentId, country: c.destinationCountry,
        })
        if (byName.orderId !== null) {
          outcome = byName
          linkSource = 'FILE_NAME'
        } else if (!c.recipientEmail) {
          outcome = byName
        }
      }
  ```
  and replace both literal `linkSource: 'BRING_EMAIL'` writes in that loop (the upsert `create` and the `updateMany`) with `linkSource`.
- In the `for (const u of unresolved)` loop, the `BRING_SHAPED` branch becomes:
  ```ts
      if (BRING_SHAPED.test(u.number)) {
        const name = labels?.names.get(u.number) ?? null
        await db.shipment.upsert({
          where: { trackingNumber: u.number },
          create: { trackingNumber: u.number, carrier: 'UNKNOWN', nextPollAt: new Date(), recipientName: name },
          // Adopt, never reset: it may already be identified, or mid-way.
          update: {},
        })
        let nameReason: string | null = null
        if (name) {
          // A row that had no name learns it; a carrier's own name, when one
          // exists, is never overwritten by the file's. Then the row tries to
          // attach on the spot - this is how re-uploading an old file links
          // the parcels that were stored before names were read.
          await db.shipment.updateMany({
            where: { trackingNumber: u.number, recipientName: null },
            data: { recipientName: name },
          })
          const row = await db.shipment.findUnique({ where: { trackingNumber: u.number }, select: ATTACH_SELECT })
          if (row && row.orderId === null) {
            const r = await attach(row)
            if (r.linked) {
              linked++
              continue
            }
            nameReason = r.reason
          }
        }
        unmatched.push({
          orderNumber: name ?? '(not identified)',
          trackingNumber: u.number,
          reason:
            (u.reason === 'Bring has no parcel with this number'
              ? 'Bring has not heard of this parcel yet - stored, the next check asks Bring again, then DHL'
              : `${u.reason} - stored, it will be retried by the next check`) +
            (nameReason ? ` - ${nameReason}` : ''),
        })
        continue
      }
  ```
- The `db.trackingImport.create` in this path gains `namesRead: labels ? labels.rows : 0`, and the return gains `namesRead: labels ? labels.rows : 0`.
- `recordFailedAttempt` is unchanged (`namesRead` stays null on a failed run).

Run the import test file - expected: PASS. Run `npx tsc --noEmit -p .` - expected: clean; fix `src/app/api/delivery/import/route.test.ts` or `inbound/route.integration.test.ts` if they build an `ImportResult` literal (add `namesRead: null`).

- [ ] **Step 3: Commit**

```bash
git add src/lib/bring/import.ts src/lib/bring/import-email.integration.test.ts
git commit -m "feat(delivery): the warehouse file names each parcel and the name attaches it"
```

---

### Task 6: Same-name candidates first, and the import row carries namesRead

**Files:**
- Modify: `src/lib/delivery/candidates.ts`, `src/lib/delivery/candidates.integration.test.ts`
- Modify: `src/app/api/delivery/route.ts:159-181`

**Interfaces:**
- Produces: `Candidate.sameName: boolean`; `CandidateRow.recipientName: string | null`; `CANDIDATE_LIMIT = 30`; the delivery GET's `imports[].namesRead: number | null`.

- [ ] **Step 1: Failing test**

Append to `src/lib/delivery/candidates.integration.test.ts` inside `describe('candidatesFor', ...)`; add `import { nameKey } from './name-key'` at the top:

```ts
  it('lists orders with the label\u2019s name first, flagged, then the country set, without repeating one', async () => {
    const same = await order(trackedId, 'C-SAME', { customerName: 'Tobias Kohlmeyer', customerNameKey: nameKey('Tobias Kohlmeyer'), shippingCountry: 'DE' })
    const sameElsewhere = await order(trackedId, 'C-SAME-FI', { customerName: 'Tobias Kohlmeyer', customerNameKey: nameKey('Tobias Kohlmeyer'), shippingCountry: 'FI' })
    const other = await order(trackedId, 'C-OTHER', { customerName: 'Someone Else', customerNameKey: nameKey('Someone Else'), shippingCountry: 'DE' })
    const r = await candidatesFor({ recipientEmail: null, recipientName: 'KOHLMEYER, Tobias', destinationCountry: 'DE', bookedAt: booked, createdAt: booked, consignmentId: null })
    expect(r.candidates.slice(0, 2).map((c) => c.sameName)).toEqual([true, true])
    expect(r.candidates.slice(0, 2).map((c) => c.orderId).sort()).toEqual([same.id, sameElsewhere.id].sort())
    expect(r.candidates[2]).toMatchObject({ number: 'C-OTHER', sameName: false })
    expect(r.candidates.filter((c) => c.orderId === other.id)).toHaveLength(1)
    expect(r.total).toBe(3)
    expect(CANDIDATE_LIMIT).toBe(30)
  })
```

Every existing call of `candidatesFor` in this file must now pass `recipientName: null`. Run: `npx vitest run --project delivery src/lib/delivery/candidates.integration.test.ts` - expected: FAIL.

- [ ] **Step 2: Implement**

In `src/lib/delivery/candidates.ts`: add `import { nameKey } from './name-key'`; `Candidate` gains `/** The label's folded name equals this order's; listed first. */ sameName: boolean`; `CandidateRow` gains `recipientName: string | null`; `CANDIDATE_LIMIT = 30`. Replace the body of `candidatesFor` with:

```ts
export async function candidatesFor(row: CandidateRow): Promise<{ candidates: Candidate[]; total: number }> {
  const key = nameKey(row.recipientName)
  if (!key && !row.recipientEmail && !row.destinationCountry) return { candidates: [], total: 0 }

  const upper = row.bookedAt ?? row.createdAt
  const window = { gte: new Date(upper.getTime() - MATCH_WINDOW_DAYS * DAY), lte: upper }
  const base = { shop: { deliveryTrackingFrom: { not: null } }, placedAt: window, voidedAt: null }
  const select = {
    id: true, number: true, placedAt: true, customerName: true,
    shop: { select: { name: true } },
    items: { select: { name: true, quantity: true } },
    shipments: { select: { consignmentId: true } },
  }

  // The label's name first, any country: the country a carrier reports and
  // the one the customer typed at checkout disagree often enough (a gift, a
  // holiday address) that a same-name order elsewhere is worth showing.
  const byName = key
    ? await db.order.findMany({ where: { ...base, customerNameKey: key }, orderBy: { placedAt: 'desc' }, take: READ_CEILING, select })
    : []
  const rest =
    row.recipientEmail || row.destinationCountry
      ? await db.order.findMany({
          where: {
            ...base,
            ...(row.recipientEmail
              ? { customerEmail: { equals: row.recipientEmail, mode: 'insensitive' } }
              : { shippingCountry: { equals: row.destinationCountry!, mode: 'insensitive' }, shipments: { none: {} } }),
            id: { notIn: byName.map((o) => o.id) },
          },
          orderBy: { placedAt: 'desc' },
          take: READ_CEILING,
          select,
        })
      : []

  const toCandidate = (o: (typeof byName)[number], sameName: boolean): Candidate => ({
    orderId: o.id,
    number: o.number,
    shop: o.shop.name,
    customerName: o.customerName,
    placedAt: o.placedAt.toISOString(),
    items: o.items.map((i) => `${i.quantity} x ${i.name}`).join(', '),
    holdsParcel: o.shipments.some((s) => s.consignmentId === null || s.consignmentId !== row.consignmentId),
    sameName,
  })
  const all = [...byName.map((o) => toCandidate(o, true)), ...rest.map((o) => toCandidate(o, false))]
  return { candidates: all.slice(0, CANDIDATE_LIMIT), total: all.length }
}
```

Run the test - expected: PASS.

- [ ] **Step 3: The API route**

In `src/app/api/delivery/route.ts`, the `trackingImport.findMany` select adds `namesRead: true,` after `rowsUnmatched: true,`. The `unlinked` select already carries `recipientName` (line 163), so `candidatesFor(s)` type-checks. Run `npx tsc --noEmit -p .` and `npx vitest run --project delivery src/app/api/delivery` - expected: clean and green (update any route test that snapshots the import row shape by adding `namesRead`).

- [ ] **Step 4: Commit**

```bash
git add src/lib/delivery/candidates.ts src/lib/delivery/candidates.integration.test.ts src/app/api/delivery/route.ts
git commit -m "feat(delivery): same-name orders lead the candidates; imports say how many names were read"
```

---

### Task 7: The page section, the imports line, the e2e, the guide

**Files:**
- Modify: `src/app/delivery/DeliveryClient.tsx` (types at 64-100, `UnattachedParcels` and `ParcelRow` at 1017-1200, the imports table at 1330-1370)
- Modify: `e2e/delivery-link-by-hand.spec.ts`
- Modify: `docs/delivery-tracking-guide.md:35-39`

**Interfaces:**
- Consumes: `Candidate.sameName`, `imports[].namesRead` (Task 6). The PATCH route and `/api/orders/lookup` are unchanged.

- [ ] **Step 1: Types**

`Candidate` (line 64) gains `sameName: boolean`. `ImportRow` (line 90) gains `namesRead: number | null`.

- [ ] **Step 2: Rewrite the section**

Replace the `UnattachedParcels` component's header text and the `ParcelRow` component. In `UnattachedParcels`, the heading span becomes `Parcels that need a person{' '}` (count unchanged) and the subtitle becomes:

```tsx
            Parcels are matched to orders by the customer&apos;s email or by the name on the label, automatically.
            These are the ones no rule could place, each with the reason.
```

The empty-state sentence becomes `None right now - every parcel a warehouse file or a carrier has named is attached to an order.` The table gains a column `Name on label` between `Last status` and `Why`, and `colSpan` on the control row becomes 8.

Replace `ParcelRow` with:

```tsx
function ParcelRow({
  p,
  shops,
  busy,
  onLink,
  onLinkTyped,
}: {
  p: UnlinkedParcel
  shops: { id: string; name: string }[]
  busy: boolean
  onLink: (trackingNumber: string, body: { orderId: string } | { dismiss: true }) => Promise<void>
  onLinkTyped: (trackingNumber: string, shopId: string, number: string) => Promise<void>
}) {
  const [chosen, setChosen] = useState('')
  const [other, setOther] = useState(false)
  const [shopId, setShopId] = useState(shops[0]?.id ?? '')
  const [number, setNumber] = useState('')
  const why = p.reason ?? (p.identifiedAt ? DASH : 'Not identified yet - the next check asks Bring, then DHL')
  const more = p.candidatesTotal - p.candidates.length
  const option = (c: Candidate) =>
    `${c.number} · ${c.customerName || 'name unknown'} · ${orderedOn(c.placedAt.slice(0, 10))}` +
    (c.items ? ` · ${c.items}` : '') +
    (c.sameName ? ' · same name as the label' : '') +
    (c.holdsParcel ? ' · already has a parcel' : '')

  return (
    <>
      <tr className="hover:bg-panel">
        <td className="px-5 py-2.5">
          {p.url ? (
            <a href={p.url} target="_blank" rel="noopener noreferrer" className="num text-accent hover:underline">{p.trackingNumber}</a>
          ) : (
            <span className="num text-ink">{p.trackingNumber}</span>
          )}
        </td>
        <td className="px-3 py-2.5 text-muted">{p.carrier}</td>
        <td className="px-3 py-2.5 text-ink">{p.destinationCountry ?? DASH}</td>
        <td className="px-3 py-2.5 text-ink">{bookedOn(p.bookedAt)}</td>
        <td className="num px-3 py-2.5 text-right text-ink">{p.weightKg !== null ? `${p.weightKg} kg` : DASH}</td>
        <td className="px-3 py-2.5 text-ink">{p.lastStatus ?? DASH}</td>
        <td className="px-3 py-2.5 text-ink">{p.recipientName ?? <span className="text-muted">no name yet</span>}</td>
        <td className="max-w-[320px] px-5 py-2.5 text-[12px] text-warn">{why}</td>
      </tr>
      <tr className="border-b border-line last:border-b-0">
        <td colSpan={8} className="px-5 pb-3 pt-0">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <select
              aria-label="Order"
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
              className="max-w-[560px] rounded-[var(--radius-control)] border border-line bg-surface px-1.5 py-1 text-ink"
            >
              <option value="">Choose the order</option>
              {p.candidates.map((c) => (
                <option key={c.orderId} value={c.orderId}>{option(c)}</option>
              ))}
              {more > 0 && <option value="" disabled>{more} more, use Other order</option>}
            </select>
            <button
              type="button"
              disabled={busy || !chosen}
              onClick={() => void onLink(p.trackingNumber, { orderId: chosen })}
              className="rounded-[var(--radius-control)] border border-line px-2 py-1 text-accent hover:bg-panel disabled:opacity-50"
            >
              Link
            </button>
            <button type="button" disabled={busy} onClick={() => void onLink(p.trackingNumber, { dismiss: true })} className="rounded-[var(--radius-control)] border border-line px-2 py-1 text-muted hover:bg-panel disabled:opacity-50">
              Not a customer parcel
            </button>
            <button type="button" onClick={() => setOther((o) => !o)} aria-expanded={other} className="text-muted underline-offset-2 hover:underline">
              Other order
            </button>
            {other && (
              <>
                <label className="flex items-center gap-1 text-muted">
                  Shop
                  <select aria-label="Shop" value={shopId} onChange={(e) => setShopId(e.target.value)} className="rounded-[var(--radius-control)] border border-line bg-surface px-1.5 py-1 text-ink">
                    {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-1 text-muted">
                  Order number
                  <input aria-label="Order number" value={number} onChange={(e) => setNumber(e.target.value)} className="w-24 rounded-[var(--radius-control)] border border-line bg-surface px-1.5 py-1 text-ink" />
                </label>
                <button type="button" disabled={busy} onClick={() => void onLinkTyped(p.trackingNumber, shopId, number)} className="rounded-[var(--radius-control)] border border-line px-2 py-1 text-accent hover:bg-panel disabled:opacity-50">
                  Link this number
                </button>
              </>
            )}
          </div>
        </td>
      </tr>
    </>
  )
}
```

(The typed path's button is "Link this number" so the two Link buttons are distinguishable by name; the spec's "Link" is the dropdown one.)

- [ ] **Step 3: The imports line**

In the imports table (line 1355 area), after the `rowsLinked` cell's number, render the names count inside the same cell:

```tsx
                      <td className="num px-4 py-2.5 text-right text-ink">
                        {i.rowsLinked}
                        {i.namesRead !== null && i.namesRead > 0 && (
                          <span className="ml-1 text-[11px] font-normal text-muted">{i.namesRead} names</span>
                        )}
                        {i.namesRead === 0 && (
                          <span className="ml-1 text-[11px] font-normal text-warn">no names read from this file</span>
                        )}
                      </td>
```

Run `npx tsc --noEmit -p .` and `npx eslint src/app/delivery/DeliveryClient.tsx` - expected: clean. If a `DeliveryClient.test.tsx` exists and renders the section, update its expectations (`Parcels that need a person`, the `Order` select) and run it with `npx vitest run --project app src/app/delivery`.

- [ ] **Step 4: The e2e**

In `e2e/delivery-link-by-hand.spec.ts`:

- Seed the order with `customerNameKey: 'kohlmeyer tobias'` (add to the `db.order.create` data) and the shipment with `recipientName: 'Tobias Kohlmeyer'` and the reason `'DHL parcel to DE: DHL gives no name or email, and no warehouse file has named this parcel yet. Upload the file for its day and it will match itself.'`.
- Replace the section steps from `const section = ...` to the `Parcel linked` assertion with:

```ts
  const section = page.locator('#unattached')
  await section.getByRole('button', { name: /Parcels that need a person/ }).click()
  await expect(section.getByText(PARCEL)).toBeVisible({ timeout: 15_000 })
  await expect(section.getByText('18.2 kg')).toBeVisible()
  await expect(section.getByText('Tobias Kohlmeyer', { exact: true })).toBeVisible()

  // The same-name order is the first real option, and says so.
  const select = section.getByLabel('Order')
  const first = select.locator('option').nth(1)
  await expect(first).toContainText(ORDER)
  await expect(first).toContainText('same name as the label')

  const orderId = (await db.order.findFirst({ where: { number: ORDER }, select: { id: true } }))!.id
  await select.selectOption(orderId)
  await section.getByRole('button', { name: 'Link', exact: true }).click()
  await expect(page.getByText('Parcel linked')).toBeVisible()
```

Run it: start the dev server in the worktree on its own port in the background (`npx next dev -p 3111`, never piped to `head`), then `E2E_PORT=3111 npx playwright test e2e/delivery-link-by-hand.spec.ts`. Expected: PASS. Stop the dev server afterwards.

- [ ] **Step 5: The guide**

In `docs/delivery-tracking-guide.md` replace the "Parcels without an order" bullet (lines 35-39) with:

```markdown
- **Parcels that need a person.** Parcels are attached to orders on their
  own: by the customer's email when the carrier gives one, else by the name
  the warehouse printed on the label. This list is what is left: each
  parcel with its carrier, destination, booked date, weight, status, the
  name on the label, and the reason no rule could place it. Choose the
  order from the dropdown (orders with the same name come first), or press
  "Other order" to type a number, or mark it "Not a customer parcel". A
  growing list means parcels waiting for a decision, not a broken file.
- **Re-reading old files.** Uploading a day's warehouse file again is safe.
  It never moves a parcel that is already attached; it fills in names for
  parcels stored before names were read, and attaches the ones that can be.
  The "Recent imports" line shows how many names each file gave.
```

- [ ] **Step 6: Commit**

```bash
git add src/app/delivery/DeliveryClient.tsx e2e/delivery-link-by-hand.spec.ts docs/delivery-tracking-guide.md
git commit -m "feat(delivery): the parcels that need a person, one dropdown each"
```

---

### Task 8: Gates, push, merge, verify

**Files:** none new.

- [ ] **Step 1: Full gates in the worktree**

```bash
npx tsc --noEmit -p .
npx eslint src e2e --ext .ts,.tsx
npx vitest run --project app
npx vitest run --project delivery
```

Expected: tsc clean; eslint reports only the 8 pre-existing errors in files this branch did not touch; both projects green except the pre-existing `ingest.integration.test.ts` failure and any file that goes green when re-run alone with `--testTimeout=20000`.

- [ ] **Step 2: Push, PR, merge, deploy**

```bash
git push -u origin feat/label-name-matching
gh pr create --title "Parcels attach themselves by the name on the label" --body-file - <<'EOF'
...
EOF
```

The body: three short paragraphs in plain words (what was wrong, what is measured, what changes), the rollout step for Philip (upload the files from 21 Aug to 10 Sept again), ending with the attribution lines from the Global Constraints. Merge with `gh pr merge --merge`, then in the PRIMARY checkout (`C:/Users/Acer Philippines/OneDrive/Desktop/Philip project/panetti`) run `git pull` and `npm run build` (worktree builds fail on a Turbopack symlink), and watch the production deployment with `gh run list` / the Vercel deployment until it is READY. Confirm on https://panetti.vercel.app/delivery that the section reads "Parcels that need a person".
