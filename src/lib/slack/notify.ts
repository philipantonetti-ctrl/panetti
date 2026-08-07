const TIMEOUT_MS = 10_000

/**
 * Post to a Slack incoming webhook.
 *
 * An incoming webhook rather than a full Slack app: no OAuth, no scopes, no app
 * review, and the client can create the URL himself in two minutes. A full app
 * would only buy choosing the channel at runtime, which is not worth it.
 *
 * THROWS on failure, deliberately. The caller must not mark orders as alerted
 * for a message that never arrived.
 */
export async function postSlack(webhookUrl: string, text: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200)
    throw new Error(`Slack responded ${res.status}: ${body}`)
  }
}
