import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { SignInForm } from '@/components/SignInForm'

/** Where a signed-in person belongs, matching the login route's landings. */
function landingFor(role: string): string {
  if (role === 'ADMIN') return '/dashboard'
  if (role === 'OPERATIONS') return '/orders'
  if (role === 'MARKETING') return '/ambassadors'
  return '/portal'
}

/** The staff door. Same credentials, different framing. */
export default async function AdminLoginPage() {
  const user = await currentUser()
  if (user) redirect(landingFor(user.role))

  return <SignInForm mode="admin" />
}
