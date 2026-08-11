'use client'

/**
 * Which ad platform the page describes.
 *
 * Options come from the response's own `byPlatform`, so only platforms that
 * actually have a connected account are offered and the client can never send
 * a value the server would reject with a 400.
 */
export function PlatformFilter({
  options,
  selected,
  onChange,
}: {
  options: { provider: string; label: string }[]
  selected: string | null
  onChange: (next: string | null) => void
}) {
  // One platform is not a choice, it is a label. Nothing to render.
  if (options.length < 2) return null

  return (
    <select
      aria-label="Ad platform"
      value={selected ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:border-faint"
    >
      <option value="">All platforms</option>
      {options.map((o) => (
        <option key={o.provider} value={o.provider}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
