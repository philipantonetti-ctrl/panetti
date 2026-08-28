/**
 * What the AI is allowed to do on its own.
 *
 * Deliberately NOT the model's own judgement. A model asked whether it is
 * confident will say yes in exactly the cases that matter most, so the gates
 * here are mechanical: the mode a person set, the categories a person listed,
 * words the customer themselves used, and a floor under the reported
 * confidence. The model can only ever LOWER its permissions by these, never
 * raise them.
 *
 * Pure, so every gate is provable without a model or a database.
 */

export type RulesConfig = {
  /** off | draft | auto */
  mode: string
  autoCategories: string[]
  escalateKeywords: string[]
  minConfidence: number
}

export type Judgement = {
  category: string | null
  confidence: number | null
  /** Whether the model itself asked for a human. */
  wantsHuman: boolean
}

export type Verdict = {
  /** send = answer the customer. draft = suggest to an agent. escalate = hand over. */
  action: 'send' | 'draft' | 'escalate'
  /** Why, in words a person reads on the review screen. Null when it just answers. */
  reason: string | null
}

export const DEFAULT_RULES: RulesConfig = {
  mode: 'draft',
  autoCategories: [],
  escalateKeywords: [],
  minConfidence: 0.85,
}

export function decide(judgement: Judgement, text: string, rules: RulesConfig): Verdict {
  // A word the CUSTOMER used, checked before anything the model concluded: a
  // legal threat read as a friendly question must still reach a person.
  const hit = rules.escalateKeywords
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .find((k) => text.toLowerCase().includes(k))
  if (hit) return { action: 'escalate', reason: `The customer wrote "${hit}", which always goes to a person.` }

  if (judgement.wantsHuman) {
    return { action: 'escalate', reason: 'The assistant judged this one to need a person.' }
  }

  // Nothing is sent while the mode says otherwise, whatever the rest says.
  if (rules.mode === 'off') return { action: 'escalate', reason: 'The assistant is switched off.' }
  if (rules.mode !== 'auto') return { action: 'draft', reason: null }

  if (!judgement.category || !rules.autoCategories.includes(judgement.category)) {
    return {
      action: 'draft',
      reason: `"${judgement.category ?? 'uncategorised'}" is not a question the assistant may answer by itself.`,
    }
  }

  // A missing confidence is not a high one.
  if (judgement.confidence === null || judgement.confidence < rules.minConfidence) {
    return {
      action: 'draft',
      reason: `Confidence ${judgement.confidence ?? 'unknown'} is below the ${rules.minConfidence} needed to send.`,
    }
  }

  return { action: 'send', reason: null }
}
