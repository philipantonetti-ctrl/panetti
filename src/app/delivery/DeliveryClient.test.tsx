// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {
  ImportsList, LateList, NoTracking, Pipeline, Split, Tiles, UnattachedParcels,
  type LateOrder, type UnlinkedParcel,
} from './DeliveryClient'
import type { DeliveryStats } from '@/lib/delivery/stats'
import { ToastProvider } from '@/components/toast/ToastProvider'

const order = (over: Partial<LateOrder> = {}): LateOrder => ({
  id: 'o1', number: '15749', customerName: null, shop: 'Panetti Germany', country: 'DE',
  daysOver: 4, waitingDays: 9, placedAtLocal: '2026-08-11T14:30:00', promiseDays: 5, state: 'IN_TRANSIT',
  parcels: [{
    number: '9597256404', carrier: 'DHL',
    url: 'https://www.dhl.com/se-en/home/tracking/tracking-freight.html?tracking-id=9597256404&submit=1',
  }],
  ...over,
})

const stats = (over: Partial<DeliveryStats> = {}): DeliveryStats => ({
  delivered: 24, medianDays: 3, medianWarehouseDays: null, medianTransitDays: null,
  splitDelivered: 0, medianSplitDays: null,
  onTimeRate: 0.96, judged: 24, unjudged: 0, lateNow: 115, noTracking: 638,
  booked: 3, inTransit: 21, collected: 20, readyForCollection: 4, notDue: 6,
  deliveredUndated: 0,
  distribution: [], byCountry: [],
  ...over,
})

describe('the warehouse-vs-transit split', () => {
  it('says how many journeys the bars describe, and their own total', () => {
    const { container } = render(
      <Split stats={stats({ delivered: 89, splitDelivered: 8, medianSplitDays: 8, medianWarehouseDays: 2.5, medianTransitDays: 6 })} />,
    )
    expect(container.textContent).toContain('8 of the 89')
    expect(container.textContent).toContain('8 days start to door')
  })
})

describe('the pipeline labels', () => {
  /**
   * "Too new to say" was accurate and meaningless: the client pasted it back
   * and asked what the words meant. The orders it counted were simply just
   * placed - the warehouse's evening file that would carry their tracking
   * number has not been produced yet. The label now names the journey
   * position, like every other stage in the bar.
   */
  it('calls a brand-new order "Just ordered", not "Too new to say"', () => {
    const { container } = render(<Pipeline stats={stats({ notDue: 16 })} lastCheckedAt={null} />)
    expect(container.textContent).toContain('Just ordered')
    expect(container.textContent).not.toContain('Too new to say')
  })
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
   * The client's words: "when order is delivered or ready for collection, it
   * can go away from the Late section."
   *
   * The heading used to advertise that it kept them, and then reconcile itself
   * with the tile above in a second sentence - a number on the page matching
   * nothing under it, which is the complaint that started all of this. The rows
   * are now exactly what the tile counts, so there is nothing left to reconcile
   * and nothing left to explain away. Which orders the route sends is held in
   * place by api/delivery/route.integration.test.ts; this holds the heading to
   * the same story, because a heading that outlives the rule it describes is
   * how the page came to disagree with itself in the first place.
   */
  it('does not advertise itself as holding orders that have already arrived', () => {
    const { container } = render(<LateList rows={[order()]} total={1} judged={24} />)
    expect(container.textContent).not.toMatch(/since arrived/i)
    expect(container.textContent).not.toMatch(/still out/i)
  })

  /**
   * The empty state became far more reachable with this change: a range where
   * every late parcel has since arrived now empties the list. "No parcel is
   * past its promise in this range" is a plain lie about such a range - some
   * were, they simply arrived - and the on-time rate sitting above it would be
   * saying so at the same time.
   */
  it('does not claim nothing was late when the late ones have merely arrived', () => {
    const { container } = render(<LateList rows={[]} total={0} judged={24} />)
    expect(container.textContent).toMatch(/still not with the customer/i)
  })

  // The other empty state, unchanged: nothing has been judged at all, which is
  // a different piece of news and must not be reported as "nothing is late".
  it('still says when no order has been judged yet', () => {
    const { container } = render(<LateList rows={[]} total={0} judged={0} />)
    expect(container.textContent).toMatch(/nothing to chase/i)
  })

  it('says plainly that every row is still away from the customer', () => {
    const { container } = render(<LateList rows={[order()]} total={1} judged={24} />)
    expect(container.textContent).toMatch(/still not reached the customer/i)
  })
})

/**
 * Live on 2026-08-18 the Late list ran to ~120 rows, SIX of which had a parcel.
 * The rest were orders no warehouse file had mentioned yet.
 *
 * That split gave those rows their own section, but the section only ever held
 * the ones ALSO past their promise, while the tile above counted every order
 * with no parcel. Two numbers over overlapping sets - the same shape as the
 * 155-against-8 bug - and no way at all to see the other rows. The section now
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

  // These are the rows most likely to need a phone call - nobody can even say
  // whether the parcel exists - so the name matters here at least as much.
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
    expect(container.textContent).toMatch(/we hold no parcel/i)
  })

  /**
   * The widening. "Days over" is meaningless for an order still inside its
   * promise, and those orders are most of this list - so the column has to be
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
    const older = { ...bare, id: 'a', number: 'OLD', placedAtLocal: '2026-08-01T09:00:00', waitingDays: 19 }
    const newer = { ...bare, id: 'b', number: 'NEW', placedAtLocal: '2026-08-15T09:00:00', waitingDays: 5 }

    const numbers = (c: HTMLElement) =>
      [...c.querySelectorAll('tbody tr td:first-child')].map((td) => td.textContent?.trim())

    const both = () => shut({ rows: [older, newer], total: 2, open: true })

    it('shows the date the order was placed', () => {
      const { container } = render(shut({ total: 1, open: true }))
      expect(container.textContent).toMatch(/11 Aug 2026/)
    })

    // Newest first on the first press: the list already opens oldest-first, so
    // opening it that way again would look like the press did nothing.
    /**
     * The time is what decides which warehouse file an order belongs in: the
     * cutoff is noon. A date alone cannot answer "was this before or after
     * twelve", which is the question the No-tracking rule turns on.
     */
    it('shows the time the order came in beside the date', () => {
      const { container } = render(shut({ total: 1, open: true }))
      expect(container.textContent).toMatch(/11 Aug 2026/)
      expect(container.textContent).toMatch(/14:30/)
    })

    it('sorts two orders from the same day by their time', () => {
      const morning = { ...bare, id: 'm', number: 'AM', placedAtLocal: '2026-08-11T09:00:00' }
      const evening = { ...bare, id: 'e', number: 'PM', placedAtLocal: '2026-08-11T17:00:00' }
      const { container } = render(shut({ rows: [morning, evening], total: 2, open: true }))
      fireEvent.click(screen.getByRole('button', { name: /ordered/i }))
      expect(numbers(container)).toEqual(['PM', 'AM'])
    })

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
   * panel showed two dashes and nothing else - a blank that reads identically
   * to "zero days" and to "still loading".
   */
  it('says why it is blank rather than showing two dashes', () => {
    // Deliberately NOT /handover/, which the panel's own subtitle already
    // contains - that would pass without the reason ever being added.
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
 * at a Nordic pickup point was reported as delivered - the same conflation the
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

  /**
   * An order the warehouse file reports delivered, which the carrier has not
   * yet dated, is a real position on this journey. Without a stage of its own
   * it belongs to none of the others - it is not in transit, and it cannot
   * join `collected`, which is a population of dates - so the bar would
   * quietly stop adding up to the orders it was given.
   */
  it('gives an arrival with no date yet its own position', () => {
    const { container } = render(
      <Pipeline
        stats={stats({ delivered: 5, collected: 3, readyForCollection: 2, deliveredUndated: 4 })}
        lastCheckedAt={null}
      />,
    )
    expect(container.textContent).toMatch(/Delivered, no date yet4/)
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

/**
 * The 2026-08-28 file put 60 identical "Ran out of time before Bring could be
 * asked" lines under one import row - twelve rendered, "and 52 more" hidden -
 * and the client asked what the wall of text meant. A reason repeated N times
 * is ONE fact about the night, not N facts, so identical reasons collapse to
 * a single line carrying the count and a few of the numbers.
 */
describe('ImportsList refusals', () => {
  const row = (unmatched: unknown) => ({
    id: 'i1', filename: 'eod.xlsx', receivedAt: '2026-08-29T00:01:40.000Z',
    rowsParsed: 64, rowsLinked: 0, rowsUnmatched: 64, namesRead: null, error: null,
    source: 'EMAIL',
    unmatched: JSON.stringify(unmatched),
  })
  const entry = (n: number, reason: string) => ({
    orderNumber: '(not identified)',
    trackingNumber: '4733253800000' + String(n).padStart(5, '0'),
    reason,
  })

  it('collapses a repeated reason into one line with a count', () => {
    const sixty = Array.from({ length: 60 }, (_, n) =>
      entry(n, 'Ran out of time before Bring could be asked about this number'))
    const { container } = render(<ImportsList items={[row(sixty)]} />)

    const text = container.textContent ?? ''
    const mentions = text.split('Ran out of time before Bring could be asked').length - 1
    expect(mentions).toBe(1)
    expect(text).toContain('60 parcels')
  })

  it('shows only a few numbers per group, and counts the rest', () => {
    const sixty = Array.from({ length: 60 }, (_, n) =>
      entry(n, 'Ran out of time before Bring could be asked about this number'))
    const { container } = render(<ImportsList items={[row(sixty)]} />)

    expect(container.querySelectorAll('a').length).toBeLessThanOrEqual(8)
    expect(container.textContent).toContain('and 52 more')
  })

  it('leaves one-off reasons exactly as they were: number, then reason', () => {
    const { container } = render(
      <ImportsList items={[row([
        entry(1, 'No order for globe@trotter.test'),
        entry(2, 'Bring has no parcel with this number'),
      ])]} />,
    )
    const text = container.textContent ?? ''
    expect(text).toContain('No order for globe@trotter.test')
    expect(text).toContain('Bring has no parcel with this number')
    expect(text).not.toContain('parcels')
    // Both numbers still render, still as tracking links.
    expect(container.querySelectorAll('a').length).toBe(2)
  })
})

const parcel = (over: Partial<UnlinkedParcel> = {}): UnlinkedParcel => ({
  trackingNumber: '473325380023179098', carrier: 'DHL',
  url: 'https://www.dhl.com/se-en/home/tracking.html?tracking-id=473325380023179098',
  lastStatus: 'DELIVERED', destinationCountry: 'DE', bookedAt: '2026-09-07T17:30:00.000Z', weightKg: 18.2,
  recipientName: null, reason: 'DHL parcel to DE: DHL gives no name or email, so no order could be matched by itself',
  identifiedAt: '2026-09-08T00:15:00.000Z', createdAt: '2026-09-07T16:00:00.000Z',
  candidates: [
    { orderId: 'o-15864', number: '15864', shop: 'Panetti Germany', customerName: 'Tobias Kohlmeyer', placedAt: '2026-09-07T15:49:00.000Z', items: '1 x Panetti ProMix', holdsParcel: false, sameName: true },
    { orderId: 'o-15865', number: '15865', shop: 'Panetti Germany', customerName: 'Martin Röthke', placedAt: '2026-09-07T16:29:00.000Z', items: '1 x Pizza oven', holdsParcel: true, sameName: false },
  ],
  candidatesTotal: 2,
  ...over,
})

const SHOPS = [{ id: 's-de', name: 'Panetti Germany' }]

afterEach(() => vi.unstubAllGlobals())

describe('UnattachedParcels', () => {
  it('shows the carrier, where it goes, the weight, the status, the name on the label and the reason', () => {
    const { container } = render(
      <ToastProvider><UnattachedParcels items={[parcel()]} total={1} shops={SHOPS} onChanged={() => {}} /></ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Parcels that need a person/ }))
    expect(container.textContent).toContain('DHL')
    expect(container.textContent).toContain('DE')
    expect(container.textContent).toContain('18.2 kg')
    expect(container.textContent).toContain('DELIVERED')
    expect(container.textContent).toContain('DHL gives no name or email')
  })

  it('says "no name yet" when the carrier gave no recipient name', () => {
    const { container } = render(
      <ToastProvider><UnattachedParcels items={[parcel({ recipientName: null })]} total={1} shops={SHOPS} onChanged={() => {}} /></ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Parcels that need a person/ }))
    expect(container.textContent).toContain('no name yet')
  })

  it('offers each candidate as an option naming the order, the customer and what they bought, flagging a same-name match and one that already holds a parcel', () => {
    render(<ToastProvider><UnattachedParcels items={[parcel()]} total={1} shops={SHOPS} onChanged={() => {}} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Parcels that need a person/ }))
    const select = screen.getByLabelText('Order')
    const options = within(select).getAllByRole('option')
    const first = options.find((o) => o.textContent?.includes('15864'))
    const second = options.find((o) => o.textContent?.includes('15865'))
    expect(first?.textContent).toContain('Tobias Kohlmeyer')
    expect(first?.textContent).toContain('1 x Panetti ProMix')
    expect(first?.textContent).toContain('same name as the label')
    expect(second?.textContent).toContain('already has a parcel')
    expect(second?.textContent).not.toContain('same name as the label')
  })

  it('sends the chosen order to the parcel route and asks the page to reload', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const onChanged = vi.fn()
    render(<ToastProvider><UnattachedParcels items={[parcel()]} total={1} shops={SHOPS} onChanged={onChanged} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Parcels that need a person/ }))

    fireEvent.change(screen.getByLabelText('Order'), { target: { value: 'o-15864' } })
    fireEvent.click(screen.getByRole('button', { name: 'Link' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/delivery/parcels/473325380023179098')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ orderId: 'o-15864' })
  })

  it('leaves Link disabled until an order is chosen from the dropdown', () => {
    render(<ToastProvider><UnattachedParcels items={[parcel()]} total={1} shops={SHOPS} onChanged={() => {}} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Parcels that need a person/ }))
    expect(screen.getByRole('button', { name: 'Link' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Order'), { target: { value: 'o-15864' } })
    expect(screen.getByRole('button', { name: 'Link' })).toBeEnabled()
  })

  it('shows the route\'s own words when a link is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'This parcel is already linked to an order' }), { status: 400 })))
    render(<ToastProvider><UnattachedParcels items={[parcel()]} total={1} shops={SHOPS} onChanged={() => {}} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Parcels that need a person/ }))
    fireEvent.change(screen.getByLabelText('Order'), { target: { value: 'o-15864' } })
    fireEvent.click(screen.getByRole('button', { name: 'Link' }))
    expect(await screen.findByText('This parcel is already linked to an order')).toBeInTheDocument()
  })

  it('dismisses a parcel that is not a customer delivery', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const onChanged = vi.fn()
    render(<ToastProvider><UnattachedParcels items={[parcel()]} total={1} shops={SHOPS} onChanged={onChanged} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Parcels that need a person/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Not a customer parcel' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ dismiss: true })
  })

  it('links by typed order number and shop when no candidate fits, via "Other order"', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/api/orders/lookup')
        ? new Response(JSON.stringify({ orderId: 'o-typed' }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ToastProvider><UnattachedParcels items={[parcel({ candidates: [], candidatesTotal: 0 })]} total={1} shops={SHOPS} onChanged={() => {}} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Parcels that need a person/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Other order' }))
    fireEvent.change(screen.getByLabelText('Order number'), { target: { value: '15866' } })
    fireEvent.click(screen.getByRole('button', { name: 'Link this number' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/orders/lookup?shop=s-de&number=15866')
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ orderId: 'o-typed' })
  })

  it('disables "Link this number" while the typed-number lookup is pending, so a fast double click cannot send it twice', async () => {
    let resolveLookup: (res: Response) => void = () => {}
    const lookupPromise = new Promise<Response>((resolve) => { resolveLookup = resolve })
    const fetchMock = vi.fn((url: string) =>
      url.includes('/api/orders/lookup')
        ? lookupPromise
        : Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    render(<ToastProvider><UnattachedParcels items={[parcel({ candidates: [], candidatesTotal: 0 })]} total={1} shops={SHOPS} onChanged={() => {}} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Parcels that need a person/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Other order' }))
    fireEvent.change(screen.getByLabelText('Order number'), { target: { value: '15866' } })

    fireEvent.click(screen.getByRole('button', { name: 'Link this number' }))
    expect(screen.getByRole('button', { name: 'Link this number' })).toBeDisabled()
    // A second, fast click while the lookup is still pending must not fire again.
    fireEvent.click(screen.getByRole('button', { name: 'Link this number' }))

    resolveLookup(new Response(JSON.stringify({ orderId: 'o-typed' }), { status: 200 }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const patchCalls = fetchMock.mock.calls.filter(
      (c) => !(c[0] as string).includes('/api/orders/lookup'),
    )
    expect(patchCalls.length).toBe(1)
  })

  it('says a parcel nobody has been asked about yet is simply not identified yet', () => {
    const { container } = render(
      <ToastProvider><UnattachedParcels items={[parcel({ carrier: 'Unknown', url: null, reason: null, identifiedAt: null, candidates: [], candidatesTotal: 0 })]} total={1} shops={SHOPS} onChanged={() => {}} /></ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Parcels that need a person/ }))
    expect(container.textContent).toContain('Not identified yet - the next check asks Bring, then DHL')
    expect(container.querySelector('a[href]')).toBeNull()
  })
})

describe('NoTracking, when a parcel was refused for that customer', () => {
  it('says so on the row, with the reason and a link down to the parcel', () => {
    const { container } = render(
      <NoTracking
        rows={[order({ state: 'NO_TRACKING', refusedParcel: { trackingNumber: '373325386490923366', reason: 'a@b.c matched 2 orders in the last 30 days: 14582, 14692', createdAt: '2026-09-07T16:00:00.000Z' } })]}
        total={1} open onToggle={() => {}}
      />,
    )
    expect(container.textContent).toContain('A parcel for this customer was in the file of 7 Sept 2026 but was not attached: a@b.c matched 2 orders in the last 30 days: 14582, 14692')
    expect(container.querySelector('a[href="#unattached"]')?.textContent).toBe('373325386490923366')
    expect(container.textContent).toContain('Where the warehouse file named a parcel we could not attach')
  })
})
