import { describe, expect, it } from 'vitest'
import { parseReply } from './format'

describe('parseReply', () => {
  it('keeps plain prose as one paragraph', () => {
    expect(parseReply('Revenue fell 12% last week.')).toEqual([
      { kind: 'para', spans: [{ text: 'Revenue fell 12% last week.', bold: false }] },
    ])
  })

  it('reads emphasis rather than printing the stars', () => {
    const [block] = parseReply('Order **600 units** by Friday.')
    expect(block).toEqual({
      kind: 'para',
      spans: [
        { text: 'Order ', bold: false },
        { text: '600 units', bold: true },
        { text: ' by Friday.', bold: false },
      ],
    })
  })

  it('groups consecutive dashes into one list', () => {
    const blocks = parseReply('Two products:\n- Pizzaspade\n- Pizzaovntrekk\n\nBoth run out in winter.')
    expect(blocks.map((b) => b.kind)).toEqual(['para', 'bullets', 'para'])
    expect(blocks[1]).toMatchObject({
      items: [
        [{ text: 'Pizzaspade', bold: false }],
        [{ text: 'Pizzaovntrekk', bold: false }],
      ],
    })
  })

  /**
   * A markdown table in a 380px panel arrives as a wall of pipes. The prompt
   * asks for none, but a model is not a promise, so a row that slips through
   * is turned into a readable line instead of being shown raw.
   */
  it('turns a table row into a readable line and drops the divider', () => {
    const blocks = parseReply('| Product | Stock |\n|---|---|\n| Pizzaspade | 1,168 |')
    expect(blocks).toEqual([
      {
        kind: 'para',
        spans: [{ text: 'Product · Stock\nPizzaspade · 1,168', bold: false }],
      },
    ])
  })

  it('reads a heading as its own emphasised line', () => {
    expect(parseReply('## What to order')).toEqual([
      { kind: 'para', spans: [{ text: 'What to order', bold: true }] },
    ])
  })

  it('is empty for nothing', () => {
    expect(parseReply('')).toEqual([])
    expect(parseReply('   \n\n  ')).toEqual([])
  })
})
