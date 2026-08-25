import { db } from '../db'
import { decryptSecret } from '../secrets'
import { postSlack } from '../slack/notify'
import { money } from './format'
import { daysOverdue, overdueOn, totalsByCurrency, type OpenItem } from './overdue'

/** Enough to act on, few enough to read on a phone. Same cap the delivery alert uses. */
const MAX_LINES = 15

/** The live site, never the host that asked - same fixed default as the reset link. */
const appUrl = () => process.env.APP_URL ?? 'https://panetti.vercel.app'

/**
 * One Slack post about everything past its due date.
 *
 * Returns the EMPTY STRING when nothing is overdue, and the caller posts
 * nothing at all. A daily "all clear" is how a channel teaches people to
 * ignore it, which is exactly what the delivery alert already avoids.
 */
export function overdueMessage(items: OpenItem[], now: Date, appUrl: string): string {
  const late = overdueOn(items, now)
  if (late.length === 0) return ''

  const totals = totalsByCurrency(late)
    .map((t) => money(t.total, t.currency))
    .join(', ')

  const head =
    late.length === 1
      ? `1 invoice is overdue - ${totals}`
      : `${late.length} invoices are overdue - ${totals}`

  const lines = late.slice(0, MAX_LINES).map((i) => {
    const days = daysOverdue(i, now)
    return (
      `• <${appUrl}/finance|${i.referenceNumber}> ${i.customerName} - ` +
      `${days} days over, ${money(i.balance, i.currency)}`
    )
  })

  const rest = late.length - lines.length
  return [head, ...lines, ...(rest > 0 ? [`…and ${rest} more.`] : [])].join('\n')
}

/**
 * Post today's overdue invoices to the finance channel.
 *
 * Reads the snapshot rather than Visma, so a rate-limited import costs a
 * warning at worst, never a wrong one: the numbers are whatever the last
 * COMPLETE read established.
 *
 * Nothing overdue means nothing posted. No webhook means nothing posted and a
 * reason returned, which is what the settings page shows.
 */
export async function sendOverdueAlerts(
  opts: { now?: Date } = {},
): Promise<{ sent: number; skipped: string | null }> {
  const now = opts.now ?? new Date()

  const row = await db.deliveryConfig.findUnique({ where: { id: 'singleton' } })
  let webhook: string | null = null
  if (row?.financeSlackWebhookUrl) {
    try {
      webhook = decryptSecret(row.financeSlackWebhookUrl)
    } catch {
      // AUTH_SECRET changed under the stored value; the settings page says so.
      webhook = null
    }
  }
  if (!webhook) return { sent: 0, skipped: 'The finance Slack channel is not connected.' }

  const rows = await db.receivable.findMany({
    select: {
      referenceNumber: true, customerName: true, dueDate: true, currency: true, balance: true,
    },
  })

  const text = overdueMessage(rows, now, appUrl())
  if (text === '') return { sent: 0, skipped: 'Nothing is overdue.' }

  await postSlack(webhook, text)
  return { sent: 1, skipped: null }
}
