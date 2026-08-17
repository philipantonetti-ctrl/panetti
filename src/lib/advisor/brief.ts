import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { CollectedFacts } from './collect'
import type { Fact } from './types'

/**
 * Turning facts into a briefing.
 *
 * The model is given figures that are already computed and asked ONLY to rank
 * and explain them. It is never asked to derive one, and it is not trusted to
 * have resisted: an item citing a fact id it was not given is dropped before
 * anything is stored, and the interface prints figures from the facts rather
 * than from the prose.
 */

export const ADVISOR_MODEL = 'claude-opus-5'

export const BriefItemSchema = z.object({
  headline: z.string().min(1),
  why: z.string().min(1),
  factIds: z.array(z.string()),
  severity: z.enum(['high', 'medium', 'low']),
  action: z.string().nullable(),
})
export const BriefPayloadSchema = z.object({ items: z.array(BriefItemSchema) })

export type BriefItem = z.infer<typeof BriefItemSchema>

/**
 * Hand-written rather than generated from the zod schema above.
 *
 * The SDK ships a zodOutputFormat helper, and it is bound to the zod version
 * the SDK bundles; this project is on zod v4 and uses it everywhere else. One
 * small literal schema is cheaper than that coupling.
 */
const BRIEF_JSON_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          headline: { type: 'string', minLength: 1 },
          why: { type: 'string', minLength: 1 },
          factIds: { type: 'array', items: { type: 'string' } },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          action: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['headline', 'why', 'factIds', 'severity', 'action'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const

const SYSTEM_PROMPT = `You advise the owner of a group of regional WooCommerce shops
(Panetti, Mazzetti, Massasjepistoler, Bellino) trading in Norway, Sweden, Denmark,
Finland and Germany. He reads this once, early, before the working day.

You are given FACTS that have already been computed from his accounting data. Each
one has an id, what it is about, the figure now, the figure over the previous equal
period, and a severity between 0 and 1.

Your job is to decide what deserves his attention, in what order, and to say why.

Rules:
- Never state a figure that is not in the facts you were given. You cannot compute.
- Do not put numbers in "headline" or "why" — the interface prints them from the
  facts, beneath your words. Refer to direction and cause instead: "fell sharply",
  "in step with advertising efficiency".
- Cite every fact an item rests on in factIds. An item citing an id you were not
  given is discarded.
- Combine facts that describe one story into one item. Revenue falling and ROAS
  falling in the same shop in the same week is one item, not two.
- "action" is what he should do. Set it to null when there is nothing to do; do not
  invent advice to fill the field.
- Order items so the most consequential is first.
- Data-quality facts mean a number on his dashboard cannot yet be trusted. Say that
  plainly — it outranks a move he can see for himself.
- A REORDER_DUE fact means a product has reached the date it must be ordered by if it
  is to arrive before the shelf empties. Its figure is how many to order, already at
  the supplier's minimum. Combine them into one item and put the order in "action".
- Write plainly. No preamble, no encouragement, no exclamation marks.`

/** What a briefing generator does. A function so tests can pass a stub. */
export type BriefingModel = (
  collected: CollectedFacts,
) => Promise<{ items: BriefItem[]; model: string }>

/**
 * The real one, or null when no key is configured — which is a state the page
 * shows plainly rather than an error it throws.
 */
export function anthropicModel(): BriefingModel | null {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null

  // The SDK's default timeout for this model/token combination is 600s, with
  // 2 retries on top — nearly 30 minutes against a 300s platform ceiling.
  // Bounded well under that ceiling, and one retry rather than the default
  // two, so an overloaded model fails inside the window write.ts still has
  // left to record the error, rather than the platform killing it first.
  const client = new Anthropic({ apiKey, timeout: 240_000, maxRetries: 1 })

  return async (collected) => {
    const res = await client.messages.create({
      model: ADVISOR_MODEL,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM_PROMPT }],
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: BRIEF_JSON_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            window: {
              from: collected.from.toISOString().slice(0, 10),
              to: collected.to.toISOString().slice(0, 10),
            },
            facts: collected.facts,
          }),
        },
      ],
    })

    // Checked BEFORE reading content: a refusal returns HTTP 200 with an empty
    // or partial content array, and indexing it blindly would throw.
    if (res.stop_reason === 'refusal') {
      throw new Error('The model declined to write this briefing.')
    }

    const text = res.content.find((b) => b.type === 'text')
    if (!text || text.type !== 'text') throw new Error('The model returned no text.')

    const payload = BriefPayloadSchema.parse(JSON.parse(text.text))
    return { items: payload.items, model: ADVISOR_MODEL }
  }
}

/**
 * Drop anything resting on a fact that was never computed.
 *
 * This is the load-bearing check. Without it, a fluent sentence about a number
 * nobody derived would be stored and shown exactly like a true one.
 */
export function validateItems(items: BriefItem[], facts: Fact[]): BriefItem[] {
  const known = new Set(facts.map((f) => f.id))
  return items.filter((item) => item.factIds.length > 0 && item.factIds.every((id) => known.has(id)))
}

export type GeneratedBrief = {
  items: BriefItem[] | null
  model: string | null
  error: string | null
}

export async function generateBrief(
  collected: CollectedFacts,
  model: BriefingModel | null,
): Promise<GeneratedBrief> {
  // A quiet week is a real answer, and it costs nothing to give.
  if (collected.facts.length === 0) return { items: [], model: null, error: null }

  if (!model) {
    return {
      items: null,
      model: null,
      error: 'No ANTHROPIC_API_KEY is configured, so no briefing could be written.',
    }
  }

  try {
    const result = await model(collected)
    return { items: validateItems(result.items, collected.facts), model: result.model, error: null }
  } catch (e) {
    // Stored, never thrown: the facts are still worth showing, and a silent
    // failure would look exactly like a quiet week.
    return { items: null, model: null, error: e instanceof Error ? e.message : String(e) }
  }
}
