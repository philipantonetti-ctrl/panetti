import { describe, it, expect } from 'vitest'
import { checkNewPassword, checkProfile, MIN_PASSWORD_LENGTH } from './account-rules'

describe('checkNewPassword', () => {
  it('accepts a good change', () => {
    expect(checkNewPassword('old-one', 'a-better-password', 'a-better-password')).toBeNull()
  })

  it('insists you prove who you are first', () => {
    expect(checkNewPassword('', 'a-better-password', 'a-better-password')).toBe(
      'Enter your current password.',
    )
  })

  it('refuses a password that is too short to be worth anything', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8)
    expect(checkNewPassword('old-one', 'short', 'short')).toBe(
      'Use at least 8 characters for your new password.',
    )
  })

  it('catches a typo in the confirmation before it locks you out', () => {
    expect(checkNewPassword('old-one', 'a-better-password', 'a-better-passwrod')).toBe(
      'The two new passwords do not match.',
    )
  })

  it('refuses to "change" a password to the one already in use', () => {
    expect(checkNewPassword('same-password', 'same-password', 'same-password')).toBe(
      'Your new password must be different from your current one.',
    )
  })

  it('does not treat surrounding spaces as characters you can rely on', () => {
    // "  pass  " is 8 characters, but only 4 of them are real.
    expect(checkNewPassword('old-one', '  pass  ', '  pass  ')).toBe(
      'Use at least 8 characters for your new password.',
    )
  })
})

describe('checkProfile', () => {
  it('accepts a real name and email', () => {
    expect(checkProfile('Emma Nilsen', 'emma@ambassador.test')).toBeNull()
  })

  it('needs a name', () => {
    expect(checkProfile('   ', 'emma@ambassador.test')).toBe('Enter your name.')
  })

  it('needs an email that could actually receive mail', () => {
    expect(checkProfile('Emma Nilsen', 'emma-at-nowhere')).toBe('Enter a valid email address.')
    expect(checkProfile('Emma Nilsen', '')).toBe('Enter a valid email address.')
  })
})
