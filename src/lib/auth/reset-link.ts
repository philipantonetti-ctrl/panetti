import { signReset } from './reset'

/**
 * The live site, never the host that asked.
 *
 * A reset link is built here and clicked hours later, so it must not inherit a
 * stale hashed deployment URL the way the ads OAuth start route does - that
 * route reads `new URL(req.url).origin` and it is exactly why pressing Connect
 * on an old deployment dies on Google's redirect_uri_mismatch. Same fixed
 * default as lib/delivery/alerts.ts uses for its Slack links.
 */
export const appUrl = () => process.env.APP_URL || 'https://panetti.vercel.app'

/**
 * A one-hour, single-use link to choose a new password for this login.
 *
 * One function for both ways a link comes to exist: the forgot-password form
 * mails it, and an admin copies it from the Users page or the roster to hand
 * over by any channel they like, for the day the email lands in spam. Both
 * produce the very same link, so /reset/[token] has one caller shape to honour.
 */
export async function resetLink(user: { id: string; passwordHash: string }): Promise<string> {
  return `${appUrl()}/reset/${await signReset(user.id, user.passwordHash)}`
}

/** The bare address in EMAIL_FROM, which may already carry a display name. */
function bareAddress(from: string | undefined): string | null {
  if (!from) return null
  const m = from.match(/<([^>]+)>/)
  return (m ? m[1] : from).trim() || null
}

/**
 * Who a password email is from: the product, at the configured address.
 *
 * EMAIL_FROM on the live site reads "Philip Antonetti" <...>. An ambassador who
 * never met Philip sees a stranger's name on a password email, marks it spam,
 * and Gmail learns the lesson for everyone after them - the 2026-10-01 reset
 * was filed as "similar to messages identified as spam in the past". The name
 * people typed into the sign-in form is the one they expect to hear back from.
 *
 * Undefined when nothing is configured, so sendEmail can name the missing
 * variable itself rather than this inventing an address.
 */
export function resetSender(): string | undefined {
  const address = bareAddress(process.env.EMAIL_FROM)
  return address ? `"Panetti-analytics" <${address}>` : undefined
}
