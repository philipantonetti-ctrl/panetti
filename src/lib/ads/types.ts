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

export type VerifiedAccount = { name: string; currency: string }

/** A provider's own words, surfaced to the UI — never an HTML dump. */
export class AdApiError extends Error {}
