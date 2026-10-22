import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { vismaCredentials, vismaGetFile } from '@/lib/visma/client'
import { isAttachmentId } from '@/lib/visma/po-files'

export const maxDuration = 60

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const fail = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status, headers: NO_STORE })

/**
 * `inline` so a PDF opens in the browser tab the link opened. The plain
 * filename drops anything a header cannot carry; filename* keeps the real one.
 */
function disposition(name: string): string {
  const plain = name.replace(/[^\x20-\x7e]|["\\]/g, '').trim() || 'file'
  return `inline; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * One file from Visma, passed through. The browser cannot fetch it directly:
 * Visma wants our bearer token, which never leaves the server.
 *
 * Admin only, like the list that links here - see ../route.ts.
 */
export async function GET(req: Request, { params }: { params: Promise<{ attachmentId: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { attachmentId } = await params
    // Checked before anything reaches Visma: the id is spliced into a path.
    if (!isAttachmentId(attachmentId)) return fail('Not a Visma file id', 400)

    const creds = vismaCredentials()
    if (!creds) return fail('Visma is not connected here', 503)

    const upstream = await vismaGetFile(creds, `controller/api/v1/attachment/${attachmentId}`)
    const name = new URL(req.url).searchParams.get('name')?.trim() || 'file'
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...NO_STORE,
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
        'Content-Disposition': disposition(name),
      },
    })
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, 403)
    console.error(e)
    return fail('Could not fetch that file from Visma', 502)
  }
}
