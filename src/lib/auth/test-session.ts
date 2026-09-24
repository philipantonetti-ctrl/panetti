import { createHash } from 'crypto'
import { expect } from 'vitest'
import { db } from '@/lib/db'
import { hashPassword } from './password'
import { signSession, type SessionUser } from './session'

/**
 * A signed cookie for a user that REALLY EXISTS. Tests only.
 *
 * `currentUser` answers from the database on every request, so a session for
 * an invented id is nobody - which is the whole point of it, and which is why
 * a test can no longer just sign a claim and be believed. This makes the row
 * first and signs a session bound to its password, so a test gets the access
 * it asks for and every revocation rule still runs for real.
 *
 * EVERY FILE GETS ITS OWN ROW, and that is the important part. Test files run
 * in parallel against one database and share a handful of ids: `test-admin`
 * appears in twenty-five of them. Sharing one row means one file's cleanup
 * logs another file out mid-test, and the failures then move from file to file
 * on every run - which is exactly what happened. So the id, and the email, are
 * quietly scoped to the calling test file. No test asserts on the literal id,
 * only on what the session is allowed to do, so nothing is lost by it.
 *
 * Not imported by any application code, so it is in no bundle.
 */

/** bcrypt is slow on purpose. One hash for the whole test process is plenty. */
let shared: Promise<string> | null = null
const testHash = () => (shared ??= hashPassword('test-password'))

/** Eight hex characters of the test file's path: short, stable, and its own. */
function fileTag(): string {
  const path = expect.getState().testPath ?? 'unknown-test-file'
  return createHash('sha256').update(path).digest('hex').slice(0, 8)
}

export async function testSession(user: SessionUser): Promise<string> {
  /**
   * A login the test MADE is the one it means. Several files build their own
   * User row - with their own email, role and links - and then ask for a
   * session as that person. Sign against the hash already stored and touch
   * nothing: renaming their row, or overwriting its password, would break the
   * very thing they set up.
   */
  const theirs = await db.user.findUnique({
    where: { id: user.userId },
    select: { id: true, email: true, role: true, ambassadorId: true, passwordHash: true },
  })
  if (theirs) {
    return signSession(
      { ...user, userId: theirs.id, email: theirs.email, ambassadorId: theirs.ambassadorId },
      theirs.passwordHash,
    )
  }

  const passwordHash = await testHash()
  const tag = fileTag()
  const userId = `${tag}-${user.userId}`
  // The email is left alone unless somebody else already holds it. One route
  // matches an admin to the ambassador that shares their address, so renaming
  // it by default would quietly break the thing being tested.
  const taken = await db.user.findUnique({ where: { email: user.email }, select: { id: true } })
  const email = !taken || taken.id === userId ? user.email : `${tag}.${user.email}`
  const { role } = user

  /**
   * An ambassador the test MADE is the one it means - the portal tests build a
   * real ambassador with real orders and then expect to sign in as them, so
   * that id is left exactly as given. An id that names nothing is an invented
   * one, and inventing it per file keeps two files from fighting over the row.
   */
  let ambassadorId = user.ambassadorId
  if (ambassadorId) {
    const theirs = await db.ambassador.findUnique({ where: { id: ambassadorId }, select: { id: true } })
    if (!theirs) {
      ambassadorId = `${tag}-${ambassadorId}`
      // A user carrying an ambassador id is meaningless without the
      // ambassador, and the foreign key says so.
      await db.ambassador.upsert({
        where: { id: ambassadorId },
        create: { id: ambassadorId, name: `test ${ambassadorId}`, email: `${ambassadorId}@test-session.invalid` },
        update: {},
      })
    }
  }

  const data = { email, role, ambassadorId, passwordHash }
  await db.user.upsert({ where: { id: userId }, create: { id: userId, ...data }, update: data })

  return signSession({ ...user, userId, email, ambassadorId }, passwordHash)
}
