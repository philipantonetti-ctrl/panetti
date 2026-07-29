// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Leaderboard } from './Leaderboard'
import type { LeaderboardRow } from '@/lib/metrics/ambassadors'

const row = (over: Partial<LeaderboardRow>): LeaderboardRow => ({
  rank: 1,
  ambassadorId: 'a1',
  name: 'Philip',
  shops: ['Panetti Norway'],
  orders: 2,
  sales: 10000,
  commission: 1000,
  ...over,
})

describe('Leaderboard', () => {
  it('names the shop beside the ambassador, quieter than the name', () => {
    render(<Leaderboard rows={[row({})]} currency="USD" />)

    expect(screen.getByText('Philip')).toBeTruthy()
    const shop = screen.getByText('(Panetti Norway)')
    expect(shop.className).toContain('text-muted')
  })

  it('joins several shops with commas', () => {
    render(
      <Leaderboard
        rows={[row({ shops: ['Panetti Norway', 'Panetti Sweden'] })]}
        currency="USD"
      />,
    )
    expect(screen.getByText('(Panetti Norway, Panetti Sweden)')).toBeTruthy()
  })

  it('leaves a codeless ambassador bare — no empty parentheses', () => {
    render(<Leaderboard rows={[row({ shops: [] })]} currency="USD" />)
    expect(screen.getByText('Philip')).toBeTruthy()
    expect(screen.queryByText(/\(\s*\)/)).toBeNull()
  })
})
