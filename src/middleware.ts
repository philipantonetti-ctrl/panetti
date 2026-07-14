import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session'

/** Pages an ambassador is allowed to open. Everything else is the company's. */
const AMBASSADOR_PAGES = ['/portal', '/account']

/**
 * A coarse gate: no session, go to /login.
 * It does NOT decide what a logged-in user may see. That is the guard's job, enforced
 * in the routes themselves, where it cannot be bypassed.
 */
export async function middleware(req: NextRequest) {
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

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/settings/:path*',
    '/portal/:path*',
    '/account/:path*',
  ],
}
