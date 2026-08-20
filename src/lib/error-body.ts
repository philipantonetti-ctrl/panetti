/**
 * A failed response's body as one line a person can read.
 *
 * Most of what we call answers with JSON or a bare string, which needs nothing
 * doing to it. WordPress is the exception: a fatal error there returns a whole
 * HTML page, and its first 300 characters are the doctype, three meta tags and
 * the opening of <title>. Truncating to 300 — which is what this replaces —
 * therefore kept 100% boilerplate and dropped 100% of the message, so a client
 * read `WooCommerce responded 500: <!DOCTYPE html> <html lang="nb-NO">` off his
 * own dashboard and had nothing to act on.
 *
 * Truncation was the wrong instrument for the job the old comment described.
 * This extracts the words and throws the markup away.
 */

/** An error line, not a document. */
const LIMIT = 200

/**
 * The handful that actually turn up in error pages. A full entity table would
 * be several hundred lines to make an error message marginally prettier.
 */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsaquo: '›', lsaquo: '‹', hellip: '…',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
}

function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
}

/**
 * Decoded AFTER the tags come out, not before: `&lt;p&gt;` is text the page
 * meant to show, and decoding first would turn it into a tag and strip it.
 */
const tidy = (html: string) =>
  decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

export function readableErrorBody(body: string, limit = LIMIT): string {
  // Nothing tag-shaped — JSON, a bare string, a stack trace. Already readable,
  // so it passes through with only its whitespace settled.
  if (!/<[a-z!/][^>]*>/i.test(body)) return body.replace(/\s+/g, ' ').trim().slice(0, limit)

  // Dropped whole rather than stripped of their tags: a WordPress error page
  // carries kilobytes of inline CSS, and CSS survives tag-stripping as text.
  const stripped = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')

  const inner = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(stripped)?.[1]
  const said = tidy(inner ?? stripped)
  if (said) return said.slice(0, limit)

  // A gateway's 502 is often a styled shell whose only words are in the tab.
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(stripped)?.[1]
  return tidy(title ?? '').slice(0, limit)
}
