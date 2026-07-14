'use client'

import { useRouter } from 'next/navigation'

export function TopBar({ email, children }: { email: string; children?: React.ReactNode }) {
  const router = useRouter()

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }

  return (
    <header className="flex items-center justify-between bg-[#2e1a47] px-4 py-2.5 text-white">
      <div className="font-bold tracking-tight">📊 ecom-analytics</div>
      <div className="flex items-center gap-2 text-xs">
        {children}
        <span className="text-white/60">{email}</span>
        <button onClick={signOut} className="rounded-md bg-white/10 px-2.5 py-1.5 hover:bg-white/20">
          Sign out
        </button>
      </div>
    </header>
  )
}
