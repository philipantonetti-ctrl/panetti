import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/** What the assistant did, newest first, for the review screen. */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())
    const url = new URL(req.url)
    const decision = url.searchParams.get('decision')
    // Practice runs from the sandbox are shown only when asked for, and never
    // counted: "how often does it send" is a question about customers.
    const source = url.searchParams.get('source') === 'sandbox' ? 'sandbox' : { not: 'sandbox' }

    const [rows, counts] = await Promise.all([
      db.aiConversation.findMany({
        where: { source, ...(decision && decision !== 'all' ? { decision } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      // Counted over everything, never over the page: "how often does it send"
      // is a question about the whole history, not about the last hundred rows.
      db.aiConversation.groupBy({ by: ['decision'], _count: true, where: { source: { not: 'sandbox' } } }),
    ])

    return NextResponse.json(
      {
        conversations: rows.map((r) => ({
          id: r.id,
          externalTicketId: r.externalTicketId,
          source: r.source,
          shopId: r.shopId,
          customerEmail: r.customerEmail,
          question: r.question,
          answer: r.answer,
          category: r.category,
          language: r.language,
          confidence: r.confidence,
          decision: r.decision,
          escalationReason: r.escalationReason,
          summary: r.summary,
          orderNumber: r.orderNumber,
          rating: r.rating,
          correction: r.correction,
          createdAt: r.createdAt.toISOString(),
        })),
        counts: Object.fromEntries(counts.map((c) => [c.decision, c._count])),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the conversations' }, { status: 500, headers: NO_STORE })
  }
}
