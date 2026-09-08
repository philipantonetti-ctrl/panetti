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

/**
 * The operations manager's half of the house: orders, delivery, products,
 * inventory and B2B. An admin can do everything they can, so the two travel
 * together everywhere this is asked.
 */
export const canRunOperations = (user: SessionUser | null): user is SessionUser =>
  user !== null && (user.role === 'ADMIN' || user.role === 'OPERATIONS')

/**
 * May this person be shown what a product costs us, or what an order earned?
 *
 * Admin only, deliberately narrower than canRunOperations. The operations
 * manager runs the five tabs in full - he uploads the warehouse file, orders
 * stock, enters B2B orders - and never learns a cost, a fee, a commission, a
 * margin or a profit. Every route that computes one asks this before putting
 * the number in its response, so the figure is absent from the wire rather
 * than merely hidden by the page drawing it.
 */
export const canSeeProfit = (user: SessionUser | null): boolean =>
  user !== null && user.role === 'ADMIN'

/** Company-wide figures - costs, profit, every shop - are admin-only. */
export function assertAdmin(user: SessionUser | null): asserts user is SessionUser {
  if (!user || user.role !== 'ADMIN') throw new AuthError('Admins only')
}

/** The five operations tabs: admin or the operations manager. */
export function assertOperations(user: SessionUser | null): asserts user is SessionUser {
  if (!canRunOperations(user)) throw new AuthError('Operations only')
}

/** Ambassador management and statistics - the marketing half of the house. */
export function assertStaff(user: SessionUser | null): asserts user is SessionUser {
  if (!isStaff(user)) throw new AuthError('Staff only')
}

export function assertAmbassadorAccess(user: SessionUser | null, ambassadorId: string): void {
  if (!canViewAmbassador(user, ambassadorId)) throw new AuthError('Not your data')
}
