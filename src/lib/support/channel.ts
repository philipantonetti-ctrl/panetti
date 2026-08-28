import { customerContext, type CustomerContext } from '@/lib/inbox/context'

/**
 * The seam between the AI and whatever carries the conversation.
 *
 * Philip's requirement, in his own words: the AI must not be hard coded around
 * Gorgias. So the brain only ever sees this interface, and Gorgias is one
 * implementation of it. Replacing the helpdesk means writing a second adapter
 * and changing one line of wiring; the AI, the knowledge base, the rules and
 * the whole history are untouched.
 *
 * Nothing below this file mentions Gorgias. Nothing above it should either.
 */

/** One inbound message, as any channel would describe it. */
export type IncomingMessage = {
  /** The channel's own id for the conversation, so replies can find it. */
  conversationId: string
  customerEmail: string | null
  customerName: string | null
  /** What the customer actually wrote, plain text. */
  text: string
  subject: string | null
  /** email, chat, instagram-direct-message, whatever the channel calls it. */
  via: string | null
}

export type Channel = {
  /** The channel's name, for the record. */
  name: string
  /** Answer the customer, through the channel they wrote in on. */
  sendMessage(conversationId: string, text: string): Promise<void>
  /**
   * Leave a note only the agents can see. This is how the AI hands a
   * conversation to a human: summary, reason, and a suggested reply.
   */
  addInternalNote(conversationId: string, text: string): Promise<void>
}

/**
 * Everything we know about the person who wrote in.
 *
 * The same function our own screens and the Gorgias sidebar use, so the AI
 * cannot be told a different story about an order than the humans are.
 */
export function getCustomerContext(email: string): Promise<CustomerContext> {
  return customerContext(email, '')
}

/**
 * Hand this conversation to a person, with everything they need to pick it up
 * without reading the thread from the start.
 *
 * A note rather than a reply, always: escalation must never put words in front
 * of a customer.
 */
export async function escalateToHuman(
  channel: Channel,
  conversationId: string,
  reason: string,
  summary: string,
  suggestedReply: string | null,
): Promise<void> {
  const parts = [
    'Handed over by the assistant.',
    '',
    `Why: ${reason}`,
    '',
    `What happened: ${summary}`,
  ]
  if (suggestedReply) {
    parts.push('', 'Suggested reply (not sent, edit before use):', suggestedReply)
  }
  await channel.addInternalNote(conversationId, parts.join('\n'))
}
