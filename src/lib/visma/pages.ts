import { vismaGet, type VismaCredentials } from './client'

/**
 * Every page of a Visma list, and whether that really was every page.
 *
 * A short page is the end. A full page at the limit is a ceiling, not an end,
 * so `complete` is false and the caller must not read the rows as all there
 * is. Visma also ignores a parameter it does not know and serves page one
 * again (measured with `skip`), so a page whose first row repeats the first
 * page's stops the loop, incomplete, instead of counting the same rows twice.
 */
export async function vismaGetPages(
  creds: VismaCredentials,
  path: string,
  { pageSize, maxPages }: { pageSize: number; maxPages: number },
): Promise<{ rows: unknown[]; complete: boolean }> {
  const sep = path.includes('?') ? '&' : '?'
  const rows: unknown[] = []
  let first: string | null = null

  for (let page = 1; page <= maxPages; page++) {
    const got = await vismaGet<unknown>(creds, `${path}${sep}pageSize=${pageSize}&pageNumber=${page}`)
    const batch = Array.isArray(got) ? got : []

    const head = batch.length > 0 ? JSON.stringify(batch[0]) : null
    if (page === 1) first = head
    else if (head !== null && head === first) return { rows, complete: false }

    rows.push(...batch)
    if (batch.length < pageSize) return { rows, complete: true }
  }
  return { rows, complete: false }
}
