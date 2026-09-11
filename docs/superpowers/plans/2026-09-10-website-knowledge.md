# Website Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The support assistant can answer what a product is, does, includes and how it is used, and quote the policy pages Philip ticks, from the shops' own websites, read by themselves every day.

**Architecture:** The catalogue sweep the Woo sync already runs (`fetchCatalog`) also returns each product's name, SKU, page link and descriptions; once a day per shop the sync turns those, plus the ticked WordPress pages, into `KnowledgeItem` rows marked `source = 'website'`, upserted by a stable key and deleted when gone. Retrieval weights title matches; the prompt names the source and forbids stating a price or stock. Settings gets a "From the websites" section with counts, a "Read now" button and a tick list of pages.

**Tech Stack:** Next.js 15 app routes, Prisma on PostgreSQL, WooCommerce REST v3 (`/wp-json/wc/v3/products`, with the shop's stored keys), WordPress public REST (`/wp-json/wp/v2/pages`, no key), vitest, Testing Library + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-10-website-knowledge-design.md`

## Global Constraints

- Work in the worktree `.claude/worktrees/website-knowledge` on branch `feat/website-knowledge`. Never `git stash`, `git checkout --`, `git reset --hard` or `git clean`.
- Edit files with the Edit/Write tools only, never through PowerShell `Get-Content`/`Set-Content`.
- Test data convention: every integration test tags what it creates (for example `[website-sync-test]`) and deletes only what carries the tag. `src/lib/support/**` integration tests run in the vitest `app` project: `npx vitest run --project app <path>`.
- The local Postgres must be running (`%LOCALAPPDATA%\panetti-pg\start-pg.cmd`). Never a Neon URL.
- No em dashes anywhere. Plain hyphens.
- No model calls are added. Nothing here spends Anthropic credit.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75
  ```
- Names fixed by the spec: `KnowledgeItem.source` is `manual` or `website`; `sourceKey` is `website:<shopId>:product:<externalId>:<n>` or `website:<shopId>:page:<pageId>:<n>`; a chunk is at most **1,500** characters and a section under **40** characters is dropped; a shop is read again when `Shop.websiteReadAt` is older than **20 hours**; the daily read gets **15 seconds** of the sync's deadline and at most **one shop per run**; the "Read now" route has a **25 second** budget.
- Pre-tick words, verbatim from the spec: terms, betingelser, villkor, vilkår, ehdot, bedingungen, warranty, garanti, takuu, faq, shipping, levering, leverans, toimitus, versand, returns, retur, palautus, rücksendung, delivery.
- Prompt copy, verbatim from the spec (rule 2 gains): "Product facts (what a product is, does, includes, fits, how it is used) also come from the KNOWLEDGE BASE; rows marked "from <shop>" are the shop's own product pages and you may state them as ours. Never state a price or whether something is in stock, even if a row mentions one: say it is on the product page and give the Page link from the row."
- Settings copy: section heading **"From the websites"**; per-shop line shape **"panetti.no: 22 products, 2 pages, read 10 Sept, 05:14"** (the "with descriptions" count is not stored per shop; it is reported by the Read now toast instead); a shop never read says **"not read yet"**; button **"Read now"**; disclosure **"Pages"**; badge **"website"**; Read now toast **"Read {products} products ({withDescriptions} with descriptions) and {pages} pages into {rows} entries"**.

---

## File structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` | Four columns on `KnowledgeItem`, four on `Shop`, the `WebsitePage` table. |
| `src/lib/woo/client.ts` | `fetchCatalog` returns the text fields beside price and stock. |
| `src/lib/support/website-text.ts` (new) | Pure: shortcodes out, HTML into sections, sections into chunks. |
| `src/lib/support/website-pages.ts` (new) | WordPress public pages: list, fetch one, and the pre-tick rule. |
| `src/lib/support/website-sync.ts` (new) | The read: products and ticked pages into knowledge rows; the page inventory; the once-a-day gate. |
| `src/lib/woo/sync.ts` | Calls the read after a completed sync, one shop per run. |
| `src/lib/support/knowledge.ts` | Rows carry `source` and `sourceUrl`; title matches weigh more; the block names the source. |
| `src/lib/support/agent.ts` | Rule 2 gains the product-facts sentences; `SYSTEM` is exported for its test. |
| `src/lib/support/sandbox.ts` | Reports each used row's source. |
| `src/app/api/support/knowledge/route.ts`, `[id]/route.ts` | GET carries source fields; DELETE refuses a website row. |
| `src/app/api/support/website/route.ts` (new) | GET the per-shop summary and page list; PUT ticks a page. |
| `src/app/api/support/website/read/route.ts` (new) | POST reads one shop now. |
| `src/app/settings/ai-support/SupportAiClient.tsx` | The "From the websites" section; badge; no Delete on website rows. |
| `src/app/support/sandbox/SandboxClient.tsx` | "(website)" after a website row. |

---

### Task 0: Worktree setup

- [ ] **Step 1: Environment and dependencies**

```bash
cd "C:/Users/Acer Philippines/OneDrive/Desktop/Philip project/panetti/.claude/worktrees/website-knowledge"
cp ../../../.env .env
npm ci
npx prisma generate
"$LOCALAPPDATA/panetti-pg/pgsql/bin/pg_isready.exe" || cmd //c "%LOCALAPPDATA%\panetti-pg\start-pg.cmd"
npx prisma db push
```

- [ ] **Step 2: Smoke test**

Run: `npx vitest run --project app src/lib/support/examples.integration.test.ts`
Expected: PASS.

---

### Task 1: Schema

**Files:**
- Modify: `prisma/schema.prisma` (model `KnowledgeItem` at line 1414; model `Shop`, after `aiChatFrom`)

**Interfaces:**
- Produces: `KnowledgeItem.source`, `sourceUrl`, `sourceKey`, `readAt`; `Shop.websiteReadAt`, `websiteProducts`, `websitePages`, `websiteError`; model `WebsitePage`.

- [ ] **Step 1: Edit the schema**

In model `KnowledgeItem`, after `sku String?`, add:

```prisma
  /// manual (typed by a person) or website (read from the shop's own site by
  /// lib/support/website-sync.ts). A website row is rewritten by every read
  /// and deleted when its product or page is gone; a manual row is never
  /// touched by a read.
  source    String    @default("manual")
  /// The product page or the page's link. Quoted to the customer in place of
  /// a price or a stock level.
  sourceUrl String?
  /// website:<shopId>:product:<externalId>:<n> or
  /// website:<shopId>:page:<pageId>:<n>. What a read upserts by.
  sourceKey String?   @unique
  readAt    DateTime?
```

In model `Shop`, after `aiChatFrom DateTime?`, add:

```prisma
  /// When this shop's website was last read into the knowledge base, and what
  /// the read found. Null = never. Read again when older than 20 hours.
  websiteReadAt   DateTime?
  websiteProducts Int?
  websitePages    Int?
  websiteError    String?
  websitePages_   WebsitePage[]
```

(The relation field is named `websitePages_` because `websitePages` is the count column.)

After model `KnowledgeItem`, add:

```prisma
/// A page on a shop's WordPress site, as listed by its public pages API.
/// `active` is the tick: only ticked pages are read into the knowledge base.
/// Listed pages are remembered so the settings screen can show titles without
/// asking the site again, and so a tick survives a re-listing.
model WebsitePage {
  id         String   @id @default(cuid())
  shopId     String
  externalId Int
  url        String
  title      String
  active     Boolean  @default(false)
  createdAt  DateTime @default(now())

  shop Shop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@unique([shopId, externalId])
}
```

- [ ] **Step 2: Push, generate, typecheck**

```bash
npx prisma db push
npx prisma generate
npx tsc --noEmit
```

Expected: in sync, generated, no errors.

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(support): the knowledge base can hold rows read from a shop's website

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 2: Text cleaning and chunking (pure)

**Files:**
- Create: `src/lib/support/website-text.ts`
- Test: `src/lib/support/website-text.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Section = { heading: string | null; text: string }
  export const CHUNK_MAX = 1500
  export const SECTION_MIN = 40
  export function stripShortcodes(html: string): string
  export function textOf(html: string): string           // tags out, entities decoded, whitespace collapsed
  export function sectionsOf(html: string): Section[]    // split on h1-h4, chunked, short ones dropped
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/support/website-text.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CHUNK_MAX, sectionsOf, stripShortcodes, textOf } from './website-text'

describe('stripShortcodes', () => {
  it('removes theme shortcodes with and without attributes, opening and closing', () => {
    const html = '[ux_banner height=&#8221;250px&#8243; bg=&#8221;554&#8243;] [text_box position_x=&#8221;50&#8243;] Massgestol - FAQ [/text_box] [/ux_banner]'
    expect(textOf(stripShortcodes(html))).toBe('Massgestol - FAQ')
  })

  it('leaves ordinary square brackets in prose alone', () => {
    expect(stripShortcodes('Fits pans up to 30 cm [tested].')).toBe('Fits pans up to 30 cm [tested].')
  })
})

describe('textOf', () => {
  it('drops tags, decodes entities and collapses whitespace', () => {
    expect(textOf('<p class="p1">Nyt fersk hjemmelaget pasta &amp; mer &#8211; n&aring;r du &oslash;nsker.</p>\n\n<p>  Enkel.</p>'))
      .toBe('Nyt fersk hjemmelaget pasta & mer - når du ønsker. Enkel.')
  })
})

describe('sectionsOf', () => {
  const para = (n: number) => `<p>${'Ord '.repeat(n).trim()}</p>`

  it('splits on headings, keeping the heading with its text', () => {
    const html = `<p>Intro text that is long enough to keep, about the ProMix kitchen machine.</p><h2>Hva følger med</h2>${para(20)}<h3>Bruk</h3>${para(20)}`
    const s = sectionsOf(html)
    expect(s.map((x) => x.heading)).toEqual([null, 'Hva følger med', 'Bruk'])
    expect(s[1].text.startsWith('Ord Ord')).toBe(true)
  })

  it('splits a long section at paragraph boundaries so no chunk passes the ceiling', () => {
    const html = `<h2>Long</h2>${para(120)}${para(120)}${para(120)}${para(120)}`
    const s = sectionsOf(html)
    expect(s.length).toBeGreaterThan(1)
    for (const x of s) {
      expect(x.text.length).toBeLessThanOrEqual(CHUNK_MAX)
      expect(x.heading).toBe('Long')
    }
  })

  it('drops a section too short to say anything', () => {
    expect(sectionsOf('<h2>Ok</h2><p>Yes.</p>')).toEqual([])
  })

  it('cleans shortcodes inside the sections', () => {
    const s = sectionsOf('<h2>Villkor</h2>[row][col span__sm="12"]<p>Inledning Detta köp regleras av nedanstående standardvillkor för distansförsäljning.</p>[/col][/row]')
    expect(s[0].text).toBe('Inledning Detta köp regleras av nedanstående standardvillkor för distansförsäljning.')
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run --project app src/lib/support/website-text.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `src/lib/support/website-text.ts`:

```ts
/**
 * A shop page's HTML into the pieces the knowledge base stores.
 *
 * Pure, so every rule is provable on a string. What it must survive was
 * measured on the live sites on 2026-09-10: Mazzetti's FAQ and terms are
 * wrapped in theme shortcodes ([ux_banner ...] ... [/ux_banner]); product
 * descriptions run to 14,000 characters; entities arrive both named (&aring;)
 * and numeric (&#8211;).
 */

export type Section = { heading: string | null; text: string }

/** The most one stored chunk carries. Twelve of these is a prompt a person can still read. */
export const CHUNK_MAX = 1500

/** Below this a section says nothing worth quoting. */
export const SECTION_MIN = 40

/** The theme shortcodes the sites use bare, without attributes. */
const THEME_TAGS = new Set([
  'row', 'col', 'row_inner', 'col_inner', 'ux_banner', 'text_box', 'title', 'section',
  'button', 'gap', 'divider', 'accordion', 'accordion-item', 'tabs', 'tab',
])

/**
 * Theme shortcodes: [name], [name attr="v"], [/name]. Attribute quotes
 * arrive as entities (&#8221;) as often as not, so anything with attributes
 * goes up to the closing bracket, every closing tag goes, and a bare tag
 * goes when it is a theme name. A word in brackets, "[tested]", is prose
 * and stays.
 */
export function stripShortcodes(html: string): string {
  return html.replace(/\[\/?([a-z_-]+)(\s[^\]]*)?\]/g, (m, name: string, attrs?: string) =>
    attrs || m.startsWith('[/') || THEME_TAGS.has(name) ? '' : m,
  )
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aring: 'å', Aring: 'Å', oslash: 'ø', Oslash: 'Ø', aelig: 'æ', AElig: 'Æ',
  auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', szlig: 'ß', eacute: 'é',
}

function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m)
}

/** Tags out, entities decoded, whitespace collapsed. */
export function textOf(html: string): string {
  return decode(html.replace(/<[^>]*>/g, ' '))
    .replace(/\u2013|\u2014/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Split on h1 to h4, then split any section over CHUNK_MAX at paragraph
 * boundaries, then drop what is too short to quote. A chunk of a split
 * section keeps the section's heading, so each still says what it is about.
 */
export function sectionsOf(html: string): Section[] {
  const clean = stripShortcodes(html)
  const parts = clean.split(/<h[1-4][^>]*>/i)
  const out: Section[] = []

  const push = (heading: string | null, body: string) => {
    for (const chunk of chunkParagraphs(body)) {
      if (chunk.length >= SECTION_MIN) out.push({ heading, text: chunk })
    }
  }

  push(null, parts[0] ?? '')
  for (const part of parts.slice(1)) {
    const end = part.search(/<\/h[1-4]>/i)
    const heading = textOf(end >= 0 ? part.slice(0, end) : '') || null
    push(heading, end >= 0 ? part.slice(end) : part)
  }
  return out
}

function chunkParagraphs(html: string): string[] {
  const paragraphs = html
    .split(/<\/p>|<br\s*\/?>|<\/li>|<\/div>/i)
    .map(textOf)
    .filter(Boolean)
  const chunks: string[] = []
  let current = ''
  for (const p of paragraphs) {
    const next = current ? `${current} ${p}` : p
    if (next.length > CHUNK_MAX && current) {
      chunks.push(current)
      current = p
    } else {
      current = next
    }
    // A single paragraph longer than the ceiling is cut at the ceiling; it
    // is prose, and a cut sentence beats a chunk nobody can read.
    while (current.length > CHUNK_MAX) {
      chunks.push(current.slice(0, CHUNK_MAX))
      current = current.slice(CHUNK_MAX).trim()
    }
  }
  if (current) chunks.push(current)
  return chunks
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project app src/lib/support/website-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/support/website-text.ts src/lib/support/website-text.test.ts
git commit -m "feat(support): a shop page's HTML becomes readable sections

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 3: WordPress pages, listed and fetched

**Files:**
- Create: `src/lib/support/website-pages.ts`
- Test: `src/lib/support/website-pages.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ListedPage = { externalId: number; url: string; title: string; slug: string }
  export async function listPages(siteUrl: string, opts?: { deadline?: number }): Promise<ListedPage[]>
  export async function fetchPage(siteUrl: string, externalId: number, opts?: { deadline?: number }): Promise<{ title: string; url: string; html: string } | null>
  export const POLICY_WORDS: readonly string[]
  export function policyLike(page: { slug: string; title: string }): boolean
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/support/website-pages.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPage, listPages, policyLike } from './website-pages'

afterEach(() => vi.unstubAllGlobals())

describe('listPages', () => {
  it('asks the public pages API without a key and returns id, link, title and slug', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([
        { id: 12, link: 'https://panetti.no/betingelser/', slug: 'betingelser', title: { rendered: 'Betingelser' } },
        { id: 13, link: 'https://panetti.no/sample-page/', slug: 'sample-page', title: { rendered: 'Sample Page' } },
      ]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const pages = await listPages('https://panetti.no/')

    expect(pages).toEqual([
      { externalId: 12, url: 'https://panetti.no/betingelser/', title: 'Betingelser', slug: 'betingelser' },
      { externalId: 13, url: 'https://panetti.no/sample-page/', title: 'Sample Page', slug: 'sample-page' },
    ])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://panetti.no/wp-json/wp/v2/pages?per_page=100&page=1&_fields=id,link,slug,title')
    expect(init?.headers).toBeUndefined()
  })

  it('decodes an entity in a title', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ id: 1, link: 'x', slug: 'x', title: { rendered: 'Napolitansk Pizza &#8211; Grunnkurs' } }]), { status: 200 })))
    expect((await listPages('https://panetti.no'))[0].title).toBe('Napolitansk Pizza - Grunnkurs')
  })

  it('throws with the status when the site refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    await expect(listPages('https://panetti.no')).rejects.toThrow('panetti.no answered 503')
  })
})

describe('fetchPage', () => {
  it('returns the rendered content of one page, or null when it is gone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ id: 12, link: 'https://panetti.no/betingelser/', title: { rendered: 'Betingelser' }, content: { rendered: '<p>Innledning</p>' } }]), { status: 200 })))
    expect(await fetchPage('https://panetti.no', 12)).toEqual({ title: 'Betingelser', url: 'https://panetti.no/betingelser/', html: '<p>Innledning</p>' })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))
    expect(await fetchPage('https://panetti.no', 99)).toBeNull()
  })
})

describe('policyLike', () => {
  it('ticks the pages that read like terms, warranty, FAQ, shipping or returns, in any of the six languages', () => {
    for (const p of [
      { slug: 'betingelser', title: 'Betingelser' },
      { slug: 'garantibevis', title: 'Warranty' },
      { slug: 'faq', title: 'FAQ' },
      { slug: 'villkor', title: 'Allmänna villkor' },
      { slug: 'toimitusehdot', title: 'Toimitus' },
      { slug: 'bedingungen', title: 'Bedingungen' },
      { slug: 'x', title: 'Rücksendung' },
    ]) expect(policyLike(p)).toBe(true)
  })

  it('leaves the rest unticked', () => {
    for (const p of [
      { slug: 'sample-page', title: 'Sample Page' },
      { slug: 'test-2', title: 'test' },
      { slug: 'om-oss', title: 'Om oss' },
      { slug: 'customer-help', title: 'Customer Help' },
      { slug: 'shop', title: 'Shop' },
    ]) expect(policyLike(p)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run --project app src/lib/support/website-pages.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `src/lib/support/website-pages.ts`:

```ts
import { textOf } from './website-text'

/**
 * A shop's WordPress pages, through the public REST API. No key: the pages
 * are public, and all nine shops answered `wp/v2/pages` without one on
 * 2026-09-10. Products are NOT read here; they come from the WooCommerce
 * catalogue sweep the sync already runs (lib/woo/client.ts, fetchCatalog).
 */

export type ListedPage = { externalId: number; url: string; title: string; slug: string }

const REQUEST_TIMEOUT_MS = 20_000

const base = (siteUrl: string) => siteUrl.replace(/\/$/, '')
const host = (siteUrl: string) => new URL(siteUrl).host.replace(/^www\./, '')

function budget(opts: { deadline?: number }): number {
  const left = opts.deadline === undefined ? REQUEST_TIMEOUT_MS : opts.deadline - Date.now()
  return Math.max(1, Math.min(REQUEST_TIMEOUT_MS, left))
}

async function get(siteUrl: string, path: string, opts: { deadline?: number }): Promise<unknown> {
  const res = await fetch(`${base(siteUrl)}${path}`, { signal: AbortSignal.timeout(budget(opts)) })
  if (!res.ok) throw new Error(`${host(siteUrl)} answered ${res.status}`)
  return res.json()
}

type RawPage = { id?: unknown; link?: unknown; slug?: unknown; title?: { rendered?: unknown }; content?: { rendered?: unknown } }

export async function listPages(siteUrl: string, opts: { deadline?: number } = {}): Promise<ListedPage[]> {
  const out: ListedPage[] = []
  for (let page = 1; page <= 5; page++) {
    const raw = (await get(siteUrl, `/wp-json/wp/v2/pages?per_page=100&page=${page}&_fields=id,link,slug,title`, opts)) as RawPage[]
    if (!Array.isArray(raw)) break
    for (const p of raw) {
      if (typeof p.id !== 'number' || typeof p.link !== 'string') continue
      out.push({
        externalId: p.id,
        url: p.link,
        title: textOf(String(p.title?.rendered ?? '')) || p.link,
        slug: typeof p.slug === 'string' ? p.slug : '',
      })
    }
    if (raw.length < 100) break
  }
  return out
}

export async function fetchPage(
  siteUrl: string,
  externalId: number,
  opts: { deadline?: number } = {},
): Promise<{ title: string; url: string; html: string } | null> {
  const raw = (await get(siteUrl, `/wp-json/wp/v2/pages?include=${externalId}&_fields=id,link,title,content`, opts)) as RawPage[]
  const p = Array.isArray(raw) ? raw[0] : undefined
  if (!p || typeof p.link !== 'string') return null
  return {
    title: textOf(String(p.title?.rendered ?? '')) || p.link,
    url: p.link,
    html: String(p.content?.rendered ?? ''),
  }
}

/** Words that mark a page as policy-like, in the six shop languages. */
export const POLICY_WORDS = [
  'terms', 'betingelser', 'villkor', 'vilkår', 'ehdot', 'bedingungen',
  'warranty', 'garanti', 'takuu', 'faq', 'shipping', 'levering', 'leverans', 'toimitus', 'versand',
  'returns', 'retur', 'palautus', 'rücksendung', 'delivery',
] as const

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

/** Pre-ticked on first listing: a page whose slug or title carries a policy word. */
export function policyLike(page: { slug: string; title: string }): boolean {
  const hay = fold(`${page.slug} ${page.title}`)
  return POLICY_WORDS.some((w) => hay.includes(fold(w)))
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project app src/lib/support/website-pages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/support/website-pages.ts src/lib/support/website-pages.test.ts
git commit -m "feat(support): list and read a shop's public pages

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 4: The catalogue sweep returns the words too

**Files:**
- Modify: `src/lib/woo/client.ts` (`CatalogEntry`, `fetchCatalog`)
- Test: `src/lib/woo/client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CatalogEntry = {
    price: number | null
    stock: number | null
    name: string
    sku: string
    permalink: string | null
    shortDescription: string
    description: string
    /** status === 'publish' and catalog_visibility !== 'hidden' */
    published: boolean
  }
  ```

- [ ] **Step 1: Write the failing test**

Find the existing `fetchCatalog` test in `src/lib/woo/client.test.ts` (search `fetchCatalog`). Add beside it:

```ts
  it('carries each product\'s name, sku, page and descriptions, and whether it is published', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { id: 24256, name: 'ProMix Pastarulle', sku: 'PRIMIXPROPASMAK', permalink: 'https://panetti.no/promix-pastamaker/', price: '1299', manage_stock: true, stock_quantity: 4, status: 'publish', catalog_visibility: 'visible', short_description: '<p>Nyt fersk pasta.</p>', description: '' },
      { id: 1, name: 'Old', sku: '', price: '1', status: 'draft', catalog_visibility: 'visible', short_description: '', description: '' },
      { id: 2, name: 'Hidden', sku: 'H', price: '1', status: 'publish', catalog_visibility: 'hidden', short_description: '', description: '' },
    ]), { status: 200 })))

    const catalog = await fetchCatalog({ url: 'https://panetti.no', key: 'k', secret: 's' })

    expect(catalog.get('24256')).toEqual({
      price: 129900, stock: 4, name: 'ProMix Pastarulle', sku: 'PRIMIXPROPASMAK',
      permalink: 'https://panetti.no/promix-pastamaker/', shortDescription: '<p>Nyt fersk pasta.</p>', description: '', published: true,
    })
    expect(catalog.get('1')?.published).toBe(false)
    expect(catalog.get('2')?.published).toBe(false)
  })
```

Check how the existing `fetchCatalog` test stubs fetch and mirror it (it may use `vi.stubGlobal('fetch', ...)` exactly like this).

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run --project app src/lib/woo/client.test.ts`
Expected: the new test FAILS (extra keys missing).

- [ ] **Step 3: Extend**

In `src/lib/woo/client.ts`, replace the `CatalogEntry` type and the body of the `for (const p of batch)` loop in `fetchCatalog`:

```ts
export type CatalogEntry = {
  /** The store's own listed price, minor units, or null when unreadable. */
  price: number | null
  /**
   * Units on hand, or null when the store does not manage stock for this item.
   * Null is not zero: zero is sold out and belongs at the top of the forecast,
   * "we do not know" does not.
   */
  stock: number | null
  name: string
  sku: string
  permalink: string | null
  /** HTML as the store holds it; lib/support/website-text.ts cleans it. */
  shortDescription: string
  description: string
  /** status === 'publish' and not hidden from the catalogue. Only these reach the knowledge base. */
  published: boolean
}
```

```ts
    const batch = await readJson<
      {
        id: number; price?: string; manage_stock?: boolean; stock_quantity?: number | null
        name?: string; sku?: string; permalink?: string; status?: string; catalog_visibility?: string
        short_description?: string; description?: string
      }[]
    >(res, 'the product catalogue')
    for (const p of batch) {
      const value = p.price ? parseFloat(p.price) : NaN
      catalog.set(String(p.id), {
        price: Number.isNaN(value) ? null : toMinor(value),
        stock: p.manage_stock === true && typeof p.stock_quantity === 'number' ? p.stock_quantity : null,
        name: p.name ?? '',
        sku: p.sku ?? '',
        permalink: p.permalink ?? null,
        shortDescription: p.short_description ?? '',
        description: p.description ?? '',
        published: p.status === 'publish' && p.catalog_visibility !== 'hidden',
      })
    }
```

Update the docstring above `fetchCatalog`: "One sweep, three uses: price and stock for the products table, and the words on the page for the knowledge base (lib/support/website-sync.ts)."

- [ ] **Step 4: Run, typecheck, commit**

Run: `npx vitest run --project app src/lib/woo/client.test.ts src/lib/woo/sync.test.ts` and `npx tsc --noEmit`. Any test that builds a `CatalogEntry` by hand (search `price:` with `stock:` in `src/lib/woo/*.test.ts` and `src/lib/advisor/**`) needs the new fields; add `name: '', sku: '', permalink: null, shortDescription: '', description: '', published: true` to those literals.

```bash
git add src/lib/woo/client.ts src/lib/woo/client.test.ts
git commit -m "feat(woo): the catalogue sweep also brings back what each product page says

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

(Add any other test files you touched to the `git add`.)

---

### Task 5: The read

**Files:**
- Create: `src/lib/support/website-sync.ts`
- Test: `src/lib/support/website-sync.integration.test.ts`

**Interfaces:**
- Consumes: `CatalogEntry` (Task 4), `sectionsOf`/`textOf` (Task 2), `listPages`/`fetchPage`/`policyLike` (Task 3).
- Produces:
  ```ts
  export const READ_AGAIN_AFTER_MS = 20 * 60 * 60 * 1000
  export type ReadCounts = { products: number; withDescriptions: number; pages: number; rows: number }
  export function productRows(shopId: string, externalId: string, entry: CatalogEntry): { sourceKey: string; title: string; body: string; sourceUrl: string | null }[]
  export function pageRows(shopId: string, page: { externalId: number; title: string; url: string; html: string }): { sourceKey: string; title: string; body: string; sourceUrl: string }[]
  export async function syncPageInventory(shopId: string, siteUrl: string, opts?: { deadline?: number }): Promise<number>
  export async function refreshWebsiteKnowledge(input: { shopId: string; siteUrl: string; catalog: Map<string, CatalogEntry>; deadline?: number }): Promise<ReadCounts>
  export function dueForRead(shop: { websiteReadAt: Date | null }, now?: Date): boolean
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/support/website-sync.integration.test.ts`:

```ts
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import type { CatalogEntry } from '@/lib/woo/client'
import { dueForRead, productRows, refreshWebsiteKnowledge, syncPageInventory } from './website-sync'

const TAG = '[website-sync-test]'
let shopId = ''

async function cleanup() {
  await db.knowledgeItem.deleteMany({ where: { OR: [{ shop: { name: { contains: TAG } } }, { title: { contains: TAG } }] } })
  await db.websitePage.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
afterEach(() => vi.unstubAllGlobals())
beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Panetti Norway ${TAG}`, currency: 'NOK', wooUrl: 'https://panetti.example.test' } })).id
})

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  price: 129900, stock: 3, name: 'Panetti ProMix Kjøkkenmaskin', sku: 'PROMIX-NO',
  permalink: 'https://panetti.example.test/promix/',
  shortDescription: '<p>Kraftig kjøkkenmaskin med 1500 W motor, utviklet eksklusivt for Panetti.</p>',
  description: '<h2>Hva følger med</h2><p>Bolle i rustfritt stål, eltekrok, visp og spatel. Alt du trenger for å komme i gang med baking hjemme.</p><h2>Bruk</h2><p>Sett bollen på plass, velg hastighet og start. Maskinen stopper automatisk ved overbelastning.</p>',
  published: true,
  ...over,
})

const noPages = () => vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))

describe('productRows', () => {
  it('makes one row per section, titled with the product and its heading, with the page link in the body', () => {
    const rows = productRows(shopId, '24256', entry())
    expect(rows.map((r) => r.title)).toEqual([
      'Panetti ProMix Kjøkkenmaskin',
      'Panetti ProMix Kjøkkenmaskin - Hva følger med',
      'Panetti ProMix Kjøkkenmaskin - Bruk',
    ])
    expect(rows[0].sourceKey).toBe(`website:${shopId}:product:24256:0`)
    expect(rows[1].body).toBe('Product: Panetti ProMix Kjøkkenmaskin (SKU PROMIX-NO)\nPage: https://panetti.example.test/promix/\n\nBolle i rustfritt stål, eltekrok, visp og spatel. Alt du trenger for å komme i gang med baking hjemme.')
    expect(rows[1].sourceUrl).toBe('https://panetti.example.test/promix/')
  })

  it('yields nothing for an unpublished product or one with no words', () => {
    expect(productRows(shopId, '1', entry({ published: false }))).toEqual([])
    expect(productRows(shopId, '2', entry({ shortDescription: '', description: '' }))).toEqual([])
  })
})

describe('refreshWebsiteKnowledge', () => {
  it('writes product rows scoped to the shop, marked website, and reports the counts', async () => {
    noPages()
    const counts = await refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map([['24256', entry()], ['1', entry({ name: `Bare ${TAG}`, shortDescription: '', description: '' })]]) })

    expect(counts).toEqual({ products: 2, withDescriptions: 1, pages: 0, rows: 3 })
    const rows = await db.knowledgeItem.findMany({ where: { shopId, source: 'website' }, orderBy: { sourceKey: 'asc' } })
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ kind: 'product', shopId, sku: null, country: null, language: null, active: true, source: 'website' })
    expect(rows[0].readAt).not.toBeNull()
    const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } })
    expect(shop.websiteProducts).toBe(2)
    expect(shop.websiteReadAt).not.toBeNull()
    expect(shop.websiteError).toBeNull()
  })

  it('rewrites a row in place on the next read, keeps it turned off if a person turned it off, and drops rows whose product is gone', async () => {
    noPages()
    await refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map([['24256', entry()]]) })
    const first = await db.knowledgeItem.findUniqueOrThrow({ where: { sourceKey: `website:${shopId}:product:24256:1` } })
    await db.knowledgeItem.update({ where: { id: first.id }, data: { active: false } })
    await db.knowledgeItem.create({ data: { kind: 'faq', title: `Manual ${TAG}`, body: 'typed by hand', shopId } })

    await refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map([['24256', entry({ description: '<h2>Hva følger med</h2><p>Bolle i rustfritt stål, eltekrok og visp. Nytt i år: en pastarulle følger med i esken.</p>' })]]) })

    const again = await db.knowledgeItem.findUniqueOrThrow({ where: { sourceKey: `website:${shopId}:product:24256:1` } })
    expect(again.id).toBe(first.id)
    expect(again.body).toContain('pastarulle')
    expect(again.active).toBe(false)
    expect(await db.knowledgeItem.findUnique({ where: { sourceKey: `website:${shopId}:product:24256:2` } })).toBeNull()
    expect(await db.knowledgeItem.count({ where: { shopId, source: 'manual' } })).toBe(1)
  })

  it('reads a ticked page into policy rows and leaves an unticked one alone', async () => {
    await db.websitePage.create({ data: { shopId, externalId: 12, url: 'https://panetti.example.test/betingelser/', title: 'Betingelser', active: true } })
    await db.websitePage.create({ data: { shopId, externalId: 13, url: 'https://panetti.example.test/test/', title: 'test', active: false } })
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('include=12')
        ? new Response(JSON.stringify([{ id: 12, link: 'https://panetti.example.test/betingelser/', title: { rendered: 'Betingelser' }, content: { rendered: '<h2>Angrerett</h2><p>Du kan angre kjøpet innen 14 dager etter at du mottok varen, uten å oppgi grunn.</p>' } }]), { status: 200 })
        : new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const counts = await refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map() })

    expect(counts.pages).toBe(1)
    const row = await db.knowledgeItem.findUniqueOrThrow({ where: { sourceKey: `website:${shopId}:page:12:0` } })
    expect(row).toMatchObject({ kind: 'policy', title: 'Betingelser - Angrerett', sourceUrl: 'https://panetti.example.test/betingelser/' })
    expect(row.body).toContain('Page: https://panetti.example.test/betingelser/')
    expect(row.body).toContain('14 dager')
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('include=13'))).toBe(false)
  })

  it('records the error and keeps the old rows when the site fails', async () => {
    noPages()
    await refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map([['24256', entry()]]) })
    await db.websitePage.create({ data: { shopId, externalId: 12, url: 'x', title: 'Betingelser', active: true } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))

    await expect(refreshWebsiteKnowledge({ shopId, siteUrl: 'https://panetti.example.test', catalog: new Map([['24256', entry()]]) })).rejects.toThrow('answered 503')

    expect(await db.knowledgeItem.count({ where: { shopId, source: 'website' } })).toBe(3)
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopId } })).websiteError).toBe('panetti.example.test answered 503')
  })
})

describe('syncPageInventory', () => {
  it('lists the pages, pre-ticks the policy-like ones on first sight, and keeps a tick a person changed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { id: 12, link: 'https://panetti.example.test/betingelser/', slug: 'betingelser', title: { rendered: 'Betingelser' } },
      { id: 13, link: 'https://panetti.example.test/sample-page/', slug: 'sample-page', title: { rendered: 'Sample Page' } },
    ]), { status: 200 })))

    expect(await syncPageInventory(shopId, 'https://panetti.example.test')).toBe(2)
    const pages = await db.websitePage.findMany({ where: { shopId }, orderBy: { externalId: 'asc' } })
    expect(pages.map((p) => [p.externalId, p.active])).toEqual([[12, true], [13, false]])

    await db.websitePage.update({ where: { shopId_externalId: { shopId, externalId: 12 } }, data: { active: false } })
    await syncPageInventory(shopId, 'https://panetti.example.test')
    expect((await db.websitePage.findUniqueOrThrow({ where: { shopId_externalId: { shopId, externalId: 12 } } })).active).toBe(false)
  })
})

describe('dueForRead', () => {
  const now = new Date('2026-09-10T05:00:00Z')
  it('is due when never read, or read more than 20 hours ago', () => {
    expect(dueForRead({ websiteReadAt: null }, now)).toBe(true)
    expect(dueForRead({ websiteReadAt: new Date('2026-09-09T05:00:00Z') }, now)).toBe(true)
    expect(dueForRead({ websiteReadAt: new Date('2026-09-09T20:00:00Z') }, now)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run --project app src/lib/support/website-sync.integration.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `src/lib/support/website-sync.ts`:

```ts
import { db } from '@/lib/db'
import type { CatalogEntry } from '@/lib/woo/client'
import { fetchPage, listPages, policyLike } from './website-pages'
import { sectionsOf, textOf } from './website-text'

/**
 * The shops' websites, read into the knowledge base.
 *
 * Products come from the catalogue sweep the Woo sync already runs, so no new
 * request goes to any shop for them; pages come from WordPress's public
 * pages API, only the ones a person ticked. Rows are upserted by a stable key
 * and deleted when their product or page is gone. A row a person turned off
 * stays off through every read, and a manual row is never touched.
 */

export const READ_AGAIN_AFTER_MS = 20 * 60 * 60 * 1000

export type ReadCounts = { products: number; withDescriptions: number; pages: number; rows: number }

type Row = { sourceKey: string; title: string; body: string; sourceUrl: string | null }

export function productRows(shopId: string, externalId: string, entry: CatalogEntry): Row[] {
  if (!entry.published) return []
  const name = textOf(entry.name)
  if (!name) return []

  const short = textOf(entry.shortDescription)
  const sections = [
    ...(short.length >= 40 ? [{ heading: null as string | null, text: short }] : []),
    ...sectionsOf(entry.description),
  ]
  const head = `Product: ${name}${entry.sku ? ` (SKU ${entry.sku})` : ''}${entry.permalink ? `\nPage: ${entry.permalink}` : ''}`

  return sections.map((s, n) => ({
    sourceKey: `website:${shopId}:product:${externalId}:${n}`,
    title: s.heading ? `${name} - ${s.heading}` : name,
    body: `${head}\n\n${s.text}`,
    sourceUrl: entry.permalink,
  }))
}

export function pageRows(
  shopId: string,
  page: { externalId: number; title: string; url: string; html: string },
): (Row & { sourceUrl: string })[] {
  const title = textOf(page.title) || page.url
  return sectionsOf(page.html).map((s, n) => ({
    sourceKey: `website:${shopId}:page:${page.externalId}:${n}`,
    title: s.heading ? `${title} - ${s.heading}` : title,
    body: `Page: ${page.url}\n\n${s.text}`,
    sourceUrl: page.url,
  }))
}

/**
 * The tick list. New pages are ticked when they read like a policy page,
 * never re-ticked afterwards: what a person set stays set.
 */
export async function syncPageInventory(shopId: string, siteUrl: string, opts: { deadline?: number } = {}): Promise<number> {
  const pages = await listPages(siteUrl, opts)
  for (const p of pages) {
    await db.websitePage.upsert({
      where: { shopId_externalId: { shopId, externalId: p.externalId } },
      create: { shopId, externalId: p.externalId, url: p.url, title: p.title, active: policyLike(p) },
      update: { url: p.url, title: p.title },
    })
  }
  return pages.length
}

export function dueForRead(shop: { websiteReadAt: Date | null }, now = new Date()): boolean {
  return shop.websiteReadAt === null || now.getTime() - shop.websiteReadAt.getTime() > READ_AGAIN_AFTER_MS
}

export async function refreshWebsiteKnowledge(input: {
  shopId: string
  siteUrl: string
  catalog: Map<string, CatalogEntry>
  deadline?: number
}): Promise<ReadCounts> {
  const { shopId } = input
  const now = new Date()
  const seen = new Set<string>()
  const rows: (Row & { kind: string })[] = []

  let withDescriptions = 0
  for (const [externalId, entry] of input.catalog) {
    const r = productRows(shopId, externalId, entry)
    if (r.length > 0) withDescriptions++
    for (const row of r) rows.push({ ...row, kind: 'product' })
  }

  let pages = 0
  try {
    const ticked = await db.websitePage.findMany({ where: { shopId, active: true }, select: { externalId: true } })
    for (const t of ticked) {
      if (input.deadline !== undefined && Date.now() >= input.deadline) break
      const page = await fetchPage(input.siteUrl, t.externalId, { deadline: input.deadline })
      if (!page) continue
      pages++
      for (const row of pageRows(shopId, { externalId: t.externalId, ...page })) rows.push({ ...row, kind: 'policy' })
    }
  } catch (e) {
    // The old rows stay. The error is shown on the settings line.
    const error = e instanceof Error ? e.message : 'Could not read the website'
    await db.shop.update({ where: { id: shopId }, data: { websiteError: error } }).catch(() => {})
    throw e
  }

  for (const row of rows) {
    seen.add(row.sourceKey)
    await db.knowledgeItem.upsert({
      where: { sourceKey: row.sourceKey },
      create: {
        kind: row.kind, title: row.title, body: row.body, shopId,
        source: 'website', sourceUrl: row.sourceUrl, sourceKey: row.sourceKey, readAt: now,
      },
      // Never `active`: a row a person turned off stays off.
      update: { kind: row.kind, title: row.title, body: row.body, sourceUrl: row.sourceUrl, readAt: now },
    })
  }
  await db.knowledgeItem.deleteMany({
    where: { shopId, source: 'website', sourceKey: { notIn: [...seen] } },
  })

  await db.shop.update({
    where: { id: shopId },
    data: { websiteReadAt: now, websiteProducts: input.catalog.size, websitePages: pages, websiteError: null },
  })

  return { products: input.catalog.size, withDescriptions, pages, rows: rows.length }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project app src/lib/support/website-sync.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/support/website-sync.ts src/lib/support/website-sync.integration.test.ts
git commit -m "feat(support): a shop's products and ticked pages are read into the knowledge base

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 6: Once a day, from the sync

**Files:**
- Modify: `src/lib/woo/sync.ts` (`syncShop` after `storeCatalog`, `syncAllShops`)
- Test: `src/lib/woo/sync.integration.test.ts` (or `sync.test.ts`, whichever holds the completed-sync catalogue test; search `storeCatalog`)

**Interfaces:**
- Consumes: `refreshWebsiteKnowledge`, `dueForRead`, `syncPageInventory`.
- Produces: `syncShop(shopId, opts & { run?: { websiteRead: boolean } })`; `syncAllShops` creates one `run` object per call.

- [ ] **Step 1: Write the failing test**

Find the test that proves the catalogue is stored after a completed sync (search the woo tests for `catalogPrice` or `storeCatalog`). Beside it add a test shaped the same way (same fetch stubbing of the Woo orders and products endpoints), with the products response carrying `name`, `sku`, `permalink`, `status: 'publish'`, `catalog_visibility: 'visible'` and a `description` of at least 40 characters, and the pages endpoint (`/wp-json/wp/v2/pages`) answering `[]`:

```ts
  it('reads the website into the knowledge base after a completed sync, once a day, one shop per run', async () => {
    // shop created by the file's helpers with wooUrl and keys; websiteReadAt null
    const run = { websiteRead: false }
    await syncShop(shopId, { run })
    expect(run.websiteRead).toBe(true)
    expect(await db.knowledgeItem.count({ where: { shopId, source: 'website' } })).toBeGreaterThan(0)
    const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } })
    expect(shop.websiteReadAt).not.toBeNull()

    // Read this morning: not again.
    const before = await db.knowledgeItem.count({ where: { shopId, source: 'website' } })
    const second = { websiteRead: false }
    await syncShop(shopId, { run: second })
    expect(second.websiteRead).toBe(false)
    expect(await db.knowledgeItem.count({ where: { shopId, source: 'website' } })).toBe(before)

    // Another shop already read this run: wait for the next run.
    await db.shop.update({ where: { id: shopId }, data: { websiteReadAt: null } })
    const spent = { websiteRead: true }
    await syncShop(shopId, { run: spent })
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopId } })).websiteReadAt).toBeNull()
  })
```

Add `knowledgeItem` and `websitePage` deletes for the file's tagged shop to its cleanup.

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run --project app <that file>`
Expected: FAIL (`run.websiteRead` stays false; no rows).

- [ ] **Step 3: Implement**

In `src/lib/woo/sync.ts`:

1. Import: `import { dueForRead, refreshWebsiteKnowledge, syncPageInventory } from '../support/website-sync'`.
2. Change `syncShop`'s options type to `opts: { backfillPages?: number; maxPages?: number; deadline?: number; run?: { websiteRead: boolean } } = {}`.
3. Replace the catalogue block with:

```ts
      // Best-effort on a COMPLETED sync only: refresh each known product's own
      // listed price and its stock. A failure here never fails the sync - order
      // data is the priority, and the next completed sync simply retries.
      //
      // The same sweep carries the words on each product page. Once a day per
      // shop, and one shop per run so no tick spends more than its share, they
      // are read into the knowledge base beside the pages a person ticked.
      try {
        const catalog = await fetchCatalog(creds)
        await storeCatalog(shop.id, catalog)
        const run = opts.run
        if (run && !run.websiteRead && dueForRead(shop)) {
          run.websiteRead = true
          const deadline = Date.now() + WEBSITE_READ_MS
          try {
            await syncPageInventory(shop.id, creds.url, { deadline })
            await refreshWebsiteKnowledge({ shopId: shop.id, siteUrl: creds.url, catalog, deadline })
          } catch {
            // Recorded on the shop by the read itself; tried again next run.
          }
        }
      } catch {
        // Retried on the next completed sync.
      }
```

4. Add near the other constants at the top: `/** The daily website read's share of a sync tick. */ const WEBSITE_READ_MS = 15_000`.
5. In `syncAllShops`, create the run object and pass it: `const run = { websiteRead: false }` before the loop and `results.push(await syncShop(shop.id, { ...opts, run }))`.

`shop` in `syncShop` is the full row (`findUniqueOrThrow`), so `dueForRead(shop)` reads `websiteReadAt` directly.

- [ ] **Step 4: Run, typecheck, commit**

Run: `npx vitest run --project app src/lib/woo/` and `npx tsc --noEmit`.

```bash
git add src/lib/woo/sync.ts <the test file>
git commit -m "feat(woo): the daily sync reads one shop's website into the knowledge base

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 7: Retrieval and the prompt

**Files:**
- Modify: `src/lib/support/knowledge.ts`, `src/lib/support/agent.ts`, `src/lib/support/sandbox.ts`
- Test: `src/lib/support/knowledge.integration.test.ts` (new), `src/lib/support/agent.test.ts`

**Interfaces:**
- Produces: `KnowledgeRow = { kind: string; title: string; body: string; source: string; sourceUrl: string | null }`; `export const SYSTEM` from `agent.ts`; `SandboxTurnResult.knowledge: { kind: string; title: string; source: string }[]`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/support/knowledge.integration.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/lib/db'
import { knowledgeBlock, knowledgeFor } from './knowledge'

const TAG = '[knowledge-rank-test]'
let shopId = ''

async function cleanup() {
  await db.knowledgeItem.deleteMany({ where: { body: { contains: TAG } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'NOK' } })).id
})

describe('knowledgeFor', () => {
  it('ranks a row whose title names the product above a longer row that only mentions it', async () => {
    await db.knowledgeItem.create({ data: { kind: 'product', title: 'Panetti ProMix - Hva følger med', body: `Product: Panetti ProMix\n\nBolle, eltekrok, visp. ${TAG}`, shopId, source: 'website', sourceUrl: 'https://panetti.no/promix/', sourceKey: `${TAG}:1` } })
    await db.knowledgeItem.create({ data: { kind: 'product', title: 'Pizzaovn - Bruk', body: `ProMix ProMix ProMix ProMix ovn ovn ovn ovn ${TAG}`, shopId, source: 'website', sourceKey: `${TAG}:2` } })

    const rows = await knowledgeFor('Hva følger med ProMix?', { shopId })
    expect(rows[0].title).toBe('Panetti ProMix - Hva følger med')
    expect(rows[0]).toMatchObject({ source: 'website', sourceUrl: 'https://panetti.no/promix/' })
  })

  it('reaches a customer with no orders, because website product rows carry no sku scope', async () => {
    await db.knowledgeItem.create({ data: { kind: 'product', title: 'Panetti ProMix', body: `Product: Panetti ProMix (SKU PROMIX)\n\nKraftig maskin. ${TAG}`, shopId, source: 'website', sourceKey: `${TAG}:3` } })
    const rows = await knowledgeFor('Er ProMix kraftig?', { shopId, skus: [] })
    expect(rows.some((r) => r.title === 'Panetti ProMix')).toBe(true)
  })
})

describe('knowledgeBlock', () => {
  it('names where a website row came from', () => {
    const text = knowledgeBlock([
      { kind: 'product', title: 'Panetti ProMix', body: 'Page: https://panetti.no/promix/\n\nKraftig.', source: 'website', sourceUrl: 'https://panetti.no/promix/' },
      { kind: 'faq', title: 'Frakt', body: 'Gratis.', source: 'manual', sourceUrl: null },
    ])
    expect(text).toContain('[product, from panetti.no] Panetti ProMix')
    expect(text).toContain('[faq] Frakt')
  })
})
```

Append to `src/lib/support/agent.test.ts`:

```ts
import { SYSTEM } from './agent'

describe('the system prompt', () => {
  it('lets the assistant state product facts from website rows, and never a price or stock', () => {
    expect(SYSTEM).toContain('Product facts (what a product is, does, includes, fits, how it is used) also')
    expect(SYSTEM).toContain('rows marked "from <shop>" are the shop\'s own product pages')
    expect(SYSTEM).toContain('Never state a price or whether something is in stock')
    expect(SYSTEM).toContain('give the Page link from the row')
  })
})
```

(Merge the import into the existing import line from `./agent`.)

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run --project app src/lib/support/knowledge.integration.test.ts src/lib/support/agent.test.ts`
Expected: FAIL (`source` undefined on rows; `SYSTEM` not exported).

- [ ] **Step 3: Implement**

In `src/lib/support/knowledge.ts`:

1. `KnowledgeRow` becomes `{ kind: string; title: string; body: string; source: string; sourceUrl: string | null }` and the `select` adds `source: true, sourceUrl: true`.
2. Replace the scoring with:

```ts
  const words = keywordsOf(text)
  const always = rows.filter((r) => ALWAYS.includes(r.kind))
  const rest = rows.filter((r) => !ALWAYS.includes(r.kind))

  /**
   * A word in the TITLE weighs three, in the body one. A product's long
   * section otherwise outranks the right product's short one by matching
   * more words by chance, now that website rows run to 1,500 characters.
   */
  const scored = rest
    .map((r) => {
      const title = r.title.toLowerCase()
      const body = r.body.toLowerCase()
      const score = words.reduce((sum, w) => sum + (title.includes(w) ? 3 : body.includes(w) ? 1 : 0), 0)
      return { row: r, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHED)
    .map((s) => s.row)
```

3. `knowledgeBlock` labels the source:

```ts
const fromHost = (url: string | null) => {
  if (!url) return null
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return null
  }
}

export function knowledgeBlock(rows: KnowledgeRow[]): string {
  if (rows.length === 0) {
    return 'KNOWLEDGE BASE: empty. Nobody has written any policies or answers yet, so you have nothing to quote. Escalate anything that needs one.'
  }
  return [
    'KNOWLEDGE BASE. These are the only policies and answers you may state as ours:',
    ...rows.map((r) => {
      const host = r.source === 'website' ? fromHost(r.sourceUrl) : null
      return `[${r.kind}${host ? `, from ${host}` : ''}] ${r.title}\n${r.body}`
    }),
  ].join('\n\n')
}
```

In `src/lib/support/agent.ts`: change `const SYSTEM` to `export const SYSTEM`, and replace rule 2 with:

```
2. Every policy - returns, warranty, shipping, refunds - comes from the KNOWLEDGE BASE
   block. If the answer would need a policy that is not there, do not guess it: ask for
   a human instead. Product facts (what a product is, does, includes, fits, how it is used) also
   come from the KNOWLEDGE BASE; rows marked "from <shop>" are the shop's own product pages
   and you may state them as ours. Never state a price or whether something is in stock,
   even if a row mentions one: say it is on the product page and give the Page link from the row.
```

(The line breaks matter: the test asserts each of those phrases on one line.)

In `src/lib/support/sandbox.ts`: `knowledge: { kind: string; title: string; source: string }[]` in the result type, and `knowledge: knowledge.map((k) => ({ kind: k.kind, title: k.title, source: k.source }))`.

Any other place that builds a `KnowledgeRow` literal (search `kind:` with `title:` and `body:` in `src/lib/support/*.test.ts` and `src/lib/support/examples.ts`) needs `source: 'manual', sourceUrl: null` added; the compiler will name them.

- [ ] **Step 4: Run, typecheck, commit**

Run: `npx vitest run --project app src/lib/support/` and `npx tsc --noEmit`.

```bash
git add src/lib/support/knowledge.ts src/lib/support/knowledge.integration.test.ts src/lib/support/agent.ts src/lib/support/agent.test.ts src/lib/support/sandbox.ts
git commit -m "feat(support): the assistant may quote the shop's own product pages, never a price

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

(Add any test files the compiler made you touch.)

---

### Task 8: Routes: summary, ticks, read now, and the knowledge list

**Files:**
- Create: `src/app/api/support/website/route.ts`, `src/app/api/support/website/read/route.ts`
- Modify: `src/app/api/support/knowledge/route.ts` (GET fields), `src/app/api/support/knowledge/[id]/route.ts` (DELETE refuses website rows)
- Test: `src/app/api/support/website/route.integration.test.ts`, `src/app/api/support/knowledge/route.integration.test.ts` (new, small)

**Interfaces:**
- Produces:
  - `GET /api/support/website` → `{ shops: { id, name, siteUrl: string | null, readAt: string | null, products: number | null, pages: number | null, error: string | null, pageList: { externalId: number; url: string; title: string; active: boolean }[] }[] }`. With `?refresh=<shopId>` it re-lists that shop's pages from the site first.
  - `PUT /api/support/website` body `{ shopId, externalId, active }` → `{ ok: true }`.
  - `POST /api/support/website/read` body `{ shopId }` → `{ products, withDescriptions, pages, rows }` or `{ error }` 400.
  - knowledge GET items gain `source`, `sourceUrl`, `readAt`.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/support/website/route.integration.test.ts`:

```ts
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'a@b.c', role: 'ADMIN' })),
}))
const { GET, PUT } = await import('./route')
const { POST } = await import('./read/route')
const { currentUser } = await import('@/lib/auth/current-user')

const TAG = '[website-route-test]'
let shopId = ''

async function cleanup() {
  await db.knowledgeItem.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.websitePage.deleteMany({ where: { shop: { name: { contains: TAG } } } })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}
afterAll(cleanup)
afterEach(() => vi.unstubAllGlobals())
beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({ data: { name: `Panetti ${TAG}`, currency: 'NOK', wooUrl: 'https://panetti.example.test' } })).id
})

describe('GET /api/support/website', () => {
  it('lists every shop with its counts and its pages, admin only', async () => {
    await db.websitePage.create({ data: { shopId, externalId: 12, url: 'https://panetti.example.test/betingelser/', title: 'Betingelser', active: true } })
    const body = await (await GET(new Request('http://localhost/api/support/website'))).json()
    const shop = body.shops.find((s: { id: string }) => s.id === shopId)
    expect(shop).toMatchObject({ siteUrl: 'https://panetti.example.test', readAt: null, products: null, pages: null, error: null })
    expect(shop.pageList).toEqual([{ externalId: 12, url: 'https://panetti.example.test/betingelser/', title: 'Betingelser', active: true }])

    vi.mocked(currentUser).mockResolvedValueOnce({ id: 'u2', email: 'o@b.c', role: 'OPERATIONS' } as never)
    expect((await GET(new Request('http://localhost/api/support/website'))).status).toBe(403)
  })

  it('re-lists a shop\'s pages from the site when asked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ id: 5, link: 'https://panetti.example.test/faq/', slug: 'faq', title: { rendered: 'FAQ' } }]), { status: 200 })))
    const body = await (await GET(new Request(`http://localhost/api/support/website?refresh=${shopId}`))).json()
    const shop = body.shops.find((s: { id: string }) => s.id === shopId)
    expect(shop.pageList).toEqual([{ externalId: 5, url: 'https://panetti.example.test/faq/', title: 'FAQ', active: true }])
  })
})

describe('PUT /api/support/website', () => {
  it('ticks and unticks a page', async () => {
    await db.websitePage.create({ data: { shopId, externalId: 12, url: 'x', title: 'Betingelser', active: false } })
    const res = await PUT(new Request('http://localhost/api/support/website', { method: 'PUT', body: JSON.stringify({ shopId, externalId: 12, active: true }) }))
    expect(res.status).toBe(200)
    expect((await db.websitePage.findUniqueOrThrow({ where: { shopId_externalId: { shopId, externalId: 12 } } })).active).toBe(true)
  })
})

describe('POST /api/support/website/read', () => {
  it('reads the shop now and answers the counts', async () => {
    await db.shop.update({ where: { id: shopId }, data: { wooKey: null, wooSecret: null } })
    const res = await POST(new Request('http://localhost/api/support/website/read', { method: 'POST', body: JSON.stringify({ shopId }) }))
    // No Woo keys on this shop: the read cannot fetch its catalogue and says so.
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('No WooCommerce credentials for this shop')
  })
})
```

Create `src/app/api/support/knowledge/route.integration.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'a@b.c', role: 'ADMIN' })),
}))
const { GET } = await import('./route')
const { DELETE } = await import('./[id]/route')

const TAG = '[knowledge-route-test]'
async function cleanup() {
  await db.knowledgeItem.deleteMany({ where: { title: { contains: TAG } } })
}
afterAll(cleanup)
beforeEach(cleanup)

describe('the knowledge list and a website row', () => {
  it('says where a row came from, and refuses to delete a website row', async () => {
    const row = await db.knowledgeItem.create({ data: { kind: 'product', title: `Site ${TAG}`, body: 'x', source: 'website', sourceUrl: 'https://panetti.no/p/', sourceKey: `${TAG}:1`, readAt: new Date('2026-09-10T05:14:00Z') } })
    const body = await (await GET()).json()
    const item = body.items.find((i: { id: string }) => i.id === row.id)
    expect(item).toMatchObject({ source: 'website', sourceUrl: 'https://panetti.no/p/', readAt: '2026-09-10T05:14:00.000Z' })

    const res = await DELETE(new Request('http://localhost'), { params: Promise.resolve({ id: row.id }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('This was read from the website; turn it off instead, or untick its page')
    expect(await db.knowledgeItem.findUnique({ where: { id: row.id } })).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run --project app src/app/api/support/website src/app/api/support/knowledge/route.integration.test.ts`
Expected: FAIL, modules not found / fields missing.

- [ ] **Step 3: The website route**

Create `src/app/api/support/website/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { syncPageInventory } from '@/lib/support/website-sync'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/**
 * What the assistant has read from each shop's website, and which pages it
 * may read. Admin only, like everything that decides what it says.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())
    const refresh = new URL(req.url).searchParams.get('refresh')
    if (refresh) {
      const shop = await db.shop.findUnique({ where: { id: refresh }, select: { wooUrl: true } })
      if (shop?.wooUrl) {
        try {
          await syncPageInventory(refresh, shop.wooUrl)
        } catch (e) {
          await db.shop.update({ where: { id: refresh }, data: { websiteError: e instanceof Error ? e.message : 'Could not list the pages' } })
        }
      }
    }
    const shops = await db.shop.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, wooUrl: true, websiteReadAt: true, websiteProducts: true, websitePages: true, websiteError: true,
        websitePages_: { orderBy: { title: 'asc' }, select: { externalId: true, url: true, title: true, active: true } },
      },
    })
    return NextResponse.json(
      {
        shops: shops.map((s) => ({
          id: s.id, name: s.name, siteUrl: s.wooUrl,
          readAt: s.websiteReadAt?.toISOString() ?? null,
          products: s.websiteProducts, pages: s.websitePages, error: s.websiteError,
          pageList: s.websitePages_,
        })),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the websites' }, { status: 500, headers: NO_STORE })
  }
}

const Tick = z.object({ shopId: z.string().min(1), externalId: z.number().int(), active: z.boolean() })

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Tick.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'A shop, a page and on or off' }, { status: 400, headers: NO_STORE })
    const { shopId, externalId, active } = parsed.data
    const r = await db.websitePage.updateMany({ where: { shopId, externalId }, data: { active } })
    if (r.count === 0) return NextResponse.json({ error: 'No such page' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not save' }, { status: 500, headers: NO_STORE })
  }
}
```

Create `src/app/api/support/website/read/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'
import { fetchCatalog } from '@/lib/woo/client'
import { refreshWebsiteKnowledge, syncPageInventory } from '@/lib/support/website-sync'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/** The "Read now" button: the same read the sync does daily, for one shop, with its own budget. */
const READ_NOW_MS = 25_000

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = z.object({ shopId: z.string().min(1) }).safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'Which shop?' }, { status: 400, headers: NO_STORE })

    const shop = await db.shop.findUnique({ where: { id: parsed.data.shopId } })
    if (!shop) return NextResponse.json({ error: 'No such shop' }, { status: 404, headers: NO_STORE })
    if (!shop.wooUrl || !shop.wooKey || !shop.wooSecret) {
      return NextResponse.json({ error: 'No WooCommerce credentials for this shop' }, { status: 400, headers: NO_STORE })
    }

    const deadline = Date.now() + READ_NOW_MS
    try {
      const creds = { url: shop.wooUrl, key: decryptSecret(shop.wooKey), secret: decryptSecret(shop.wooSecret) }
      const catalog = await fetchCatalog(creds)
      await syncPageInventory(shop.id, shop.wooUrl, { deadline })
      const counts = await refreshWebsiteKnowledge({ shopId: shop.id, siteUrl: shop.wooUrl, catalog, deadline })
      return NextResponse.json(counts, { headers: NO_STORE })
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Could not read the website'
      await db.shop.update({ where: { id: shop.id }, data: { websiteError: error } }).catch(() => {})
      return NextResponse.json({ error }, { status: 400, headers: NO_STORE })
    }
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not read the website' }, { status: 500, headers: NO_STORE })
  }
}
```

- [ ] **Step 4: The knowledge routes**

In `src/app/api/support/knowledge/route.ts` GET, add to each item: `source: i.source, sourceUrl: i.sourceUrl, readAt: i.readAt?.toISOString() ?? null`.

In `src/app/api/support/knowledge/[id]/route.ts` DELETE, before `deleteMany`:

```ts
    const row = await db.knowledgeItem.findUnique({ where: { id }, select: { source: true } })
    if (row?.source === 'website') {
      return NextResponse.json(
        { error: 'This was read from the website; turn it off instead, or untick its page' },
        { status: 400, headers: NO_STORE },
      )
    }
```

- [ ] **Step 5: Run, typecheck, commit**

Run: `npx vitest run --project app src/app/api/support/` and `npx tsc --noEmit`.

```bash
git add src/app/api/support/website/ src/app/api/support/knowledge/
git commit -m "feat(support): the websites' read state, page ticks and a Read now, over the API

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 9: Settings: "From the websites"

**Files:**
- Modify: `src/app/settings/ai-support/SupportAiClient.tsx`
- Test: `src/app/settings/ai-support/SupportAiClient.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `SupportAiClient.test.tsx`, extend `mockFetch` so `/api/support/website` answers `over.website ?? WEBSITE` (GET), `{ ok: true }` (PUT), and `/api/support/website/read` answers `{ products: 22, withDescriptions: 17, pages: 2, rows: 60 }`. Add:

```ts
const WEBSITE = {
  shops: [
    {
      id: 's-no', name: 'Panetti Norway', siteUrl: 'https://panetti.no', readAt: '2026-09-10T05:14:00.000Z', products: 22, pages: 2, error: null,
      pageList: [
        { externalId: 12, url: 'https://panetti.no/betingelser/', title: 'Betingelser', active: true },
        { externalId: 13, url: 'https://panetti.no/sample-page/', title: 'Sample Page', active: false },
      ],
    },
    { id: 's-dk', name: 'Panetti Denmark', siteUrl: 'https://panetti.dk', readAt: null, products: null, pages: null, error: 'panetti.dk answered 503', pageList: [] },
  ],
}
```

and the item fixture for the knowledge list should include one website row: `{ id: 'k-web', kind: 'product', title: 'Panetti ProMix', body: 'Product: ...', active: true, shopId: 's-no', shopName: 'Panetti Norway', country: null, language: null, sku: null, source: 'website', sourceUrl: 'https://panetti.no/promix/', readAt: '2026-09-10T05:14:00.000Z' }` and one manual row with `source: 'manual'`. Then:

```ts
describe('From the websites', () => {
  it('shows each shop\'s counts, last read and error', async () => {
    mockFetch()
    draw()
    expect(await screen.findByRole('heading', { name: 'From the websites' })).toBeInTheDocument()
    expect(screen.getByText(/panetti\.no: 22 products, 2 pages, read 10 Sept/)).toBeInTheDocument()
    expect(screen.getByText(/panetti\.dk: not read yet/)).toBeInTheDocument()
    expect(screen.getByText('panetti.dk answered 503')).toBeInTheDocument()
  })

  it('ticks a page', async () => {
    const calls = mockFetch()
    draw()
    await screen.findByRole('heading', { name: 'From the websites' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Pages' })[0])
    fireEvent.click(screen.getByLabelText('Sample Page'))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/support/website' && c.init?.method === 'PUT')).toBe(true))
    const put = calls.find((c) => c.url === '/api/support/website' && c.init?.method === 'PUT')!
    expect(JSON.parse(put.init!.body as string)).toEqual({ shopId: 's-no', externalId: 13, active: true })
  })

  it('reads a shop now and says what it found', async () => {
    const calls = mockFetch()
    draw()
    await screen.findByRole('heading', { name: 'From the websites' })
    fireEvent.click(screen.getAllByRole('button', { name: 'Read now' })[0])
    await waitFor(() => expect(calls.some((c) => c.url === '/api/support/website/read')).toBe(true))
    expect(JSON.parse(calls.find((c) => c.url === '/api/support/website/read')!.init!.body as string)).toEqual({ shopId: 's-no' })
    expect(await screen.findByText('Read 22 products (17 with descriptions) and 2 pages into 60 entries')).toBeInTheDocument()
  })

  it('badges a website row and offers no Delete for it', async () => {
    mockFetch()
    draw()
    await screen.findByRole('heading', { name: 'What it knows' })
    const row = screen.getByText('Panetti ProMix').closest('div')!.parentElement!
    expect(row.textContent).toContain('website')
    expect(row.querySelector('button')?.textContent).toBe('Turn off')
    expect([...row.querySelectorAll('button')].some((b) => b.textContent === 'Delete')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run --project app src/app/settings/ai-support/SupportAiClient.test.tsx`
Expected: the four new tests FAIL.

- [ ] **Step 3: Implement**

In `SupportAiClient.tsx`:

1. Types: add `source: string; sourceUrl: string | null; readAt: string | null` to `Item`; add
   ```ts
   type WebsitePage = { externalId: number; url: string; title: string; active: boolean }
   type WebsiteShop = { id: string; name: string; siteUrl: string | null; readAt: string | null; products: number | null; pages: number | null; error: string | null; pageList: WebsitePage[] }
   ```
2. State: `const [website, setWebsite] = useState<WebsiteShop[]>([])`, `const [pagesOpen, setPagesOpen] = useState<string | null>(null)`, `const [reading, setReading] = useState<string | null>(null)`.
3. `load()` fetches `/api/support/website` as a fourth request and `setWebsite(w.shops)`.
4. Handlers:

```ts
  async function tickPage(shopId: string, externalId: number, active: boolean) {
    const res = await fetch('/api/support/website', { method: 'PUT', body: JSON.stringify({ shopId, externalId, active }) })
    if (!res.ok) toast.error('Could not save')
    await load()
  }

  async function readNow(shopId: string) {
    setReading(shopId)
    try {
      const res = await fetch('/api/support/website/read', { method: 'POST', body: JSON.stringify({ shopId }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body.error ?? 'Could not read the website')
        return
      }
      toast.success(`Read ${body.products} products (${body.withDescriptions} with descriptions) and ${body.pages} pages into ${body.rows} entries`)
      await load()
    } finally {
      setReading(null)
    }
  }

  const host = (url: string | null) => (url ? url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '') : 'no site')
  const readOn = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
```

5. In the "What it knows" section, before the `{items === null ? ...}` block, add:

```tsx
            <div className="mb-4 rounded-[var(--radius-card)] border border-line bg-panel p-3">
              <h3 className="text-[13px] font-semibold text-ink">From the websites</h3>
              <p className="mb-2 text-[12px] text-muted">
                Every product page is read by itself once a day. Tick the pages it may also read, such as
                terms, warranty and FAQ. It never states a price or a stock level from these; it links the page.
              </p>
              <ul className="space-y-1.5 text-[13px]">
                {website.map((w) => (
                  <li key={w.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-ink">
                        {host(w.siteUrl)}:{' '}
                        {w.readAt
                          ? `${w.products ?? 0} products, ${w.pages ?? 0} pages, read ${readOn(w.readAt)}`
                          : 'not read yet'}
                      </span>
                      {w.error && <span className="text-[12px] text-loss">{w.error}</span>}
                      <button type="button" disabled={reading === w.id} onClick={() => void readNow(w.id)} className="text-[12px] text-accent disabled:opacity-50">
                        {reading === w.id ? 'Reading' : 'Read now'}
                      </button>
                      <button type="button" onClick={() => setPagesOpen((o) => (o === w.id ? null : w.id))} className="text-[12px] text-accent">
                        Pages
                      </button>
                    </div>
                    {pagesOpen === w.id && (
                      <ul className="mt-1 space-y-0.5 pl-4 text-[12px]">
                        {w.pageList.length === 0 && <li className="text-muted">No pages listed yet. Read now lists them.</li>}
                        {w.pageList.map((p) => (
                          <li key={p.externalId}>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" aria-label={p.title} checked={p.active} onChange={(e) => void tickPage(w.id, p.externalId, e.target.checked)} />
                              <span className="text-ink">{p.title}</span>
                              <a href={p.url} target="_blank" rel="noopener noreferrer" className="truncate text-faint hover:underline">{p.url}</a>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
```

6. In the item list, after the kind pill add `{i.source === 'website' && <span className="ml-1 rounded-full border border-line px-1.5 text-[11px] text-muted">website</span>}` and render the Delete button only when `i.source !== 'website'`.

- [ ] **Step 4: Run, lint, commit**

Run: `npx vitest run --project app src/app/settings/ai-support/` and `npx eslint src/app/settings/ai-support` and `npx tsc --noEmit`.

```bash
git add src/app/settings/ai-support/
git commit -m "feat(support): settings show what was read from each website and which pages it may read

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 10: The practice page names a website row

**Files:**
- Modify: `src/app/support/sandbox/SandboxClient.tsx` (type at line 27, rendering at line 198)
- Test: `src/app/support/sandbox/SandboxClient.test.tsx`

- [ ] **Step 1: Write the failing test**

In `SandboxClient.test.tsx`, change the `result()` fixture's `knowledge` to `[{ kind: 'policy', title: 'Levering', source: 'manual' }, { kind: 'product', title: 'Panetti ProMix - Hva følger med', source: 'website' }]` and add:

```ts
  it('says which rows came from the website', async () => {
    mockFetch({ body: result() })
    draw()
    await waitFor(() => expect(screen.getByLabelText('Shop')).toHaveValue('s-dk'))
    await say('Hva følger med ProMix?')
    expect(await screen.findByText(/product: Panetti ProMix - Hva følger med \(website\)/)).toBeInTheDocument()
    expect(screen.getByText(/policy: Levering(?! \(website\))/)).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run --project app src/app/support/sandbox/SandboxClient.test.tsx`
Expected: the new test FAILS.

- [ ] **Step 3: Implement**

Type: `knowledge: { kind: string; title: string; source: string }[]`. Rendering: `l.result.knowledge.map((k) => \`${k.kind}: ${k.title}${k.source === 'website' ? ' (website)' : ''}\`).join('; ')`.

- [ ] **Step 4: Run and commit**

Run: `npx vitest run --project app src/app/support/sandbox/`

```bash
git add src/app/support/sandbox/
git commit -m "feat(support): the practice page says when an answer leaned on the website

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 11: End to end through the sandbox (recorded model)

**Files:**
- Test: `src/lib/support/sandbox.integration.test.ts`

- [ ] **Step 1: Write the test**

Append inside `describe('runSandboxTurn', ...)`. The file mocks `judge` and tags knowledge rows by title prefix `TAG`:

```ts
  it('hands the judge the shop\'s own product page for a customer with no orders', async () => {
    await db.knowledgeItem.create({
      data: {
        kind: 'product', title: `${TAG} Panetti ProMix - Hva følger med`, shopId, source: 'website',
        sourceUrl: 'https://panetti.dk/promix/', sourceKey: `${TAG}:promix:1`,
        body: 'Product: Panetti ProMix (SKU PROMIX)\nPage: https://panetti.dk/promix/\n\nBolle, eltekrok, visp og spatel følger med.',
      },
    })

    const r = await runSandboxTurn(
      { shopId, customerEmail: null, sessionKey: 'test-web', messages: [{ role: 'user', text: 'Hva følger med ProMix?' }] },
      { rules },
    )

    const input = judge.mock.calls[0][0] as { knowledge: { title: string; source: string }[] }
    expect(input.knowledge.some((k) => k.title.endsWith('Panetti ProMix - Hva følger med') && k.source === 'website')).toBe(true)
    expect(r.knowledge.some((k) => k.source === 'website')).toBe(true)
  })
```

- [ ] **Step 2: Run**

Run: `npx vitest run --project app src/lib/support/sandbox.integration.test.ts`
Expected: PASS (Task 7 made the scope and the result carry `source`). If the file's cleanup does not delete by `sourceKey` prefix, add `await db.knowledgeItem.deleteMany({ where: { sourceKey: { startsWith: TAG } } })` to it.

- [ ] **Step 3: Commit**

```bash
git add src/lib/support/sandbox.integration.test.ts
git commit -m "test(support): a product question with no order reaches the shop's own page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75"
```

---

### Task 12: Whole suite, PR, first live read

- [ ] **Step 1: Run everything**

```bash
npx tsc --noEmit
npx eslint src
npx vitest run --project app
npx vitest run --project delivery --testTimeout=20000
```

Expected: no type errors; eslint only the eight pre-existing errors (none in touched files); every test passes except the pre-existing `src/lib/inbox/ingest.integration.test.ts` failure.

- [ ] **Step 2: Merge main, re-run the support tests**

```bash
git fetch origin && git merge origin/main
npx prisma generate && npx vitest run --project app src/lib/support src/app/api/support src/app/settings/ai-support src/app/support
```

- [ ] **Step 3: PR**

```bash
git push -u origin feat/website-knowledge
gh pr create --title "The assistant reads the webshops: product pages daily, policy pages by tick" --body-file - <<'EOF'
## What

- The catalogue sweep the sync already runs now also carries each product's name, page link and descriptions. Once a day per shop (one shop per run, 15 s share) they become `product` knowledge rows, cleaned of theme shortcodes and split by heading into chunks of at most 1,500 characters, upserted by a stable key and deleted when gone. A row a person turns off stays off.
- Pages are read only when ticked in Settings. Policy-like pages (terms, warranty, FAQ, shipping, returns, in six languages) are pre-ticked; "test" and "Sample Page" are not.
- Retrieval weighs a title match three times a body match. The prompt names website rows "from panetti.no" and forbids stating a price or stock: it links the page.
- Settings: "From the websites" with counts, last read, error, Read now, and the page tick list. Website rows carry a badge and cannot be deleted, only turned off. The practice page marks website rows.

Measured 2026-09-10 through the public Store API: 115 products across 9 shops, 95 with a description.

## Spec and plan

docs/superpowers/specs/2026-09-10-website-knowledge-design.md
docs/superpowers/plans/2026-09-10-website-knowledge.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01BNGXmzAFxyuZJf1g2dFh75
EOF
gh pr checks --watch
gh pr merge --merge --delete-branch=false
```

- [ ] **Step 4: Verify live**

Poll `https://panetti.vercel.app/api/version` until it reports the merge commit. Then, as admin, open Settings, Support assistant, and press "Read now" on Panetti Denmark; the toast should report its products and pages. Open the practice page, choose Panetti Denmark, ask what the ProMix comes with, and check "what it looked at" lists a `product` row marked "(website)".
