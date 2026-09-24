// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrandMark } from './BrandMark'

/**
 * The mark is drawn on the sidebar and on every signed-out page, so anything
 * that throws while rendering it takes half the app's tests down with it. It
 * did: next/image builds an absolute URL for its optimiser and there is no
 * host to build one from under the test runner, which killed every page that
 * draws the shell with "Invalid URL".
 */
describe('BrandMark', () => {
  it('draws without needing a host to resolve, and is decorative', () => {
    render(<BrandMark size={24} />)
    const img = screen.getByRole('presentation', { hidden: true }) as HTMLImageElement
    expect(img.getAttribute('src')).toMatch(/panetti-mark/)
    expect(img.getAttribute('width')).toBe('24')
    // Empty alt: the product name is written out beside it every time.
    expect(img.getAttribute('alt')).toBe('')
  })
})
