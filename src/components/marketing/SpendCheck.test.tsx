// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SpendCheck } from './SpendCheck'
import type { SpendCheckAccount, SpendCheckResult } from '@/lib/ads/spend-check'

const account = (over: Partial<SpendCheckAccount> = {}): SpendCheckAccount => ({
  id: 'acc-1',
  name: 'Panetti NO',
  provider: 'meta',
  currency: 'NOK',
  nativeTotal: 443_199_00,
  convertedTotal: 40_623_00,
  daysWithData: 30,
  daysInRange: 30,
  firstDay: '2026-07-11',
  lastDay: '2026-08-09',
  lastSyncAt: new Date('2026-08-10T06:00:00Z'),
  lastError: null,
  status: 'ok',
  ...over,
})

const data = (over: Partial<SpendCheckResult> = {}): SpendCheckResult => ({
  accounts: [account()],
  needsAttention: false,
  ...over,
})

describe('SpendCheck', () => {
  it('stays collapsed until asked', () => {
    render(<SpendCheck data={data()} currency="USD" allStores={true} />)
    expect(screen.queryByText('Panetti NO')).not.toBeInTheDocument()
  })

  it('shows the UNCONVERTED native total when expanded', () => {
    // The number a person holds against Ads Manager. If this were converted
    // the panel could not settle anything.
    render(<SpendCheck data={data()} currency="USD" allStores={true} />)
    fireEvent.click(screen.getByRole('button', { name: /spend check/i }))
    expect(screen.getByTestId('native-acc-1')).toHaveTextContent('443')
  })

  it('says nothing alarming when every account is healthy', () => {
    render(<SpendCheck data={data()} currency="USD" allStores={true} />)
    expect(screen.queryByTestId('spend-check-banner')).not.toBeInTheDocument()
  })

  it('raises a banner when an account needs attention', () => {
    render(
      <SpendCheck
        data={data({ accounts: [account({ status: 'error', lastError: 'Login expired' })], needsAttention: true })}
        currency="USD"
        allStores={true}
      />,
    )
    expect(screen.getByTestId('spend-check-banner')).toBeInTheDocument()
  })

  it('renders nothing when there are no accounts', () => {
    const { container } = render(<SpendCheck data={data({ accounts: [] })} currency="USD" allStores={true} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the partial-scope caution when filtered to a subset of stores', () => {
    render(<SpendCheck data={data()} currency="USD" allStores={false} />)
    fireEvent.click(screen.getByRole('button', { name: /spend check/i }))
    expect(screen.getByTestId('spend-check-caution')).toBeInTheDocument()
  })

  it('does not show the partial-scope caution when every store is selected', () => {
    render(<SpendCheck data={data()} currency="USD" allStores={true} />)
    fireEvent.click(screen.getByRole('button', { name: /spend check/i }))
    expect(screen.queryByTestId('spend-check-caution')).not.toBeInTheDocument()
  })
})
