import { Money } from './Money'
import type { LeaderboardRow } from '@/lib/metrics/ambassadors'

export function Leaderboard({ rows, currency }: { rows: LeaderboardRow[]; currency: string }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-500">
        No ambassador sales in this period.
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-slate-50 text-right text-slate-500">
            <th className="px-3 py-2.5 text-left font-medium">#</th>
            <th className="px-3 py-2.5 text-left font-medium">Ambassador</th>
            <th className="px-3 py-2.5 font-medium">Orders</th>
            <th className="px-3 py-2.5 font-medium">Sales</th>
            <th className="px-3 py-2.5 font-medium">Commission</th>
          </tr>
        </thead>
        <tbody className="text-right text-slate-700">
          {rows.map((row) => (
            <tr key={row.ambassadorId} className="border-t border-slate-100">
              <td className="px-3 py-2 text-left">{row.rank}</td>
              <td className="px-3 py-2 text-left font-medium text-slate-900">{row.name}</td>
              <td className="px-3 py-2">{row.orders}</td>
              <td className="px-3 py-2"><Money minor={row.sales} currency={currency} /></td>
              <td className="px-3 py-2 font-semibold text-violet-700"><Money minor={row.commission} currency={currency} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
