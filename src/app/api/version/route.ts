import { NextResponse } from 'next/server'

/**
 * Which build is the server running? Open tabs ask this once a minute and
 * reload themselves when the answer changes (see FreshBuild). The id is the
 * deployment's commit sha inlined at build time - opaque, public, harmless -
 * and 'dev' outside Vercel, where there is nothing to keep in step with.
 */
export function GET() {
  return NextResponse.json(
    { id: process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev' },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
