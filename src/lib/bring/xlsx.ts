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
