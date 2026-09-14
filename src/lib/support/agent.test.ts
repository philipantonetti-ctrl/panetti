import { afterEach, describe, expect, it, vi } from 'vitest'

const create = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create }
  },
}))

const { chatInstructions, judgeMessages, pickProducts, SYSTEM } = await import('./agent')
type Turn = import('./agent').Turn
import type { CustomerContext } from '@/lib/inbox/context'

/** The prompt pieces a chat turn adds, proven without a model in the room. */

const nobody: CustomerContext = { customer: null, orders: [], previousTickets: [] }

describe('chatInstructions', () => {
  it('asks for short chat answers and to hand over on request, every time', () => {
    const text = chatInstructions({ firstReply: false, customerKnown: true })
    expect(text).toMatch(/live chat/i)
    expect(text).toMatch(/few short sentences/i)
    expect(text).toMatch(/asks for a person/i)
  })

  it('says who it is only on the first reply', () => {
    expect(chatInstructions({ firstReply: true, customerKnown: true })).toMatch(/Panetti's assistant/)
    expect(chatInstructions({ firstReply: false, customerKnown: true })).not.toMatch(/Panetti's assistant/)
  })

  it('asks for the order number and email when it holds no orders', () => {
    expect(chatInstructions({ firstReply: false, customerKnown: false })).toMatch(/order number and the email/i)
    expect(chatInstructions({ firstReply: false, customerKnown: true })).not.toMatch(/order number and the email/i)
  })
})

describe('judgeMessages', () => {
  it('sends one user message when there is no history, as before', () => {
    const msgs = judgeMessages({ message: 'Hvor er pakken?', subject: 'Pakke', context: nobody, knowledge: [] })
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(String(msgs[0].content)).toContain('CUSTOMER CONTEXT')
    expect(String(msgs[0].content)).toContain('(subject: Pakke)')
    expect(String(msgs[0].content)).toContain('Hvor er pakken?')
  })

  it('replays the conversation as alternating turns, facts first, the new message last', () => {
    const history: Turn[] = [
      { role: 'user', text: 'Hej' },
      { role: 'assistant', text: 'Hej! Jeg er Panettis assistent.' },
    ]
    const msgs = judgeMessages({ message: 'Hvor er min ordre 14689?', subject: null, context: nobody, knowledge: [], history })
    expect(msgs.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user'])
    expect(String(msgs[0].content)).toContain('KNOWLEDGE BASE')
    expect(String(msgs[0].content)).toContain('CONVERSATION SO FAR')
    expect(msgs[1].content).toBe('Hej')
    expect(msgs[2].content).toBe('Hej! Jeg er Panettis assistent.')
    expect(String(msgs[3].content)).toContain('Hvor er min ordre 14689?')
  })
})

describe('the system prompt', () => {
  it('lets the assistant state product facts from website rows, and never a price or stock', () => {
    expect(SYSTEM).toContain('Product facts (what a product is, does, includes, fits, how it is used) also')
    expect(SYSTEM).toContain('rows marked "from <shop>" are the shop\'s own product pages')
    expect(SYSTEM).toContain('Never state a price or whether something is in stock')
    expect(SYSTEM).toContain('give the Page link from the row')
  })
})

/**
 * Which product the customer means, asked of the model when the words do
 * not say. What is proven here is the contract: it reads the tool call,
 * keeps only keys it was given, and never throws into a live chat.
 */
describe('pickProducts', () => {
  const products = [
    { key: 'website:s:product:1', name: 'Panetti Pizzetta Pro - Elektrisk pizzaovn (SKU PANPIZPRO)' },
    { key: 'website:s:product:2', name: 'Panetti PrimoChef - Smart køkkenassistent (SKU PANPRICHE)' },
  ]
  afterEach(() => { create.mockReset(); vi.unstubAllEnvs() })

  it('shows the model the question and the list, and returns the keys it picked, only ones it was given', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    create.mockResolvedValue({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'products', input: { keys: ['website:s:product:1', 'made-up'] } }] })

    const keys = await pickProducts('Hvor mange grader kan ovnen komme opp til?', products)

    expect(keys).toEqual(['website:s:product:1'])
    const req = create.mock.calls[0][0]
    expect(req.model).toBe('claude-haiku-4-5-20251001')
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'products' })
    const text = JSON.stringify(req.messages)
    expect(text).toContain('Hvor mange grader kan ovnen komme opp til?')
    expect(text).toContain('website:s:product:1: Panetti Pizzetta Pro - Elektrisk pizzaovn (SKU PANPIZPRO)')
    expect(JSON.stringify(req.system)).toMatch(/the oven, the machine, the chair/)
  })

  it('picks nothing when there is no key, when the model fails, or when it answers with no tool call', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    expect(await pickProducts('Hvor er ovnen?', products)).toEqual([])
    expect(create).not.toHaveBeenCalled()

    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    create.mockRejectedValue(new Error('timeout'))
    expect(await pickProducts('Hvor er ovnen?', products)).toEqual([])
    create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'none' }] })
    expect(await pickProducts('Hvor er ovnen?', products)).toEqual([])
  })

  it('asks nothing when the shop has no product pages', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    expect(await pickProducts('Hvor er ovnen?', [])).toEqual([])
    expect(create).not.toHaveBeenCalled()
  })
})
