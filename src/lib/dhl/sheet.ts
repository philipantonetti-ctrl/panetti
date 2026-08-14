/**
 * An xlsx worksheet as rows keyed by their header.
 *
 * Its own file so `fflate` keeps one caller per concern, exactly as
 * `lib/bring/xlsx.ts` does for the Bring path. The two are deliberately
 * different readers: Bring's flattens the whole archive to text because that
 * path only wants long digit runs and must not care about layout. DHL's export
 * is the opposite — 61 named columns, and the answer lives in two specific ones
 * — so here the columns are exactly what we need.
 *
 * Everything is returned as a STRING. `Shipment Number` is a 10-digit id that
 * JavaScript would happily hold as a float and hand back in a form nobody can
 * look up.
 */
import { unzipSync, strFromU8 } from 'fflate'

/**
 * Both cell forms, and matching both is load-bearing.
 *
 * Excel writes an unused-but-styled cell as `<c r="B2" s="1"/>` — self-closing,
 * no value. Matching only the paired `<c ...>…</c>` form makes the regex run
 * past such a cell and consume the NEXT cell's `<v>`, filing that value under
 * the empty cell's column. Every column after it shifts by one.
 *
 * That is not hypothetical. On DHL's real export it made `Receiver Reference`
 * read as blank on all 62 rows, which is the single column the whole
 * integration depends on, while `Sender VAT Country Code` filled up with
 * numbers like 650. The conclusion "DHL does not export the order number" was
 * wrong, and this alternation is why.
 */
const CELL = /<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
const ROW = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g

/** Only the five XML entities a worksheet can contain. */
function unescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Last, or an escaped "&amp;lt;" would decode twice.
    .replace(/&amp;/g, '&')
}

function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    // A styled cell splits its text across several <t> runs; joining them is
    // what keeps "Panetti.de Order #15537" from arriving as "Panetti" alone.
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescape(t[1])).join(''),
  )
}

export function xlsxToRows(buf: Buffer): Record<string, string>[] {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buf))
  } catch {
    // Written for whoever uploaded it; ImportParseError passes it through verbatim.
    throw new Error('This file could not be read as an Excel file.')
  }

  const sheetName = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0]
  if (!sheetName) return []

  const shared = files['xl/sharedStrings.xml']
    ? sharedStrings(strFromU8(files['xl/sharedStrings.xml']))
    : []

  /** One cell's text, whichever way the writer chose to store it. */
  const read = (attrs: string, body: string): string => {
    const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
    const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
    if (type === 's' && v !== undefined) return shared[Number(v)] ?? ''
    if (type === 'inlineStr') return unescape(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1] ?? '')
    return v === undefined ? '' : unescape(v)
  }

  const xml = strFromU8(files[sheetName])
  const grid: { index: number; cells: Record<string, string> }[] = []

  for (const row of xml.matchAll(ROW)) {
    const cells: Record<string, string> = {}
    for (const cell of row[2].matchAll(CELL)) {
      const column = /r="([A-Z]+)\d+"/.exec(cell[1])?.[1]
      if (!column) continue
      cells[column] = read(cell[1], cell[2] ?? '')
    }
    grid.push({ index: Number(row[1]), cells })
  }

  grid.sort((a, b) => a.index - b.index)
  const [head, ...body] = grid
  if (!head) return []

  return body.map((row) => {
    const out: Record<string, string> = {}
    for (const [column, name] of Object.entries(head.cells)) {
      if (name === '') continue
      // Absent means empty, never undefined: a caller reading a column that
      // happens to be blank on one row should not have to guard for it.
      out[name] = row.cells[column] ?? ''
    }
    return out
  })
}
