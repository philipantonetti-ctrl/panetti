import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Fact } from './types'
import { describeFailure, generateBrief, validateItems, type BriefItem } from './brief'

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

// generateBrief logs every failure, which is the point of it - but several
// tests here fail the model on purpose, and their stderr is not a finding.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
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
    // computed is not partly true - it is a fabricated number wearing a
    // citation. `every`, not `some`, is what makes that impossible.
    expect(
      validateItems([item({ factIds: ['revenue:shop_se', 'revenue:invented'] })], [fact('revenue:shop_se')]),
    ).toEqual([])
  })
})

/**
 * The shape the Anthropic SDK throws: the parsed body hangs off `error`, and
 * the request id is the only handle support can trace a failure by.
 */
const apiError = (over: Record<string, unknown> = {}) =>
  Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Invalid request data"},"request_id":"req_011Ce7jTJaTjz33YEBYvR3VY"}'), {
    status: 400,
    error: {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Invalid request data' },
      request_id: 'req_011Ce7jTJaTjz33YEBYvR3VY',
    },
    ...over,
  })

describe('describeFailure', () => {
  /**
   * Written after a live 400 nobody could explain. The stored text was the raw
   * JSON body, which says everything except the three things worth having.
   */
  it('keeps the status, the kind of failure and the request id', () => {
    const text = describeFailure(apiError())
    expect(text).toContain('400')
    expect(text).toContain('invalid_request_error')
    expect(text).toContain('req_011Ce7jTJaTjz33YEBYvR3VY')
  })

  it('keeps what the API actually said', () => {
    expect(describeFailure(apiError())).toContain('Invalid request data')
  })

  /**
   * The point of the exercise. A JSON blob on the page is an unanswerable
   * question rather than a thing to fix - the same rule this file already
   * applies to a raw WooCommerce error.
   */
  it('is one readable line, not the raw body', () => {
    const text = describeFailure(apiError())
    expect(text).not.toContain('{')
    expect(text.split('\n')).toHaveLength(1)
  })

  it('reads sensibly when there is no request id to quote', () => {
    const text = describeFailure(
      Object.assign(new Error('529 overloaded'), {
        status: 529,
        error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      }),
    )
    expect(text).toContain('529')
    expect(text).toContain('overloaded_error')
    expect(text).not.toContain('undefined')
  })

  it('falls back to the message of an ordinary error', () => {
    expect(describeFailure(new Error('socket hang up'))).toBe('socket hang up')
  })

  it('survives something that is not an Error at all', () => {
    expect(describeFailure('boom')).toBe('boom')
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

  it('stores the request id, so a failure can be traced instead of guessed at', async () => {
    const model = vi.fn().mockRejectedValue(apiError())
    const result = await generateBrief(collected, model)
    expect(result.error).toContain('req_011Ce7jTJaTjz33YEBYvR3VY')
    expect(result.error).not.toContain('{')
  })

  /**
   * The stored line is deliberately short, which means the detail has to live
   * somewhere. A failure nobody can debug afterwards is how one 400 cost an
   * afternoon.
   */
  it('logs the whole error where the platform will keep it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const thrown = apiError()
    await generateBrief(collected, vi.fn().mockRejectedValue(thrown))
    expect(logged).toHaveBeenCalledWith('advisor briefing failed', thrown)
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
