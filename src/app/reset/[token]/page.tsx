import { ResetClient } from './ResetClient'

/**
 * Where a reset link lands.
 *
 * The token is handed straight to the form without being inspected here, unlike
 * the invite page, which looks its token up to greet the ambassador by name.
 * There is nothing equivalent to show: the only facts behind a reset token are
 * whose login it is and which password it replaces, and putting either on
 * screen would tell whoever holds the link something they had not already
 * proved they were entitled to know.
 *
 * POST /api/auth/reset applies every guard on its own, so nothing skipped here
 * is load-bearing security.
 */
export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <ResetClient token={token} />
}
