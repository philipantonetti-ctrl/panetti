import { describe, expect, it, vi } from 'vitest'
import type { Fact } from './types'
import { generateBrief, validateItems, type BriefItem } from './brief'

const fact = (id: string): Fact => ({
  id,
  kind: 'REVENUE_MOVE',
  shopId: 'shop_se',
  shopName: 'Panetti Sweden',
  subject: null,
  current: 820_000,
  previous: 1_000_000,
  deltaPct: -0.18,
  unit: 'money',
  severity: 0.4,
  currency: 'USD',
})

const item = (over: Partial<BriefItem>): BriefItem => ({
  headline: 'Sweden revenue is down',
  why: 'Advertising efficiency fell over the same week.',
  factIds: ['revenue:shop_se'],
  severity: 'high',
  action: 'Check the Meta campaign that changed.',
  ...over,
})

describe('validateItems', () => {
  it('keeps an item whose facts all exist', () => {
    expect(validateItems([item({})], [fact('revenue:shop_se')])).toHaveLength(1)
  })

  it('drops an item that cites a fact it was never given', () => {
    // The one defence against a plausible sentence about a number nobody computed.
    expect(validateItems([item({ factIds: ['revenue:invented'] })], [fact('revenue:shop_se')])).toEqual([])
  })

  it('drops an item citing no facts at all', () => {
    expect(validateItems([item({ factIds: [] })], [fact('revenue:shop_se')])).toEqual([])
  })

  it('keeps an item that cites one real fact among several', () => {
    const kept = validateItems([item({ factIds: ['revenue:shop_se', 'roas:shop_se'] })], [
      fact('revenue:shop_se'),
      fact('roas:shop_se'),
    ])
    expect(kept).toHaveLength(1)
  })

  it('drops an item that mixes a real fact with an invented one', () => {
    // The whole game. An item resting on one real figure and one nobody
    // computed is not partly true — it is a fabricated number wearing a
    // citation. `every`, not `some`, is what makes that impossible.
    expect(
      validateItems([item({ factIds: ['revenue:shop_se', 'revenue:invented'] })], [fact('revenue:shop_se')]),
    ).toEqual([])
  })
})

describe('generateBrief', () => {
  const collected = { from: new Date('2026-08-03'), to: new Date('2026-08-09'), facts: [fact('revenue:shop_se')] }

  it('returns validated items and the model that wrote them', async () => {
    const model = vi.fn().mockResolvedValue({ items: [item({})], model: 'claude-opus-5' })
    const result = await generateBrief(collected, model)
    expect(result.items).toHaveLength(1)
    expect(result.model).toBe('claude-opus-5')
    expect(result.error).toBeNull()
  })

  it('drops invented facts before storing anything', async () => {
    const model = vi.fn().mockResolvedValue({ items: [item({ factIds: ['nope'] })], model: 'claude-opus-5' })
    const result = await generateBrief(collected, model)
    expect(result.items).toEqual([])
    expect(result.error).toBeNull()
  })

  it('reports a model failure as an error rather than throwing', async () => {
    const model = vi.fn().mockRejectedValue(new Error('529 overloaded'))
    const result = await generateBrief(collected, model)
    expect(result.items).toBeNull()
    expect(result.error).toContain('529 overloaded')
  })

  it('says so plainly when there is no model configured at all', async () => {
    const result = await generateBrief(collected, null)
    expect(result.items).toBeNull()
    expect(result.error).toContain('ANTHROPIC_API_KEY')
  })

  it('does not call the model when nothing moved', async () => {
    const model = vi.fn()
    const result = await generateBrief({ ...collected, facts: [] }, model)
    expect(model).not.toHaveBeenCalled()
    expect(result.items).toEqual([])
    expect(result.error).toBeNull()
  })
})
