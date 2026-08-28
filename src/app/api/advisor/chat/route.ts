import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { ADVISOR_MODEL } from '@/lib/advisor/brief'
import { runTool, TOOL_DEFINITIONS } from '@/lib/advisor/tools'
import { trimTranscript, type Turn } from '@/lib/advisor/trim'
import { METHODOLOGY } from '@/lib/advisor/methodology'
import { pageContext } from '@/lib/advisor/page-context'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export const maxDuration = 300

const SYSTEM_PROMPT = `You answer questions about a group of regional WooCommerce shops
(Panetti, Mazzetti, Massasjepistoler, Bellino) trading in Norway, Sweden, Denmark,
Finland and Germany, for the owner.

You have read-only tools over his accounting data. Use them for EVERY figure you
state. Never estimate, never work a number out in your head, and never carry a
figure forward from memory - call a tool and read it.

Money comes back in minor units (cents, øre) of the currency named beside it, so
82000 in USD is $820.00. Convert for display, never between currencies.

To answer "why did X change", fetch the same window and the equal window before it
and compare them.

If a tool returns nothing, or a figure is missing, say so. A confident wrong number
is worse than an admitted gap. Write plainly and briefly.`

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return NextResponse.json(
        { error: 'No ANTHROPIC_API_KEY is configured, so the advisor cannot answer.' },
        { status: 503, headers: NO_STORE },
      )
    }

    const body = (await req.json()) as { messages?: Turn[]; page?: string }
    const messages = Array.isArray(body.messages) ? body.messages : []
    if (messages.length === 0) {
      return NextResponse.json({ error: 'Ask a question first.' }, { status: 400, headers: NO_STORE })
    }

    // Up to 8 tool rounds share one 300s platform ceiling below, so a
    // per-call timeout anywhere near the SDK's 600s default is meaningless -
    // one slow round would already exceed the whole budget. 60s bounds a
    // single stuck call without pretending to guarantee the total; the
    // platform's own kill at maxDuration is what actually enforces that.
    const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 })
    // Bounded here rather than in the browser: the route already returns the
    // array the client stores, so trimming once on the way in caps the cost of
    // this request AND the size of what the browser keeps.
    const turns = trimTranscript(messages) as Anthropic.MessageParam[]
    // Which page the question was asked from, when it is one we can name.
    const where = pageContext(body.page)

    // A bounded loop, not a while(true): a model that keeps calling tools must
    // stop somewhere, and stopping visibly beats a request the platform kills.
    for (let round = 0; round < 8; round++) {
      const res = await client.messages.create({
        model: ADVISOR_MODEL,
        max_tokens: 8000,
        system: [
          // Stable prefix, cached - the chat re-sends it on every turn, and the
          // methodology is long. It must stay byte-identical between requests,
          // which is why the page below is a second block rather than appended.
          {
            type: 'text',
            text: `${SYSTEM_PROMPT}\n\n${METHODOLOGY}`,
            cache_control: { type: 'ephemeral' },
          },
          // Where the question was asked from. Changes as the user walks around
          // the product, so it is never cached.
          ...(where ? [{ type: 'text' as const, text: where }] : []),
        ],
        tools: TOOL_DEFINITIONS,
        messages: turns,
      })

      if (res.stop_reason === 'refusal') {
        return NextResponse.json(
          { error: 'The advisor declined to answer that.' },
          { status: 200, headers: NO_STORE },
        )
      }

      turns.push({ role: 'assistant', content: res.content })

      const calls = res.content.filter((b) => b.type === 'tool_use')
      if (calls.length === 0) {
        const text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
        return NextResponse.json({ reply: text, messages: turns }, { headers: NO_STORE })
      }

      // Every result goes back in ONE user message. Splitting them across
      // several silently teaches the model to stop calling tools in parallel.
      const results = await Promise.all(
        calls.map(async (call) => {
          try {
            const value = await runTool(call.name, call.input as Record<string, unknown>)
            return { type: 'tool_result' as const, tool_use_id: call.id, content: JSON.stringify(value) }
          } catch (e) {
            return {
              type: 'tool_result' as const,
              tool_use_id: call.id,
              content: e instanceof Error ? e.message : String(e),
              is_error: true,
            }
          }
        }),
      )
      turns.push({ role: 'user', content: results })
    }

    return NextResponse.json(
      { error: 'The advisor could not finish that one. Try asking it more narrowly.' },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not answer' }, { status: 500, headers: NO_STORE })
  }
}
