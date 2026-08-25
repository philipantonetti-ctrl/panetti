export const CATEGORIES = ['shipping', 'return', 'warranty', 'refund', 'product', 'other'] as const
export type Category = (typeof CATEGORIES)[number]

/**
 * Keyword rules, most specific intent first: a customer asking where their
 * REFUND is has usually also mentioned the return, and the money question is
 * the one they want answered. Word STEMS, so every inflection the shops'
 * languages produce still matches. An AI classifier can replace this whole
 * table without the ticket column changing shape.
 */
const RULES: [Category, RegExp][] = [
  ['refund', /\b(refund|refusjon|refunder|återbetal|tilbagebetal|hyvity|rückerstatt|erstattung|pengene tilbake|pengarna tillbaka)/i],
  ['return', /\b(return|retur|retour|angrerett|angre|ångra|fortryd|palaut|widerruf|rücksend|zurückschick|zurückgeben)/i],
  ['warranty', /\b(warranty|garanti|reklamasjon|reklamation|takuu|gewährleistung|defekt|broken|ødelagt|trasig|rikki|kaputt|virker ikke|fungerar inte|funktioniert nicht)/i],
  ['shipping', /\b(where is|track|shipping|delivery|deliver|levering|leverans|sendung|lieferung|toimitus|pakke|paket|paketti|sporing|spårning|sendingsnummer|transit)/i],
  ['product', /\b(how do i|how to|instruction|manual|bruksanvisning|brugsanvisning|käyttöohje|anleitung|bedienung|hvordan bruker|hur använder)/i],
]

export function categorize(subject: string, body: string): Category {
  const text = `${subject}\n${body}`
  for (const [category, rule] of RULES) if (rule.test(text)) return category
  return 'other'
}

export const LANGUAGES = ['nb', 'sv', 'da', 'fi', 'de', 'en'] as const
export type Language = (typeof LANGUAGES)[number]

/**
 * Stop-word scoring. Deliberately tiny: the mailbox's default language is
 * already a strong prior, so this only needs to be right when it speaks, and
 * it speaks only on a clear winner. Bokmål and Danish share most of their
 * short words - hei/takk against hej/tak is what separates them here - and
 * when they tie the answer is null, never a coin toss.
 */
const WORDS: Record<Language, string[]> = {
  nb: ['og', 'ikke', 'jeg', 'er', 'det', 'har', 'en', 'med', 'på', 'min', 'hei', 'takk', 'fått', 'kan', 'dere', 'pakken', 'bestilling', 'ordre'],
  sv: ['och', 'inte', 'jag', 'är', 'det', 'har', 'en', 'med', 'på', 'min', 'mitt', 'hej', 'tack', 'fått', 'kan', 'ni', 'paketet', 'paket', 'beställning'],
  da: ['og', 'ikke', 'jeg', 'er', 'det', 'har', 'en', 'med', 'på', 'min', 'hej', 'tak', 'modtaget', 'kan', 'i', 'pakke', 'pakken', 'ordre'],
  fi: ['ja', 'ei', 'en', 'olen', 'on', 'se', 'ole', 'saanut', 'hei', 'kiitos', 'voitteko', 'minun', 'että', 'pakettiani', 'paketti', 'tilaus'],
  de: ['und', 'nicht', 'ich', 'ist', 'das', 'habe', 'ein', 'mit', 'auf', 'mein', 'meine', 'hallo', 'danke', 'erhalten', 'können', 'sie', 'paket', 'bestellung'],
  en: ['and', 'not', 'i', 'is', 'the', 'have', 'a', 'with', 'on', 'my', 'hello', 'thanks', 'received', 'can', 'you', 'package', 'order', 'please'],
}

export function detectLanguage(text: string): Language | null {
  const tokens = text.toLowerCase().match(/[a-zæøåäöüß]+/g) ?? []
  if (tokens.length < 3) return null
  const scores = LANGUAGES.map((lang) => {
    const set = new Set(WORDS[lang])
    return { lang, score: tokens.filter((t) => set.has(t)).length }
  }).sort((a, b) => b.score - a.score)
  const [best, second] = scores
  return best.score >= 2 && best.score > second.score ? best.lang : null
}
