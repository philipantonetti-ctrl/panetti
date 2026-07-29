/**
 * Guess which shop an ad account advertises for, from nothing but its name.
 * "Mazzetti NO" should land on Mazzetti.no without anyone thinking about it —
 * and a name that fits nothing gets no guess rather than a wrong one.
 */

const ALIASES: Record<string, string> = {
  no: 'norway',
  se: 'sweden',
  dk: 'denmark',
  fi: 'finland',
  de: 'germany',
  danmark: 'denmark',
  norge: 'norway',
  sverige: 'sweden',
  suomi: 'finland',
}

export function tokensOf(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => ALIASES[t] ?? t)
}

export function suggestShop(
  accountName: string,
  shops: { id: string; name: string }[],
): string | null {
  const account = new Set(tokensOf(accountName))

  let best: string | null = null
  let bestScore = 0
  let tied = false
  for (const shop of shops) {
    const score = tokensOf(shop.name).filter((t) => account.has(t)).length
    if (score > bestScore) {
      best = shop.id
      bestScore = score
      tied = false
    } else if (score === bestScore && score > 0) {
      tied = true
    }
  }

  // One overlapping word ("Panetti") points at half the roster; two ("Panetti"
  // + a country) point at a shop. Anything ambiguous stays a manual choice.
  return bestScore >= 2 && !tied ? best : null
}
