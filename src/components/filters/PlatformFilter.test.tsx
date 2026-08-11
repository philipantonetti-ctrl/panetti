// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PlatformFilter } from './PlatformFilter'

const options = [
  { provider: 'meta', label: 'Meta' },
  { provider: 'google', label: 'Google' },
]

describe('PlatformFilter', () => {
  it('starts on all platforms', () => {
    render(<PlatformFilter options={options} selected={null} onChange={() => {}} />)
    expect(screen.getByRole('combobox')).toHaveValue('')
  })

  it('reports the chosen provider, and null for all', () => {
    const onChange = vi.fn()
    render(<PlatformFilter options={options} selected={null} onChange={onChange} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'meta' } })
    expect(onChange).toHaveBeenCalledWith('meta')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('renders nothing when there is only one platform to choose from', () => {
    // A dropdown with one real option is a control that cannot do anything.
    const { container } = render(
      <PlatformFilter options={[options[0]]} selected={null} onChange={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
