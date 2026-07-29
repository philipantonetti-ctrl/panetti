import type { SessionUser } from './session'

export class AuthError extends Error {
  constructor(message = 'Not allowed') {
    super(message)
    this.name = 'AuthError'
  }
}

/** Admin and Marketing: the people who run the ambassador program. */
const isStaff = (user: SessionUser | null): boolean =>
  user !== null && (user.role === 'ADMIN' || user.role === 'MARKETING')

/**
 * The rule, in one function:
 *   staff (admin or marketing) may view any ambassador;
 *   an ambassador may view ONLY themselves;
 *   nobody else may view anyone.
 */
export function canViewAmbassador(user: SessionUser | null, ambassadorId: string): boolean {
  if (isStaff(user)) return true
  return user?.ambassadorId === ambassadorId
}

/** Company-wide figures — costs, profit, every shop — are admin-only. */
export function assertAdmin(user: SessionUser | null): asserts user is SessionUser {
  if (!user || user.role !== 'ADMIN') throw new AuthError('Admins only')
}

/** Ambassador management and statistics — the marketing half of the house. */
export function assertStaff(user: SessionUser | null): asserts user is SessionUser {
  if (!isStaff(user)) throw new AuthError('Staff only')
}

export function assertAmbassadorAccess(user: SessionUser | null, ambassadorId: string): void {
  if (!canViewAmbassador(user, ambassadorId)) throw new AuthError('Not your data')
}
