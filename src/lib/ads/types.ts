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

/** One day of one account's delivery, minor units in the ACCOUNT's currency. */
export type DailyRow = { date: Date; spend: number; impressions: number; clicks: number }

export type VerifiedAccount = { name: string; currency: string }

/** A provider's own words, surfaced to the UI — never an HTML dump. */
export class AdApiError extends Error {}
