/**
 * What a customer types when they mean an order, in the languages the shops
 * trade in. The number itself is 3-7 digits: shop numbers run #1000-#99999
 * today, and anything longer is a parcel or a phone.
 */
const ORDER_WORD =
  /(?:#|\b(?:order|ordre|ordrenummer|ordrenr|bestilling|bestillingsnummer|beställning|beställningsnummer|ordernummer|bestellung|bestellnummer|tilaus|tilausnumero)\b[\s:.#-]*)(\d{3,7})\b/gi

const B2B_NUMBER = /\bB-\d{4,}\b/g

export function orderNumbersIn(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(ORDER_WORD)) found.add(m[1])
  for (const m of text.matchAll(B2B_NUMBER)) found.add(m[0])
  return [...found]
}

/**
 * Bring's 18-digit numbers start 373 (the shape lib/bring already matches);
 * DHL Express is JJD + digits. A generic 14-20 digit run covers the rest of
 * Bring's range without swallowing 8-12 digit phones.
 */
const TRACKING = /\b(?:373\d{15}|JJD\d{15,22}|\d{14,20})\b/g

export function trackingNumbersIn(text: string): string[] {
  return [...new Set([...text.matchAll(TRACKING)].map((m) => m[0]))]
}

/** Digits only, with a 00 international prefix folded into a plus-less country code. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.startsWith('00') ? digits.slice(2) : digits
}

/**
 * A phone is 8-12 digits once the spaces come out, optionally led by + or 00.
 * The run is matched WITH its separators so "912 34 567" is one number, not
 * three, and then normalised.
 *
 * The trailing \b only guards the END of a match: scanning a 18-digit parcel
 * number, the engine happily starts twelve digits from its end and "finds" a
 * phone inside it. So a match whose preceding character is a digit is part of
 * a longer run and no phone — and one preceded by # is an order number.
 */
const PHONE = /(?:\+|00)?\d(?:[\s.-]?\d){7,11}\b/g

export function phonesIn(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(PHONE)) {
    const before = m.index !== undefined ? (text[m.index - 1] ?? '') : ''
    if (/[\d#]/.test(before)) continue
    const n = normalizePhone(m[0])
    if (n.length >= 8 && n.length <= 12) found.add(n)
  }
  return [...found]
}
