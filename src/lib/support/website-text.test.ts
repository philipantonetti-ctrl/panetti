import { describe, expect, it } from 'vitest'
import { CHUNK_MAX, sectionsOf, stripShortcodes, textOf } from './website-text'

describe('stripShortcodes', () => {
  it('removes theme shortcodes with and without attributes, opening and closing', () => {
    const html = '[ux_banner height=&#8221;250px&#8243; bg=&#8221;554&#8243;] [text_box position_x=&#8221;50&#8243;] Massgestol - FAQ [/text_box] [/ux_banner]'
    expect(textOf(stripShortcodes(html))).toBe('Massgestol - FAQ')
  })

  it('leaves ordinary square brackets in prose alone', () => {
    expect(stripShortcodes('Fits pans up to 30 cm [tested].')).toBe('Fits pans up to 30 cm [tested].')
  })
})

describe('textOf', () => {
  it('drops tags, decodes entities and collapses whitespace', () => {
    expect(textOf('<p class="p1">Nyt fersk hjemmelaget pasta &amp; mer &#8211; når du &oslash;nsker.</p>\n\n<p>  Enkel.</p>'))
      .toBe('Nyt fersk hjemmelaget pasta & mer - når du ønsker. Enkel.')
  })
})

describe('sectionsOf', () => {
  const para = (n: number) => `<p>${'Ord '.repeat(n).trim()}</p>`

  it('splits on headings, keeping the heading with its text', () => {
    const html = `<p>Intro text that is long enough to keep, about the ProMix kitchen machine.</p><h2>Hva følger med</h2>${para(20)}<h3>Bruk</h3>${para(20)}`
    const s = sectionsOf(html)
    expect(s.map((x) => x.heading)).toEqual([null, 'Hva følger med', 'Bruk'])
    expect(s[1].text.startsWith('Ord Ord')).toBe(true)
  })

  it('splits a long section at paragraph boundaries so no chunk passes the ceiling', () => {
    const html = `<h2>Long</h2>${para(120)}${para(120)}${para(120)}${para(120)}`
    const s = sectionsOf(html)
    expect(s.length).toBeGreaterThan(1)
    for (const x of s) {
      expect(x.text.length).toBeLessThanOrEqual(CHUNK_MAX)
      expect(x.heading).toBe('Long')
    }
  })

  it('drops a section too short to say anything', () => {
    expect(sectionsOf('<h2>Ok</h2><p>Yes.</p>')).toEqual([])
  })

  it('cleans shortcodes inside the sections', () => {
    const s = sectionsOf('<h2>Villkor</h2>[row][col span__sm="12"]<p>Inledning Detta köp regleras av nedanstående standardvillkor för distansförsäljning.</p>[/col][/row]')
    expect(s[0].text).toBe('Inledning Detta köp regleras av nedanstående standardvillkor för distansförsäljning.')
  })
})
