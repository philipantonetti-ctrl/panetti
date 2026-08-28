import { describe, expect, it } from 'vitest'
import { decide, DEFAULT_RULES, type RulesConfig } from './rules'

const rules = (over: Partial<RulesConfig> = {}): RulesConfig => ({
  ...DEFAULT_RULES,
  mode: 'auto',
  autoCategories: ['shipping', 'product'],
  escalateKeywords: ['lawyer', 'compensation', 'erstatning'],
  minConfidence: 0.85,
  ...over,
})

const sure = { category: 'shipping', confidence: 0.95, wantsHuman: false }

describe('decide', () => {
  it('answers a safe question it is allowed to answer', () => {
    expect(decide(sure, 'Where is my order?', rules())).toEqual({ action: 'send', reason: null })
  })

  /**
   * The customer's own words outrank everything. A legal threat the model read
   * as a cheerful question must still reach a person, so this gate runs before
   * the model's judgement is consulted at all.
   */
  it('hands over on a word the customer used, however sure the assistant is', () => {
    const v = decide(sure, 'I am speaking to my lawyer about this', rules())
    expect(v.action).toBe('escalate')
    expect(v.reason).toMatch(/lawyer/)
  })

  it('matches those words in any language and any case', () => {
    expect(decide(sure, 'Jeg krever ERSTATNING', rules()).action).toBe('escalate')
  })

  it('hands over when the assistant itself asks for a person', () => {
    expect(decide({ ...sure, wantsHuman: true }, 'hello', rules()).action).toBe('escalate')
  })

  /**
   * Draft mode is the setting this ships in: the AI suggests and a person
   * sends. Nothing reaches a customer until someone deliberately grants it
   * more authority.
   */
  it('only ever drafts while the mode says draft', () => {
    expect(decide(sure, 'Where is my order?', rules({ mode: 'draft' }))).toEqual({ action: 'draft', reason: null })
  })

  it('does nothing at all when switched off', () => {
    expect(decide(sure, 'hi', rules({ mode: 'off' })).action).toBe('escalate')
  })

  it('drafts rather than sends for a category nobody allowed', () => {
    const v = decide({ ...sure, category: 'refund' }, 'money back please', rules())
    expect(v.action).toBe('draft')
    expect(v.reason).toMatch(/refund/)
  })

  it('drafts when it is not sure enough, and treats no confidence as not sure', () => {
    expect(decide({ ...sure, confidence: 0.6 }, 'hi', rules()).action).toBe('draft')
    expect(decide({ ...sure, confidence: null }, 'hi', rules()).action).toBe('draft')
  })

  it('ships conservative: the default settings never send', () => {
    expect(DEFAULT_RULES.mode).toBe('draft')
    expect(DEFAULT_RULES.autoCategories).toEqual([])
    expect(decide(sure, 'Where is my order?', DEFAULT_RULES).action).toBe('draft')
  })
})
