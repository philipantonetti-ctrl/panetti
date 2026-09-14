import { describe, expect, it } from 'vitest'
import { keywordsOf } from './knowledge'

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
