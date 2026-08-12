import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ShieldAlert, SlidersHorizontal } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Admin per-user Scopes editor (UserEdit page). Two rows per dimension:
 * defaults (seeds the user's UIs) and restrictions (server-enforced row
 * scoping — the user can ONLY see rows matching the picked values).
 */

interface ScopesInfo {
  dimensions: Array<{
    name: string
    label: string
    target_collection: string
    display_field: string | null
    options_sort: string | null
  }>
  defaults: Record<string, Array<string | number>>
  restricted: Record<string, Array<string | number>>
}

function ValuePills({
  dimension,
  selected,
  accent,
  onToggle
}: {
  dimension: ScopesInfo['dimensions'][number]
  selected: Array<string | number>
  accent: 'cyan' | 'amber'
  onToggle: (values: Array<string | number>) => void
}) {
  const lf = dimension.display_field ?? 'name'
  const [q, setQ] = useState('')
  const { data: options = [] } = useQuery({
    queryKey: ['scope-options', dimension.name],
    queryFn: () =>
      api
        .get<{ data: Array<Record<string, unknown>> }>(`/items/${dimension.target_collection}`, {
          params: {
            fields: `id,${lf}`,
            limit: 200,
            ...(dimension.options_sort ? { sort: dimension.options_sort } : {})
          }
        })
        .then((r) =>
          (r.data.data ?? []).map((row) => ({
            id: row.id as string | number,
            label: String(row[lf] ?? row.id)
          }))
        )
  })
  // Big value spaces get a search-to-add picker instead of a pill wall; the
  // search hits the server so nothing is capped at the first 200 options.
  const pickerMode = options.length > 24
  const { data: matches = [], isFetching: searching } = useQuery({
    queryKey: ['scope-search', dimension.name, q],
    queryFn: () =>
      api
        .get<{ data: Array<Record<string, unknown>> }>(`/items/${dimension.target_collection}`, {
          params: {
            fields: `id,${lf}`,
            limit: 30,
            filter: JSON.stringify({ [lf]: { _contains: q } }),
            ...(dimension.options_sort ? { sort: dimension.options_sort } : {})
          }
        })
        .then((r) =>
          (r.data.data ?? []).map((row) => ({
            id: row.id as string | number,
            label: String(row[lf] ?? row.id)
          }))
        ),
    enabled: pickerMode && q.trim().length > 0,
    placeholderData: (prev) => prev
  })
  const known = new Map(options.map((o) => [String(o.id), o.label]))
  for (const m of matches) known.set(String(m.id), m.label)
  const missing = selected.filter((v) => !known.has(String(v)))
  const { data: extraLabels = [] } = useQuery({
    queryKey: ['scope-selected-labels', dimension.name, missing.map(String).sort().join(',')],
    queryFn: () =>
      api
        .get<{ data: Array<Record<string, unknown>> }>(`/items/${dimension.target_collection}`, {
          params: {
            fields: `id,${lf}`,
            limit: 100,
            filter: JSON.stringify({ id: { _in: missing } })
          }
        })
        .then((r) =>
          (r.data.data ?? []).map((row) => ({
            id: row.id as string | number,
            label: String(row[lf] ?? row.id)
          }))
        ),
    enabled: missing.length > 0
  })
  for (const e of extraLabels) known.set(String(e.id), e.label)

  const sel = new Set(selected.map(String))
  const toggle = (id: string | number) =>
    onToggle(sel.has(String(id)) ? selected.filter((v) => String(v) !== String(id)) : [...selected, id])
  const onCls =
    accent === 'amber'
      ? 'border-amber-400 bg-amber-50 font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
      : 'border-nvr-cyan bg-accent font-medium text-nvr-navy dark:text-nvr-cyan'

  if (!pickerMode) {
    return (
      <div className='flex flex-wrap gap-1'>
        {options.map((o) => {
          const on = sel.has(String(o.id))
          return (
            <button
              key={String(o.id)}
              type='button'
              onClick={() => toggle(o.id)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors',
                on ? onCls : 'border-slate-200 text-slate-400 hover:border-slate-300 dark:border-border'
              )}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    )
  }
  return (
    <div className='max-w-xl'>
      {selected.length > 0 && (
        <div className='mb-1.5 flex flex-wrap gap-1'>
          {selected.map((v) => (
            <span
              key={String(v)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1 text-[11.5px]',
                onCls
              )}
            >
              {known.get(String(v)) ?? String(v)}
              <button
                type='button'
                onClick={() => toggle(v)}
                aria-label={`Remove ${known.get(String(v)) ?? v}`}
                className='rounded-full px-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${dimension.label.toLowerCase()} to add…`}
        className='h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12px] outline-none focus:border-nvr-cyan dark:border-border dark:bg-card'
      />
      {q.trim().length > 0 && (
        <div className='mt-1 max-h-44 overflow-y-auto rounded-md border border-slate-200 dark:border-border'>
          {matches.map((m) => {
            const on = sel.has(String(m.id))
            return (
              <button
                key={String(m.id)}
                type='button'
                onClick={() => toggle(m.id)}
                className={cn(
                  'flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-muted',
                  on ? 'font-medium text-nvr-navy dark:text-nvr-cyan' : 'text-slate-600 dark:text-slate-300'
                )}
              >
                <span className='truncate'>{m.label}</span>
                <span className='pl-2 text-[11px] text-slate-400'>{on ? 'Remove' : 'Add'}</span>
              </button>
            )
          })}
          {matches.length === 0 && (
            <p className='px-2.5 py-2 text-[11.5px] text-slate-400'>
              {searching ? 'Searching…' : 'No matches.'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function UserScopesCard({ userId }: { userId: string }) {
  const queryClient = useQueryClient()
  const { data: scopes } = useQuery({
    queryKey: ['user-scopes', userId],
    queryFn: () => api.get<{ data: ScopesInfo }>(`/user-scopes/${userId}`).then((r) => r.data.data)
  })
  const save = useMutation({
    mutationFn: (body: { dimension: string; mode: 'default' | 'restrict'; values: Array<string | number> }) =>
      api.put(`/user-scopes/${userId}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['user-scopes', userId] })
  })

  if (!scopes || scopes.dimensions.length === 0) return null
  return (
    <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <header className='flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <SlidersHorizontal className='h-4 w-4 text-nvr-navy dark:text-nvr-cyan' />
        <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>Scopes</h3>
        <p className='hidden text-[11px] text-slate-400 sm:block'>
          Defaults pre-fill their filters; restrictions limit what they can see
        </p>
      </header>
      <div className='space-y-4 p-4'>
        {scopes.dimensions.map((d) => (
          <div key={d.name}>
            <p className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
              {d.label}
            </p>
            <div className='mt-1.5 space-y-2'>
              <div>
                <p className='mb-1 text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
                  Defaults
                </p>
                <ValuePills
                  dimension={d}
                  selected={scopes.defaults[d.name] ?? []}
                  accent='cyan'
                  onToggle={(values) => save.mutate({ dimension: d.name, mode: 'default', values })}
                />
              </div>
              <div>
                <p className='mb-1 flex items-center gap-1 text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
                  <ShieldAlert className='h-3 w-3 text-amber-500' /> Restricted to
                  <span className='normal-case tracking-normal'>
                    (empty = unrestricted; enforced on every read)
                  </span>
                </p>
                <ValuePills
                  dimension={d}
                  selected={scopes.restricted[d.name] ?? []}
                  accent='amber'
                  onToggle={(values) => save.mutate({ dimension: d.name, mode: 'restrict', values })}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
