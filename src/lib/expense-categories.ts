/**
 * The operational-expense category taxonomy.
 *
 * This mirrors the categories the business already uses in BeProfit, so an expense
 * categorised there means the same thing here. Grouped for the picker; stored flat
 * as "Group > Option".
 */

export type CategoryGroup = {
  group: string
  options: string[]
}

export const CATEGORY_GROUPS: CategoryGroup[] = [
  { group: 'Overhead', options: ['Office', 'Employees', 'Subscriptions', 'Equipment'] },
  { group: 'Financing', options: ['Financing'] },
  {
    group: 'Marketing',
    options: ['Custom Ad Spend', 'Digital Marketing', 'Design', 'Website Expenses', 'Content'],
  },
  { group: 'Operations', options: ['COGS', 'Product Samples', 'Importing Fees'] },
  { group: 'Fulfillment', options: ['Fulfillment', 'Warehouse', 'Materials', 'Handling'] },
  { group: 'Other', options: ['Other'] },
  { group: 'Transaction fees', options: ['Transaction Fees'] },
]

/** Every category as it is stored: "Group > Option". */
export const CATEGORIES: string[] = CATEGORY_GROUPS.flatMap((g) =>
  g.options.map((option) => `${g.group} > ${option}`),
)
