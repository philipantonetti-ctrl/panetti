import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { SignInForm } from '@/components/SignInForm'

/** Where a signed-in person belongs, matching the login route's landings. */
function landingFor(role: string): string {
  // Both dashboards live at one address; the role decides which page is drawn.
  if (role === 'ADMIN' || role === 'OPERATIONS') return '/dashboard'
  if (role === 'MARKETING') return '/ambassadors'
  return '/portal'
}

/** The default front door. Most people signing in are ambassadors. */
export default async function LoginPage() {
  const user = await currentUser()
  if (user) redirect(landingFor(user.role))

  return <SignInForm mode="ambassador" />
}
