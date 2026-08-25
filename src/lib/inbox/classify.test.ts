import { describe, expect, it } from 'vitest'
import { categorize, detectLanguage, CATEGORIES, LANGUAGES } from './classify'

describe('categorize', () => {
  it("reads the customer's intent from subject and body in the shops' languages", () => {
    expect(categorize('Hvor er pakken min?', '')).toBe('shipping')
    expect(categorize('', 'Where is my order, it says in transit')).toBe('shipping')
    expect(categorize('Retur', 'Jeg vil returnere stolen')).toBe('return')
    expect(categorize('Widerruf', 'Ich möchte die Bestellung zurückschicken')).toBe('return')
    expect(categorize('Reklamasjon', 'Massasjepistolen er ødelagt')).toBe('warranty')
    expect(categorize('Garanti', 'Stolen er defekt etter 2 måneder')).toBe('warranty')
    expect(categorize('Refusjon', 'Når får jeg pengene tilbake?')).toBe('refund')
    expect(categorize('Rückerstattung', '')).toBe('refund')
    expect(categorize('Bruksanvisning', 'Hvordan bruker jeg varmefunksjonen?')).toBe('product')
    expect(categorize('How do I', 'set up the massage chair')).toBe('product')
  })
  it('says other, never guesses, when no rule fires', () => {
    expect(categorize('Hello', 'Just saying thanks!')).toBe('other')
  })
  it('a refund question about a return is a refund question', () => {
    expect(categorize('', 'I returned the chair last week, when is my refund coming?')).toBe('refund')
  })
  it('exports the category list the UI filters on', () => {
    expect(CATEGORIES).toEqual(['shipping', 'return', 'warranty', 'refund', 'product', 'other'])
  })
})

describe('detectLanguage', () => {
  it('tells the six languages apart on ordinary support sentences', () => {
    expect(detectLanguage('Hei! Jeg har ikke fått pakken min. Takk')).toBe('nb')
    expect(detectLanguage('Hej! Jag har inte fått mitt paket. Tack')).toBe('sv')
    expect(detectLanguage('Hej! Jeg har ikke modtaget min pakke. Tak')).toBe('da')
    expect(detectLanguage('Hei! En ole saanut pakettiani. Kiitos')).toBe('fi')
    expect(detectLanguage('Hallo! Ich habe mein Paket nicht erhalten. Danke')).toBe('de')
    expect(detectLanguage('Hello! I have not received my package. Thanks')).toBe('en')
  })
  it('returns null rather than a guess on a tie or too little text', () => {
    expect(detectLanguage('ok')).toBeNull()
    expect(detectLanguage('#1042')).toBeNull()
  })
  it('exports the language list', () => {
    expect(LANGUAGES).toEqual(['nb', 'sv', 'da', 'fi', 'de', 'en'])
  })
})
