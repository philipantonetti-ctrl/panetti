// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CodeCombobox } from './CodeCombobox'

const CODES = ['JOHN10', 'SUMMER', 'JOHNVIP']

describe('CodeCombobox', () => {
  it('is disabled until a store is chosen, and says so', () => {
    render(<CodeCombobox value="" onChange={vi.fn()} codes={[]} disabled />)
    const input = screen.getByLabelText('Discount code') as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect(input.placeholder).toMatch(/pick a store/i)
  })

  it('lists the store codes when focused', () => {
    render(<CodeCombobox value="" onChange={vi.fn()} codes={CODES} />)
    fireEvent.focus(screen.getByLabelText('Discount code'))
    expect(screen.getByRole('button', { name: 'JOHN10' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'SUMMER' })).toBeTruthy()
  })

  it('filters the list by the current value', () => {
    render(<CodeCombobox value="JOHN" onChange={vi.fn()} codes={CODES} />)
    fireEvent.focus(screen.getByLabelText('Discount code'))
    expect(screen.getByRole('button', { name: 'JOHN10' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'JOHNVIP' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'SUMMER' })).toBeNull()
  })

  it('uppercases what you type', () => {
    const onChange = vi.fn()
    render(<CodeCombobox value="" onChange={onChange} codes={CODES} />)
    fireEvent.change(screen.getByLabelText('Discount code'), { target: { value: 'john' } })
    expect(onChange).toHaveBeenCalledWith('JOHN')
  })

  it('picking a suggestion fills that code', () => {
    const onChange = vi.fn()
    render(<CodeCombobox value="" onChange={onChange} codes={CODES} />)
    fireEvent.focus(screen.getByLabelText('Discount code'))
    fireEvent.mouseDown(screen.getByRole('button', { name: 'SUMMER' }))
    expect(onChange).toHaveBeenCalledWith('SUMMER')
  })

  it('shows a loading state while codes are fetched', () => {
    render(<CodeCombobox value="" onChange={vi.fn()} codes={[]} loading />)
    fireEvent.focus(screen.getByLabelText('Discount code'))
    expect(screen.getByText(/loading codes/i)).toBeTruthy()
  })

  it('keeps a typed code that is not in the list, and says it will be used as typed', () => {
    render(<CodeCombobox value="CUSTOM99" onChange={vi.fn()} codes={['JOHN10']} />)
    fireEvent.focus(screen.getByLabelText('Discount code'))
    expect((screen.getByLabelText('Discount code') as HTMLInputElement).value).toBe('CUSTOM99')
    expect(screen.getByText(/used as typed/i)).toBeTruthy()
  })
})
