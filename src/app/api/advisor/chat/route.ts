import Anthropic from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { ADVISOR_MODEL } from '@/lib/advisor/brief'
import { runTool, TOOL_DEFINITIONS } from '@/lib/advisor/tools'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export const maxDuration = 300

const SYSTEM_PROMPT = `You answer questions about a group of regional WooCommerce shops
(Panetti, Mazzetti, Massasjepistoler, Bellino) trading in Norway, Sweden, Denmark,
Finland and Germany, for the owner.

You have read-only tools over his accounting data. Use them for EVERY figure you
state. Never estimate, never work a number out in your head, and never carry a
figure forward from memory — call a tool and read it.

Money comes back in minor units (cents, øre) of the currency named beside it, so
82000 in USD is $820.00. Convert for display, never between currencies.

To answer "why did X change", fetch the same window and the equal window before it
and compare them.

If a tool returns nothing, or a figure is missing, say so. A confident wrong number
is worse than an admitted gap. Write plainly and briefly.`

type Turn = { role: 'user' | 'assistant'; content: unknown }

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

    const body = (await req.json()) as { messages?: Turn[] }
    const messages = Array.isArray(body.messages) ? body.messages : []
    if (messages.length === 0) {
      return NextResponse.json({ error: 'Ask a question first.' }, { status: 400, headers: NO_STORE })
    }

    const client = new Anthropic({ apiKey })
    const turns = [...messages] as Anthropic.MessageParam[]

    // A bounded loop, not a while(true): a model that keeps calling tools must
    // stop somewhere, and stopping visibly beats a request the platform kills.
    for (let round = 0; round < 8; round++) {
      const res = await client.messages.create({
        model: ADVISOR_MODEL,
        max_tokens: 8000,
        system: [
          // Stable prefix, cached — the chat re-sends it on every turn.
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
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
