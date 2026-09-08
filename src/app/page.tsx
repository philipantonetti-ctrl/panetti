import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'

/** Where a signed-in person belongs, matching the login route's landings. */
function landingFor(role: string): string {
  if (role === 'ADMIN') return '/dashboard'
  if (role === 'OPERATIONS') return '/orders'
  if (role === 'MARKETING') return '/ambassadors'
  return '/portal'
}

export default async function Home() {
  const user = await currentUser()
  if (!user) redirect('/login')
  redirect(landingFor(user.role))
}
