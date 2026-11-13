import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronLeft, ChevronRight, Loader2, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { describeError } from '../../lib/error-message'
import { cn, titleCase } from '../../lib/utils'
import { type FacetHop, type FacetMeta, facetHops, useFacetMeta } from './facets'

export interface PickedFacet {
  path: string[]
  /** Collection the options load from. */
  target: string
  kind: FacetHop['kind']
}

/**
 * "What do people filter by?" — the relations out of the list's collection,
 * one level at a time. A row picks that relation; its › opens the related
 * record's own relations (Workflow › Project › Project Type). One panel with a
 * back step rather than nested fly-outs, so it fits beside its button on a phone.
 */
export function QuickFilterFieldPicker({
  rootCollection,
  initialPath,
  used = {},
  currentPath,
  onPick,
  onCancel,
  className
}: {
  rootCollection: string
  /** Opens at the level this path sits on (when changing an existing filter). */
  initialPath?: string[]
  /** Paths already on the bar ('a.b' → the name they show as) — marked, still pickable. */
  used?: Record<string, string>
  /** The path of the filter being changed — marked "this filter". */
  currentPath?: string[]
  onPick: (picked: PickedFacet) => void
  /** Shows a Cancel beside the heading (changing a field inside a form). */
  onCancel?: () => void
  className?: string
}) {
  // The trail of hops taken: each entry is the collection that level lists.
  const [trail, setTrail] = useState<Array<{ field: string; collection: string }>>([])
  const [q, setQ] = useState('')
  const here = trail.length > 0 ? trail[trail.length - 1].collection : rootCollection
  const prefix = trail.map((t) => t.field)
  const meta = useFacetMeta(here)
  // Open on an existing filter's level (Workflow › Project for …› Project Type):
  // walk its path once, each level's metadata from the shared cache.
  const qc = useQueryClient()
  const client = useNivaroClient()
  const startAt = (initialPath ?? []).slice(0, -1).join('.')
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opened path
  useEffect(() => {
    if (!startAt) return
    let live = true
    void (async () => {
      const walked: Array<{ field: string; collection: string }> = []
      let at = rootCollection
      for (const seg of startAt.split('.')) {
        const m = await qc
          .fetchQuery<FacetMeta>({
            queryKey: ['cbv-collection-meta', at],
            queryFn: () =>
              client.request<{ data: FacetMeta }>(get(`/collections/${at}`)).then((r) => r.data),
            staleTime: 10 * 60_000
          })
          .catch(() => null)
        const hop = facetHops(m, at).find((h) => h.field === seg)
        if (!hop) break
        walked.push({ field: hop.field, collection: hop.target })
        at = hop.target
      }
      if (live && walked.length > 0) setTrail(walked)
    })()
    return () => {
      live = false
    }
  }, [startAt, rootCollection])

  const hops = useMemo(() => facetHops(meta.data, here), [meta.data, here])
  const shown = q.trim()
    ? hops.filter((h) =>
        `${h.field} ${titleCase(h.field)} ${h.target}`
          .toLowerCase()
          .includes(q.trim().toLowerCase())
      )
    : hops
  const current = (currentPath ?? []).join('.')

  return (
    <div className={cn('flex max-h-[min(24rem,70vh)] flex-col', className)}>
      <div className='flex min-h-8 items-center gap-1 px-2 pt-2'>
        {trail.length > 0 && (
          <button
            type='button'
            onClick={() => {
              setTrail((t) => t.slice(0, -1))
              setQ('')
            }}
            aria-label='Back'
            className='flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
          >
            <ChevronLeft className='h-3.5 w-3.5' />
          </button>
        )}
        <p className='min-w-0 flex-1 truncate text-[12px] text-slate-500 dark:text-slate-400'>
          {trail.length === 0 ? (
            <>
              Filter{' '}
              <span className='font-medium text-slate-800 dark:text-slate-100'>
                {titleCase(rootCollection)}
              </span>{' '}
              by…
            </>
          ) : (
            <>
              {titleCase(rootCollection)} ›{' '}
              <span className='font-medium text-slate-800 dark:text-slate-100'>
                {trail.map((t) => titleCase(t.field)).join(' › ')}
              </span>
            </>
          )}
        </p>
        {onCancel && (
          <button
            type='button'
            onClick={onCancel}
            className='h-6 shrink-0 rounded px-1.5 text-[11.5px] font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white'
          >
            Cancel
          </button>
        )}
      </div>
      <div className='relative mx-2 mt-1.5'>
        <Search
          aria-hidden
          className='pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400'
        />
        <input
          // biome-ignore lint/a11y/noAutofocus: the picker opens to be typed into
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='Find a field…'
          aria-label='Find a field'
          className='h-7 w-full rounded-md border border-slate-200 bg-slate-50 pl-7 pr-2 text-[12px] text-slate-800 placeholder:text-slate-400 focus:border-nvr-cyan/60 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/25 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500'
        />
      </div>
      <div className='mt-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1'>
        {meta.isLoading ? (
          <p className='flex items-center gap-2 px-2 py-3 text-[12px] text-slate-500 dark:text-slate-400'>
            <Loader2 aria-hidden className='h-3.5 w-3.5 animate-spin' />
            Loading fields…
          </p>
        ) : meta.isError ? (
          <p className='px-2 py-3 text-[12px] text-red-700 dark:text-red-300'>
            {describeError(meta.error, 'The fields could not be loaded').title}
          </p>
        ) : shown.length === 0 ? (
          <p className='px-2 py-3 text-[12px] leading-snug text-slate-500 dark:text-slate-400'>
            {q.trim()
              ? `Nothing here matches “${q.trim()}”.`
              : 'No related records here. A quick filter offers the records a field links to.'}
          </p>
        ) : (
          <ul>
            {shown.map((h) => {
              const key = [...prefix, h.field].join('.')
              const isCurrent = key === current
              const usedAs = used[key]
              return (
                <li key={h.field} className='group flex items-center rounded-md'>
                  <button
                    type='button'
                    onClick={() =>
                      onPick({ path: [...prefix, h.field], target: h.target, kind: h.kind })
                    }
                    className='flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50 dark:hover:bg-slate-800'
                  >
                    <span className='min-w-0 truncate text-[12.5px] text-slate-800 dark:text-slate-100'>
                      {titleCase(h.field)}
                    </span>
                    {isCurrent || usedAs ? (
                      <span className='inline-flex shrink-0 items-center gap-0.5 rounded bg-nvr-cyan/[0.12] px-1.5 py-px text-[10.5px] font-medium text-[#0284a8] dark:text-nvr-cyan'>
                        <Check aria-hidden className='h-2.5 w-2.5' strokeWidth={3} />
                        {isCurrent ? 'this filter' : `on the bar as ${usedAs}`}
                      </span>
                    ) : (
                      <span className='min-w-0 truncate text-[11px] text-slate-500 dark:text-slate-400'>
                        {h.kind === 'many' ? 'list of ' : 'links to '}
                        {titleCase(h.target)}
                      </span>
                    )}
                  </button>
                  <button
                    type='button'
                    onClick={() => {
                      setTrail((t) => [...t, { field: h.field, collection: h.target }])
                      setQ('')
                    }}
                    aria-label={`Fields of ${titleCase(h.field)}`}
                    data-tip={`Filter by something on ${titleCase(h.field)}`}
                    className='flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-slate-800 dark:hover:text-slate-200'
                  >
                    <ChevronRight className='h-3.5 w-3.5' />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

/** 'a.b' → the name the bar shows, for every path a filter uses. */
export function usedPathLabels(
  defs: Array<{ label?: string; path?: string[]; or_paths?: string[][] }>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of defs)
    for (const p of f.or_paths?.length ? f.or_paths : [f.path ?? []])
      if (p.length) out[p.join('.')] = f.label?.trim() || 'a filter'
  return out
}
