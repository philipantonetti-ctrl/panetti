import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session'

/**
 * A coarse gate: no session -> go to /login.
 * It does NOT decide what a logged-in user may see — that is the guard's job,
 * enforced in the routes themselves, where it cannot be bypassed.
 */
export async function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  const user = token ? await verifySession(token) : null

  if (!user) {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // An ambassador has no business on an admin page.
  if (user.role === 'AMBASSADOR' && !req.nextUrl.pathname.startsWith('/portal')) {
    const url = req.nextUrl.clone()
    url.pathname = '/portal'
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/dashboard/:path*', '/ambassadors/:path*', '/settings/:path*', '/portal/:path*'],
}
