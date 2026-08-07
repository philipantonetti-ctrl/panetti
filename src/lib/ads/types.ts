export const AD_PROVIDERS = ['meta', 'google'] as const
export type AdProvider = (typeof AD_PROVIDERS)[number]

export type MetaCredentials = { accessToken: string }
export type GoogleCredentials = {
  developerToken: string
  clientId: string
  clientSecret: string
  refreshToken: string
  loginCustomerId?: string
}
export type AdCredentials = MetaCredentials | GoogleCredentials

/**
 * One day of one account's delivery, money in minor units of the ACCOUNT's
 * currency. Only day-additive numbers: reach and frequency do not sum across
 * days, so an honest range figure for those needs a live range query instead.
 */
export type DailyRow = {
  date: Date
  spend: number
  impressions: number
  clicks: number
  linkClicks: number
  conversions: number // purchases; Google reports fractions
  conversionValue: number // attributed purchase value, minor units
  videoViews3s: number
  thruplays: number
  reach: number
}

/**
 * One day of ONE CAMPAIGN's delivery. Same units and same day-additive rule as
 * DailyRow; the campaign's own id and name ride along so the sync can keep the
 * AdCampaign row's name fresh without a second request.
 */
export type CampaignDailyRow = DailyRow & {
  campaignId: string
  campaignName: string
}

export type VerifiedAccount = { name: string; currency: string }

/** A provider's own words, surfaced to the UI — never an HTML dump. */
export class AdApiError extends Error {}

/**
 * The three levels both platforms happen to share. Meta calls the middle one an
 * ad set and Google an ad group; the API speaks one vocabulary and the screen
 * translates, so a client never reads the wrong platform's word.
 */
export type BreakdownLevel = 'campaign' | 'adset' | 'ad'

/**
 * What a platform driver returns: the platform's own figures for one entity and
 * nothing of ours. The route adds which of OUR accounts it came from.
 *
 * No ROAS and no CTR. Both are derived once, at render, from these numbers —
 * carrying a derived figure alongside its inputs is how two numbers on one
 * screen come to disagree.
 */
export type BreakdownEntry = {
  id: string
  name: string
  spend: number // minor units, the ad account's own currency
  purchases: number
  purchaseValue: number // minor units
  impressions: number
  clicks: number
}
