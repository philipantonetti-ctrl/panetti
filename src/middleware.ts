import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session'

/** Pages that need a session at all. Everything else passes straight through. */
const PROTECTED_PAGES = ['/dashboard', '/marketing', '/settings', '/portal', '/account', '/ambassadors']

/** Pages an ambassador is allowed to open. Everything else is the company's. */
const AMBASSADOR_PAGES = ['/portal', '/account']

/** Pages marketing is allowed to open: the ambassador program and themselves. */
const MARKETING_PAGES = ['/ambassadors', '/account']

/**
 * Doors only machines knock on, exempt from the one-live-host walk below.
 *
 * Vercel Cron calls the deployment's OWN generated URL — the log line reads
 * `GET 308 panetti-ec53dmxro-....vercel.app /api/cron/sync` — never the
 * production domain. Cron does not follow redirects, so the 308 WAS the whole
 * invocation: the scheduled sync had not run since the host check shipped, and
 * because Vercel does not log a redirected cron as an invocation, it failed
 * without leaving a trace. A store delivering a webhook is the same shape of
 * caller: it retries against the URL it holds and counts a 3xx as a failed
 * delivery, disabling the webhook after enough of them.
 *
 * Neither cares which host it reached us on, and neither builds a URL from it.
 * Both carry their own credential — the cron its CRON_SECRET bearer token, the
 * webhook its per-shop HMAC — so the host check was never what protected them.
 * Postmark's inbound webhook is the same shape again: it POSTs the URL on
 * file and carries its own `?token=` secret, never a session.
 *
 * Deliberately a short, named list, not all of /api: the OAuth start route
 * builds its redirect_uri from the host it was called on, which is the very
 * reason the host check exists. It must keep being walked.
 */
const MACHINE_PATHS = ['/api/cron/', '/api/webhooks/', '/api/delivery/inbound']

/**
 * Two duties, in order.
 *
 * One live host, for people: every deploy mints a hashed .vercel.app URL that
 * team members can wander onto without noticing; OAuth then carries that host
 * to Facebook, which rightly refuses it. In production, any host that is not
 * the project's production domain walks to it, path and query intact — unless
 * the caller is a machine that cannot walk (see MACHINE_PATHS).
 *
 * Then a coarse session gate: no session, go to /login. It does NOT decide
 * what a logged-in user may see. That is the guard's job, enforced in the
 * routes themselves, where it cannot be bypassed.
 */
export async function middleware(req: NextRequest) {
  const machine = MACHINE_PATHS.some((path) => req.nextUrl.pathname.startsWith(path))
  const canonical = process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (
    !machine &&
    process.env.VERCEL_ENV === 'production' &&
    canonical &&
    req.nextUrl.hostname !== canonical
  ) {
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
