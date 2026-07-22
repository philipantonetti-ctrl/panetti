// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { DateFilter } from './DateFilter'

afterEach(() => vi.useRealTimers())

function renderPicker(onChange = vi.fn()) {
  // Pin "now" so the calendar always opens on July 2026.
  vi.useFakeTimers({ now: new Date('2026-07-21T10:00:00Z'), toFake: ['Date'] })
  render(<DateFilter preset="this_month" from="" to="" onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Date range' }))
  return onChange
}

describe('DateFilter calendar', () => {
  it('first click starts the range, second ends it, Apply reports it', () => {
    const onChange = renderPicker()

    fireEvent.click(screen.getByRole('button', { name: '2026-07-12' }))
    fireEvent.click(screen.getByRole('button', { name: '2026-07-16' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onChange).toHaveBeenCalledWith({ preset: 'custom', from: '2026-07-12', to: '2026-07-16' })
  })

  it('clicking an earlier day restarts the range there', () => {
    const onChange = renderPicker()

    fireEvent.click(screen.getByRole('button', { name: '2026-07-12' }))
    fireEvent.click(screen.getByRole('button', { name: '2026-07-05' })) // before the start
    fireEvent.click(screen.getByRole('button', { name: '2026-07-08' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onChange).toHaveBeenCalledWith({ preset: 'custom', from: '2026-07-05', to: '2026-07-08' })
  })

  it('a single picked day applies as a one-day range', () => {
    const onChange = renderPicker()

    fireEvent.click(screen.getByRole('button', { name: '2026-07-19' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onChange).toHaveBeenCalledWith({ preset: 'custom', from: '2026-07-19', to: '2026-07-19' })
  })

  it('Clear wipes the picked range so Apply is disabled again', () => {
    const onChange = renderPicker()

    fireEvent.click(screen.getByRole('button', { name: '2026-07-12' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('still offers every preset, including the new ones', () => {
    renderPicker()
    expect(screen.getByRole('button', { name: 'Last month' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Last 12 months' })).toBeTruthy()
  })

  it('locks future dates: today and past stay clickable, tomorrow and later do not', () => {
    renderPicker() // now pinned to 2026-07-21
    expect((screen.getByRole('button', { name: '2026-07-21' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '2026-07-20' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '2026-07-22' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '2026-08-01' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a future date cannot be picked, so it never starts a range', () => {
    const onChange = renderPicker()
    fireEvent.click(screen.getByRole('button', { name: '2026-07-25' })) // future, disabled
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
