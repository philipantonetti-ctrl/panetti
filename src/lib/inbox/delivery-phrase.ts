import type { OrderDelivery } from '@/lib/delivery/view'

/**
 * `{{delivery_status}}` in a macro, and the sidebar's one-line summary. Reads
 * from deliveryFor()'s verdict so support can never tell a customer a
 * different story than the Delivery page tells the owner. Null where the
 * page would show a dash: an untracked shop is not "not shipped".
 */
export function deliveryPhrase(d: OrderDelivery): string | null {
  switch (d.state) {
    case 'DELIVERED':
      return d.totalDays === null ? 'delivered' : `delivered, ${d.totalDays} days after the order`
    case 'DELIVERED_UNDATED':
      return 'delivered'
    case 'AVAILABLE':
      return 'ready for pickup'
    case 'IN_TRANSIT':
      return d.late && d.daysOver !== null ? `in transit, ${d.daysOver} days past the promised date` : 'in transit'
    case 'BOOKED':
      return 'packed at the warehouse, not yet handed to the carrier'
    case 'NO_TRACKING':
    case 'NOT_DUE':
      return 'not shipped yet'
    case 'RETURNED':
      return 'returned to sender'
    case 'CANCELLED':
      return 'shipment cancelled'
    case 'UNTRACKED':
    case 'BEFORE_TRACKING':
    case 'VOIDED':
      return null
  }
}
