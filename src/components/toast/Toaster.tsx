'use client'

import type { Toast } from './useToast'

export function Toaster({
  toasts,
  onDismiss,
}: {
  toasts: Toast[]
  onDismiss: (id: number) => void
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      // z-toast (60) sits above the modal layer (50): a toast reporting a
      // modal's own save failure must appear over it.
      style={{ zIndex: 'var(--z-toast)' }}
      className="pointer-events-none fixed bottom-4 right-4 flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className={`pointer-events-auto max-w-[360px] rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-left text-xs shadow-xl ${
            t.tone === 'error' ? 'text-loss' : 'text-gain'
          }`}
        >
          {t.text}
        </button>
      ))}
    </div>
  )
}
