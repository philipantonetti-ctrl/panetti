'use client'

import { useCallback, useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'
import { LANGUAGES } from '@/lib/inbox/classify'

/**
 * Where a person decides how the support assistant behaves.
 *
 * Two halves, in the order they matter: what it is ALLOWED to do, then what it
 * KNOWS. The permissions come first deliberately - a knowledge base is
 * harmless while the assistant may only draft, and dangerous the moment it may
 * send, so the setting that governs that should be the first thing on screen.
 */

type Item = {
  id: string
  kind: string
  title: string
  body: string
  active: boolean
  shopId: string | null
  shopName: string | null
  country: string | null
  language: string | null
  sku: string | null
}
type Shop = { id: string; name: string }
type Rules = {
  mode: string
  autoCategories: string[]
  escalateKeywords: string[]
  minConfidence: number
  extraInstructions: string
}

/** What each kind is for, in the words of the person filling it in. */
const KIND_HELP: Record<string, string> = {
  tone: 'How we sound. Sent with every ticket.',
  instruction: 'A standing instruction. Sent with every ticket.',
  never_say: 'Something it must never say or promise. Sent with every ticket.',
  always_escalate: 'A situation that must always go to a person. Sent with every ticket.',
  faq: 'A question and its answer.',
  policy: 'Returns, warranty, shipping, refunds.',
  product: 'Product facts, manuals, specifications.',
  troubleshooting: 'Steps that fix a common problem.',
  example: 'A good answer, to copy the shape of.',
}

const MODE_HELP: Record<string, string> = {
  off: 'The assistant reads nothing and answers nothing.',
  draft: 'It writes a suggested reply as an internal note. A person always sends.',
  auto: 'It may answer by itself, but only the categories ticked below and only when sure enough.',
}

export function SupportAiClient({ email }: { email: string }) {
  const toast = useToast()
  const [items, setItems] = useState<Item[] | null>(null)
  const [shops, setShops] = useState<Shop[]>([])
  const [kinds, setKinds] = useState<string[]>([])
  const [rules, setRules] = useState<Rules | null>(null)
  const [categories, setCategories] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const [draft, setDraft] = useState({ kind: 'faq', title: '', body: '', shopId: '', country: '', language: '', sku: '' })

  /**
   * State is set inside the promise callbacks, never straight after an await
   * in the effect body: React counts the latter as a synchronous set during
   * render and cascades. Same shape DashboardClient uses.
   */
  const load = useCallback(
    () =>
      Promise.all([
        fetch('/api/support/knowledge').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/support/rules').then((r) => (r.ok ? r.json() : null)),
      ]).then(([k, r]) => {
        if (k) {
          setItems(k.items)
          setShops(k.shops)
          setKinds(k.kinds)
        }
        if (r) {
          setRules({
            mode: r.rules.mode,
            autoCategories: r.rules.autoCategories,
            escalateKeywords: r.rules.escalateKeywords,
            minConfidence: r.rules.minConfidence,
            extraInstructions: r.rules.extraInstructions ?? '',
          })
          setCategories(r.categories)
        }
      }),
    [],
  )

  useEffect(() => {
    void load()
  }, [load])

  async function saveRules() {
    if (!rules || saving) return
    setSaving(true)
    try {
      const res = await fetch('/api/support/rules', { method: 'PUT', body: JSON.stringify(rules) })
      if (!res.ok) {
        toast.error((await res.json()).error ?? 'Could not save')
        return
      }
      toast.success('Saved')
    } finally {
      setSaving(false)
    }
  }

  async function addItem() {
    const res = await fetch('/api/support/knowledge', { method: 'POST', body: JSON.stringify(draft) })
    if (!res.ok) {
      toast.error((await res.json()).error ?? 'Could not save it')
      return
    }
    toast.success('Added')
    setDraft({ ...draft, title: '', body: '', sku: '' })
    await load()
  }

  async function removeItem(id: string) {
    const res = await fetch(`/api/support/knowledge/${id}`, { method: 'DELETE' })
    if (!res.ok) toast.error('Could not remove it')
    await load()
  }

  async function toggleItem(id: string, active: boolean) {
    await fetch(`/api/support/knowledge/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) })
    await load()
  }

  const toggleCategory = (c: string) => {
    if (!rules) return
    setRules({
      ...rules,
      autoCategories: rules.autoCategories.includes(c)
        ? rules.autoCategories.filter((x) => x !== c)
        : [...rules.autoCategories, c],
    })
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Support assistant"
        subtitle="What it is allowed to do, and what it is allowed to know."
      />
      <PageBody>
        <div className="max-w-[900px] space-y-4">
          {/* Permissions first: knowledge is harmless until this says auto. */}
          <section className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
            <h2 className="mb-3 text-[15px] font-semibold text-ink">What it may do</h2>
            {!rules ? (
              <div className="skeleton h-[120px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
            ) : (
              <div className="space-y-4 text-[13px]">
                <div className="flex flex-col gap-2">
                  {['off', 'draft', 'auto'].map((m) => (
                    <label key={m} className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="mode"
                        checked={rules.mode === m}
                        onChange={() => setRules({ ...rules, mode: m })}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="font-semibold text-ink">
                          {m === 'off' ? 'Off' : m === 'draft' ? 'Draft only' : 'Answer by itself'}
                        </span>
                        <span className="block text-[12px] text-muted">{MODE_HELP[m]}</span>
                      </span>
                    </label>
                  ))}
                </div>

                <div>
                  <span className="text-[12px] text-muted">It may answer these by itself</span>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {categories.map((c) => (
                      <button
                        key={c}
                        onClick={() => toggleCategory(c)}
                        aria-pressed={rules.autoCategories.includes(c)}
                        className={`rounded-full border px-2.5 py-1 text-[12px] transition-colors duration-150 ${
                          rules.autoCategories.includes(c)
                            ? 'border-accent bg-accent-soft text-accent-ink'
                            : 'border-line text-muted hover:border-faint'
                        }`}
                      >
                        {c.replace('_', ' ')}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="block">
                  <span className="text-[12px] text-muted">
                    Words that always go to a person, whatever the assistant thinks (comma separated)
                  </span>
                  <input
                    aria-label="Escalation words"
                    value={rules.escalateKeywords.join(', ')}
                    onChange={(e) =>
                      setRules({
                        ...rules,
                        escalateKeywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                      })
                    }
                    placeholder="lawyer, advokat, compensation, erstatning, injury"
                    className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-ink"
                  />
                </label>

                <label className="block">
                  <span className="text-[12px] text-muted">
                    How sure it must be to send by itself: {Math.round(rules.minConfidence * 100)}%
                  </span>
                  <input
                    aria-label="Confidence needed"
                    type="range"
                    min={0.5}
                    max={1}
                    step={0.05}
                    value={rules.minConfidence}
                    onChange={(e) => setRules({ ...rules, minConfidence: Number(e.target.value) })}
                    className="mt-1 w-full"
                  />
                </label>

                <label className="block">
                  <span className="text-[12px] text-muted">Anything else it should always keep in mind</span>
                  <textarea
                    aria-label="House instructions"
                    value={rules.extraInstructions}
                    onChange={(e) => setRules({ ...rules, extraInstructions: e.target.value })}
                    rows={3}
                    placeholder="Never promise a delivery date. Always sign off as the shop, not as a person."
                    className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-ink"
                  />
                </label>

                <div className="flex justify-end">
                  <button
                    onClick={() => void saveRules()}
                    disabled={saving}
                    className="rounded-[var(--radius-control)] bg-ink px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
            <h2 className="mb-1 text-[15px] font-semibold text-ink">What it knows</h2>
            <p className="mb-3 text-[12px] text-muted">
              Tone, instructions, never-say and always-escalate are sent with every ticket. The rest is used when
              the question matches. Leave a shop, country or language empty to mean everywhere.
            </p>

            {items === null ? (
              <div className="skeleton h-[120px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
            ) : items.length === 0 ? (
              <p className="mb-4 text-[13px] text-muted">
                Nothing yet. Until something is here, the assistant has no policies to quote and will hand over
                anything that needs one.
              </p>
            ) : (
              <div className="mb-4 space-y-1.5">
                {items.map((i) => (
                  <div key={i.id} className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5 text-[13px] last:border-b-0">
                    <div className="min-w-0">
                      <span className="rounded-full border border-line px-1.5 text-[11px] text-muted">
                        {i.kind.replace('_', ' ')}
                      </span>{' '}
                      <span className={`font-semibold ${i.active ? 'text-ink' : 'text-faint line-through'}`}>
                        {i.title}
                      </span>
                      <div className="truncate text-[12px] text-muted">{i.body.split('\n')[0]}</div>
                      <div className="text-[11px] text-faint">
                        {[i.shopName, i.country, i.language, i.sku].filter(Boolean).join(' · ') || 'everywhere'}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2 text-[12px]">
                      <button onClick={() => void toggleItem(i.id, !i.active)} className="text-accent">
                        {i.active ? 'Turn off' : 'Turn on'}
                      </button>
                      <button onClick={() => void removeItem(i.id)} className="text-loss">
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 text-[12px] text-muted">
              <label className="block">
                Kind
                <select
                  aria-label="Kind"
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
                  className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                >
                  {kinds.map((k) => (
                    <option key={k} value={k}>
                      {k.replace('_', ' ')}
                    </option>
                  ))}
                </select>
                <span className="mt-0.5 block text-[11px] text-faint">{KIND_HELP[draft.kind]}</span>
              </label>
              <label className="block">
                Title
                <input
                  aria-label="Title"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="Returns within 14 days"
                  className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                />
              </label>
              <label className="col-span-2 block">
                Body
                <textarea
                  aria-label="Body"
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  rows={3}
                  placeholder="A customer may return an unopened item within 14 days of delivery. They pay return shipping."
                  className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                />
              </label>
              <label className="block">
                Shop
                <select
                  aria-label="Shop"
                  value={draft.shopId}
                  onChange={(e) => setDraft({ ...draft, shopId: e.target.value })}
                  className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                >
                  <option value="">Every shop</option>
                  {shops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                Language
                <select
                  aria-label="Language"
                  value={draft.language}
                  onChange={(e) => setDraft({ ...draft, language: e.target.value })}
                  className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                >
                  <option value="">Every language</option>
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                Country (optional)
                <input
                  aria-label="Country"
                  value={draft.country}
                  onChange={(e) => setDraft({ ...draft, country: e.target.value })}
                  placeholder="NO"
                  maxLength={2}
                  className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                />
              </label>
              <label className="block">
                Product SKU (optional)
                <input
                  aria-label="SKU"
                  value={draft.sku}
                  onChange={(e) => setDraft({ ...draft, sku: e.target.value })}
                  placeholder="MPX-001"
                  className="mt-0.5 w-full rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                />
              </label>
            </div>
            <div className="mt-2 flex justify-end">
              <button
                onClick={() => void addItem()}
                disabled={!draft.title.trim() || !draft.body.trim()}
                className="rounded-[var(--radius-control)] bg-ink px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
              >
                Add
              </button>
            </div>
          </section>
        </div>
      </PageBody>
    </AppShell>
  )
}
