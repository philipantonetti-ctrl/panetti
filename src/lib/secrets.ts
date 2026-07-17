import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto'

/**
 * Shop API keys, encrypted at rest.
 *
 * AES-256-GCM with a key derived (HKDF-SHA256) from AUTH_SECRET — the one secret
 * that already exists on Vercel, so connecting a shop needs no extra setup.
 * A value without the prefix is returned as-is: rows written before this module
 * (local dev) keep working. If AUTH_SECRET ever changes, decryption throws and
 * the sync reports "reconnect this shop" — a visible failure, never a silent one.
 */

const PREFIX = 'enc:v1:'
const TAG_LENGTH = 16

function key(): Buffer {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error('AUTH_SECRET is not set')
  return Buffer.from(hkdfSync('sha256', secret, 'shop-credentials', 'v1', 32))
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tagged = Buffer.concat([encrypted, cipher.getAuthTag()])
  return `${PREFIX}${iv.toString('base64')}:${tagged.toString('base64')}`
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored

  const [ivPart, taggedPart] = stored.slice(PREFIX.length).split(':')
  const iv = Buffer.from(ivPart, 'base64')
  const tagged = Buffer.from(taggedPart ?? '', 'base64')

  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tagged.subarray(tagged.length - TAG_LENGTH))
  return Buffer.concat([
    decipher.update(tagged.subarray(0, tagged.length - TAG_LENGTH)),
    decipher.final(),
  ]).toString('utf8')
}
