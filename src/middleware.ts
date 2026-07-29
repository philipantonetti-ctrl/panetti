import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session'

/** Pages that need a session at all. Everything else passes straight through. */
const PROTECTED_PAGES = ['/dashboard', '/marketing', '/settings', '/portal', '/account', '/ambassadors']

/** Pages an ambassador is allowed to open. Everything else is the company's. */
const AMBASSADOR_PAGES = ['/portal', '/account']

/** Pages marketing is allowed to open: the ambassador program and themselves. */
const MARKETING_PAGES = ['/ambassadors', '/account']

/**
 * Two duties, in order.
 *
 * One live host: every deploy mints a hashed .vercel.app URL that team
 * members can wander onto without noticing; OAuth then carries that host to
 * Facebook, which rightly refuses it. In production, any host that is not
 * the project's production domain walks to it, path and query intact.
 *
 * Then a coarse session gate: no session, go to /login. It does NOT decide
 * what a logged-in user may see. That is the guard's job, enforced in the
 * routes themselves, where it cannot be bypassed.
 */
export async function middleware(req: NextRequest) {
  const canonical = process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (process.env.VERCEL_ENV === 'production' && canonical && req.nextUrl.hostname !== canonical) {
    const url = req.nextUrl.clone()
    url.protocol = 'https:'
    url.hostname = canonical
    url.port = ''
    return NextResponse.redirect(url, 308)
  }

  const protectedPage = PROTECTED_PAGES.some((page) => req.nextUrl.pathname.startsWith(page))
  if (!protectedPage) return NextResponse.next()

  const token = req.cookies.get(SESSION_COOKIE)?.value
  const user = token ? await verifySession(token) : null

  if (!user) {
    const url = req.nextUrl.clone()
    url.pathname = '/login' // the default door
    return NextResponse.redirect(url)
  }

  // An ambassador has no business on an admin page, but their own account is theirs.
  const allowed = AMBASSADOR_PAGES.some((page) => req.nextUrl.pathname.startsWith(page))
  if (user.role === 'AMBASSADOR' && !allowed) {
    const url = req.nextUrl.clone()
    url.pathname = '/portal'
    return NextResponse.redirect(url)
  }

  // Marketing runs the ambassador program and nothing else.
  if (user.role === 'MARKETING' && !MARKETING_PAGES.some((p) => req.nextUrl.pathname.startsWith(p))) {
    const url = req.nextUrl.clone()
    url.pathname = '/ambassadors'
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  // Everything but Next's own assets: the host check must see every door,
  // /login and the OAuth routes included.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
