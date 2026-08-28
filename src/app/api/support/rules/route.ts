import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { CATEGORIES } from '@/lib/support/agent'
import { DEFAULT_RULES } from '@/lib/support/rules'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/**
 * What the assistant is allowed to do, editable without touching code -
 * Philip's requirement 4. The gates themselves live in lib/support/rules.ts;
 * this only stores the settings they read.
 */
const Body = z.object({
  mode: z.enum(['off', 'draft', 'auto']),
  autoCategories: z.array(z.enum(CATEGORIES)).max(20),
  escalateKeywords: z.array(z.string().trim().min(1).max(60)).max(100),
  minConfidence: z.number().min(0).max(1),
  extraInstructions: z.string().max(8000),
})

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const row = await db.aiSupportRules.findUnique({ where: { id: 'singleton' } })
    return NextResponse.json(
      {
        // The defaults are the same ones the engine falls back to, so an
        // untouched page shows exactly what the assistant is really doing.
        rules: row ?? { id: 'singleton', ...DEFAULT_RULES, extraInstructions: '' },
        categories: CATEGORIES,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not load the rules' }, { status: 500, headers: NO_STORE })
  }
}

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Those settings are not ones the assistant understands' },
        { status: 400, headers: NO_STORE },
      )
    }
    await db.aiSupportRules.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...parsed.data },
      update: parsed.data,
    })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not save the rules' }, { status: 500, headers: NO_STORE })
  }
}
