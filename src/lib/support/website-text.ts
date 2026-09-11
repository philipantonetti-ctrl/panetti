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
