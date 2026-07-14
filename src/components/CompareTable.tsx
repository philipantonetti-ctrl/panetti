import { Money, Percent } from './Money'
import type { EngineResult } from '@/lib/metrics/types'

export function CompareTable({ result }: { result: EngineResult }) {
  const c = result.displayCurrency

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full whitespace-nowrap text-xs">
        <thead>
          <tr className="bg-slate-50 text-right text-slate-500">
            <th className="px-3 py-2.5 text-left font-medium">Shop</th>
            <th className="px-3 py-2.5 font-medium">Orders</th>
            <th className="px-3 py-2.5 font-medium">Net revenue</th>
            <th className="px-3 py-2.5 font-medium" title="Product cost + handling">COGS</th>
            <th className="px-3 py-2.5 font-medium">Op. Ex.</th>
            <th className="px-3 py-2.5 font-medium">Commission</th>
            <th className="px-3 py-2.5 font-medium">Net profit</th>
            <th className="px-3 py-2.5 font-medium">Margin</th>
          </tr>
        </thead>
        <tbody className="text-right text-slate-700">
          {result.byShop.map((row) => (
            <tr key={row.shopId} className="border-t border-slate-100">
              <td className="px-3 py-2 text-left font-medium text-slate-900">{row.shopName}</td>
              <td className="px-3 py-2">{row.orders}</td>
              <td className="px-3 py-2"><Money minor={row.netRevenue} currency={c} /></td>
              <td className="px-3 py-2"><Money minor={row.cogs} currency={c} /></td>
              <td className="px-3 py-2"><Money minor={row.operationalExpenses} currency={c} /></td>
              <td className="px-3 py-2"><Money minor={row.commission} currency={c} /></td>
              <td className="px-3 py-2 font-semibold text-emerald-600"><Money minor={row.netProfit} currency={c} /></td>
              <td className="px-3 py-2"><Percent value={row.netMargin} /></td>
            </tr>
          ))}

          <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-slate-900">
            <td className="px-3 py-2.5 text-left">Total</td>
            <td className="px-3 py-2.5">{result.total.orders}</td>
            <td className="px-3 py-2.5"><Money minor={result.total.netRevenue} currency={c} /></td>
            <td className="px-3 py-2.5"><Money minor={result.total.cogs} currency={c} /></td>
            <td className="px-3 py-2.5"><Money minor={result.total.operationalExpenses} currency={c} /></td>
            <td className="px-3 py-2.5"><Money minor={result.total.commission} currency={c} /></td>
            <td className="px-3 py-2.5 text-emerald-600"><Money minor={result.total.netProfit} currency={c} /></td>
            <td className="px-3 py-2.5"><Percent value={result.total.netMargin} /></td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
