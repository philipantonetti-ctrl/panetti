import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'
import { SignInForm } from '@/components/SignInForm'

/** The staff door. Same credentials, different framing. */
export default async function AdminLoginPage() {
  const user = await currentUser()
  if (user) redirect(user.role === 'ADMIN' ? '/dashboard' : '/portal')

  return <SignInForm mode="admin" />
}
