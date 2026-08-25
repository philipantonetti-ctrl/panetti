const TIMEOUT_MS = 10_000

const ENDPOINT = 'https://api.postmarkapp.com/email'

/**
 * The warehouse's daily report arrives on the INBOUND stream of this same
 * Postmark server (see api/delivery/inbound/route.ts). Naming the outbound
 * stream explicitly keeps the two apart: Postmark rejects a transactional
 * message sent on an inbound stream, and sharing one would put password resets
 * and the delivery intake in a single volume figure.
 */
const STREAM = 'outbound'

/**
 * Send one transactional email through Postmark's REST API.
 *
 * Postmark rather than a new vendor because the account already exists for the
 * warehouse intake - one bill, one dashboard, one set of credentials to keep
 * alive. Raw `fetch` rather than the Postmark SDK because this is a single POST
 * and the SDK would be a dependency earning nothing.
 *
 * THROWS on failure, like postSlack in lib/slack/notify.ts. Every caller has a
 * different idea of what a failure means - the forgot-password route swallows
 * it so the page cannot be used to discover who has an account - so this
 * reports the truth and lets them decide.
 *
 * Configuration is read at call time, not at module load: a serverless instance
 * may be reused across a redeploy that changed the variables.
 */
export async function sendEmail(to: string, subject: string, textBody: string): Promise<void> {
  const token = process.env.POSTMARK_SERVER_TOKEN
  const from = process.env.EMAIL_FROM

  // Checked before the network, so a misconfigured server never opens a
  // connection to be told something it could have known locally. The variable
  // is NAMED in the message because the only person who ever reads it is
  // whoever has to go and set it.
  if (!token) throw new Error('POSTMARK_SERVER_TOKEN is not set, so no email can be sent')
  if (!from) throw new Error('EMAIL_FROM is not set, so no email can be sent')

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Postmark-Server-Token': token,
    },
    body: JSON.stringify({
      From: from,
      To: to,
      Subject: subject,
      TextBody: textBody,
      MessageStream: STREAM,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!res.ok) {
    // Postmark answers a JSON body with an ErrorCode and a Message that says
    // exactly what is wrong ("Sender signature not confirmed", "Bad token").
    // Carrying it into the thrown error is the difference between a diagnosable
    // failure and a bare status code.
    const body = (await res.text()).slice(0, 200)
    throw new Error(`Postmark responded ${res.status}: ${body}`)
  }
}
