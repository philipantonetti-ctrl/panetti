import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { LANGUAGES } from '@/lib/inbox/classify'
import { MACRO_VARIABLES } from '@/lib/inbox/macros'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

export const MacroBody = z.object({
  name: z.string().trim().min(1).max(80),
  language: z.enum(LANGUAGES),
  body: z.string().trim().min(1).max(20000),
})

/**
 * A macro may only use variables the composer can fill; catching a typo here
 * is cheaper than an agent discovering a marked-missing "custmer_name" in the
 * middle of answering someone.
 */
export function unknownVariable(body: string): string | null {
  for (const m of body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)) {
    if (!(MACRO_VARIABLES as readonly string[]).includes(m[1].toLowerCase())) return m[1]
  }
  return null
}

/** Prisma's duplicate-key code - Macro is @@unique([name, language]). */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002'
}

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const macros = await db.macro.findMany({ orderBy: [{ name: 'asc' }, { language: 'asc' }] })
    return NextResponse.json({ macros, variables: MACRO_VARIABLES }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the macros' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = MacroBody.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'A macro needs a name, a language and a body' }, { status: 400, headers: NO_STORE })
    const unknown = unknownVariable(parsed.data.body)
    if (unknown) return NextResponse.json({ error: `${unknown} is not a variable macros know` }, { status: 400, headers: NO_STORE })
    const macro = await db.macro.create({ data: parsed.data })
    return NextResponse.json({ ok: true, macro }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (isUniqueViolation(e)) return NextResponse.json({ error: 'That macro already exists in that language' }, { status: 409, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the macro' }, { status: 500, headers: NO_STORE })
  }
}
