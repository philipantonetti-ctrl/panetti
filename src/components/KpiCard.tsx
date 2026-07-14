export function KpiCard({
  label,
  value,
  tone = 'plain',
}: {
  label: string
  value: React.ReactNode
  tone?: 'plain' | 'good' | 'accent'
}) {
  const colour =
    tone === 'good' ? 'text-emerald-600' : tone === 'accent' ? 'text-violet-700' : 'text-slate-900'

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${colour}`}>{value}</div>
    </div>
  )
}
