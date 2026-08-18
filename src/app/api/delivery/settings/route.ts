import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** How many past imports the settings page shows — matches /api/delivery's own list. */
const RECENT_IMPORTS = 10

const Body = z.object({
  bringApiUid: z.string().trim().optional(),
  // Blank means "leave what is stored" — the browser never receives the secret,
  // so it cannot send it back, and requiring it would wipe the key on every
  // unrelated save. Trimmed for the same reason wooKey/wooSecret are
  // (src/app/api/shops/[id]/route.ts): a whitespace-only paste is otherwise
  // still truthy, so it would pass the "non-empty means replace" check below
  // and silently overwrite a good stored secret with blanks.
  bringApiKey: z.string().trim().optional(),
  bringClientUrl: z.string().trim().url().optional().or(z.literal('')),
  // Trimmed for the same reason as bringApiKey above.
  slackWebhookUrl: z.string().trim().optional(),
  // The finance channel's own webhook. Trimmed for the same reason.
  financeSlackWebhookUrl: z.string().trim().optional(),
  promises: z
    .array(
      z.object({
        // null means "every shop". Two shops in one country promise different
        // things, so country alone cannot express the real policy.
        shopId: z.string().min(1).nullable().optional(),
        country: z.string().trim().min(1).max(2).or(z.literal('*')),
        // At least one day. Zero would make every order late the moment it was
        // placed, which is the loudest possible way to be wrong.
        days: z.number().int().min(1).max(90),
        businessDays: z.boolean(),
        effectiveFrom: z.string(),
      }),
    )
    .optional(),
  // Which shops are delivery-tracked, and from when — the feature's on/off
  // switch. Unlike the secrets above, a blank date here is a DELIBERATE
  // instruction, not "no change": dates are not secret, so the browser
  // always holds the true current value, and blanking one is how an admin
  // turns tracking off for a shop that does not ship from the Bring
  // warehouse.
  shopTracking: z
    .array(z.object({ shopId: z.string().min(1), date: z.string() }))
    .optional(),
})

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const [row, promises, shops, imports] = await Promise.all([
      db.deliveryConfig.findUnique({ where: { id: 'singleton' } }),
      db.deliveryPromise.findMany({
        // Shop-specific rows first, then the all-shop ones, so the list reads
        // in the same order the resolution actually applies them.
        orderBy: [{ shopId: 'asc' }, { country: 'asc' }, { effectiveFrom: 'desc' }],
      }),
      db.shop.findMany({
        where: { active: true },
        select: { id: true, name: true, deliveryTrackingFrom: true },
        orderBy: { name: 'asc' },
      }),
      db.trackingImport.findMany({
        orderBy: { receivedAt: 'desc' },
        take: RECENT_IMPORTS,
        select: {
          id: true, filename: true, receivedAt: true,
          rowsParsed: true, rowsLinked: true, rowsUnmatched: true, error: true,
        },
      }),
    ])

    return NextResponse.json(
      {
        bringApiUid: row?.bringApiUid ?? '',
        bringClientUrl: row?.bringClientUrl ?? '',
        // Never the secrets themselves, only whether they exist.
        hasBringKey: Boolean(row?.bringApiKey),
        hasSlackWebhook: Boolean(row?.slackWebhookUrl),
        hasFinanceSlackWebhook: Boolean(row?.financeSlackWebhookUrl),
        // DHL's key is a deployment secret in Vercel rather than a stored
        // setting, so there is no row to read — but the page still has to be
        // able to say which of the two carriers is actually connected. Read
        // exactly as syncShipments reads it, so the panel and the poller can
        // never disagree about whether DHL is on.
        hasDhlKey: Boolean(process.env.DHL_API_KEY),
        lastSyncAt: row?.lastSyncAt?.toISOString() ?? null,
        lastError: row?.lastError ?? null,
        // Its own field, separate from the Bring sync's lastError above — see
        // the schema comment on DeliveryConfig.slackLastError.
        slackLastError: row?.slackLastError ?? null,
        promises: promises.map((p) => ({
          ...p, effectiveFrom: p.effectiveFrom.toISOString().slice(0, 10),
        })),
        shops: shops.map((s) => ({
          id: s.id,
          name: s.name,
          deliveryTrackingFrom: s.deliveryTrackingFrom
            ? s.deliveryTrackingFrom.toISOString().slice(0, 10)
            : null,
        })),
        imports: imports.map((i) => ({ ...i, receivedAt: i.receivedAt.toISOString() })),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not load settings' }, { status: 500, headers: NO_STORE })
  }
}

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Check the values and try again.' },
        { status: 400, headers: NO_STORE },
      )
    }
    const b = parsed.data

    await db.deliveryConfig.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        bringApiUid: b.bringApiUid || null,
        bringApiKey: b.bringApiKey ? encryptSecret(b.bringApiKey) : null,
        bringClientUrl: b.bringClientUrl || null,
        slackWebhookUrl: b.slackWebhookUrl ? encryptSecret(b.slackWebhookUrl) : null,
        financeSlackWebhookUrl: b.financeSlackWebhookUrl
          ? encryptSecret(b.financeSlackWebhookUrl)
          : null,
      },
      update: {
        ...(b.bringApiUid !== undefined ? { bringApiUid: b.bringApiUid || null } : {}),
        ...(b.bringClientUrl !== undefined ? { bringClientUrl: b.bringClientUrl || null } : {}),
        // A blank secret leaves the stored one alone. Only a non-empty value replaces it.
        ...(b.bringApiKey ? { bringApiKey: encryptSecret(b.bringApiKey) } : {}),
        ...(b.slackWebhookUrl ? { slackWebhookUrl: encryptSecret(b.slackWebhookUrl) } : {}),
        ...(b.financeSlackWebhookUrl
          ? { financeSlackWebhookUrl: encryptSecret(b.financeSlackWebhookUrl) }
          : {}),
      },
    })

    if (b.promises) {
      // Rewritten wholesale rather than diffed: simpler and always correct, the
      // same choice storeOrder makes for order lines.
      await db.$transaction(async (tx) => {
        await tx.deliveryPromise.deleteMany()
        await tx.deliveryPromise.createMany({
          data: b.promises!.map((p) => ({
            shopId: p.shopId ?? null,
            country: p.country.toUpperCase(),
            days: p.days,
            businessDays: p.businessDays,
            effectiveFrom: new Date(`${p.effectiveFrom}T00:00:00Z`),
          })),
        })
      })
    }

    if (b.shopTracking) {
      // updateMany, not update: a shop id that no longer exists is silently a
      // no-op rather than failing the whole save over one stale row.
      await Promise.all(
        b.shopTracking.map((s) =>
          db.shop.updateMany({
            where: { id: s.shopId },
            data: { deliveryTrackingFrom: s.date ? new Date(`${s.date}T00:00:00Z`) : null },
          }),
        ),
      )
    }

    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not save' }, { status: 500, headers: NO_STORE })
  }
}
