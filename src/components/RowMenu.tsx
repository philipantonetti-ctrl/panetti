'use client'

import { useEffect, useRef, useState } from 'react'

export type RowAction = {
  label: string
  onSelect: () => void
  /** Set apart below a rule and coloured as a loss. At most one per menu. */
  danger?: boolean
  disabled?: boolean
}

/** One item's height, used only to decide whether the menu still fits below the button. */
const ITEM_PX = 30

/**
 * A row's own actions, behind one button.
 *
 * A table row can carry three or four verbs, and spelling them all out makes
 * the last column the widest thing on the page — squeezing the columns holding
 * the actual data until they wrap. Worse, it gives Delete the same weight as
 * Edit. Here the row shows one quiet control, and the actions rank themselves
 * inside it: the ordinary ones first, anything destructive set apart below a
 * rule where it cannot be hit on the way past.
 *
 * Positioned FIXED against the button's own rect rather than absolutely inside
 * the cell. The table sits in a rounded, `overflow-hidden` panel, which clips
 * any descendant — an absolute menu on the last row would simply be cut off at
 * the table's edge. Fixed escapes that without a portal, and lets the menu flip
 * above the button when the viewport has no room below.
 */
export function RowMenu({ ariaLabel, actions }: { ariaLabel: string; actions: RowAction[] }) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState({ top: 0, right: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  function place() {
    const button = trigger.current
    if (!button) return
    const r = button.getBoundingClientRect()
    const height = actions.length * ITEM_PX + 16
    // Flip above when the space below cannot hold it, so the last row of a long
    // table opens upward instead of off-screen.
    const below = window.innerHeight - r.bottom
    setAt({
      top: below < height + 8 ? r.top - height - 4 : r.bottom + 4,
      right: window.innerWidth - r.right,
    })
  }

  function close(returnFocus = true) {
    setOpen(false)
    // Focus goes back where it came from, or a keyboard user is dropped at the
    // top of the document with no idea which row they were on.
    if (returnFocus) trigger.current?.focus()
  }

  useEffect(() => {
    if (!open) return

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    /**
     * A fixed menu is anchored to a viewport point, so it has to be re-placed
     * when the page moves beneath it.
     *
     * Re-place, never close. An earlier version closed on any scroll, and the
     * browser fires one the instant focus lands on the first item — the menu
     * shut in the same frame it opened and the button looked dead. Following
     * the row has no such failure mode, and is the better behaviour anyway.
     */
    const follow = () => place()

    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [open])

  /**
   * Opening should land you on the first item, not leave focus behind on the
   * trigger with a menu hanging open beneath it.
   *
   * `preventScroll` is not a nicety. Focusing an element the browser considers
   * out of view scrolls it into view, that scroll fires the listener above, and
   * the menu closes in the same frame it opened — it looked like the button did
   * nothing at all. The menu is already placed against the trigger, so there is
   * nothing to scroll to.
   */
  useEffect(() => {
    if (!open) return
    panel.current
      ?.querySelector<HTMLButtonElement>('button:not([disabled])')
      ?.focus({ preventScroll: true })
  }, [open])

  /**
   * Move focus to the next or previous item, wrapping at the ends. Read from
   * what is actually focused rather than from the action's own index: a
   * disabled item is skipped by the query, so the two lists do not line up.
   */
  function step(by: 1 | -1) {
    const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
    if (items.length === 0) return
    const here = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(here + by + items.length) % items.length].focus()
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) close()
          else {
            place()
            setOpen(true)
          }
        }}
        className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] text-muted transition-colors duration-150 hover:bg-panel hover:text-ink aria-expanded:bg-panel aria-expanded:text-ink"
      >
        {/* Three dots, not a word: the label would be longer than the menu. */}
        <span aria-hidden className="text-base leading-none">⋯</span>
      </button>

      {open && (
        <>
          {/* Anywhere else closes it. Below the panel, above everything else. */}
          <div className="fixed inset-0 z-40" onClick={() => close(false)} />
          <div
            ref={panel}
            role="menu"
            aria-label={ariaLabel}
            style={{ top: at.top, right: at.right }}
            className="fixed z-50 min-w-[10rem] overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface py-1 shadow-lg"
          >
            {actions.map((action, i) => (
              <div key={action.label}>
                {/* The rule earns its place only above something destructive. */}
                {action.danger && i > 0 && <div className="my-1 border-t border-line" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={action.disabled}
                  onClick={() => {
                    close(false)
                    action.onSelect()
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      step(1)
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      step(-1)
                    }
                  }}
                  className={`block w-full px-3 py-1.5 text-left text-xs font-medium transition-colors duration-150 disabled:opacity-50 ${
                    action.danger
                      ? 'text-loss hover:bg-warn-soft'
                      : 'text-ink hover:bg-panel'
                  }`}
                >
                  {action.label}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}
