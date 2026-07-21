/**
 * BeProfit's payment gateway list, shown on the Processing Fees page.
 * Rates are stored per gateway; the profit engine charges every order the
 * rate of the gateway the stores actually route payments through.
 */
export const GATEWAYS = [
  'Credit Card',
  'PayPal Account',
  'Check payments',
  'SEPA Direct Debit',
  'Vorkasse',
  'Link',
  'Cash App',
  'Pay Later',
  'Dintero Checkout',
  'Bancontact (via PayPal)',
  'Blik (via PayPal)',
] as const

export const ACTIVE_GATEWAY = 'Dintero Checkout'
