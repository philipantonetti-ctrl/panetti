export const MACRO_VARIABLES = [
  'customer_name', 'order_number', 'tracking_number', 'product_name', 'delivery_status', 'agent_name', 'brand_name',
] as const
export type MacroVariable = (typeof MACRO_VARIABLES)[number]

export type MacroVars = Partial<Record<string, string | null>>

/**
 * The marker a missing value leaves behind. Visibly not a brace pair, so the
 * composer can find it, and visibly not prose, so it can never be mistaken for
 * the sentence it interrupts. The send button stays disabled while one exists.
 */
export const MISSING_OPEN = '⟪'
export const MISSING_CLOSE = '⟫'

export function renderMacro(body: string, vars: MacroVars): { text: string; missing: string[] } {
  const missing: string[] = []
  const text = body.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, raw: string) => {
    const name = raw.toLowerCase()
    const value = vars[name]
    if (value === undefined || value === null || value === '') {
      if (!missing.includes(name)) missing.push(name)
      return `${MISSING_OPEN}${name}${MISSING_CLOSE}`
    }
    return value
  })
  return { text, missing }
}

/** True while the composer still holds a marker from renderMacro. */
export function hasMissingMarker(text: string): boolean {
  return text.includes(MISSING_OPEN)
}
