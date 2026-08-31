import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { gorgiasCredentials } from '@/lib/support/client'

export const dynamic = 'force-dynamic'

/**
 * The agent's helpdesk photo, fetched server-side.
 *
 * Gorgias stores profile pictures in a bucket that answers 403 to the open
 * internet (measured 2026-08-31), so the browser cannot load the URL the
 * users API hands out. This route asks with the same credentials the sync
 * uses and streams the bytes through; when Gorgias refuses even those, the
 * page's initials fallback stands and nothing broken renders.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const name = new URL(req.url).searchParams.get('agent') ?? ''
    if (!name) return new NextResponse(null, { status: 404 })

    const agent = await db.supportAgent.findFirst({
      where: { name, avatarUrl: { not: null } },
      select: { avatarUrl: true },
    })
    const creds = gorgiasCredentials()
    if (!agent?.avatarUrl || !creds) return new NextResponse(null, { status: 404 })

    let upstream: Response
    try {
      upstream = await fetch(agent.avatarUrl, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      return new NextResponse(null, { status: 404 })
    }
    if (!upstream.ok) return new NextResponse(null, { status: 404 })

    return new NextResponse(upstream.body, {
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'image/png',
        // A face changes rarely; an hour spares Gorgias a request per row per
        // page view without freezing anyone's new photo for long.
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (e) {
    if (e instanceof AuthError) return new NextResponse(null, { status: 403 })
    console.error(e)
    return new NextResponse(null, { status: 404 })
  }
}
