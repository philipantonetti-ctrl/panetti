# The assistant reads the webshops

**Date:** 2026-09-10
**Status:** design, awaiting review
**Asked by:** Philip, after the live-chat message: "but what about basic
product knowledge? It should be able to use our website as a source also to
find information and reply customers?"

## What the assistant knows today

- From the customer's orders: product **names** and quantities, nothing else
  about the product.
- From the knowledge base: whatever a person typed under "What it knows",
  kinds `product`, `policy`, `faq` and so on. Nothing there comes from the
  websites.

Rule 2 of the system prompt says every policy must come from the knowledge
base or the assistant hands over. So a pre-sale question ("does the ProMix
come with a pasta roller?") is handed over today unless someone typed the
answer by hand.

## What the websites offer (measured 2026-09-10)

All nine shops are WooCommerce sites and answer the public Store API and the
public pages list without any key. Counted through `wc/store/v1/products`:

| Shop | Products | With a long description | With any description |
| --- | --- | --- | --- |
| panetti.no | 22 | 7 | 17 |
| panetti.de | 16 | 7 | 12 |
| panetti.dk | 16 | 7 | 12 |
| panetti.se | 16 | 7 | 12 |
| panetti.fi | 21 | 7 | 12 |
| mazzetti.se | 6 | 6 | 6 |
| mazzetti.no | 6 | 6 | 6 |
| mazzetti.fi | 6 | 6 | 6 |
| mazzetti.dk | 6 | 6 | 6 |

Long descriptions run about 3,000 characters on Panetti and 12,000 to 14,000
on Mazzetti. Policy pages exist: terms (13,183 characters on panetti.no),
warranty, FAQ, about us.

**Two cautions the sites themselves raised.** Some pages are junk: mazzetti.se
has a "Customer help" page of theme placeholder text from 2018 and a "test"
page; its FAQ and terms are wrapped in theme shortcodes (`[ux_banner ...]`).
And prices and stock change daily. So "use the website" must mean: every
published product's description, cleaned; only the pages a person ticks; and
never a price or a stock level from memory.

## Goals

1. The assistant can answer what a product is, does, includes, fits and how it
   is used, in the customer's language, from the shop's own words.
2. It can quote the policy pages Philip chooses, per shop.
3. It never states a price or stock level from stored text; it links the
   product page instead.
4. Nothing is typed twice. The websites are read by themselves, daily.
5. A person can see what was read, turn a row off, and read again on demand.

## Non-goals

- Crawling the whole site. Products come from the product API, pages from a
  ticked list.
- Reading blog posts, comparison pages or the shop grid.
- Embeddings or a vector index. Scoping plus word overlap is what the
  knowledge base uses today and it stays.
- Answering price or stock questions from stored text.

## Design

### 1. Where the words come from

**Products:** the existing catalogue sweep in `src/lib/woo/client.ts`
(`fetchCatalog`, `GET /wp-json/wc/v3/products`, with the shop's stored keys)
already runs after every completed sync for price and stock. The same response
carries `name`, `sku`, `permalink`, `short_description`, `description`,
`status` and `catalog_visibility`. The sweep returns those too; the sync stores
price and stock as today and, at most once a day per shop, also refreshes the
knowledge rows (section 4). No new request to any shop.

**Pages:** WordPress's public `GET /wp-json/wp/v2/pages` on the shop's
`wooUrl`. The settings page lists them for ticking; the daily read fetches the
ticked ones by id with `_fields=title,content,modified,link`.

### 2. Cleaning and chunking

Pure module `src/lib/support/website-text.ts`:

- Remove theme shortcodes (`[name attr="..."]` and `[/name]`).
- Split on `<h1>` to `<h4>` boundaries into sections of heading plus text.
  A section longer than 1,500 characters is split further at paragraph
  boundaries. Sections under 40 characters are dropped.
- Strip every tag, decode entities, collapse whitespace.
- A product's `short_description` becomes its first section, titled with the
  product name alone.

### 3. What a website row looks like

`KnowledgeItem` gains four columns:

| Column | Meaning |
| --- | --- |
| `source String @default("manual")` | `manual` or `website` |
| `sourceUrl String?` | The product page or the page's link |
| `sourceKey String? @unique` | `website:<shopId>:product:<externalId>:<n>` or `website:<shopId>:page:<pageId>:<n>` |
| `readAt DateTime?` | When it was last read |

A product row: kind `product`, `shopId` set, `sku` null (see section 5),
country and language null, title `"<Product name> - <section heading>"` (or
the product name alone for the first section), body:

```
Product: Panetti ProMix Kjøkkenmaskin (SKU PROMIX-NO)
Page: https://panetti.no/promix/

<section text>
```

A page row: kind `policy`, `shopId` set, title `"<Page title> - <section
heading>"`, body with `Page: <link>` then the text.

A new table `WebsitePage { id, shopId, externalId Int, url, title, active
Boolean @default(false), @@unique([shopId, externalId]) }` holds the tick
list. Ticking is what makes a page read.

### 4. The daily read

`refreshWebsiteKnowledge(shop, catalog, deadline)` in
`src/lib/support/website-sync.ts`, called from the Woo sync after a completed
sync when `Shop.websiteReadAt` is null or older than 20 hours, best-effort,
with a 15-second share of the sync's deadline. At most one shop is read per
sync run, so a run never spends more than those 15 seconds on it; the other
shops follow on the next runs.

1. For each product with `status === 'publish'` and a visibility that is not
   `hidden`: clean and chunk; upsert each chunk by `sourceKey` (title, body,
   `sourceUrl`, `readAt`). `active` is never written on update, so a row a
   person turned off stays off through every read.
2. For each ticked `WebsitePage`: fetch, clean, chunk, upsert the same way.
3. Delete website rows for this shop whose `sourceKey` was not seen in this
   read (a product unpublished, a page unticked).
4. Set `Shop.websiteReadAt`. Record counts on the shop for the settings page:
   `websiteProducts Int?`, `websitePages Int?`, `websiteError String?`.

Manual rows are never touched. A read that fails leaves the previous rows in
place and writes `websiteError`.

`POST /api/support/website-read` with `{ shopId }` (admin) runs the same read
now, with a 25-second budget, and answers the counts. It is the button in
Settings and the way to see the first result without waiting a day.

### 5. Retrieval

`knowledgeFor` changes in two small ways:

- A keyword that matches the **title** scores 3, one that matches only the
  body scores 1. A long product chunk otherwise outranks the right product's
  short one by matching more words by chance.
- Website product rows carry `sku: null` on purpose. The sku scope excludes
  rows whose sku is not among the customer's orders, and a pre-sale question
  comes from someone with no orders. The product's SKU is in the body text, so
  a customer who names it still matches.

The 400-row read ceiling holds: rows are scoped to one shop, and the largest
shop produces about 100 chunks.

### 6. The prompt

`knowledgeBlock` marks the source: `[product, from panetti.no] Title`. Rule 2
of the system prompt gains two sentences:

> Product facts (what a product is, does, includes, fits, how it is used) also
> come from the KNOWLEDGE BASE; rows marked "from <shop>" are the shop's own
> product pages and you may state them as ours. Never state a price or whether
> something is in stock, even if a row mentions one: say it is on the product
> page and give the Page link from the row.

The cached first system block changes once; that is a one-time cache miss.

### 7. Settings and the practice page

In Settings, Support assistant, "What it knows" gains a first sub-section
**"From the websites"**: one line per shop, "panetti.no: 22 products, 17 with
descriptions, 2 pages, read 10 Sept 05:14", a "Read now" button, and a
"Pages" disclosure listing every page on that site with a checkbox. Pages
whose slug or title contains a policy-like word in any of the six languages
(terms, betingelser, villkor, vilkår, ehdot, bedingungen, warranty, garanti,
takuu, faq, shipping, levering, leverans, toimitus, versand, returns, retur,
palautus, rücksendung, delivery) are pre-ticked on first listing; everything
else, including "test" and "Sample Page", is unticked. Ticking or unticking
saves at once and takes effect on the next read.

Website rows in the knowledge list show a "website" badge, keep "Turn off"
and lose "Delete" (the next read would only bring it back).

On the practice page, "what it looked at" lists knowledge rows as today, with
"(website)" after a website row's title.

### 8. Roles

Admin only, as the rest of the assistant's settings. The operations manager
does not see this section.

## Data flow, end to end

1. Every 15 minutes the Woo sync completes for a shop and sweeps its
   catalogue. Once a day that sweep also refreshes the shop's website rows and
   fetches its ticked pages.
2. A customer writes in a shop's chat. `knowledgeFor` is scoped to that shop.
   Product and page chunks that share words with the question are among the
   twelve rows the assistant is shown, each with its page link.
3. The assistant answers from those words, or links the page for price and
   stock, or hands over when nothing covers the question, as now.
4. Philip reads the answer on the practice page, sees which website rows it
   used, and can turn a wrong one off.

## Error handling

- A shop whose product API fails keeps its old rows and shows the error on
  the settings line.
- A page that fails to fetch is skipped for that read; its old rows stay.
- The daily read never fails the Woo sync (same try/catch shape as the
  catalogue sweep).
- The read button answers 400 with the shop's own error text when the read
  fails.

## Cost

No model calls. The prompt grows by at most the twelve matched rows, each at
most about 1,500 characters. Woo requests do not increase; page fetches are
one per ticked page per shop per day.

## Testing

- `website-text.test.ts`: shortcodes removed, sections split on headings,
  long sections split at paragraphs, short ones dropped, entities decoded.
  Fixtures are real fragments captured today from panetti.no and mazzetti.se.
- `website-sync.integration.test.ts`: rows upserted by key; a turned-off row
  stays off after a read; rows of an unpublished product are deleted; manual
  rows untouched; a failed fetch leaves the old rows and records the error.
- `knowledge.test.ts`: title matches outrank body matches; a website product
  row reaches a customer with no orders.
- `agent.test.ts`: the prompt block names the source and carries the page
  link.
- Route tests: `website-read` runs a read and answers counts; the pages
  endpoint lists and ticks; every route refuses non-admins.
- `SupportAiClient.test.tsx`: the section renders counts, the tick list, and
  sends the right requests.
- `SandboxClient.test.tsx`: a website row is labelled.
- A recorded end-to-end: a sandbox turn asking what a product includes gets a
  reply that quotes the description and links the page (mocked model call
  asserting on the prompt contents).
