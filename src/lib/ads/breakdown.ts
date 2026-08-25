import { db } from '../db'
import { resolveCredentials } from './sync'
import { fetchMetaBreakdown } from './meta'
import { fetchGoogleBreakdown } from './google'
import { accountIdsForShops } from './attribution'
import type { BreakdownEntry, BreakdownLevel, GoogleCredentials, MetaCredentials } from './types'

export type BreakdownRow = BreakdownEntry & {
  accountId: string
  accountName: string
  currency: string
}

/**
 * One account failing must not lose the others, for the same reason
 * `syncAllShops` does not let one store cost the rest their turn. So a failure
 * is data, not a status code: the response is 200 with whatever rows worked and
 * a named reason for each account that did not.
 */
export type BreakdownResponse = {
  rows: BreakdownRow[]
  errors: { accountId: string; accountName: string; message: string }[]
  /**
   * How many of this shop's ad accounts on this provider were consulted.
   *
   * Zero is a different sentence from "no campaigns ran": one means nothing is
   * connected, the other means nothing was spent. Reading the second when the
   * first is true is how someone concludes a platform is dead when it was never
   * plugged in.
   */
  accountsChecked: number
}

/**
 * Every campaign, ad set or ad the shop's accounts on this provider report for
 * the range.
 *
 * One account failing does not lose the others: its reason is collected against
 * it and the rest still return, for the same reason `syncAllShops` does not let
 * one store cost the rest their turn. A caller that rejected wholesale would
 * turn one lapsed token into an empty screen for every account.
 */
export async function loadBreakdown(opts: {
  shopId: string
  provider: 'meta' | 'google'
  level: BreakdownLevel
  parentId?: string
  /**
   * Scopes the query to one ad account. A campaign id - and everything
   * beneath it - belongs to exactly one account, never every account the
   * shop has on this provider. Omit this only at campaign level, where
   * asking every account is the point: that is how the union across a
   * shop's accounts gets built in the first place.
   */
  accountId?: string
  from: Date
  to: Date
}): Promise<BreakdownResponse> {
  // The third instance of the same scoping trap already fixed in load.ts and
  // /api/marketing/route.ts: a split account qualifies on where ITS CAMPAIGNS
  // resolve, not on the account's own shopId. Filtering on `shopId: opts.shopId`
  // alone would show an EMPTY drill-down beneath a non-zero row whenever a
  // split account's default sits outside opts.shopId but one of its campaigns
  // belongs to it.
  const ids = await accountIdsForShops([opts.shopId])
  const accounts = await db.adAccount.findMany({
    where: {
      active: true,
      id: { in: ids },
      provider: opts.provider,
      ...(opts.accountId ? { id: opts.accountId } : {}),
    },
    include: { connection: { select: { provider: true, secret: true, expiresAt: true } } },
  })

  const rows: BreakdownRow[] = []
  const errors: BreakdownResponse['errors'] = []

  for (const account of accounts) {
    try {
      const creds = await resolveCredentials(account)
      const entries =
        opts.provider === 'meta'
          ? await fetchMetaBreakdown(
              creds as MetaCredentials,
              {
                level: opts.level,
                accountExternalId: account.externalId,
                ...(opts.parentId ? { parentId: opts.parentId } : {}),
              },
              opts.from,
              opts.to,
            )
          : await fetchGoogleBreakdown(
              creds as GoogleCredentials,
              {
                level: opts.level,
                customerId: account.externalId,
                ...(opts.parentId ? { parentId: opts.parentId } : {}),
              },
              opts.from,
              opts.to,
            )

      for (const entry of entries) {
        rows.push({
          ...entry,
          accountId: account.id,
          accountName: account.name,
          currency: account.currency,
        })
      }
    } catch (e) {
      errors.push({
        accountId: account.id,
        accountName: account.name,
        message: e instanceof Error ? e.message : 'Could not read this account.',
      })
    }
  }

  // Highest spend first, matching MarketingTable's own default sort - the
  // platform's own order carries no meaning on a page used to judge spending.
  rows.sort((a, b) => b.spend - a.spend)

  // Every account in the loop above was consulted, whether it produced rows,
  // came back empty, or errored - accountsChecked is that count, never
  // rows.length, which would conflate "nothing connected" with "connected but
  // spent nothing" the moment any account fails or reports zero.
  return { rows, errors, accountsChecked: accounts.length }
}
