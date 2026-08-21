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
  counted: true,
  amount: 20_000_00 as number | null,
  currency: 'NOK' as string | null,
  ...over,
})

const props = (over = {}) => ({
  carriers: [average()],
  months: [month()],
  defaultCurrency: 'NOK',
  firstMonth: null as string | null,
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

  /**
   * Bring's bill is read from Bring now, so telling him to type one is an
   * instruction he should not follow. He asked for this to be automatic; the
   * page has to stop asking.
   */
  it('tells Bring its bills arrive by themselves, and names the first priced month', () => {
    render(
      <CarrierCosts
        {...props({
          firstMonth: '2026-09',
          carriers: [average({ averageMinor: null, cost: null, monthsCounted: [] })],
        })}
      />,
    )
    expect(screen.getByText(/bills arrive by themselves/i)).toBeInTheDocument()
    expect(screen.getByText(/september 2026/i)).toBeInTheDocument()
    expect(screen.queryByText(/enter an invoice below/i)).not.toBeInTheDocument()
  })

  /**
   * DHL has no invoice service, so a person types it - but pointing him at a
   * box for a month that cannot be priced is an instruction into a dead end.
   * The caption names the FIRST month typing will actually do something.
   */
  it('tells DHL which invoice to type, instead of pointing at a dead box', () => {
    render(
      <CarrierCosts
        {...props({
          firstMonth: '2026-09',
          carriers: [average({ carrier: 'DHL', averageMinor: null, cost: null, monthsCounted: [] })],
          months: [month({ carrier: 'DHL', month: '2026-08', counted: false, amount: null })],
        })}
      />,
    )
    expect(screen.getByText(/september 2026/i)).toBeInTheDocument()
    expect(screen.getByText(/type dhl/i)).toBeInTheDocument()
  })

  /**
   * The card's own opening lines, which outlived the world they described.
   * After Bring became automatic they still read "Enter each carrier's
   * monthly invoice below" and "Bring and DHL only tell us where a parcel
   * is, never what it cost" - the first an instruction not to follow, the
   * second now plainly false for Bring. The client pasted these exact lines
   * back and asked what they meant.
   */
  it('opens by saying Bring is automatic and DHL is typed', () => {
    render(<CarrierCosts {...props()} />)
    expect(screen.getByText(/fills in by itself/i)).toBeInTheDocument()
    expect(screen.getByText(/DHL.+typed/i)).toBeInTheDocument()
  })

  it('no longer instructs him to enter each invoice, nor claims costs cannot be read', () => {
    render(<CarrierCosts {...props()} />)
    expect(screen.queryByText(/enter each carrier/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/never what it cost/i)).not.toBeInTheDocument()
  })

  it('says nothing at all when no parcel moved in the range', () => {
    const { container } = render(<CarrierCosts {...props({ carriers: [], months: [] })} />)
    expect(container.textContent).toBe('')
  })
})

describe('CarrierCosts and a month outside the record', () => {
  /**
   * A month we were not counting parcels for shows its bill and refuses
   * everything derived from parcels: printing the few parcels we happened to
   * see invites dividing the whole-month bill by them by hand, and that
   * quotient is exactly the wrong number the flag exists to prevent.
   */
  it('shows the bill but neither a parcel count nor a per-parcel figure', () => {
    render(
      <CarrierCosts
        {...props({
          months: [month({ month: '2026-06', counted: false, source: 'bring' })],
          carriers: [average({ averageMinor: null, cost: null, monthsCounted: [] })],
        })}
      />,
    )
    expect(screen.getByText(/20,000\.00/)).toBeInTheDocument()
    const cells = screen.getAllByRole('cell').map((c) => c.textContent ?? '')
    expect(cells.some((t) => t.includes('400'))).toBe(false)
  })

  it('shows the count and the division for a month inside the record', () => {
    render(<CarrierCosts {...props()} />)
    const cells = screen.getAllByRole('cell').map((c) => c.textContent ?? '')
    expect(cells.some((t) => t.includes('400'))).toBe(true)
    expect(cells.some((t) => t.includes('50.00'))).toBe(true)
  })
})

/**
 * The card the client quoted back because he could not read it: "DHL - 28
 * parcels. Enter an invoice below to see the cost." above a row of dashes with
 * nowhere useful to type, and a bare 324814.90 in a box with nothing saying
 * what it was. Every change here answers that message.
 */
describe('CarrierCosts, kept readable', () => {
  it('does not show a month that can neither show money nor accept any', () => {
    render(
      <CarrierCosts
        {...props({
          months: [month({ month: '2026-08', counted: false, amount: null, source: null })],
          carriers: [average({ averageMinor: null, cost: null, monthsCounted: [] })],
        })}
      />,
    )
    expect(screen.queryByText(/august 2026/i)).not.toBeInTheDocument()
  })

  it('drops the whole table when every month is hidden, rather than showing headers over nothing', () => {
    render(
      <CarrierCosts
        {...props({
          months: [month({ month: '2026-08', counted: false, amount: null, source: null })],
          carriers: [average({ averageMinor: null, cost: null, monthsCounted: [] })],
        })}
      />,
    )
    expect(screen.queryByText('Month')).not.toBeInTheDocument()
  })

  /**
   * A bill Bring sent is a fact to read, not a box to edit: shown as money,
   * with its label, never as a bare figure in an input. "324814.90" in a box
   * was the exact thing the client said he could not understand.
   */
  it('shows a Bring bill as formatted money with its label, not as an editable box', () => {
    render(
      <CarrierCosts
        {...props({
          months: [month({ month: '2026-07', counted: false, amount: 324_814_90, source: 'bring' })],
          carriers: [average({ averageMinor: null, cost: null, monthsCounted: [] })],
        })}
      />,
    )
    expect(screen.getByText(/324,814\.90/)).toBeInTheDocument()
    // Exact, because the card's intro also contains the words "from Bring".
    expect(screen.getByText('from Bring')).toBeInTheDocument()
    expect(screen.queryByLabelText(/invoice for july 2026/i)).not.toBeInTheDocument()
  })

  it('keeps the typing box for a month a person is meant to fill in', () => {
    render(
      <CarrierCosts
        {...props({
          months: [month({ carrier: 'DHL', month: '2026-09', counted: true, amount: null, source: null })],
          carriers: [average({ carrier: 'DHL', averageMinor: null, cost: null, monthsCounted: [] })],
        })}
      />,
    )
    expect(screen.getByLabelText(/invoice for september 2026/i)).toBeInTheDocument()
  })
})
