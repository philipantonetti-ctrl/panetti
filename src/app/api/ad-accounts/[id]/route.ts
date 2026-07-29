import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'
import { verifyMeta } from '@/lib/ads/meta'
import { verifyGoogle } from '@/lib/ads/google'
import { readCredentials } from '@/lib/ads/sync'
import { toPublic } from '@/lib/ads/accounts'
import { AdApiError, type GoogleCredentials, type MetaCredentials } from '@/lib/ads/types'

export const maxDuration = 60

const Body = z.object({
  shopId: z.string().optional(),
  accessToken: z.string().trim().optional(),
  developerToken: z.string().trim().optional(),
  clientId: z.string().trim().optional(),
  clientSecret: z.string().trim().optional(),
  refreshToken: z.string().trim().optional(),
  loginCustomerId: z.string().trim().optional(),
})

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid details' }, { status: 400 })

    const existing = await db.adAccount.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'No such ad account' }, { status: 404 })

    if (parsed.data.shopId) {
      const shop = await db.shop.findUnique({ where: { id: parsed.data.shopId } })
      if (!shop) return NextResponse.json({ error: 'No such shop' }, { status: 404 })
    }

    // A blank field means "leave what is saved" — the edit form posts blanks
    // for anything untouched, exactly like the shop connection modal. An
    // account connected by login starts from nothing here.
    const stored = existing.credentials
      ? (readCredentials(existing.credentials) as Record<string, string>)
      : {}
    const patch: Record<string, string> = {}
    for (const field of [
      'accessToken',
      'developerToken',
      'clientId',
      'clientSecret',
      'refreshToken',
      'loginCustomerId',
    ] as const) {
      if (parsed.data[field]) patch[field] = parsed.data[field]
    }
    const changedCredentials = Object.keys(patch).length > 0
    const merged = { ...stored, ...patch }

    // New credentials must prove themselves before they replace working ones,
    // and the platform's answer refreshes the name and currency while we're at it.
    let verified: { name: string; currency: string } | null = null
    if (changedCredentials) {
      verified =
        existing.provider === 'meta'
          ? await verifyMeta(merged as unknown as MetaCredentials, existing.externalId)
          : await verifyGoogle(merged as unknown as GoogleCredentials, existing.externalId)
    }

    const account = await db.adAccount.update({
      where: { id },
      data: {
        ...(parsed.data.shopId ? { shopId: parsed.data.shopId } : {}),
        ...(changedCredentials
          ? {
              credentials: encryptSecret(JSON.stringify(merged)),
              name: verified!.name,
              currency: verified!.currency,
              lastError: null,
            }
          : {}),
      },
      include: { shop: { select: { name: true } } },
    })

    return NextResponse.json({ account: toPublic(account) })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    if (e instanceof AdApiError) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the ad account' }, { status: 500 })
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const existing = await db.adAccount.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'No such ad account' }, { status: 404 })

    // Cascades the stored daily spend with it. Reconnecting later simply
    // backfills the same year of history from the platform again.
    await db.adAccount.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not remove the ad account' }, { status: 500 })
  }
}
