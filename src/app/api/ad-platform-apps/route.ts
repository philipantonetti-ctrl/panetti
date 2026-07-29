import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { decryptSecret, encryptSecret } from '@/lib/secrets'
import { validateMetaApp } from '@/lib/ads/oauth'
import { AdApiError } from '@/lib/ads/types'

/**
 * The client's own Meta app / Google OAuth client — the one-time setup that
 * makes "Connect with Facebook/Google" possible. Secrets go in, never out.
 */

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const rows = await db.adPlatformApp.findMany()
    return NextResponse.json({
      apps: rows.map((a) => ({
        provider: a.provider,
        clientId: a.clientId,
        hasSecret: Boolean(a.clientSecret),
        hasDeveloperToken: Boolean(a.developerToken),
      })),
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load the platform setup' }, { status: 500 })
  }
}

const Body = z.object({
  provider: z.enum(['meta', 'google']),
  clientId: z.string().trim().min(1, 'Fill in the app ID'),
  clientSecret: z.string().trim().optional(),
  developerToken: z.string().trim().optional(),
})

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid details' },
        { status: 400 },
      )
    }

    const { provider, clientId, clientSecret, developerToken } = parsed.data
    const existing = await db.adPlatformApp.findUnique({ where: { provider } })
    if (!existing && !clientSecret) {
      return NextResponse.json({ error: 'Paste the app secret' }, { status: 400 })
    }
    if (provider === 'google' && !existing?.developerToken && !developerToken) {
      return NextResponse.json({ error: 'Paste the developer token' }, { status: 400 })
    }

    // A Meta app proves itself before it is saved: a wrong App ID or secret
    // dies here with Facebook's words, not later at the login dialog. The
    // domain check is the same courtesy for the "Can't load URL" screen.
    // (Google offers no silent way to prove a client id + secret.)
    let warning: string | undefined
    if (provider === 'meta') {
      const secret = clientSecret || (existing ? decryptSecret(existing.clientSecret) : '')
      const domain = new URL(req.url).hostname
      warning = (await validateMetaApp({ clientId, clientSecret: secret }, domain)).warning
    }

    // Blank secret fields mean "keep what is saved", like every other modal.
    await db.adPlatformApp.upsert({
      where: { provider },
      create: {
        provider,
        clientId,
        clientSecret: encryptSecret(clientSecret ?? ''),
        ...(developerToken ? { developerToken: encryptSecret(developerToken) } : {}),
      },
      update: {
        clientId,
        ...(clientSecret ? { clientSecret: encryptSecret(clientSecret) } : {}),
        ...(developerToken ? { developerToken: encryptSecret(developerToken) } : {}),
      },
    })
    return NextResponse.json({ ok: true, ...(warning ? { warning } : {}) })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    if (e instanceof AdApiError) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the platform setup' }, { status: 500 })
  }
}
