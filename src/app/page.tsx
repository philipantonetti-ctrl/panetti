import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'

/** Where a signed-in person belongs, matching the login route's landings. */
function landingFor(role: string): string {
  // Both dashboards live at one address; the role decides which page is drawn.
  if (role === 'ADMIN' || role === 'OPERATIONS') return '/dashboard'
  if (role === 'MARKETING') return '/ambassadors'
  return '/portal'
}

export default async function Home() {
  const user = await currentUser()
  if (!user) redirect('/login')
  redirect(landingFor(user.role))
}
