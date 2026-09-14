import { describe, expect, it } from 'vitest'
import { keywordsOf, summariseKnowledge } from './knowledge'

/**
 * The customer's words, as retrieval matches them. A Nordic noun changes its
 * ending with every use (pizzaovn, pizzaovnen, pizzaovnene), and a product
 * page says "450 °C" where the customer says "grader", so the word has to
 * be cut back to the part that survives inflection before it is looked for.
 */
describe('keywordsOf', () => {
  it('cuts a definite or plural ending off, so the customer\'s form finds the page\'s form', () => {
    expect(keywordsOf('Hvor mange grader kan pizzaovnen gå opp til?')).toEqual(['hvor', 'mange', 'grad', 'pizzaovn'])
  })

  it('cuts "the oven" down to the three letters that sit inside "pizzaovn"', () => {
    // The customer says ovnen, ugnen, uunin; the product is a pizzaovn, a
    // pizzaugn, a pizzauuni. The head noun is three letters in two of those
    // languages, so a stem may be three letters; a whole word still needs four.
    expect(keywordsOf('Blir ovnen varm?')).toEqual(['blir', 'ovn', 'varm'])
    expect(keywordsOf('Hur varm blir ugnen?')).toEqual(['varm', 'blir', 'ugn'])
  })

  it('cuts one ending only, and the longest that fits', () => {
    expect(keywordsOf('pizzaovnene ugnarna Pizzaöfen')).toEqual(['pizzaovn', 'ugn', 'pizzaöf'])
  })

  it('still drops the stop words and repeats', () => {
    expect(keywordsOf('Hei! Jeg har ikke fått pakken, pakken mangler')).toEqual(['fått', 'pakk', 'mangl'])
  })
})

/**
 * The "Used" line on the practice page. A page is stored as many sections
 * and each was listed on its own, so one answer showed the same product
 * fourteen times. Grouped by page, with a count, in the order first seen.
 */
describe('summariseKnowledge', () => {
  const row = (kind: string, title: string, body: string, sourceKey: string | null, source = 'website') =>
    ({ kind, title, body, source, sourceUrl: null, sourceKey })

  it('groups a page\'s sections under the page, counted, and leaves a manual row as it is', () => {
    const out = summariseKnowledge([
      row('example', 'Hvor lang tid tager levering?', 'To dage.', null, 'manual'),
      row('product', 'Panetti Pizzetta Pro - Elektrisk pizzaovn', 'Product: Panetti Pizzetta Pro - Elektrisk pizzaovn (SKU PANPIZPRO)\nPage: https://panetti.dk/p/\n\nDel 0.', 'website:s:product:11173:0'),
      row('product', 'Panetti Pizzetta Pro - Elektrisk pizzaovn - 4 varmeelementer', 'Product: Panetti Pizzetta Pro - Elektrisk pizzaovn (SKU PANPIZPRO)\nPage: https://panetti.dk/p/\n\nDel 5.', 'website:s:product:11173:5'),
      row('policy', 'Villkor - Fragt:', 'Page: https://panetti.dk/villkor/\n\nFragt.', 'website:s:page:7661:5'),
      row('policy', 'Villkor - Fortrydelsesret:', 'Page: https://panetti.dk/villkor/\n\nFortryd.', 'website:s:page:7661:6'),
      row('product', 'Panetti PrimoChef - Smart køkkenassistent - FAQ', 'Product: Panetti PrimoChef - Smart køkkenassistent (SKU PANPRICHE)\nPage: https://panetti.dk/c/\n\nFAQ.', 'website:s:product:10101:9'),
    ])
    expect(out).toEqual([
      { kind: 'example', title: 'Hvor lang tid tager levering?', source: 'manual', sections: 1 },
      { kind: 'product', title: 'Panetti Pizzetta Pro - Elektrisk pizzaovn', source: 'website', sections: 2 },
      { kind: 'policy', title: 'Villkor', source: 'website', sections: 2 },
      { kind: 'product', title: 'Panetti PrimoChef - Smart køkkenassistent', source: 'website', sections: 1 },
    ])
  })
})
