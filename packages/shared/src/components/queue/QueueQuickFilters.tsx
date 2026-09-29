import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { MultiPick } from '../CollectionBrowserView'
import type { FilterDef } from '../DataTable'

// The queue's quick filters — the collection browser's facet bar, same
// control (MultiPick), same draft-then-Apply rhythm: picking values stages a
// draft, Apply commits it to the queue's filters, Clear resets to the
// scope-seeded baseline. Every column filter stays in the table's header
// row; this bar holds the handful of facets people narrow a queue by.

type Values = Record<string, string | string[]>

const asList = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : [])

/** A facet whose options come from the server as you search (large relation targets). */
function AsyncFacet({
  def,
  selected,
  onChange,
  badge
}: {
  def: FilterDef
  selected: string[]
  onChange: (vals: string[]) => void
  badge: { label: string; cls: string; title: string } | null
}) {
  const [armed, setArmed] = useState(false)
  const [q, setQ] = useState('')
  const load = def.loadOptions
  const { data = [], isLoading } = useQuery({
    queryKey: ['queue-quick-facet', def.key, q],
    queryFn: () => (load ? load(q) : Promise.resolve([])),
    enabled: !!load && (armed || selected.length > 0),
    staleTime: 60_000
  })
  // A value picked earlier keeps its chip label even when the current search
  // no longer returns it.
  const options = useMemo(() => {
    const seen = new Set(data.map((o) => o.value))
    return [...data, ...selected.filter((v) => !seen.has(v)).map((v) => ({ label: v, value: v }))]
  }, [data, selected])
  return (
    <MultiPick
      label={def.placeholder}
      options={options}
      selected={selected}
      onChange={(vals) => onChange(vals.map(String))}
      loading={isLoading}
      badge={badge}
      onSearch={setQ}
      onOpenChange={(o) => {
        if (o) setArmed(true)
      }}
    />
  )
}

export function QueueQuickFilters({
  defs,
  values,
  seededKeys,
  onApply,
  onClear,
  right
}: {
  defs: FilterDef[]
  /** The queue's applied filter values. */
  values: Values
  /** Keys whose value was pre-filled from the viewer's default scopes. */
  seededKeys: Set<string>
  /** Commit the draft for these keys. */
  onApply: (patch: Values) => void
  /** Back to the scope-seeded baseline (column filters included, as in the browser). */
  onClear: () => void
  /** Right-aligned summary (item count, attention counts). */
  right?: ReactNode
}) {
  const appliedKey = JSON.stringify(defs.map((d) => [d.key, asList(values[d.key])]))
  const [draft, setDraft] = useState<Record<string, string[]>>({})
  // Follow the applied values: a header-row edit, a saved view or a stat
  // click changes them underneath the bar.
  // biome-ignore lint/correctness/useExhaustiveDependencies: appliedKey is the content signature of defs + values
  useEffect(() => {
    const next: Record<string, string[]> = {}
    for (const d of defs) next[d.key] = asList(values[d.key])
    setDraft(next)
  }, [appliedKey])
  const dirty = defs.some(
    (d) => JSON.stringify(draft[d.key] ?? []) !== JSON.stringify(asList(values[d.key]))
  )
  if (defs.length === 0 && !right) return null
  return (
    <div
      className='flex shrink-0 flex-wrap items-center gap-1.5 border-b border-slate-100 bg-white px-4 py-1.5 dark:border-slate-800 dark:bg-slate-900'
      data-queue-quick-filters
    >
      {defs.map((def) => {
        const selected = draft[def.key] ?? []
        const badge = def.restricted
          ? {
              label: 'restricted',
              cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
              title: `Options limited to your restricted ${def.placeholder} scope`
            }
          : seededKeys.has(def.key) && selected.length > 0
            ? {
                label: 'default',
                cls: 'bg-[#00ceff1f] text-[#0284a8] dark:text-[#00ceff]',
                title: `Pre-selected from your default ${def.placeholder} scope — adjust freely`
              }
            : null
        const set = (vals: string[]) => setDraft((d) => ({ ...d, [def.key]: vals }))
        return def.loadOptions ? (
          <AsyncFacet key={def.key} def={def} selected={selected} onChange={set} badge={badge} />
        ) : (
          <MultiPick
            key={def.key}
            label={def.placeholder}
            options={def.options ?? []}
            selected={selected}
            onChange={(vals) => set(vals.map(String))}
            badge={badge}
          />
        )
      })}
      {defs.length > 0 && (
        <>
          <button
            type='button'
            onClick={() => {
              const patch: Values = {}
              for (const d of defs) {
                const v = draft[d.key] ?? []
                // Single-value defs store a string; multi-value ones an array.
                patch[d.key] = d.multi || d.type === 'combobox' ? v : (v[0] ?? '')
              }
              onApply(patch)
            }}
            className={`h-6 rounded px-2.5 text-[11px] font-semibold text-white transition-[filter] hover:brightness-110 ${
              dirty ? 'bg-[#00ceff]' : 'bg-[#00ceff] opacity-60'
            }`}
            data-queue-quick-apply
          >
            Apply
          </button>
          <button
            type='button'
            onClick={onClear}
            className='h-6 rounded border border-slate-200 px-2 text-[11px] text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
            data-queue-quick-clear
          >
            Clear
          </button>
        </>
      )}
      {right && <div className='ml-auto flex items-center gap-2'>{right}</div>}
    </div>
  )
}
