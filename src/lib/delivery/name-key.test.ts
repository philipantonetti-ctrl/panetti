import { describe, expect, it } from 'vitest'
import { nameKey } from './name-key'

describe('nameKey', () => {
  it('folds case, accents, punctuation and word order', () => {
    expect(nameKey('Röthke, Martin')).toBe('martin rothke')
    expect(nameKey('martin ROTHKE')).toBe('martin rothke')
    expect(nameKey('  Anitta   Airi ')).toBe('airi anitta')
    expect(nameKey('Jörg Schladweiler')).toBe('jorg schladweiler')
    expect(nameKey('Rei’tetty Pizzalapio')).toBe('pizzalapio rei tetty')
  })
  it('maps the letters NFD cannot decompose', () => {
    expect(nameKey('Søren Ø. Kjærgaard')).toBe('kjaergaard o soren')
    expect(nameKey('Großmann Straße')).toBe('grossmann strasse')
    expect(nameKey('Łukasz Đorđević')).toBe('dordevic lukasz')
  })
  it('keeps digits and gives an empty key for nothing', () => {
    expect(nameKey('Firma 24 GmbH')).toBe('24 firma gmbh')
    expect(nameKey('')).toBe('')
    expect(nameKey('   ')).toBe('')
    expect(nameKey('---')).toBe('')
    expect(nameKey(null)).toBe('')
    expect(nameKey(undefined)).toBe('')
  })
})
