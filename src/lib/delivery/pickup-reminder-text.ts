/**
 * The words of the pickup reminder, in the customer's language.
 *
 * Plain text on purpose: sendEmail sends TextBody only, and a plain message
 * from a shop reads like a person wrote it, which is what gets a parcel
 * collected. No offer, no review request, nothing to sell: that is what keeps
 * it a service message rather than marketing in every country we ship to.
 *
 * The pickup code is NOT in it and cannot be: Bring stopped showing it to
 * senders in April 2025. The customer already has it in Bring's own message,
 * so the reminder points there.
 */

export type ReminderLanguage = 'nb' | 'sv' | 'da' | 'fi' | 'de' | 'en'

const BY_COUNTRY: Record<string, ReminderLanguage> = {
  NO: 'nb',
  SE: 'sv',
  AX: 'sv',
  DK: 'da',
  FI: 'fi',
  DE: 'de',
  AT: 'de',
  CH: 'de',
}

/** The language a customer in this country reads. English when we cannot tell. */
export function languageFor(country: string | null | undefined): ReminderLanguage {
  return BY_COUNTRY[(country ?? '').trim().toUpperCase()] ?? 'en'
}

const LOCALE: Record<ReminderLanguage, string> = {
  nb: 'nb-NO',
  sv: 'sv-SE',
  da: 'da-DK',
  fi: 'fi-FI',
  de: 'de-DE',
  en: 'en-GB',
}

export type ReminderInput = {
  language: ReminderLanguage
  /** The shop's brand as the customer knows it: "Panetti", "Mazzetti". */
  brand: string
  /** The customer's first name, or null to greet without one. */
  firstName: string | null
  orderNumber: string
  trackingUrl: string
  /** When the parcel reached the pickup point. */
  arrivedAt: Date
  /** The shop's timezone, so "since 28 September" is the customer's 28th. */
  timeZone: string
}

type Words = {
  subject: (brand: string) => string
  hello: (name: string | null) => string
  waiting: (brand: string, order: string, date: string) => string
  collect: string
  code: string
  track: string
  regards: string
}

const WORDS: Record<ReminderLanguage, Words> = {
  nb: {
    subject: (b) => `Pakken din fra ${b} venter på hentestedet`,
    hello: (n) => (n ? `Hei ${n},` : 'Hei,'),
    waiting: (b, o, d) => `Pakken din fra ${b} (ordre ${o}) har ligget klar på hentestedet siden ${d}.`,
    collect: 'Husk å hente den snart. Pakker som ikke hentes i tide, blir sendt i retur til oss.',
    code: 'Hentested og hentekode finner du i meldingen fra Posten/Bring eller i Posten-appen.',
    track: 'Spor pakken',
    regards: 'Vennlig hilsen',
  },
  sv: {
    subject: (b) => `Ditt paket från ${b} väntar på utlämningsstället`,
    hello: (n) => (n ? `Hej ${n},` : 'Hej,'),
    waiting: (b, o, d) => `Ditt paket från ${b} (order ${o}) har legat redo att hämtas på utlämningsstället sedan ${d}.`,
    collect: 'Hämta det gärna snart. Paket som inte hämtas i tid skickas tillbaka till oss.',
    code: 'Utlämningsställe och hämtkod hittar du i sms:et eller mejlet från Bring, eller i Bring-appen.',
    track: 'Spåra paketet',
    regards: 'Med vänliga hälsningar',
  },
  da: {
    subject: (b) => `Din pakke fra ${b} venter på afhentningsstedet`,
    hello: (n) => (n ? `Hej ${n},` : 'Hej,'),
    waiting: (b, o, d) => `Din pakke fra ${b} (ordre ${o}) har ligget klar til afhentning siden ${d}.`,
    collect: 'Husk at hente den snart. Pakker, der ikke bliver hentet i tide, bliver sendt retur til os.',
    code: 'Afhentningssted og afhentningskode finder du i sms’en eller e-mailen fra Bring eller i Bring-appen.',
    track: 'Følg din pakke',
    regards: 'Venlig hilsen',
  },
  fi: {
    subject: (b) => `Pakettisi ${b}-verkkokaupasta odottaa noutopisteessä`,
    hello: (n) => (n ? `Hei ${n},` : 'Hei,'),
    waiting: (b, o, d) => `Pakettisi ${b}-verkkokaupasta (tilaus ${o}) on odottanut noutoa noutopisteessä ${d} lähtien.`,
    collect: 'Noudathan sen pian. Paketit, joita ei noudeta ajoissa, palautetaan meille.',
    code: 'Noutopisteen ja noutokoodin löydät Bringin tekstiviestistä tai sähköpostista tai Bring-sovelluksesta.',
    track: 'Seuraa pakettia',
    regards: 'Ystävällisin terveisin',
  },
  de: {
    subject: (b) => `Ihr Paket von ${b} wartet am Abholort`,
    hello: (n) => (n ? `Hallo ${n},` : 'Hallo,'),
    waiting: (b, o, d) => `Ihr Paket von ${b} (Bestellung ${o}) liegt seit dem ${d} am Abholort für Sie bereit.`,
    collect: 'Bitte holen Sie es bald ab. Pakete, die nicht rechtzeitig abgeholt werden, gehen an uns zurück.',
    code: 'Den Abholort und den Abholcode finden Sie in der SMS oder E-Mail von Bring oder in der Bring-App.',
    track: 'Sendungsverfolgung',
    regards: 'Mit freundlichen Grüßen',
  },
  en: {
    subject: (b) => `Your parcel from ${b} is waiting at the pickup point`,
    hello: (n) => (n ? `Hi ${n},` : 'Hi,'),
    waiting: (b, o, d) => `Your parcel from ${b} (order ${o}) has been waiting at the pickup point since ${d}.`,
    collect: 'Please collect it soon. Parcels that are not collected in time are sent back to us.',
    code: 'You will find the pickup point and the pickup code in the text message or email from Bring, or in the Bring app.',
    track: 'Track your parcel',
    regards: 'Kind regards',
  },
}

/** "28. september", "28 september", "28. syyskuuta": day and month, the customer's way. */
export function arrivalDate(at: Date, language: ReminderLanguage, timeZone: string): string {
  return at.toLocaleDateString(LOCALE[language], { day: 'numeric', month: 'long', timeZone })
}

export function pickupReminderEmail(input: ReminderInput): { subject: string; text: string } {
  const w = WORDS[input.language]
  const date = arrivalDate(input.arrivedAt, input.language, input.timeZone)
  const text = [
    w.hello(input.firstName),
    '',
    w.waiting(input.brand, input.orderNumber, date),
    '',
    w.collect,
    '',
    w.code,
    '',
    `${w.track}: ${input.trackingUrl}`,
    '',
    w.regards,
    input.brand,
  ].join('\n')
  return { subject: w.subject(input.brand), text }
}

/**
 * The name to greet a customer by: the first word of what they typed at
 * checkout, capitalised if they typed it all in lower case. Null when there is
 * nothing usable, so the greeting falls back to a plain "Hi,".
 */
export function firstNameOf(customerName: string | null | undefined): string | null {
  const first = (customerName ?? '').trim().split(/\s+/)[0] ?? ''
  if (!first || !/\p{L}/u.test(first)) return null
  return first === first.toLowerCase() ? first.charAt(0).toUpperCase() + first.slice(1) : first
}

/** "Panetti Norway" -> "Panetti". The brand is what the customer bought from. */
export function brandOf(shopName: string): string {
  return shopName.trim().split(/\s+/)[0] || shopName
}
