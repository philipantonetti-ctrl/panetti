// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ShopFilter, NO_SHOPS } from './ShopFilter'

const shops = [
  { id: 's1', name: 'Panetti Norway', currency: 'NOK' },
  { id: 's2', name: 'Mazzetti Denmark', currency: 'DKK' },
]

/** Render with a selection and open the dropdown. */
function open(selected: string[]) {
  const onChange = vi.fn()
  render(<ShopFilter shops={shops} selected={selected} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Shops' }))
  return onChange
}

describe('ShopFilter', () => {
  it('offers Deselect all while everything is selected, and it empties the board', () => {
    const onChange = open([])
    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }))
    expect(onChange).toHaveBeenCalledWith([NO_SHOPS])
  })

  it('with nothing selected: every box clear, the label says No shops, Select all returns', () => {
    const onChange = open([NO_SHOPS])
    expect(screen.getByText('No shops')).toBeTruthy()
    for (const s of shops) {
      expect((screen.getByRole('checkbox', { name: s.name }) as HTMLInputElement).checked).toBe(false)
    }

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('ticking a shop from the none state selects exactly that shop', () => {
    const onChange = open([NO_SHOPS])
    fireEvent.click(screen.getByRole('checkbox', { name: 'Panetti Norway' }))
    expect(onChange).toHaveBeenCalledWith(['s1'])
  })

  it('un-ticking the last chosen shop means none — not suddenly all again', () => {
    const onChange = open(['s1'])
    fireEvent.click(screen.getByRole('checkbox', { name: 'Panetti Norway' }))
    expect(onChange).toHaveBeenCalledWith([NO_SHOPS])
  })

  it('keeps Select all while only some shops are chosen', () => {
    open(['s1'])
    expect(screen.getByRole('button', { name: 'Select all' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Deselect all' })).toBeNull()
  })
})
