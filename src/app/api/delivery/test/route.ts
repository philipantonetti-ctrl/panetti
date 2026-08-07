import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { getDeliveryConfig } from '@/lib/delivery/config'
import { fetchTracking } from '@/lib/bring/client'
import { postSlack } from '@/lib/slack/notify'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const Body = z.object({ target: z.enum(['bring', 'slack']) })

// Obviously not a real parcel. Bring simply returns nothing for a number it
// does not know (see fetchTracking's own doc) — any response at all, empty
// or not, is what proves the credentials were accepted.
const PROBE_NUMBER = '00000000000TEST'

/**
 * The two buttons that prove the integrations actually work.
 *
 * An alerting feature nobody has seen fire is one nobody trusts — this is the
 * whole reason the client believes a silent week means "nothing is late"
 * rather than "it broke". Both branches speak in a sentence a human can act
 * on: Bring's and Slack's own errors are caught here and turned into words,
 * never forwarded as a raw stack.
 */
export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Choose Bring or Slack.' },
        { status: 400, headers: NO_STORE },
      )
    }

    const { creds, slackWebhookUrl } = await getDeliveryConfig()

    if (parsed.data.target === 'bring') {
      if (!creds) {
        return NextResponse.json(
          {
            ok: false,
            message: 'Bring is not connected. Save the account email, API key and client URL first.',
          },
          { headers: NO_STORE },
        )
      }
      try {
        // The point is that Bring accepted the credentials, not that this
        // parcel exists — any non-error response counts as success.
        await fetchTracking(creds, [PROBE_NUMBER])
        return NextResponse.json(
          { ok: true, message: 'Bring accepted the credentials.' },
          { headers: NO_STORE },
        )
      } catch {
        return NextResponse.json(
          {
            ok: false,
            message: 'Bring refused the credentials. Check the account email, API key and client URL.',
          },
          { headers: NO_STORE },
        )
      }
    }

    // target === 'slack'
    if (!slackWebhookUrl) {
      return NextResponse.json(
        { ok: false, message: 'Slack is not connected. Save a webhook URL first.' },
        { headers: NO_STORE },
      )
    }
    try {
      await postSlack(slackWebhookUrl, 'Delivery alerts are connected. This is a test.')
      return NextResponse.json(
        { ok: true, message: 'Test message sent to Slack. Check the channel.' },
        { headers: NO_STORE },
      )
    } catch {
      return NextResponse.json(
        { ok: false, message: 'Could not post to Slack. Check the webhook URL.' },
        { headers: NO_STORE },
      )
    }
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json(
      { error: 'Something went wrong running the test.' },
      { status: 500, headers: NO_STORE },
    )
  }
}
