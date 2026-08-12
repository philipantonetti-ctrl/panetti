# Warehouse File Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Have the warehouse's daily report arrive by email and link its parcels to the right orders automatically, without asking the warehouse to change anything.

**Architecture:** The warehouse's `Order` column is their own counter and matches the wrong order every time, so we ignore it. We pull only long digit-runs out of the attachment, ask Bring about each one, and use the `recipientEmailAddress` Bring returns to match `Order.customerEmail`. One `Shipment` is written per `packageNumber`; the existing poller in `src/lib/bring/sync.ts` takes over from there. Nothing downstream of `Shipment` changes.

**Tech Stack:** Next.js 16.2.10 App Router, React 19.2.4, Prisma 6 + PostgreSQL, Vitest 4, Tailwind v4, zod 4, `fflate` (new).

**Spec:** `docs/superpowers/specs/2026-08-12-warehouse-file-intake-design.md`

## Global Constraints

- **No schema change is needed.** `Shipment`, `TrackingImport` and `linkSource` already exist. Do not run `npm run db:push` and do not edit `prisma/schema.prisma` except for the one doc-comment in Task 6. If you believe you need a column, stop and report instead.
- **Never point tests at the live Neon database.** Tests use the local Postgres from `.env` (`vitest.config.ts` falls back to `postgresql://postgres@127.0.0.1:5432/ecom_analytics`).
- **If hundreds of DB tests suddenly fail with no code change, another checkout ran `prisma db push` against the shared local Postgres.** Introspect the database before debugging your own code.
- **Never run `git stash`, `git checkout <path>`, `git restore`, `git reset --hard`, or `git clean`.** Work in this repo has been silently reverted this way. If you think you need one, stop and report instead.
- **Re-check the branch immediately before every commit** (`git rev-parse --abbrev-ref HEAD`). A background sync worktree merges branches into `main` and moves the checkout mid-session. Expected branch: `feat/delivery-warehouse-intake`.
- **Edit files with the Edit/Write tools only.** PowerShell `Get-Content`/`Set-Content` corrupts UTF-8 in this environment.
- **Every new API route is admin-only** — `assertAdmin(await currentUser())` plus `Cache-Control: private, no-store` — **except `/api/delivery/inbound`**, which is machine-to-machine and authenticates with a shared secret instead (Task 5). It must never call `currentUser()`.
- **No customer PII in the repository.** The sample file and the Bring responses carry real names, emails, phone numbers and home addresses. Every fixture you commit must use invented values. Tracking numbers may be kept structurally realistic (18 digits) but must not be the real ones.
- **Tests are colocated** next to their subject as `<name>.test.ts`. Tests that touch the database are named `<name>.integration.test.ts`.
- **Integration tests in `src/lib/bring/**` and `src/app/api/delivery/**` already run in the `delivery` Vitest project** with `fileParallelism: false` (`vitest.config.ts:64-95`). Its `include` list and the `app` project's `exclude` list must stay an exact partition of the suite. Task 5's new file `src/app/api/delivery/inbound/route.integration.test.ts` is matched by the existing glob `src/app/api/delivery/**/*.integration.test.ts` — **no config change is needed.** Do not edit `vitest.config.ts`.
- **Test data convention — this one will bite you.** Files in the `app` project run in parallel against one shared local Postgres, so a test may never delete a row it did not create.

  1. **Every fixture carries a tag unique to its own file.** This plan's tags are `[intake-match-test]` (Task 4) and `[intake-route-test]` (Task 5). No two files may share one.
  2. **Every `deleteMany` is scoped to that tag.** A bare `db.shop.deleteMany()` or `db.order.deleteMany()` destroys the seeded shops that `src/lib/data/load.integration.test.ts:29` asserts, for every checkout sharing that database.
  3. **Rows with no shop to tag get their own per-file prefix.** A `Shipment` whose `orderId` is null belongs to no shop. Task 4 uses tracking-number prefix `IMTCH`, Task 5 uses `IMRTE`, and each cleans by `{ trackingNumber: { startsWith: PREFIX } }`.
  4. **`TrackingImport` has no shop and no natural key.** Scope its cleanup by the exact filenames the file uses.
  5. **`DeliveryConfig` is a fixed-id singleton (`id: 'singleton'`).** Never `deleteMany()` then `create()` — always `upsert`, so two racing files cannot make each other's row vanish.

- **Bring accepts exactly one tracking number per request.** Measured against the live API on 2026-08-12: asking for 10 returned 1 consignment, asking for 2 returned 0, asking for 1 returned the right one 27 times out of 27. Never send more than one `q`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/bring/xlsx.ts` *(new)* | xlsx bytes into plain text. One dependency, one caller, mirrors `pdf.ts`. |
| `src/lib/bring/parse.ts` *(modify)* | Gains `extractLongNumbers` and an `.xlsx` branch. Existing exports untouched. |
| `src/lib/bring/consignments.ts` *(new)* | Numbers into resolved consignments, one Bring request each, skipping what is already accounted for. |
| `src/lib/bring/match.ts` *(new)* | A recipient email plus a receipt time into one order id, or a stated refusal. |
| `src/lib/bring/import.ts` *(modify)* | Orchestrates the new path and writes `Shipment` + `TrackingImport`. |
| `src/app/api/delivery/inbound/route.ts` *(new)* | Postmark inbound webhook, shared-secret authenticated. |
| `src/lib/bring/sync.ts` *(modify)* | `BATCH` 10 → 1. |

Tasks 1-5 each end with a working, independently testable deliverable. Task 6 is the one-line poller fix plus the schema comment. Task 7 is a manual switch-on with no code.

---

### Task 1: Read an xlsx into text

**Files:**
- Create: `src/lib/bring/xlsx.ts`
- Test: `src/lib/bring/xlsx.test.ts`
- Modify: `package.json` (add `fflate`)

**Interfaces:**
- Consumes: nothing.
- Produces: `xlsxToText(buf: Buffer): string`

An xlsx is a zip. The numbers we want live either in `xl/sharedStrings.xml` (when Excel stored the cell as text, which it does for anything with a leading zero or more than 15 significant digits) or in `xl/worksheets/sheetN.xml` (when it stored a number). We concatenate both and let the caller pick digits out. We never look at cells, columns or headings.

- [ ] **Step 1: Install the dependency**

```bash
npm install fflate
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/bring/xlsx.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { xlsxToText } from './xlsx'

/** A minimal but structurally real xlsx: shared strings plus one sheet. */
const book = (shared: string[], sheetValues: string[]) =>
  Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/workbook.xml': strToU8('<workbook/>'),
      'xl/sharedStrings.xml': strToU8(
        `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        `<worksheet><sheetData><row>${sheetValues
          .map((v) => `<c><v>${v}</v></c>`)
          .join('')}</row></sheetData></worksheet>`,
      ),
    }),
  )

describe('xlsxToText', () => {
  it('returns text held as a shared string', () => {
    const text = xlsxToText(book(['373325386490923366'], []))
    expect(text).toContain('373325386490923366')
  })

  it('returns text held as a raw cell value', () => {
    const text = xlsxToText(book([], ['73325383667032998']))
    expect(text).toContain('73325383667032998')
  })

  it('separates neighbouring cells, so two values never fuse into one token', () => {
    const text = xlsxToText(book([], ['111111111111111', '222222222222222']))
    expect(text).not.toContain('111111111111111222222222222222')
  })

  it('reads every worksheet, not just the first', () => {
    const buf = Buffer.from(
      zipSync({
        'xl/worksheets/sheet1.xml': strToU8('<c><v>111111111111111</v></c>'),
        'xl/worksheets/sheet2.xml': strToU8('<c><v>222222222222222</v></c>'),
      }),
    )
    const text = xlsxToText(buf)
    expect(text).toContain('111111111111111')
    expect(text).toContain('222222222222222')
  })

  it('throws something the uploader can read when the bytes are not a zip', () => {
    expect(() => xlsxToText(Buffer.from('this is not a spreadsheet'))).toThrow(
      /could not be read as an Excel file/i,
    )
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/bring/xlsx.test.ts`
Expected: FAIL — `Failed to resolve import "./xlsx"`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/bring/xlsx.ts`:

```ts
/**
 * xlsx bytes into plain text.
 *
 * Its own file so the dependency has exactly one caller, exactly as pdf.ts does
 * for unpdf. Deliberately NOT a spreadsheet reader: it does not know about
 * cells, columns or headings, because the whole point of this path is that the
 * warehouse's layout is not our business. It flattens the parts of the archive
 * that can hold a tracking number and hands the text on.
 *
 * Both parts are needed. Excel stores a value with a leading zero, or with more
 * than fifteen significant digits, as a SHARED STRING; anything it can hold as a
 * float lands in the sheet instead. An 18-digit parcel number can arrive either
 * way depending on how the warehouse's exporter was configured, and we do not
 * get to find out.
 */
import { unzipSync, strFromU8 } from 'fflate'

const WANTED = /^xl\/(sharedStrings\.xml|worksheets\/.*\.xml)$/

export function xlsxToText(buf: Buffer): string {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buf))
  } catch {
    // Written for the person who uploaded it — ImportParseError passes this
    // through to the client verbatim.
    throw new Error('This file could not be read as an Excel file.')
  }

  const parts: string[] = []
  for (const name of Object.keys(files).sort()) {
    if (!WANTED.test(name)) continue
    parts.push(strFromU8(files[name]))
  }

  // Every tag becomes a space. That is what keeps two adjacent cells —
  // `<v>111</v><v>222</v>` — from fusing into one 6-digit token that belongs to
  // neither of them.
  return parts.join(' ').replace(/<[^>]*>/g, ' ')
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/bring/xlsx.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print feat/delivery-warehouse-intake
git add package.json package-lock.json src/lib/bring/xlsx.ts src/lib/bring/xlsx.test.ts
git commit -m "feat(delivery): read an xlsx into plain text"
```

---

### Task 2: Pull the long numbers out of any file

**Files:**
- Modify: `src/lib/bring/parse.ts`
- Test: `src/lib/bring/parse.test.ts` (append; leave every existing test untouched)

**Interfaces:**
- Consumes: `xlsxToText(buf: Buffer): string` from Task 1.
- Produces:
  - `extractLongNumbers(text: string): string[]`
  - `parseTrackingNumbers(buf: Buffer, filename: string): Promise<string[]>`

`extractPairs`, `looksLikeTracking`, `countParcelNumbers` and `parseTrackingFile` all stay exactly as they are. They are still the PDF/order-number path, still tested, and removing them is not this plan's job.

**The threshold is 15 digits and it is load-bearing.** `KolliID` is 18 and `Sändningsref` is 17, so both clear it. `COD` and `COD ID` are 6. `Datum` is `2026-08-11 08:19:24`, which collapses to 14 digits (`20260811081924`) if a reader ever hands it over as one unsplit token — one digit of margin, on purpose. **Do not reuse `looksLikeTracking` here:** at 8-plus digits it swallows that timestamp whole.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/bring/parse.test.ts`:

```ts
import { extractLongNumbers, parseTrackingNumbers } from './parse'
import { zipSync, strToU8 } from 'fflate'

describe('extractLongNumbers', () => {
  it('takes an 18-digit package number and a 17-digit shipment reference', () => {
    expect(extractLongNumbers('373325386490923366 73325383667032998')).toEqual([
      '373325386490923366',
      '73325383667032998',
    ])
  })

  it('rejects the COD columns, which are six digits', () => {
    expect(extractLongNumbers('516668 517360')).toEqual([])
  })

  it('rejects a timestamp even when it arrives as one unsplit token', () => {
    // 20260811081924 is 14 digits. This is the near miss the threshold exists for.
    expect(extractLongNumbers('2026-08-11 08:19:24')).toEqual([])
    expect(extractLongNumbers('2026-08-11T08:19:24')).toEqual([])
  })

  it('rejects a weight written with a decimal comma', () => {
    expect(extractLongNumbers('16,500000')).toEqual([])
  })

  it('strips punctuation inside an otherwise long number', () => {
    expect(extractLongNumbers('373-325-386-490-923-366')).toEqual(['373325386490923366'])
  })

  it('returns each number once, in the order first seen', () => {
    expect(
      extractLongNumbers('373325386490923366 373325386490923366 73325383667032998'),
    ).toEqual(['373325386490923366', '73325383667032998'])
  })

  it('ignores a long word that is not digits', () => {
    expect(extractLongNumbers('Sendingsnummerreferanse')).toEqual([])
  })
})

describe('parseTrackingNumbers', () => {
  it('reads an xlsx', async () => {
    const buf = Buffer.from(
      zipSync({
        'xl/worksheets/sheet1.xml': strToU8(
          '<c><v>373325386490923366</v></c><c><v>516668</v></c>',
        ),
      }),
    )
    await expect(parseTrackingNumbers(buf, 'LTAS_Eod_Report.xlsx')).resolves.toEqual([
      '373325386490923366',
    ])
  })

  it('reads a csv', async () => {
    const csv = 'Datum;Order;KolliID\n2026-08-11 08:19:24;027286;373325386490923366\n'
    await expect(parseTrackingNumbers(Buffer.from(csv), 'r.csv')).resolves.toEqual([
      '373325386490923366',
    ])
  })

  it('refuses a file type it cannot read, naming the extension', async () => {
    await expect(parseTrackingNumbers(Buffer.from('x'), 'notes.docx')).rejects.toThrow(
      /\.docx/,
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/bring/parse.test.ts`
Expected: FAIL — `extractLongNumbers is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/lib/bring/parse.ts` (keep every existing export):

```ts
import { xlsxToText } from './xlsx'

/**
 * The fewest digits a parcel or shipment number can have.
 *
 * KolliID is 18 and Sändningsref is 17, so both clear it. The floor is set here
 * rather than lower because of one specific near miss: `Datum` reads
 * "2026-08-11 08:19:24", which is 14 digits once punctuation goes. Fourteen is
 * one below fifteen on purpose.
 *
 * `looksLikeTracking` above is deliberately NOT reused. It accepts 8-plus
 * digits, which is right for a PDF full of prose and wrong here, where it would
 * take that timestamp on every row of every file.
 */
const MIN_DIGITS = 15

/**
 * Every distinct long number in a document, in the order first seen.
 *
 * This is the whole of what we read from the warehouse's report. Not the order
 * number, which is theirs and not ours; not the columns, which they may
 * reorder; not the headings, which they may rename. Bring will tell us
 * everything else, and it cannot be talked into telling us the wrong thing.
 *
 * Both a package number and a shipment reference are valid lookups, so there is
 * no need to know which column a number came from.
 */
export function extractLongNumbers(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const token of text.split(/\s+/)) {
    if (!token) continue
    const digits = token.replace(/\D/g, '')
    if (digits.length < MIN_DIGITS) continue
    if (seen.has(digits)) continue
    seen.add(digits)
    out.push(digits)
  }
  return out
}

/**
 * Read whatever the warehouse sent and return the numbers in it.
 *
 * xlsx is what they send today. The others cost nothing to keep and mean a
 * change of format on their side is not an outage on ours.
 */
export async function parseTrackingNumbers(buf: Buffer, filename: string): Promise<string[]> {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (ext === 'xlsx') return extractLongNumbers(xlsxToText(buf))
  if (ext === 'pdf') return extractLongNumbers(await pdfToText(buf))
  if (ext === 'csv' || ext === 'txt')
    return extractLongNumbers(buf.toString('utf8').replace(/[;,]/g, ' '))
  throw new Error('Only Excel, PDF and CSV files can be read. This one is a .' + ext)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/bring/parse.test.ts`
Expected: PASS. The pre-existing `looksLikeTracking` / `extractPairs` / `parseTrackingFile` tests must still pass unchanged — if any of them now fail, you edited something you should not have.

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print feat/delivery-warehouse-intake
git add src/lib/bring/parse.ts src/lib/bring/parse.test.ts
git commit -m "feat(delivery): pull tracking numbers out of a file without reading its columns"
```

---

### Task 3: Resolve numbers into consignments

**Files:**
- Create: `src/lib/bring/consignments.ts`
- Test: `src/lib/bring/consignments.test.ts`

**Interfaces:**
- Consumes: `fetchTracking(creds: BringCredentials, numbers: string[], opts?: BringFilter): Promise<unknown[]>` from `./client`, and `BringCredentials` / `BringFilter` from the same file.
- Produces:
  - `type ResolvedConsignment = { consignmentId: string; packageNumbers: string[]; recipientEmail: string | null; recipientName: string | null }`
  - `resolveConsignments(creds: BringCredentials, numbers: string[], opts?: { deadline?: number }): Promise<{ consignments: ResolvedConsignment[]; unresolved: string[] }>`

One request per number, because Bring answers about only one. After each response we record every number that response accounted for — its `consignmentId` and all of its `packageNumber`s — and skip those later. Measured by running the committed parser over the sample file, that is what turns its **61 distinct long numbers** — 27 seventeen-digit shipment references plus 34 eighteen-digit package numbers — into **27 requests**, which then write **34 `Shipment` rows**: a two-parcel order is one consignment carrying both packages.

`unresolved` is every input number Bring returned nothing for. It is reported, never guessed at.

- [ ] **Step 1: Write the failing test**

Create `src/lib/bring/consignments.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

const fetchTracking = vi.fn()
vi.mock('./client', () => ({ fetchTracking: (...a: unknown[]) => fetchTracking(...a) }))

const { resolveConsignments } = await import('./consignments')

const CREDS = { uid: 'a@b.test', key: 'k', clientUrl: 'https://example.test/' }

/** Shaped like Bring's real reply — see src/lib/bring/__fixtures__/. */
const reply = (
  consignmentId: string,
  packages: { packageNumber: string; recipientEmailAddress?: string }[],
  recipientName = 'Test Person',
) => ({ consignmentId, recipientName, packageSet: packages })

beforeEach(() => fetchTracking.mockReset())

describe('resolveConsignments', () => {
  it('asks for exactly one number per request — Bring answers about only one', async () => {
    fetchTracking.mockResolvedValue([])
    await resolveConsignments(CREDS, ['111111111111111', '222222222222222'])
    expect(fetchTracking).toHaveBeenCalledTimes(2)
    for (const call of fetchTracking.mock.calls) expect(call[1]).toHaveLength(1)
  })

  it('reads the recipient email off the first package', async () => {
    fetchTracking.mockResolvedValue([
      reply('73325383667032998', [
        { packageNumber: '373325386490923366', recipientEmailAddress: 'Buyer@Example.TEST' },
      ]),
    ])
    const { consignments } = await resolveConsignments(CREDS, ['373325386490923366'])
    expect(consignments).toEqual([
      {
        consignmentId: '73325383667032998',
        packageNumbers: ['373325386490923366'],
        recipientEmail: 'buyer@example.test',
        recipientName: 'Test Person',
      },
    ])
  })

  it('skips a number an earlier response already accounted for', async () => {
    // One consignment, two packages. The file lists both, plus the shipment ref.
    fetchTracking.mockResolvedValue([
      reply('73325383667043604', [
        { packageNumber: '373325386490957422', recipientEmailAddress: 'x@example.test' },
        { packageNumber: '373325386490957439' },
      ]),
    ])
    const { consignments, unresolved } = await resolveConsignments(CREDS, [
      '373325386490957422',
      '373325386490957439',
      '73325383667043604',
    ])
    expect(fetchTracking).toHaveBeenCalledTimes(1)
    expect(consignments).toHaveLength(1)
    expect(consignments[0].packageNumbers).toEqual([
      '373325386490957422',
      '373325386490957439',
    ])
    expect(unresolved).toEqual([])
  })

  it('reports a number Bring knows nothing about instead of inventing one', async () => {
    fetchTracking.mockResolvedValue([])
    const { consignments, unresolved } = await resolveConsignments(CREDS, ['999999999999999'])
    expect(consignments).toEqual([])
    expect(unresolved).toEqual(['999999999999999'])
  })

  it('keeps going when one lookup throws, and reports that number as unresolved', async () => {
    fetchTracking
      .mockRejectedValueOnce(new Error('Bring responded 503: nope'))
      .mockResolvedValueOnce([
        reply('73325383667032998', [
          { packageNumber: '373325386490923366', recipientEmailAddress: 'x@example.test' },
        ]),
      ])
    const { consignments, unresolved } = await resolveConsignments(CREDS, [
      '111111111111111',
      '373325386490923366',
    ])
    expect(unresolved).toEqual(['111111111111111'])
    expect(consignments).toHaveLength(1)
  })

  it('stops starting new lookups once the deadline has passed', async () => {
    fetchTracking.mockResolvedValue([])
    const { unresolved } = await resolveConsignments(
      CREDS,
      ['111111111111111', '222222222222222'],
      { deadline: Date.now() - 1 },
    )
    expect(fetchTracking).not.toHaveBeenCalled()
    expect(unresolved).toHaveLength(2)
  })

  it('records a consignment with no email so the caller can say why it did not link', async () => {
    fetchTracking.mockResolvedValue([
      reply('73325383667032998', [{ packageNumber: '373325386490923366' }]),
    ])
    const { consignments } = await resolveConsignments(CREDS, ['373325386490923366'])
    expect(consignments[0].recipientEmail).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/bring/consignments.test.ts`
Expected: FAIL — `Failed to resolve import "./consignments"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/bring/consignments.ts`:

```ts
import { fetchTracking, type BringCredentials } from './client'

export type ResolvedConsignment = {
  consignmentId: string
  /** Every package in this consignment. One Shipment row will be written per entry. */
  packageNumbers: string[]
  /** Lower-cased. Null when Bring holds no email for the parcel. */
  recipientEmail: string | null
  recipientName: string | null
}

export type ResolveResult = {
  consignments: ResolvedConsignment[]
  /** Input numbers Bring returned nothing for, or that failed. Reported, never guessed. */
  unresolved: string[]
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null

/**
 * Turn the numbers found in a warehouse file into consignments.
 *
 * ONE NUMBER PER REQUEST. Bring answers about a single `q` however many are
 * sent — measured against the live API on 2026-08-12: ten in returned one
 * consignment, two in returned none, one in returned the right parcel 27 times
 * out of 27. Batching here would look like it worked and silently lose parcels.
 *
 * A file lists both the package number and the shipment reference for the same
 * parcel, and a two-parcel order lists three numbers for one consignment. Since
 * a response names its consignment AND all of its packages, everything it
 * accounted for can be struck off before the next request. Measured by running
 * the committed parser over the real 2026-08-11 file, that is what takes its 61
 * distinct long numbers — 27 seventeen-digit shipment references plus 34
 * eighteen-digit package numbers — down to 27 lookups.
 */
export async function resolveConsignments(
  creds: BringCredentials,
  numbers: string[],
  opts: { deadline?: number } = {},
): Promise<ResolveResult> {
  const consignments: ResolvedConsignment[] = []
  const unresolved: string[] = []
  const accounted = new Set<string>()

  for (const number of numbers) {
    if (accounted.has(number)) continue

    // Checked before the request, not after: starting a lookup we have no time
    // to finish spends the budget for nothing. Same rule as sync.ts:120.
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
      unresolved.push(number)
      continue
    }

    let raw: unknown[]
    try {
      raw = await fetchTracking(creds, [number], { deadline: opts.deadline })
    } catch {
      // One dead lookup must not stop the file. The number is reported so a
      // half-read import is visible rather than silently short.
      unresolved.push(number)
      continue
    }

    const first = raw[0] as
      | { consignmentId?: unknown; recipientName?: unknown; packageSet?: unknown }
      | undefined
    const consignmentId = str(first?.consignmentId)
    const packages = Array.isArray(first?.packageSet) ? first.packageSet : []
    const packageNumbers: string[] = []
    let recipientEmail: string | null = null

    for (const pkg of packages) {
      const p = pkg as { packageNumber?: unknown; recipientEmailAddress?: unknown }
      const n = str(p?.packageNumber)
      if (n) packageNumbers.push(n)
      if (!recipientEmail) {
        const e = str(p?.recipientEmailAddress)
        if (e) recipientEmail = e.toLowerCase()
      }
    }

    if (!consignmentId || packageNumbers.length === 0) {
      unresolved.push(number)
      continue
    }

    accounted.add(number)
    accounted.add(consignmentId)
    for (const n of packageNumbers) accounted.add(n)

    consignments.push({
      consignmentId,
      packageNumbers,
      recipientEmail,
      recipientName: str(first?.recipientName),
    })
  }

  return { consignments, unresolved }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/bring/consignments.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print feat/delivery-warehouse-intake
git add src/lib/bring/consignments.ts src/lib/bring/consignments.test.ts
git commit -m "feat(delivery): resolve warehouse numbers into Bring consignments"
```

---

### Task 4: Match a consignment to an order by email

**Files:**
- Create: `src/lib/bring/match.ts`
- Test: `src/lib/bring/match.integration.test.ts`

**Interfaces:**
- Consumes: `ResolvedConsignment` from Task 3, `db` from `@/lib/db`.
- Produces:
  - `type MatchOutcome = { orderId: string } | { orderId: null; reason: string }`
  - `matchByEmail(email: string | null, receivedAt: Date): Promise<MatchOutcome>`
  - `const MATCH_WINDOW_DAYS = 30`

This is the heart of the plan. The rule, in full: orders whose `customerEmail` equals the recipient email case-insensitively, in a shop with `deliveryTrackingFrom` set, with `placedAt` at or before `receivedAt` and no more than 30 days before it, and `voidedAt` null. Exactly one match links. Zero or several is refused with a reason.

**Refusing rather than taking the newest is deliberate**, and follows the rule `link.ts:46` already sets for ambiguous order numbers: a wrong link poisons that order's delivery figure permanently and invisibly, while a refused one is on screen. On the sample this costs nothing — all 27 are unique.

The upper bound is when the file reached us, not the file's `Datum` column, because reading `Datum` means parsing their table again and that is the dependency this whole design removes. Receipt is hours after dispatch, which only widens the candidate set, and the exact-email match plus the refusal rule handle that.

- [ ] **Step 1: Write the failing test**

Create `src/lib/bring/match.integration.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { matchByEmail } from './match'

// Unique to THIS file — see "Test data convention" in the Global Constraints.
const TAG = '[intake-match-test]'
const scoped = { shop: { name: { contains: TAG } } }

const RECEIVED = new Date('2026-08-11T18:00:00Z')

let trackedShopId: string
let untrackedShopId: string

const order = (
  shopId: string,
  externalId: string,
  email: string,
  placedAt: string,
  extra: Record<string, unknown> = {},
) =>
  db.order.create({
    data: {
      shopId,
      externalId,
      number: externalId,
      placedAt: new Date(placedAt),
      status: 'completed',
      currency: 'NOK',
      grossSales: 1000, discountTotal: 0, netSales: 1000,
      shippingCharged: 0, taxTotal: 0, total: 1000,
      customerEmail: email,
      ...extra,
    },
  })

async function cleanup() {
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

beforeAll(async () => {
  await cleanup()
  const tracked = await db.shop.create({
    data: {
      name: `Tracked ${TAG}`, currency: 'NOK',
      deliveryTrackingFrom: new Date('2026-01-01'),
    },
  })
  const untracked = await db.shop.create({
    data: { name: `Untracked ${TAG}`, currency: 'NOK', deliveryTrackingFrom: null },
  })
  trackedShopId = tracked.id
  untrackedShopId = untracked.id
})

afterAll(cleanup)

describe('matchByEmail', () => {
  it('links the one order with that email', async () => {
    const o = await order(trackedShopId, 'M1', 'one@example.test', '2026-08-10T09:00:00Z')
    await expect(matchByEmail('one@example.test', RECEIVED)).resolves.toEqual({ orderId: o.id })
  })

  it('ignores case, because Bring and Woo disagree about it', async () => {
    const o = await order(trackedShopId, 'M2', 'Mixed@Example.TEST', '2026-08-10T09:00:00Z')
    await expect(matchByEmail('mixed@example.test', RECEIVED)).resolves.toEqual({ orderId: o.id })
  })

  it('refuses when two live orders share an email in the window, rather than guessing', async () => {
    await order(trackedShopId, 'M3a', 'twice@example.test', '2026-08-09T09:00:00Z')
    await order(trackedShopId, 'M3b', 'twice@example.test', '2026-08-10T09:00:00Z')
    const out = await matchByEmail('twice@example.test', RECEIVED)
    expect(out.orderId).toBeNull()
    expect((out as { reason: string }).reason).toMatch(/2 orders/)
  })

  it('says so when no order has that email', async () => {
    const out = await matchByEmail('nobody@example.test', RECEIVED)
    expect(out.orderId).toBeNull()
    expect((out as { reason: string }).reason).toMatch(/No order/i)
  })

  it('says so when Bring held no email at all', async () => {
    const out = await matchByEmail(null, RECEIVED)
    expect(out.orderId).toBeNull()
    expect((out as { reason: string }).reason).toMatch(/no email/i)
  })

  it('will not reach into a shop that is not delivery-tracked', async () => {
    await order(untrackedShopId, 'M4', 'untracked@example.test', '2026-08-10T09:00:00Z')
    const out = await matchByEmail('untracked@example.test', RECEIVED)
    expect(out.orderId).toBeNull()
  })

  it('ignores an order placed after the file reached us', async () => {
    await order(trackedShopId, 'M5', 'later@example.test', '2026-08-12T09:00:00Z')
    const out = await matchByEmail('later@example.test', RECEIVED)
    expect(out.orderId).toBeNull()
  })

  it('ignores an order older than the window', async () => {
    await order(trackedShopId, 'M6', 'ancient@example.test', '2026-05-01T09:00:00Z')
    const out = await matchByEmail('ancient@example.test', RECEIVED)
    expect(out.orderId).toBeNull()
  })

  it('ignores a voided order, so a repeat customer is not ambiguous because of one', async () => {
    await order(trackedShopId, 'M7a', 'repeat@example.test', '2026-08-08T09:00:00Z', {
      voidedAt: new Date('2026-08-09T09:00:00Z'),
    })
    const live = await order(trackedShopId, 'M7b', 'repeat@example.test', '2026-08-10T09:00:00Z')
    await expect(matchByEmail('repeat@example.test', RECEIVED)).resolves.toEqual({
      orderId: live.id,
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project delivery src/lib/bring/match.integration.test.ts`
Expected: FAIL — `Failed to resolve import "./match"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/bring/match.ts`:

```ts
import { db } from '../db'

/** How far before the file's arrival an order may have been placed. */
export const MATCH_WINDOW_DAYS = 30

const DAY = 24 * 60 * 60 * 1000

export type MatchOutcome = { orderId: string } | { orderId: null; reason: string }

/**
 * Find the order a parcel belongs to, from the recipient email Bring returns.
 *
 * The warehouse's own `Order` column cannot do this job. It is their internal
 * counter — Bring carries it as `senderReference` — and it happens to fall in
 * the same numeric range as Panetti Norway's order numbers, so every value
 * matches a real order and none of them match the right one. Measured on the
 * 2026-08-11 sample: 0 of 27 correct. The recipient email scored 27 of 27.
 *
 * Two or more candidates are REFUSED, not resolved by taking the newest. This
 * is the same judgement link.ts:46 makes about an order number two shops share:
 * a wrong link poisons that order's delivery figure permanently and nobody ever
 * notices, while a refused one is listed on the delivery page with its reason.
 *
 * `receivedAt` is when the file reached us, NOT the file's own dispatch column.
 * Reading that column would put us back to parsing their table, which is the
 * dependency this path exists to remove. Receipt is a few hours after dispatch,
 * so the bound is looser but never wrong: it exists to stop a parcel attaching
 * to an order the same customer placed AFTER it shipped.
 */
export async function matchByEmail(
  email: string | null,
  receivedAt: Date,
): Promise<MatchOutcome> {
  if (!email) return { orderId: null, reason: 'Bring holds no email for this parcel' }

  const orders = await db.order.findMany({
    where: {
      customerEmail: { equals: email, mode: 'insensitive' },
      shop: { deliveryTrackingFrom: { not: null } },
      placedAt: {
        gte: new Date(receivedAt.getTime() - MATCH_WINDOW_DAYS * DAY),
        lte: receivedAt,
      },
      voidedAt: null,
    },
    select: { id: true },
    take: 2, // one is enough to link, two is enough to refuse
  })

  if (orders.length === 0) return { orderId: null, reason: `No order for ${email}` }
  if (orders.length > 1)
    return { orderId: null, reason: `${email} matched 2 orders in the last ${MATCH_WINDOW_DAYS} days` }
  return { orderId: orders[0].id }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project delivery src/lib/bring/match.integration.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print feat/delivery-warehouse-intake
git add src/lib/bring/match.ts src/lib/bring/match.integration.test.ts
git commit -m "feat(delivery): match a parcel to its order by the recipient email"
```

---

### Task 5: Import a file end to end, and receive it by email

**Files:**
- Modify: `src/lib/bring/import.ts`
- Create: `src/app/api/delivery/inbound/route.ts`
- Test: `src/lib/bring/import-email.integration.test.ts`
- Test: `src/app/api/delivery/inbound/route.integration.test.ts`

**Interfaces:**
- Consumes: `parseTrackingNumbers` (Task 2), `resolveConsignments` / `ResolvedConsignment` (Task 3), `matchByEmail` / `MatchOutcome` (Task 4), and `ImportParseError` from `./import`.
- Also consumes `getDeliveryConfig` from **`../delivery/config`** — note the directory: it lives in `src/lib/delivery/config.ts`, not in `src/lib/bring/`. Its real signature is `getDeliveryConfig(): Promise<{ creds: BringCredentials | null; slackWebhookUrl: string | null }>`. It **never returns null and never throws**: an unreadable key yields `creds: null`, which is the "reconnect Bring" case. Destructure `creds` and test that, not the outer object.
- Produces:
  - `importWarehouseFile(buf: Buffer, filename: string, source: 'UPLOAD' | 'EMAIL', opts?: { deadline?: number }): Promise<ImportResult>`
  - `ImportResult` gains nothing; reuse the existing type from `import.ts:5`.

`importTrackingFile` stays exactly as it is. This is a second, additive entry point. Wiring the upload page over to it is not this plan's job.

One `Shipment` per `packageNumber`, all pointing at the matched order, `linkSource: 'BRING_EMAIL'`, `nextPollAt: new Date()` so the next cron run picks them up. Use `upsert` keyed on `trackingNumber`, updating only `orderId` and `linkSource` — a re-import must never undo a week of tracking, exactly as `link.ts:54-66` already does.

The route is machine-to-machine. It must **not** call `currentUser()` or `assertAdmin`.

- [ ] **Step 1: Write the failing test for the import**

Create `src/lib/bring/import-email.integration.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'

const resolveConsignments = vi.fn()
vi.mock('./consignments', () => ({
  resolveConsignments: (...a: unknown[]) => resolveConsignments(...a),
}))

const { db } = await import('@/lib/db')
const { importWarehouseFile } = await import('./import')
const { encryptSecret } = await import('@/lib/secrets')

const TAG = '[intake-import-test]'
const PREFIX = 'IMIMP'
const scoped = { shop: { name: { contains: TAG } } }
const FILES = ['eod.xlsx', 'broken.docx']

let shopId: string

async function cleanup() {
  await db.shipmentEvent.deleteMany({
    where: { shipment: { trackingNumber: { startsWith: PREFIX } } },
  })
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: PREFIX } } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  await db.trackingImport.deleteMany({ where: { filename: { in: FILES } } })
}

const book = (values: string[]) =>
  Buffer.from(
    zipSync({
      'xl/worksheets/sheet1.xml': strToU8(
        values.map((v) => `<c><v>${v}</v></c>`).join(''),
      ),
    }),
  )

beforeAll(async () => {
  await cleanup()

  // importWarehouseFile refuses to run when Bring is not connected, so the
  // singleton must hold readable credentials. UPSERT, never delete-then-create:
  // it is a fixed-id row no tag can isolate — see the Global Constraints.
  const connected = {
    bringApiUid: 'test@example.test',
    bringApiKey: encryptSecret('test-key'),
    bringClientUrl: 'https://example.test/',
  }
  await db.deliveryConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', ...connected },
    update: connected,
  })

  const shop = await db.shop.create({
    data: {
      name: `Shop ${TAG}`, currency: 'NOK',
      deliveryTrackingFrom: new Date('2026-01-01'),
    },
  })
  shopId = shop.id
  await db.order.create({
    data: {
      shopId, externalId: 'I1', number: 'I1',
      placedAt: new Date(), status: 'completed', currency: 'NOK',
      grossSales: 1000, discountTotal: 0, netSales: 1000,
      shippingCharged: 0, taxTotal: 0, total: 1000,
      customerEmail: 'buyer@example.test',
    },
  })
})

afterAll(async () => {
  await cleanup()
  await db.deliveryConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  })
})

describe('importWarehouseFile', () => {
  it('writes one shipment per package and links them all to the one order', async () => {
    resolveConsignments.mockResolvedValue({
      consignments: [
        {
          consignmentId: `${PREFIX}C1`,
          packageNumbers: [`${PREFIX}0001`, `${PREFIX}0002`],
          recipientEmail: 'buyer@example.test',
          recipientName: 'Buyer',
        },
      ],
      unresolved: [],
    })
    const result = await importWarehouseFile(
      book(['373325386490923366']), 'eod.xlsx', 'EMAIL',
    )
    expect(result.linked).toBe(2)

    const rows = await db.shipment.findMany({
      where: { trackingNumber: { startsWith: PREFIX } },
      orderBy: { trackingNumber: 'asc' },
    })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.orderId !== null)).toBe(true)
    expect(rows[0].linkSource).toBe('BRING_EMAIL')
    expect(rows[0].nextPollAt).not.toBeNull()
  })

  it('records the run, with the source, so a silent morning is visible', async () => {
    const row = await db.trackingImport.findFirst({
      where: { filename: 'eod.xlsx' },
      orderBy: { receivedAt: 'desc' },
    })
    expect(row?.source).toBe('EMAIL')
    expect(row?.rowsLinked).toBe(2)
  })

  it('is safe to run twice — the second import adopts, never rebuilds', async () => {
    const before = await db.shipment.findFirst({
      where: { trackingNumber: `${PREFIX}0001` },
    })
    resolveConsignments.mockResolvedValue({
      consignments: [
        {
          consignmentId: `${PREFIX}C1`,
          packageNumbers: [`${PREFIX}0001`, `${PREFIX}0002`],
          recipientEmail: 'buyer@example.test',
          recipientName: 'Buyer',
        },
      ],
      unresolved: [],
    })
    await importWarehouseFile(book(['373325386490923366']), 'eod.xlsx', 'EMAIL')
    const after = await db.shipment.findMany({
      where: { trackingNumber: { startsWith: PREFIX } },
    })
    expect(after).toHaveLength(2)
    expect(after.find((r) => r.trackingNumber === `${PREFIX}0001`)?.createdAt).toEqual(
      before?.createdAt,
    )
  })

  it('states why a parcel did not link instead of dropping it silently', async () => {
    resolveConsignments.mockResolvedValue({
      consignments: [
        {
          consignmentId: `${PREFIX}C9`,
          packageNumbers: [`${PREFIX}9999`],
          recipientEmail: 'stranger@example.test',
          recipientName: 'Stranger',
        },
      ],
      unresolved: ['888888888888888'],
    })
    const result = await importWarehouseFile(
      book(['373325386490923366']), 'eod.xlsx', 'EMAIL',
    )
    expect(result.linked).toBe(0)
    expect(result.unmatched.some((u) => /stranger@example.test/.test(u.reason))).toBe(true)
    expect(result.unaccounted).toBeGreaterThan(0)
  })

  it('records a file it cannot read at all, then throws for the uploader', async () => {
    await expect(
      importWarehouseFile(Buffer.from('x'), 'broken.docx', 'UPLOAD'),
    ).rejects.toThrow(/\.docx/)
    const row = await db.trackingImport.findFirst({ where: { filename: 'broken.docx' } })
    expect(row?.error).toMatch(/\.docx/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project delivery src/lib/bring/import-email.integration.test.ts`
Expected: FAIL — `importWarehouseFile is not a function`.

- [ ] **Step 3: Implement `importWarehouseFile`**

Add to `src/lib/bring/import.ts`, leaving `importTrackingFile`, `ImportResult`, `ImportParseError` and `recordFailedAttempt` in place:

```ts
import { parseTrackingNumbers } from './parse'
import { resolveConsignments } from './consignments'
import { matchByEmail } from './match'
// Note the directory: config.ts lives under delivery/, not bring/.
import { getDeliveryConfig } from '../delivery/config'

/**
 * Read one warehouse file the format-independent way.
 *
 * The warehouse's own order number is not ours and lands on the wrong order
 * every time, so this path never looks at it. It takes the long numbers out of
 * the file, asks Bring who each parcel belongs to, and matches on the recipient
 * email. That means a change to their column order, their headings, or their
 * file format is not an outage here.
 *
 * `importTrackingFile` above is the older order-number path and is left alone.
 */
export async function importWarehouseFile(
  buf: Buffer,
  filename: string,
  source: 'UPLOAD' | 'EMAIL',
  opts: { deadline?: number } = {},
): Promise<ImportResult> {
  const receivedAt = new Date()

  let numbers: string[]
  try {
    numbers = await parseTrackingNumbers(buf, filename)
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Could not read this file'
    await recordFailedAttempt(filename, source, {
      rowsParsed: 0, rowsLinked: 0, rowsUnmatched: 0, error,
    })
    throw new ImportParseError(error)
  }

  // getDeliveryConfig never throws and never returns null: an unreadable key
  // comes back as creds: null, which is the "reconnect Bring" case.
  const { creds } = await getDeliveryConfig()
  if (!creds) {
    const error = 'Bring is not connected, so parcels cannot be identified'
    await recordFailedAttempt(filename, source, {
      rowsParsed: numbers.length, rowsLinked: 0, rowsUnmatched: numbers.length, error,
    })
    throw new ImportParseError(error)
  }

  const { consignments, unresolved } = await resolveConsignments(creds, numbers, opts)

  const unmatched: UnmatchedRow[] = []
  let linked = 0

  for (const c of consignments) {
    const outcome = await matchByEmail(c.recipientEmail, receivedAt)
    if (outcome.orderId === null) {
      unmatched.push({
        orderNumber: c.recipientName ?? c.consignmentId,
        trackingNumber: c.packageNumbers[0],
        reason: outcome.reason,
      })
      continue
    }
    for (const trackingNumber of c.packageNumbers) {
      await db.shipment.upsert({
        where: { trackingNumber },
        // Due immediately, so the next cron run picks it up.
        create: {
          trackingNumber,
          orderId: outcome.orderId,
          linkSource: 'BRING_EMAIL',
          nextPollAt: new Date(),
        },
        // Only the link. Milestones, events and poll state are the sync's to
        // own, and a re-import must not undo a week of tracking.
        update: { orderId: outcome.orderId, linkSource: 'BRING_EMAIL' },
      })
      linked++
    }
  }

  // Everything the file offered that did not end up linked, named or not.
  const seen = numbers.length
  const unaccounted = unresolved.length + unmatched.length

  const record = await db.trackingImport.create({
    data: {
      filename,
      source,
      rowsParsed: seen,
      rowsLinked: linked,
      rowsUnmatched: unaccounted,
      unmatched: unmatched.length ? JSON.stringify(unmatched) : null,
    },
  })

  return { importId: record.id, parsed: seen, linked, unmatched, unaccounted }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project delivery src/lib/bring/import-email.integration.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing test for the route**

Create `src/app/api/delivery/inbound/route.integration.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'

const importWarehouseFile = vi.fn()
vi.mock('@/lib/bring/import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bring/import')>()
  return { ...actual, importWarehouseFile: (...a: unknown[]) => importWarehouseFile(...a) }
})

const { db } = await import('@/lib/db')
const { POST } = await import('./route')

const SECRET = 'inbound-secret-for-tests'
const FILES = ['eod.xlsx']

beforeAll(() => {
  process.env.DELIVERY_INBOUND_SECRET = SECRET
})

afterAll(async () => {
  await db.trackingImport.deleteMany({ where: { filename: { in: FILES } } })
})

const post = (body: unknown, token = SECRET) =>
  POST(
    new Request(`https://x.test/api/delivery/inbound?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const message = (name: string, content = Buffer.from('x').toString('base64')) => ({
  Subject: 'EOD report',
  From: 'warehouse@example.test',
  Attachments: [{ Name: name, Content: content, ContentType: 'application/octet-stream' }],
})

describe('POST /api/delivery/inbound', () => {
  it('rejects a wrong token', async () => {
    const res = await post(message('eod.xlsx'), 'not-the-secret')
    expect(res.status).toBe(401)
    expect(importWarehouseFile).not.toHaveBeenCalled()
  })

  it('rejects a missing token', async () => {
    const res = await POST(
      new Request('https://x.test/api/delivery/inbound', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message('eod.xlsx')),
      }),
    )
    expect(res.status).toBe(401)
  })

  it('imports the attachment and answers 200', async () => {
    importWarehouseFile.mockResolvedValue({
      importId: 'x', parsed: 3, linked: 3, unmatched: [], unaccounted: 0,
    })
    const res = await post(message('eod.xlsx'))
    expect(res.status).toBe(200)
    expect(importWarehouseFile).toHaveBeenCalledOnce()
    expect(importWarehouseFile.mock.calls[0][1]).toBe('eod.xlsx')
    expect(importWarehouseFile.mock.calls[0][2]).toBe('EMAIL')
  })

  it('skips an attachment type it cannot read, without failing the delivery', async () => {
    importWarehouseFile.mockClear()
    const res = await post(message('signature.png'))
    expect(res.status).toBe(200)
    expect(importWarehouseFile).not.toHaveBeenCalled()
  })

  it('answers 200 even when the import throws, so Postmark does not redeliver', async () => {
    importWarehouseFile.mockRejectedValue(new Error('bad file'))
    const res = await post(message('eod.xlsx'))
    expect(res.status).toBe(200)
  })

  it('records an email that carried no readable attachment at all', async () => {
    importWarehouseFile.mockClear()
    const res = await post({ Subject: 'hello', From: 'x@example.test', Attachments: [] })
    expect(res.status).toBe(200)
    const row = await db.trackingImport.findFirst({
      where: { source: 'EMAIL', error: { contains: 'no readable attachment' } },
      orderBy: { receivedAt: 'desc' },
    })
    expect(row).not.toBeNull()
    await db.trackingImport.deleteMany({ where: { id: row!.id } })
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run --project delivery src/app/api/delivery/inbound/route.integration.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 7: Implement the route**

Create `src/app/api/delivery/inbound/route.ts`:

```ts
import { timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { importWarehouseFile } from '@/lib/bring/import'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Reading a file and asking Bring about every parcel in it is not instant. */
export const maxDuration = 60

/** What the warehouse could plausibly attach that we can actually read. */
const READABLE = /\.(xlsx|csv|txt|pdf)$/i

/** Refuse anything absurd before decoding it. A day's report is a few kilobytes. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/**
 * NOT admin-only, and deliberately so: Postmark is a machine and has no session.
 * A shared secret in the URL is the whole of the authentication, so it is
 * compared in constant time and the route does nothing at all before it passes.
 */
function authorised(req: Request): boolean {
  const expected = process.env.DELIVERY_INBOUND_SECRET
  if (!expected) return false
  const given = new URL(req.url).searchParams.get('token') ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

type Attachment = { Name?: unknown; Content?: unknown }

/**
 * One inbound email from the warehouse.
 *
 * Answers 200 to almost everything on purpose. Postmark redelivers on a
 * non-2xx, and a file we have already taken and failed to parse will fail
 * exactly the same way on every retry — so a failure is RECORDED, in
 * TrackingImport, and acknowledged. The delivery page is where a bad morning
 * becomes visible; the retry queue is not.
 */
export async function POST(req: Request) {
  if (!authorised(req))
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401, headers: NO_STORE })

  let body: { Attachments?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected JSON' }, { status: 400, headers: NO_STORE })
  }

  const attachments = Array.isArray(body.Attachments) ? (body.Attachments as Attachment[]) : []
  const results: { filename: string; linked?: number; error?: string }[] = []

  for (const a of attachments) {
    const filename = typeof a?.Name === 'string' ? a.Name : ''
    const content = typeof a?.Content === 'string' ? a.Content : ''
    if (!filename || !READABLE.test(filename) || !content) continue

    const buf = Buffer.from(content, 'base64')
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      results.push({ filename, error: 'Attachment too large' })
      continue
    }

    try {
      const r = await importWarehouseFile(buf, filename, 'EMAIL')
      results.push({ filename, linked: r.linked })
    } catch (e) {
      // importWarehouseFile has already written its own TrackingImport row.
      console.error(e)
      results.push({ filename, error: e instanceof Error ? e.message : 'Import failed' })
    }
  }

  if (results.length === 0) {
    // An email that carried nothing we could read is exactly the event nobody
    // would otherwise notice: linking simply stops and the page looks like a
    // quiet day.
    await db.trackingImport
      .create({
        data: {
          filename: attachments.map((a) => String(a?.Name ?? '?')).join(', ') || '(none)',
          source: 'EMAIL',
          rowsParsed: 0, rowsLinked: 0, rowsUnmatched: 0,
          error: 'This email carried no readable attachment',
        },
      })
      .catch(() => {})
  }

  return NextResponse.json({ ok: true, results }, { headers: NO_STORE })
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run --project delivery src/app/api/delivery/inbound/route.integration.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 9: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print feat/delivery-warehouse-intake
git add src/lib/bring/import.ts src/lib/bring/import-email.integration.test.ts \
        src/app/api/delivery/inbound/route.ts \
        src/app/api/delivery/inbound/route.integration.test.ts
git commit -m "feat(delivery): receive the warehouse report by email and link it"
```

---

### Task 6: One number per Bring request

**Files:**
- Modify: `src/lib/bring/sync.ts:20`
- Modify: `prisma/schema.prisma:467` (doc comment only)
- Test: `src/lib/bring/sync.integration.test.ts` (append one test)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new.

Measured against the live API on 2026-08-12: ten numbers in returned one consignment, two returned none, one returned the right parcel 27 times out of 27. With `BATCH = 10`, nine of every ten parcels take the `if (!found)` branch at `sync.ts:150`, get stamped `lastError: 'Bring does not know this number yet'` and are pushed six hours out. No data is lost, but tracking crawls and the error text lies. It has never fired because there are no shipments yet.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/bring/sync.integration.test.ts`, following the mocking style already used in that file for `fetchTracking`:

```ts
it('asks Bring about one parcel per request — it answers about only one', async () => {
  // Two due parcels. With a batch size above 1 they go out in a single request
  // and Bring replies about one of them, leaving the other falsely marked
  // unknown. Reuse this file's existing fixture helpers and its fetchTracking
  // mock; assert on the shape of the calls, not on their number.
  const calls = fetchTracking.mock.calls
  expect(calls.length).toBeGreaterThanOrEqual(2)
  for (const call of calls) expect(call[1]).toHaveLength(1)
})
```

Read the surrounding file first and place this inside the describe block that already creates due shipments, reusing its fixtures rather than adding new ones. If that file's mock is not named `fetchTracking`, use whatever name it already uses.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project delivery src/lib/bring/sync.integration.test.ts`
Expected: FAIL — one call carrying 2 numbers.

- [ ] **Step 3: Change the batch size**

In `src/lib/bring/sync.ts`, replace the `BATCH` declaration and its comment:

```ts
/**
 * How many parcels go out in one request.
 *
 * One. Bring's tracking endpoint answers about a SINGLE `q` however many are
 * sent — measured 2026-08-12: ten in returned one consignment, two in returned
 * none, one in returned the right parcel 27 times out of 27. A larger number
 * looks like it works, because the batch succeeds and most of its parcels are
 * then marked "Bring does not know this number yet" and quietly retried.
 *
 * The loop below is kept as a loop rather than flattened, because the deadline
 * check between iterations is what bounds a run.
 */
const BATCH = 1
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project delivery src/lib/bring/sync.integration.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Record the new link source in the schema comment**

In `prisma/schema.prisma`, update the `linkSource` doc comment (currently `/// Which strategy produced the link: FILE | NYCE | WOO | MANUAL.`):

```prisma
  /// Which strategy produced the link: FILE | BRING_EMAIL | NYCE | WOO | MANUAL.
  /// BRING_EMAIL is the warehouse-file path: the file gives only parcel numbers,
  /// Bring gives the recipient email, and that matches Order.customerEmail.
  linkSource     String?
```

This is a comment. Do **not** run `npm run db:push` — the column is unchanged.

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print feat/delivery-warehouse-intake
git add src/lib/bring/sync.ts src/lib/bring/sync.integration.test.ts prisma/schema.prisma
git commit -m "fix(delivery): Bring answers about one parcel per request, not ten"
```

---

### Task 7: Full gates, then switch it on

**Files:** none.

- [ ] **Step 1: Run the whole suite**

Run: `npm run test`
Expected: PASS. Note the total file count before and after — a bad glob silently runs fewer tests, which looks like success. `src/lib/woo/sync.test.ts` is known to flake under DB contention and is unrelated to this branch; re-run it alone to confirm before treating a failure there as real.

- [ ] **Step 2: Lint and build**

Run: `npm run lint` then `npm run build`
Expected: both clean.

- [ ] **Step 3: Commit anything the gates changed, then push**

```bash
git rev-parse --abbrev-ref HEAD   # must print feat/delivery-warehouse-intake
git push
```

- [ ] **Step 4: Set the secret in Vercel**

Add `DELIVERY_INBOUND_SECRET` to the Vercel project, production and preview, as a long random string. Redeploy so it is live.

- [ ] **Step 5: Point Postmark at the route**

In Postmark, create an inbound stream and set its webhook to:

```
https://panetti.vercel.app/api/delivery/inbound?token=<DELIVERY_INBOUND_SECRET>
```

Postmark then gives an inbound address ending `@inbound.postmarkapp.com`. That is the address the warehouse sends the daily report to.

You may forward a friendlier address onto it later; nothing in the code cares which address delivered the mail. **If you do, do not publish that address without a sender allowlist in front of it.** The route authenticates the URL, not the sender: it never looks at `From`, so anyone who learns the inbound address can post attachments into our import queue. A Postmark inbound domain rule, or a forwarding filter that only passes the warehouse's address, is what makes it safe to hand out.

- [ ] **Step 6: Confirm Postmark is actually getting a 200**

Send one message to the inbound address and open Postmark's **Activity** view for that inbound stream. The webhook response must be **200**.

Check this before anything else, because both ways it can fail are silent on our side:

- **401** — the `token` in the webhook URL does not match `DELIVERY_INBOUND_SECRET` in Vercel. The route refuses before it does anything at all.
- **308** — the middleware exemption for `/api/delivery/inbound` (`src/middleware.ts`, `MACHINE_PATHS`) is missing or the path changed, so the canonical-host redirect caught the delivery.

In both cases **nothing is written**: no `TrackingImport` row, no `Shipment`, no error anywhere in our logs. The delivery page then looks like a quiet day, permanently, and the only place the truth exists is Postmark's Activity view. That is why this is a step and not a footnote.

- [ ] **Step 7: Switch the two Norway shops on**

On `https://panetti.vercel.app/settings/delivery`, set the tracking-from date for **Panetti Norway** and **Mazzetti Norway** to **today** — the day you switch on, not a backdated one. Leave Sweden, Denmark, Germany and Finland empty until we know whether the warehouse reports on them. This is data, not code.

**Today, and not earlier, on purpose.** There is no historical backfill in this design: the only parcels we will ever hold are the ones the warehouse reports from now on. But `src/lib/delivery/alerts.ts` treats an order in a delivery-tracked shop with no shipment as a late-alert candidate across a 90-day window (`ALERT_WINDOW_DAYS = 90`). Backdate the date and the first cron run after switch-on posts a Slack message about hundreds of orders that shipped perfectly normally, months ago, and simply predate the feed.

**Expected corollary: for roughly the first week the delivery page will look sparse.** Parcels dispatched now belong to orders placed days earlier — before the switch-on date — so those orders are outside tracking and their parcels have no order to attach to. This is correct behaviour, not a fault, and it resolves on its own as orders placed after switch-on start shipping. Do not respond to it by backdating the date.

- [ ] **Step 8: Prove it with the real file**

Upload `LTAS_Eod_Report_20260811.xlsx` on `https://panetti.vercel.app/delivery`, or send it to the Postmark address.

Expected, on the sample file: 61 distinct long numbers read out of it, **27 consignments resolved**, **34 shipments written** (one per package), and **0 unmatched**.

The delivery page will say **"Parsed 27, Linked 27, Unmatched 0"**, and 27 is the right number to see there — `rowsParsed` counts consignments plus the numbers Bring could not resolve, not raw long numbers. A file lists two long numbers per parcel, so counting numbers would report a flawless import as half of them vanishing. Do not read the 27 as 7 parcels having gone missing.

If the unmatched count is not zero, read the reasons on the page before changing any code — every refusal names itself, and the most likely honest cause is a shop that has not been switched on.

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: intake flow → Tasks 2/3/5; which number is stored → Task 3 produces `packageNumbers`, Task 5 writes one `Shipment` each; matching rule → Task 4; receipt-time upper bound → Task 4; `linkSource: BRING_EMAIL` → Tasks 5 and 6; inbound route, secret, attachment limits, `TrackingImport` on every delivery → Task 5; `.xlsx` support → Tasks 1 and 2; the `BATCH` bug → Task 6; switching on Norway only → Task 7; anonymised fixtures → Global Constraints, and every fixture in this plan uses invented values.

**Placeholders.** None. Task 6 Step 1 is the one place that says "read the surrounding file first" — that is deliberate, because `sync.integration.test.ts` is 14.5 KB with its own fixture helpers and mock names, and inventing a parallel set of fixtures for it would be worse than reusing what is there.

**Type consistency.** `ResolvedConsignment` is produced in Task 3 and consumed in Task 5 with the same four fields. `MatchOutcome` is produced in Task 4 and destructured in Task 5 as `outcome.orderId`. `ImportResult` is reused from `import.ts:5` unchanged, and `UnmatchedRow` from `link.ts:4` keeps its `{ orderNumber, trackingNumber, reason }` shape — Task 5 fills `orderNumber` with the recipient name because that is the honest label for a row identified by person rather than by number.

**Resolved during review, not left to the implementer:** `getDeliveryConfig` is in `src/lib/delivery/config.ts`, not `src/lib/bring/`, so `import.ts` reaches it as `'../delivery/config'`. It returns `{ creds, slackWebhookUrl }` and never returns null or throws — an unreadable key surfaces as `creds: null`. Task 5's code and its test fixture both reflect that: the test upserts a connected `DeliveryConfig` in `beforeAll`, because without one `importWarehouseFile` refuses to run and every assertion in the file would fail for the wrong reason.

**Known risk, accepted:** Task 5's integration test mocks `./consignments` rather than the network, so it never proves the real Bring call shape. That is Task 3's job, and Task 3 mocks `./client` for the same reason. The only thing neither covers is `client.ts` itself, which is unchanged by this plan and already has `client.test.ts`. Task 7 Step 7 is what exercises the whole chain against the live API with the real file.
