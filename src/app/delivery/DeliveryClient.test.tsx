// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { AwaitingFile, LateList, Split, type LateOrder } from './DeliveryClient'
import type { DeliveryStats } from '@/lib/delivery/stats'

const order = (over: Partial<LateOrder> = {}): LateOrder => ({
  id: 'o1', number: '15749', customerName: null, shop: 'Panetti Germany', country: 'DE',
  daysOver: 4, promiseDays: 5, state: 'IN_TRANSIT',
  parcels: [{
    number: '9597256404', carrier: 'DHL',
    url: 'https://www.dhl.com/global-en/home/tracking.html?tracking-id=9597256404',
  }],
  ...over,
})

const stats = (over: Partial<DeliveryStats> = {}): DeliveryStats => ({
  delivered: 24, medianDays: 3, medianWarehouseDays: null, medianTransitDays: null,
  onTimeRate: 0.96, judged: 24, unjudged: 0, lateNow: 115, noTracking: 638,
  booked: 3, inTransit: 21, distribution: [], byCountry: [],
  ...over,
})

describe('LateList', () => {
  it('lists an order that has a parcel to chase', () => {
    const { container } = render(<LateList rows={[order()]} total={1} judged={24} />)
    expect(container.textContent).toMatch(/15749/)
    expect(container.textContent).toMatch(/9597256404/)
    expect(container.textContent).toMatch(/DHL/)
  })

  /**
   * The order number identifies the row for us. It is not what somebody
   * writing an apology needs, and looking each one up meant opening every
   * order in turn.
   */
  it('names the customer who is waiting', () => {
    const { container } = render(
      <LateList rows={[order({ customerName: 'Kristian Coster' })]} total={1} judged={24} />,
    )
    expect(container.textContent).toMatch(/Kristian Coster/)
  })

  // Null and '' both mean "we hold no name", and neither must print as the
  // word null at a person. A dash is the page's existing way of saying so.
  it('prints a dash rather than the word null when no name was captured', () => {
    const { container } = render(
      <LateList rows={[order({ customerName: null })]} total={1} judged={24} />,
    )
    expect(container.textContent).not.toMatch(/null/i)
  })

  /**
   * The tile above counts the live queue — still not with the customer — while
   * this list deliberately keeps orders that have since arrived, so the two
   * legitimately differ. Left unexplained that is the same complaint that
   * started this: a number on the page matching nothing under it.
   */
  it('reconciles itself with the tile when some rows have already arrived', () => {
    const { container } = render(
      <LateList rows={[order(), order({ id: 'o2', state: 'AVAILABLE' })]} total={2} stillOut={1} judged={24} />,
    )
    expect(container.textContent).toMatch(/1 still out/i)
  })

  it('says nothing extra when every row is still out', () => {
    const { container } = render(
      <LateList rows={[order()]} total={1} stillOut={1} judged={24} />,
    )
    expect(container.textContent).not.toMatch(/still out/i)
  })
})

/**
 * Live on 2026-08-18 the Late list ran to ~120 rows, SIX of which had a parcel.
 * The rest were orders no warehouse file had mentioned yet. Two problems in
 * one: the six actionable rows were invisible, and the other ~114 were filed
 * under "missed its promise" when the truth is only that we never heard about
 * them.
 */
describe('AwaitingFile', () => {
  const bare = order({ id: 'o2', number: '27345', shop: 'Panetti Norway', country: 'NO',
    daysOver: 5, promiseDays: 4, state: 'NO_TRACKING', parcels: [] })

  it('states the count without being opened, so the size is never hidden', () => {
    const { container } = render(<AwaitingFile rows={[bare]} total={109} />)
    expect(container.textContent).toMatch(/109/)
  })

  it('stays shut by default, so it cannot bury the orders that can be chased', () => {
    render(<AwaitingFile rows={[bare]} total={109} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('27345')).not.toBeInTheDocument()
  })

  it('shows the orders once opened', () => {
    render(<AwaitingFile rows={[bare]} total={1} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('27345')).toBeInTheDocument()
  })

  // These are the rows most likely to need a phone call — nobody can even say
  // whether the parcel exists — so the name matters here at least as much.
  it('names the customer once opened', () => {
    render(<AwaitingFile rows={[{ ...bare, customerName: 'Louise Nielsen' }]} total={1} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Louise Nielsen')).toBeInTheDocument()
  })

  /**
   * The whole point of the split. A missing file is not evidence of a missed
   * promise, so this section must not use the word for one.
   */
  it('does not call these orders late, because nothing has said that they are', () => {
    const { container } = render(<AwaitingFile rows={[bare]} total={109} />)
    expect(container.textContent).not.toMatch(/\blate\b/i)
    expect(container.textContent).toMatch(/no warehouse file/i)
  })
})

describe('Split', () => {
  /**
   * Both halves need a handover time, which only ever arrives as a carrier
   * event. Orders already delivered when first seen never record one, so this
   * panel showed two dashes and nothing else — a blank that reads identically
   * to "zero days" and to "still loading".
   */
  it('says why it is blank rather than showing two dashes', () => {
    // Deliberately NOT /handover/, which the panel's own subtitle already
    // contains — that would pass without the reason ever being added.
    const { container } = render(<Split stats={stats()} />)
    expect(container.textContent).toMatch(/no handover time/i)
  })

  it('says the plainer thing when nothing has been delivered at all', () => {
    const { container } = render(
      <Split stats={stats({ delivered: 0, medianDays: null, judged: 0 })} />,
    )
    expect(container.textContent).toMatch(/nothing.*delivered|delivered.*yet/i)
  })

  it('draws the bars normally once there is a handover time', () => {
    const { container } = render(
      <Split stats={stats({ medianWarehouseDays: 1, medianTransitDays: 2 })} />,
    )
    expect(container.textContent).toMatch(/1 day/)
    expect(container.textContent).toMatch(/2 days/)
    expect(container.textContent).not.toMatch(/handover time/i)
  })
})
