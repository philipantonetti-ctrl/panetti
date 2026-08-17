import { TIP_WINDOW_DAYS, type ReorderTip } from '../../inventory/reorder'
import type { Fact } from '../types'

/**
 * What needs ordering, as facts the briefing can rank against everything else.
 *
 * The Forecast page already shows this, but only to somebody who goes and looks.
 * The client asked to be told when an order needs placing, and the 05:00
 * briefing is the only thing here that reaches him without being opened.
 *
 * Nothing is computed in this file. `forecast()` worked out the date and the
 * quantity, minimum and container rounding included; `reorderTips` decided what
 * is close enough to matter. This turns those into the shape the briefing reads.
 */

/**
 * How many reorders one morning can usefully carry.
 *
 * The morning lead times are first entered, EVERY product is past its order date
 * at once. Uncapped, twenty of these at full severity would take half the
 * briefing's forty slots and push out everything about the money. The Forecast
 * page is the complete list; this is a digest.
 */
export const MAX_REORDER_FACTS = 5

export function reorderFacts(tips: ReorderTip[]): Fact[] {
  return tips
    .map((tip) => ({
      id: `reorder:${tip.sku}`,
      kind: 'REORDER_DUE' as const,
      // A warehouse is not a shop. The stores mirror one of them, and it is the
      // warehouse that empties — so this fact belongs to no shop's section.
      shopId: null,
      shopName: null,
      subject: tip.name,
      // The quantity, because that is the figure he acts on. There is no
      // previous window to set it against and none is invented.
      current: tip.quantity,
      previous: null,
      deltaPct: null,
      unit: 'count' as const,
      // Late is as urgent as it gets. Otherwise it falls away evenly across the
      // window, so a date three weeks out ranks below one already missed.
      severity: tip.daysLate !== null ? 1 : Math.max(0, 1 - tip.daysUntil / TIP_WINDOW_DAYS),
    }))
    .sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id))
    .slice(0, MAX_REORDER_FACTS)
}
