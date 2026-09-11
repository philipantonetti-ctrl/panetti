import { describe, expect, it } from 'vitest'
import { chatInstructions, judgeMessages, SYSTEM, type Turn } from './agent'
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
