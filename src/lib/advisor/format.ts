/**
 * An answer, turned into something a narrow panel can show.
 *
 * The model writes markdown by habit. Printed raw it arrives as asterisks
 * around every emphasis and, worse, as rows of pipes and dashes where it tried
 * to draw a table - which is what the client saw. The prompt now asks for
 * neither, but a prompt is not a guarantee, so the few shapes that still get
 * through are read here rather than shown as punctuation.
 *
 * Deliberately not a markdown library: this needs bold, lists and a safety net
 * for tables. Everything it produces is rendered as React elements, never as
 * HTML, so nothing here can inject markup.
 */

export type Span = { text: string; bold: boolean }
export type Block = { kind: 'para'; spans: Span[] } | { kind: 'bullets'; items: Span[][] }

const BULLET = /^\s*[-*•]\s+/
const TABLE_ROW = /^\s*\|.*\|\s*$/
/** The |---|:--:|---| line under a table header. Structure, never content. */
const TABLE_DIVIDER = /^\s*\|[\s:|-]*\|\s*$/
const HEADING = /^\s*#{1,6}\s+/

/** Splits on **bold**, keeping the order of what is around it. */
function spansOf(text: string): Span[] {
  const spans: Span[] = []
  let rest = text
  const BOLD = /\*\*(.+?)\*\*/

  for (let m = BOLD.exec(rest); m; m = BOLD.exec(rest)) {
    if (m.index > 0) spans.push({ text: rest.slice(0, m.index), bold: false })
    spans.push({ text: m[1], bold: true })
    rest = rest.slice(m.index + m[0].length)
  }
  if (rest) spans.push({ text: rest, bold: false })
  return spans.length ? spans : [{ text: '', bold: false }]
}

/** A table row as one readable line: cells joined, empty edges dropped. */
function rowLine(line: string): string {
  return line
    .trim()
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(' · ')
}

export function parseReply(text: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  let bullets: string[] = []

  const flush = () => {
    if (bullets.length) {
      blocks.push({ kind: 'bullets', items: bullets.map(spansOf) })
      bullets = []
    }
    if (para.length) {
      blocks.push({ kind: 'para', spans: spansOf(para.join('\n')) })
      para = []
    }
  }

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()

    if (!line.trim()) {
      flush()
      continue
    }
    if (TABLE_DIVIDER.test(line)) continue

    if (BULLET.test(line)) {
      // A list interrupts a paragraph, and the paragraph goes out first so the
      // two do not swap places on screen.
      if (para.length) {
        blocks.push({ kind: 'para', spans: spansOf(para.join('\n')) })
        para = []
      }
      bullets.push(line.replace(BULLET, ''))
      continue
    }

    if (bullets.length) flush()
    if (HEADING.test(line)) {
      flush()
      blocks.push({ kind: 'para', spans: [{ text: line.replace(HEADING, ''), bold: true }] })
      continue
    }
    para.push(TABLE_ROW.test(line) ? rowLine(line) : line)
  }

  flush()
  return blocks
}
