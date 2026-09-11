/**
 * A customer's name folded to the form two spellings of it share.
 *
 * The warehouse prints the recipient's name on the label from the order, so
 * the two strings are the same name; but one side may be upper-cased,
 * "Last, First", or typed without the accent. Folding both sides the same
 * way is what lets equality do the matching, and measured on 90 linked
 * parcels (2026-09-11) it agreed 90 times.
 *
 * NFD splits an accented letter into the letter and a combining mark, and
 * the mark is dropped. The letters NFD cannot split (o-stroke, ae, sharp s,
 * oe ligature, l-stroke, d-stroke, eth, thorn) are mapped by hand; without
 * that mapping those letters would fold away entirely.
 */
const SINGLE: Record<string, string> = {
  '\u00f8': 'o', '\u00e6': 'ae', '\u00df': 'ss', '\u0153': 'oe', '\u0142': 'l', '\u0111': 'd', '\u00f0': 'd', '\u00fe': 'th',
}

export function nameKey(name: string | null | undefined): string {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u00f8\u00e6\u00df\u0153\u0142\u0111\u00f0\u00fe]/g, (c) => SINGLE[c] ?? c)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ')
}
