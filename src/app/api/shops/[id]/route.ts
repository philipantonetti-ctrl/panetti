import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'

const Body = z.object({
  wooUrl: z.string().url().or(z.literal('')),
  wooKey: z.string(),
  wooSecret: z.string(),
})

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid details' }, { status: 400 })

    // An empty field means "leave what is saved". The form posts blank key
    // fields on every edit, so writing them through would wipe the connection.
    const { wooUrl, wooKey, wooSecret } = parsed.data
    await db.shop.update({
      where: { id },
      data: {
        ...(wooUrl ? { wooUrl } : {}),
        ...(wooKey ? { wooKey: encryptSecret(wooKey) } : {}),
        ...(wooSecret ? { wooSecret: encryptSecret(wooSecret) } : {}),
      },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not save' }, { status: 500 })
  }
}
