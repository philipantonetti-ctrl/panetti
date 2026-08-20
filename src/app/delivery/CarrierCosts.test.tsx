// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { CarrierCosts } from './CarrierCosts'
import type { CarrierAverage } from '@/lib/delivery/carrier-cost'

const average = (over: Partial<CarrierAverage> = {}): CarrierAverage => ({
  carrier: 'BRING',
  shipments: 400,
  parcelsInRange: 400,
  cost: 20_000_00,
  currency: 'NOK',
  averageMinor: 50_00,
  monthsCounted: ['2026-07'],
  monthsMissingCost: [],
  mixedCurrency: false,
  ...over,
})

const month = (over = {}) => ({
  carrier: 'BRING',
  month: '2026-07',
  parcels: 400,
  amount: 20_000_00 as number | null,
  currency: 'NOK' as string | null,
  ...over,
})

const props = (over = {}) => ({
  carriers: [average()],
  months: [month()],
  defaultCurrency: 'NOK',
  onSave: vi.fn(),
  ...over,
})

describe('CarrierCosts', () => {
  it('states the cost of sending one parcel', () => {
    const { container } = render(<CarrierCosts {...props()} />)
    expect(container.textContent).toMatch(/50\.00/)
  })

  it('names the carrier the figure belongs to', () => {
    const { container } = render(<CarrierCosts {...props()} />)
    expect(container.textContent).toMatch(/Bring/i)
  })

  /**
   * The figure is entered, not fetched. Saying so is the difference between a
   * number the reader trusts and one they wonder about — neither carrier's API
   * returns what a shipment cost, and the page should not imply that it does.
   */
  it('says the money was entered by hand rather than read from the carrier', () => {
    const { container } = render(<CarrierCosts {...props()} />)
    expect(container.textContent).toMatch(/entered|invoice/i)
  })

  /**
   * The explanatory text is read by the client, who reads English as a second
   * language. A long dash mid-sentence makes a sentence harder to parse, and
   * he has asked twice for them to go. The em dash the number columns use for
   * "no value" is a different thing and is left alone.
   */
  it('explains itself without long dashes', () => {
    const { container } = render(<CarrierCosts {...props()} />)
    const intro = [...container.querySelectorAll('section > p')].map((p) => p.textContent ?? '')
    expect(intro.length).toBeGreaterThan(0)
    for (const line of intro) expect(line).not.toMatch(/—/)
  })

  it('shows the parcels it counted, so the division can be checked', () => {
    const { container } = render(<CarrierCosts {...props()} />)
    expect(container.textContent).toMatch(/400/)
  })

  /**
   * A month with parcels but no invoice is excluded from the average on
   * purpose. Left unsaid, the reader would divide the same invoice by every
   * parcel on screen and get a different, lower number than the one shown.
   */
  it('says which months it had to leave out', () => {
    const { container } = render(
      <CarrierCosts
        {...props({
          carriers: [average({ shipments: 400, parcelsInRange: 580, monthsMissingCost: ['2026-08'] })],
          months: [month(), month({ month: '2026-08', parcels: 180, amount: null, currency: null })],
        })}
      />,
    )
    expect(container.textContent).toMatch(/August 2026/)
  })

  it('shows no average at all until an invoice is entered', () => {
    const { container } = render(
      <CarrierCosts
        {...props({
          carriers: [average({ shipments: 0, cost: null, currency: null, averageMinor: null, monthsCounted: [], monthsMissingCost: ['2026-07'] })],
          months: [month({ amount: null, currency: null })],
        })}
      />,
    )
    // A zero here would read as "sending parcels is free".
    expect(container.textContent).not.toMatch(/0\.00/)
  })

  it('refuses an average rather than adding two currencies together', () => {
    const { container } = render(
      <CarrierCosts
        {...props({
          carriers: [average({ averageMinor: null, cost: null, currency: null, mixedCurrency: true })],
        })}
      />,
    )
    expect(container.textContent).toMatch(/currenc/i)
  })

  it('sends what was typed as minor units, so nothing is stored as a float', () => {
    const onSave = vi.fn()
    render(<CarrierCosts {...props({ onSave, months: [month({ amount: null, currency: null })] })} />)

    const input = screen.getByLabelText(/invoice for july 2026/i)
    fireEvent.change(input, { target: { value: '20000.50' } })
    fireEvent.blur(input)

    expect(onSave).toHaveBeenCalledWith({
      carrier: 'BRING',
      month: '2026-07',
      amount: 2_000_050,
      currency: 'NOK',
    })
  })

  // Clearing has to be its own instruction: a stored zero means the carrier
  // billed nothing, which is a different claim from not knowing yet.
  it('clears the month when the box is emptied', () => {
    const onSave = vi.fn()
    render(<CarrierCosts {...props({ onSave })} />)

    const input = screen.getByLabelText(/invoice for july 2026/i)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    expect(onSave).toHaveBeenCalledWith({ carrier: 'BRING', month: '2026-07', amount: null, currency: 'NOK' })
  })

  it('does not save when nothing was changed', () => {
    const onSave = vi.fn()
    render(<CarrierCosts {...props({ onSave })} />)
    fireEvent.blur(screen.getByLabelText(/invoice for july 2026/i))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('says nothing at all when no parcel moved in the range', () => {
    const { container } = render(<CarrierCosts {...props({ carriers: [], months: [] })} />)
    expect(container.textContent).toBe('')
  })
})
