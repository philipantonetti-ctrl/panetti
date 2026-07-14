/**
 * The rules for changing your own account.
 *
 * They live here, away from the browser and the database, so the page and the API can
 * apply exactly the same ones. A rule enforced only in the browser is not a rule.
 */

export const MIN_PASSWORD_LENGTH = 8

/** Returns the problem to show the user, or null when the change is fine. */
export function checkNewPassword(
  current: string,
  next: string,
  confirm: string,
): string | null {
  if (!current) return 'Enter your current password.'

  // Spaces at either end are not characters anyone can rely on remembering.
  if (next.trim().length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters for your new password.`
  }

  if (next !== confirm) return 'The two new passwords do not match.'

  if (next === current) return 'Your new password must be different from your current one.'

  return null
}

export function checkProfile(name: string, email: string): string | null {
  if (!name.trim()) return 'Enter your name.'

  // Deliberately simple: an address has something, an @, something, a dot, something.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Enter a valid email address.'

  return null
}
