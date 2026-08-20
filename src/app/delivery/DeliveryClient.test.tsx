// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { LateList, NoTracking, Pipeline, Split, Tiles, type LateOrder } from './DeliveryClient'
import type { DeliveryStats } from '@/lib/delivery/stats'

const order = (over: Partial<LateOrder> = {}): LateOrder => ({
  id: 'o1', number: '15749', customerName: null, shop: 'Panetti Germany', country: 'DE',
  daysOver: 4, waitingDays: 9, placedOn: '2026-08-11', promiseDays: 5, state: 'IN_TRANSIT',
  parcels: [{
    number: '9597256404', carrier: 'DHL',
    url: 'https://www.dhl.com/global-en/home/tracking.html?tracking-id=9597256404',
  }],
  ...over,
})

const stats = (over: Partial<DeliveryStats> = {}): DeliveryStats => ({
  delivered: 24, medianDays: 3, medianWarehouseDays: null, medianTransitDays: null,
  onTimeRate: 0.96, judged: 24, unjudged: 0, lateNow: 115, noTracking: 638,
  booked: 3, inTransit: 21, collected: 20, readyForCollection: 4,
  distribution: [], byCountry: [],
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
   * "Available" said both "waiting at a pickup point" and "in the customer's
   * hands". DHL only ever reports the second, so a DHL row badged "Available"
   * beside a DHL tracking page that said "Delivered".
   */
  it('says delivered when the customer has the parcel', () => {
    const { container } = render(
      <LateList rows={[order({ state: 'DELIVERED' })]} total={1} judged={24} />,
    )
    expect(container.textContent).toMatch(/Delivered/)
  })

  it('says ready for collection while a parcel waits at a pickup point', () => {
    const { container } = render(
      <LateList rows={[order({ state: 'AVAILABLE' })]} total={1} judged={24} />,
    )
    expect(container.textContent).toMatch(/Ready for collection/i)
    // The word on its own is the ambiguity being removed.
    expect(container.textContent).not.toMatch(/\bAvailable\b/)
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
 * The rest were orders no warehouse file had mentioned yet.
 *
 * That split gave those rows their own section, but the section only ever held
 * the ones ALSO past their promise, while the tile above counted every order
 * with no parcel. Two numbers over overlapping sets — the same shape as the
 * 155-against-8 bug — and no way at all to see the other rows. The section now
 * holds the whole set the tile counts, and the tile opens it.
 */
describe('NoTracking', () => {
  const bare = order({ id: 'o2', number: '27345', shop: 'Panetti Norway', country: 'NO',
    daysOver: 5, waitingDays: 9, promiseDays: 4, state: 'NO_TRACKING', parcels: [] })

  const shut = (props: Partial<Parameters<typeof NoTracking>[0]> = {}) => (
    <NoTracking rows={[bare]} total={109} open={false} onToggle={() => {}} {...props} />
  )

  it('states the count without being opened, so the size is never hidden', () => {
    const { container } = render(shut())
    expect(container.textContent).toMatch(/109/)
  })

  it('stays shut by default, so it cannot bury the orders that can be chased', () => {
    render(shut())
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('27345')).not.toBeInTheDocument()
  })

  it('shows the orders once opened', () => {
    render(shut({ total: 1, open: true }))
    expect(screen.getByText('27345')).toBeInTheDocument()
  })

  // These are the rows most likely to need a phone call — nobody can even say
  // whether the parcel exists — so the name matters here at least as much.
  it('names the customer once opened', () => {
    render(shut({ rows: [{ ...bare, customerName: 'Louise Nielsen' }], total: 1, open: true }))
    expect(screen.getByText('Louise Nielsen')).toBeInTheDocument()
  })

  /**
   * A missing file is not evidence of a missed promise, so this section must
   * not use the word for one about the set as a whole.
   */
  it('does not call these orders late, because nothing has said that they are', () => {
    const { container } = render(shut())
    expect(container.textContent).not.toMatch(/\blate\b/i)
    expect(container.textContent).toMatch(/no warehouse file/i)
  })

  /**
   * The widening. "Days over" is meaningless for an order still inside its
   * promise, and those orders are most of this list — so the column has to be
   * how long we have been in the dark, not how far past a deadline.
   */
  it('holds orders that are not past their promise at all', () => {
    const fresh = { ...bare, id: 'o3', number: '27346', daysOver: 0, waitingDays: 1 }
    render(shut({ rows: [fresh], total: 1, open: true }))
    expect(screen.getByText('27346')).toBeInTheDocument()
  })

  it('says how long each order has been waiting', () => {
    const { container } = render(shut({ total: 1, open: true }))
    expect(container.textContent).toMatch(/Waiting/)
    expect(container.textContent).toMatch(/9d/)
  })

  // In words, not by colour: this table is read by someone deciding who to
  // chase first, and red on its own says nothing to a colour-blind reader.
  it('marks in words the ones that are past their promise', () => {
    const { container } = render(shut({ total: 1, open: true }))
    expect(container.textContent).toMatch(/past promise/i)
  })

  it('says nothing of the sort for an order still inside its promise', () => {
    const fresh = { ...bare, id: 'o3', daysOver: 0, waitingDays: 1 }
    const { container } = render(shut({ rows: [fresh], total: 1, open: true }))
    expect(container.textContent).not.toMatch(/past promise/i)
  })

  /**
   * "1d" says how long, not when. Somebody chasing an order needs the date it
   * was placed to find it in the warehouse's own system, and needs to be able
   * to read the list from either end.
   */
  describe('order date', () => {
    const older = { ...bare, id: 'a', number: 'OLD', placedOn: '2026-08-01', waitingDays: 19 }
    const newer = { ...bare, id: 'b', number: 'NEW', placedOn: '2026-08-15', waitingDays: 5 }

    const numbers = (c: HTMLElement) =>
      [...c.querySelectorAll('tbody tr td:first-child')].map((td) => td.textContent?.trim())

    const both = () => shut({ rows: [older, newer], total: 2, open: true })

    it('shows the date the order was placed', () => {
      const { container } = render(shut({ total: 1, open: true }))
      expect(container.textContent).toMatch(/11 Aug 2026/)
    })

    // Newest first on the first press: the list already opens oldest-first, so
    // opening it that way again would look like the press did nothing.
    it('sorts newest first on the first press', () => {
      const { container } = render(both())
      fireEvent.click(screen.getByRole('button', { name: /ordered/i }))
      expect(numbers(container)).toEqual(['NEW', 'OLD'])
    })

    it('flips to oldest first on the second press', () => {
      const { container } = render(both())
      fireEvent.click(screen.getByRole('button', { name: /ordered/i }))
      fireEvent.click(screen.getByRole('button', { name: /ordered/i }))
      expect(numbers(container)).toEqual(['OLD', 'NEW'])
    })

    // Longest waiting first, which is the order the route sent them in.
    it('leaves the rows as they arrived until asked', () => {
      const { container } = render(both())
      expect(numbers(container)).toEqual(['OLD', 'NEW'])
    })
  })
})

/**
 * The client's words: "there is no way for me to press the no tracking to
 * actually see which orders are missing tracking".
 */
describe('Tiles', () => {
  it('makes the no-tracking count something you can press', () => {
    const onShow = vi.fn()
    render(<Tiles stats={stats({ noTracking: 45 })} onShowNoTracking={onShow} />)
    fireEvent.click(screen.getByRole('button', { name: /no tracking/i }))
    expect(onShow).toHaveBeenCalled()
  })

  // Nothing to show, nothing to press: a button opening an empty section is a
  // dead end dressed up as an action.
  it('leaves it as plain text when there is nothing to show', () => {
    render(<Tiles stats={stats({ noTracking: 0 })} onShowNoTracking={() => {}} />)
    expect(screen.queryByRole('button', { name: /no tracking/i })).not.toBeInTheDocument()
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

/**
 * The strip is four positions along one journey. Its last one said "Delivered"
 * and counted every order whose clock had stopped, so a parcel still sitting
 * at a Nordic pickup point was reported as delivered — the same conflation the
 * badges had, one level up the page. Fixing the badge alone would have left
 * the two contradicting each other on one screen.
 */
describe('Pipeline', () => {
  it('gives the parcels waiting at a pickup point their own position', () => {
    const { container } = render(
      <Pipeline
        stats={stats({ delivered: 5, collected: 3, readyForCollection: 2 })}
        lastCheckedAt={null}
      />,
    )
    expect(container.textContent).toMatch(/Ready for collection2/)
  })

  it('counts only collected parcels under Delivered', () => {
    const { container } = render(
      <Pipeline
        stats={stats({ delivered: 5, collected: 3, readyForCollection: 2 })}
        lastCheckedAt={null}
      />,
    )
    expect(container.textContent).toMatch(/Delivered3/)
  })

  // The bar is still one journey, so the stages have to add up to the orders
  // in it and not double-count the ones that arrived.
  it('does not count an arrived order twice', () => {
    const { container } = render(
      <Pipeline
        stats={stats({ noTracking: 0, booked: 0, inTransit: 0, delivered: 5, collected: 3, readyForCollection: 2 })}
        lastCheckedAt={null}
      />,
    )
    expect(container.textContent).not.toMatch(/Delivered5/)
  })
})
