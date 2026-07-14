import type { SessionUser } from './session'

export class AuthError extends Error {
  constructor(message = 'Not allowed') {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * The rule, in one function:
 *   an admin may view any ambassador;
 *   an ambassador may view ONLY themselves;
 *   nobody else may view anyone.
 */
export function canViewAmbassador(user: SessionUser | null, ambassadorId: string): boolean {
  if (!user) return false
  if (user.role === 'ADMIN') return true
  return user.ambassadorId === ambassadorId
}

/** Company-wide figures — costs, profit, every shop — are admin-only. */
export function assertAdmin(user: SessionUser | null): asserts user is SessionUser {
  if (!user || user.role !== 'ADMIN') throw new AuthError('Admins only')
}

export function assertAmbassadorAccess(user: SessionUser | null, ambassadorId: string): void {
  if (!canViewAmbassador(user, ambassadorId)) throw new AuthError('Not your data')
}
