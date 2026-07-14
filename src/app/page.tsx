import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth/current-user'

export default async function Home() {
  const user = await currentUser()
  if (!user) redirect('/login')
  redirect(user.role === 'ADMIN' ? '/dashboard' : '/portal')
}
