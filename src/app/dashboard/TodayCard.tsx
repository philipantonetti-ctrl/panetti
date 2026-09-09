import Link from 'next/link'
import { money } from '@/lib/finance/format'
import type { TaskCard } from '@/lib/operations/today'

/**
 * One job on the operations manager's first page: a heading, how many there
 * are, and the worst few, each a link to the thing it is about.
 *
 * Nothing to do is said in words rather than left as an empty box - a blank
 * card reads as a page that failed to load, which is the one thing it must
 * never mean. `see all` appears only when rows are actually being held back,
 * so a card showing everything it has does not send anyone looking for more.
 */
export function TodayCard({
  title,
  card,
  clear,
  seeAllHref,
}: {
  title: string
  card: TaskCard
  /** What to say when there is nothing to do. */
  clear: string
  /** The tab that owns this job. */
  seeAllHref: string
}) {
  const held = card.total - card.rows.length

  return (
    <section className="flex flex-col rounded-[var(--radius-card)] border border-line bg-surface">
      <header className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        <span
          className={`num text-[20px] font-semibold leading-none ${
            card.total === 0 ? 'text-faint' : 'text-ink'
          }`}
        >
          {card.total}
        </span>
      </header>

      {card.total === 0 ? (
        <p className="px-4 py-5 text-[13px] text-muted">{clear}</p>
      ) : (
        <ul className="flex-1">
          {card.rows.map((r) => (
            <li key={r.key} className="border-b border-line last:border-0">
              <Link
                href={r.href}
                className="flex items-baseline justify-between gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-panel"
              >
                <span className="min-w-0">
                  <span className="text-[13px] font-medium text-ink">{r.label}</span>
                  {r.sub && <span className="ml-2 truncate text-[12px] text-muted">{r.sub}</span>}
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[12px] text-warn">{r.detail}</span>
                  {r.amount && (
                    <span className="num block text-[12px] text-muted">
                      {money(r.amount.minor, r.amount.currency)}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {held > 0 && (
        <Link
          href={seeAllHref}
          className="border-t border-line px-4 py-2.5 text-[12px] font-medium text-accent hover:underline"
        >
          see all {card.total}
        </Link>
      )}
    </section>
  )
}
