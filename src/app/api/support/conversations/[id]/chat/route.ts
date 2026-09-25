import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { ownMessages } from '@/lib/support/chat'
import { isOurs } from '@/lib/support/chat-turn'
import { gorgiasChannel } from '@/lib/support/gorgias-channel'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

/** Who said it, in the four kinds a chat actually has. */
export type Speaker = 'customer' | 'assistant' | 'person' | 'widget'

/**
 * The whole chat behind one row, as the customer saw it.
 *
 * The review page is about the assistant, so until now it showed the
 * assistant's half and nothing else - and the first question anyone asks of a
 * chat the assistant handed over or stood out of is "what did the person then
 * say?". Read live from the channel rather than stored: the person's reply
 * arrives long after the row is written, and a copy of a conversation goes
 * stale the moment anybody types.
 *
 * Telling our own line from a colleague's is the whole difficulty, and it is
 * the same rule the assistant itself uses (`ownMessages` + `isOurs`): the id
 * the channel gave our reply. Guessing here would put a colleague's words in
 * the assistant's mouth on the page people judge the assistant by.
 */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const row = await db.aiConversation.findUnique({
      where: { id },
      select: { source: true, externalTicketId: true, sessionId: true },
    })
    if (!row) return NextResponse.json({ error: 'No such conversation' }, { status: 404, headers: NO_STORE })

    const quiet = (reason: string) => NextResponse.json({ messages: [], reason }, { headers: NO_STORE })
    if (row.source === 'sandbox') return quiet('This was a practice run, so there is no live chat behind it.')

    const channel = gorgiasChannel('gorgias_chat')
    if (!channel?.transcript) return quiet('Gorgias is not configured, so the chat cannot be read.')

    const transcript = await channel.transcript(row.externalTicketId).catch(() => null)
    if (transcript === null) return quiet('Gorgias would not give us this chat just now. Try again in a moment.')

    const own = row.sessionId ? await ownMessages(row.sessionId, new Date()) : { ids: new Set<string>(), texts: new Set<string>() }
    const messages = transcript.map((m) => ({
      who: (!m.fromAgent
        ? 'customer'
        : isOurs(m, own)
          ? 'assistant'
          : m.automatic
            ? 'widget'
            : 'person') as Speaker,
      text: m.text,
      at: m.at,
    }))

    return NextResponse.json({ messages }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not read the chat' }, { status: 500, headers: NO_STORE })
  }
}
