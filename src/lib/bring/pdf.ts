/**
 * PDF bytes into plain text.
 *
 * Its own file so the dependency has exactly one caller: if unpdf ever has to
 * be swapped, nothing but this function changes.
 */
import { extractText, getDocumentProxy } from 'unpdf'

export async function pdfToText(buf: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(buf))
  const { text } = await extractText(doc, { mergePages: true })
  return text
}
