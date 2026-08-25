/**
 * Warm the dev server before the first test measures it. Next compiles each
 * page on its first hit; without this, whichever test lands first pays the
 * whole compile bill and times out while every later test sails through.
 * Production builds compile ahead of time and don't need the favour.
 */
export default async function globalSetup() {
  const base = 'http://localhost:3000'
  for (const path of ['/login', '/dashboard', '/advisor', '/inbox', '/settings/inbox', '/orders', '/portal', '/account', '/settings/shops', '/settings/affiliate', '/marketing', '/b2b']) {
    try {
      await fetch(`${base}${path}`, { redirect: 'manual' })
    } catch {
      // The webServer readiness check already guarantees the server exists;
      // a single cold page that still fails will surface in its own test.
    }
  }
}
