import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { ForgotClient } from './ForgotClient'

/**
 * Asking for a way back in.
 *
 * Someone already signed in has no business here - they change their password
 * in account settings, where knowing the current one is the check. Sending them
 * on matches what /login does for the same situation.
 */
export default async function ForgotPage() {
  const user = await currentUser()
  if (user) redirect(user.role === 'ADMIN' ? '/dashboard' : '/portal')

  return <ForgotClient />
}
