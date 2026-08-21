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
  /**
   * In the app's own money style: space-grouped, code suffix - the format the
   * finance page and the Slack warning already use, chosen there because the
   * reader is Norwegian and both comma and dot mean the decimal separator to
   * him. One figure must not read one way on /finance and another here.
   */
  it('states the cost of sending one parcel, in the same style as the finance page', () => {
    const { container } = render(<CarrierCosts {...props()} />)
    expect(container.textContent).toContain('50.00 NOK')
  })

  /**
   * The client read the bill lists and asked whether those prices were the
   * "average cost per shipment". They are not - they are the bills - and the
   * confusion was the card's fault: the one number that IS the average had no
   * name of its own. The title now carries his word, and the figure labels
   * itself where it stands, so the two can never be read as each other.
   */
  it('is titled with his own word for it: Average cost per parcel', () => {
    render(<CarrierCosts {...props()} />)
    expect(screen.getByText('Average cost per parcel')).toBeInTheDocument()
  })

  it('labels the figure itself, right where it stands', () => {
    render(<CarrierCosts {...props()} />)
    expect(screen.getByText('average per parcel')).toBeInTheDocument()
  })

  it('shows no stray label while the figure is still to come', () => {
    render(
      <CarrierCosts
        {...props({ carriers: [average({ averageMinor: null, cost: null, monthsCounted: [] })] })}
      />,
    )
    expect(screen.queryByText('average per parcel')).not.toBeInTheDocument()
  })

  it('names the carrier the figure belongs to', () => {
    const { container } = render(<CarrierCosts {...props()} />)
    expect(container.textContent).toMatch(/Bring/i)
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
  /**
   * The when matters more than the mechanism: Philip reads "September will be
   * the first month" and looks in September, but the figure lands when the
   * month's last bill does, in early October. Say the arrival, not the label.
   */
  it('says when the first cost per parcel arrives, and for which month', () => {
    render(
      <CarrierCosts
        {...props({
          firstMonth: '2026-09',
          carriers: [average({ averageMinor: null, cost: null, monthsCounted: [] })],
        })}
      />,
    )
    expect(screen.getByText(/comes in early october/i)).toBeInTheDocument()
    expect(screen.getByText(/for september 2026/i)).toBeInTheDocument()
    expect(screen.queryByText(/enter an invoice below/i)).not.toBeInTheDocument()
  })

  /** DHL reads the same as Bring: the sources live once, in the card's intro. */
  it('gives DHL the same plain sentence, with nothing to type', () => {
    render(
      <CarrierCosts
        {...props({
          firstMonth: '2026-09',
          carriers: [average({ carrier: 'DHL', averageMinor: null, cost: null, monthsCounted: [] })],
          months: [month({ carrier: 'DHL', month: '2026-08', counted: false, amount: null })],
        })}
      />,
    )
    expect(screen.getByText(/comes in early october, for september 2026/i)).toBeInTheDocument()
    expect(screen.queryByText(/type dhl/i)).not.toBeInTheDocument()
  })

  /**
   * The card's own opening lines, which outlived the world they described.
   * After Bring became automatic they still read "Enter each carrier's
   * monthly invoice below" and "Bring and DHL only tell us where a parcel
   * is, never what it cost" - the first an instruction not to follow, the
   * second now plainly false for Bring. The client pasted these exact lines
   * back and asked what they meant.
   */
  it('opens by saying both carriers fill in by themselves', () => {
    render(<CarrierCosts {...props()} />)
    expect(screen.getByText(/fill in by themselves/i)).toBeInTheDocument()
    expect(screen.queryByText(/typed in/i)).not.toBeInTheDocument()
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
  /**
   * The client pasted the June and July rows back and asked "why are there 2
   * months here". A table row that is dashes in three of four columns reads
   * as broken data, however real the money in it is. A month from before the
   * record is one FACT - what Bring billed - so it renders as one sentence
   * that says exactly that, and never as a row.
   */
  /**
   * DHL's six months arrived as one comma-run sentence and the client said he
   * could not read it. Money reads as rows: month on the left, amount on the
   * right, digits aligned - the same shape as every other money list he uses.
   */
  it('lists the old bills as rows of month and money, not a comma-run sentence', () => {
    render(
      <CarrierCosts
        {...props({
          months: [
            month({ month: '2026-07', counted: false, amount: 324_814_90, source: 'bring' }),
            month({ month: '2026-06', counted: false, amount: 233_785_88, source: 'bring' }),
          ],
          carriers: [average({ averageMinor: null, cost: null, monthsCounted: [] })],
        })}
      />,
    )
    expect(screen.getByText(/what bring billed/i)).toBeInTheDocument()
    expect(screen.getByText('233 785.88 NOK')).toBeInTheDocument()
    expect(screen.getByText('324 814.90 NOK')).toBeInTheDocument()
    // Still no table headers: these are bills, not months to divide.
    expect(screen.queryByText('Month')).not.toBeInTheDocument()
  })

  /** Six months of bills deserve one answer at the bottom. */
  it('sums the old bills, so nobody adds six figures in their head', () => {
    render(
      <CarrierCosts
        {...props({
          months: [
            month({ month: '2026-07', counted: false, amount: 324_814_90, source: 'bring' }),
            month({ month: '2026-06', counted: false, amount: 233_785_88, source: 'bring' }),
          ],
          carriers: [average({ averageMinor: null, cost: null, monthsCounted: [] })],
        })}
      />,
    )
    expect(screen.getByText(/so far/i)).toBeInTheDocument()
    expect(screen.getByText('558 600.78 NOK')).toBeInTheDocument()
  })

  it('offers no sum for a single bill, which is its own total', () => {
    render(
      <CarrierCosts
        {...props({
          months: [month({ month: '2026-06', counted: false, amount: 233_785_88, source: 'bring' })],
          carriers: [average({ averageMinor: null, cost: null, monthsCounted: [] })],
        })}
      />,
    )
    expect(screen.queryByText(/so far/i)).not.toBeInTheDocument()
  })

  it('lists the old bills oldest first, the order a person reads months in', () => {
    const { container } = render(
      <CarrierCosts
        {...props({
          months: [
            month({ month: '2026-07', counted: false, amount: 324_814_90, source: 'bring' }),
            month({ month: '2026-06', counted: false, amount: 233_785_88, source: 'bring' }),
          ],
          carriers: [average({ averageMinor: null, cost: null, monthsCounted: [] })],
        })}
      />,
    )
    const text = container.textContent ?? ''
    expect(text.indexOf('June')).toBeLessThan(text.indexOf('July'))
  })

  it('shows the table for real months and the sentence for old bills side by side', () => {
    render(
      <CarrierCosts
        {...props({
          months: [
            month({ carrier: 'BRING', month: '2026-09', counted: true, amount: null, source: null }),
            month({ month: '2026-06', counted: false, amount: 233_785_88, source: 'bring' }),
          ],
          carriers: [average({ averageMinor: null, cost: null, monthsCounted: [] })],
        })}
      />,
    )
    expect(screen.getByText('Month')).toBeInTheDocument()
    expect(screen.getByText(/september 2026/i)).toBeInTheDocument()
    expect(screen.getByText(/what bring billed/i)).toBeInTheDocument()
  })

  it('shows the count and the division for a month inside the record', () => {
    render(<CarrierCosts {...props()} />)
    const cells = screen.getAllByRole('cell').map((c) => c.textContent ?? '')
    expect(cells.some((t) => t.includes('400'))).toBe(true)
    expect(cells.some((t) => t.includes('50.00 NOK'))).toBe(true)
  })
})

/**
 * The card the client quoted back because he could not read it: "DHL - 28
 * parcels. Enter an invoice below to see the cost." above a row of dashes with
 * nowhere useful to type, and a bare 324814.90 in a box with nothing saying
 * what it was. Every change here answers that message.
 */
describe('CarrierCosts and a figure read from Visma', () => {
  it('shows a DHL bill from the accounting as money with its label, not an editable box', () => {
    render(
      <CarrierCosts
        {...props({
          carriers: [average({ carrier: 'DHL', averageMinor: null, cost: null, monthsCounted: [] })],
          months: [month({ carrier: 'DHL', month: '2026-09', counted: true, amount: 23_455_00, source: 'visma' })],
        })}
      />,
    )
    expect(screen.getByText('23 455.00 NOK')).toBeInTheDocument()
    expect(screen.getByText('from Visma')).toBeInTheDocument()
    expect(screen.queryByLabelText(/invoice for september 2026/i)).not.toBeInTheDocument()
  })
})

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
  /** From October: September's row, its bill read from Bring, inside the table. */
  it('shows a Bring bill in a real month as formatted money with its label, not an editable box', () => {
    render(
      <CarrierCosts
        {...props({
          months: [month({ month: '2026-09', counted: true, amount: 324_814_90, source: 'bring' })],
          carriers: [average({ averageMinor: null, cost: null, monthsCounted: [] })],
        })}
      />,
    )
    expect(screen.getByText('324 814.90 NOK')).toBeInTheDocument()
    // Exact, because the card's intro also contains the words "from Bring".
    expect(screen.getByText('from Bring')).toBeInTheDocument()
    expect(screen.queryByLabelText(/invoice for september 2026/i)).not.toBeInTheDocument()
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
