import { db } from '../db'
import { resolveCredentials } from './sync'
import { fetchMetaBreakdown } from './meta'
import { fetchGoogleBreakdown } from './google'
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
  from: Date
  to: Date
}): Promise<BreakdownResponse> {
  const accounts = await db.adAccount.findMany({
    where: { active: true, shopId: opts.shopId, provider: opts.provider },
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

  return { rows, errors }
}
