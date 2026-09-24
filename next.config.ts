import type { NextConfig } from "next";
import path from "node:path";

/**
 * What a browser is allowed to do with our pages.
 *
 * Measured against the live site on 2026-09-24: it sent Strict-Transport-Security
 * (Vercel adds that) and nothing else. No framing rule, no content type rule, no
 * referrer rule, and X-Powered-By naming the framework.
 *
 * This is an admin console. One signed-in admin can change a shop's API
 * credentials, upload a warehouse file, and send messages to real customers, so
 * the two that matter most here are `frame-ancestors`, which stops the console
 * being loaded invisibly inside somebody else's page and clicked through, and
 * `Referrer-Policy`, because Settings > Support assistant prints a webhook URL
 * with a secret in its query string and a full Referer would hand that to every
 * site an admin clicked through to.
 *
 * The script rule is `'self' 'unsafe-inline'`. Inline is not dropped because
 * Next's own bootstrap and its flight data are inline scripts, and a nonce needs
 * every response to go through middleware. It is still worth setting: it stops
 * an injected `<script src="https://attacker/evil.js">` and it stops the page
 * reaching any host we do not talk to. `'unsafe-eval'` is deliberately absent -
 * the production bundle does not need it.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // Avatars the helpdesk stores as data URIs, and remote avatar URLs.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // The browser talks to this app and nothing else.
  "connect-src 'self'",
  "media-src 'self'",
  // Nothing here embeds anything, and nothing may embed us.
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  // A stolen <base> or a posted form cannot send an admin's credentials away.
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join('; ')

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
]

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
  // unpdf ships its own pdf.js build; bundling it breaks the worker resolution.
  serverExternalPackages: ['unpdf'],
  // Naming the framework and its version only helps somebody choosing an exploit.
  poweredByHeader: false,
  env: {
    // Inlined into every bundle, server and client alike, so an open tab can
    // tell when a newer deployment exists and reload itself (see FreshBuild).
    // 'dev' outside Vercel, where there is nothing to keep in step with.
    NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
  },
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }]
  },
};

export default nextConfig;
