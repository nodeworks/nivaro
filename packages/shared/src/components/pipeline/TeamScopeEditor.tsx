import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, put } from '../../lib/commands'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { type ScopeDimensionLite, type TeamScopeMap, useScopeDimensions } from './teamScopes'

/**
 * Team scope editor — one row per scope dimension: selected values as chips,
 * "All <dimension>" when unset (unset = unrestricted, the documented
 * semantics). Values picked from the dimension's target collection through a
 * styled searchable combobox; edits stage locally and save in one PUT.
 */

function ScopeValuePicker({
  dim,
  selectedIds,
  onPick
}: {
  dim: ScopeDimensionLite
  selectedIds: Array<string | number>
  onPick: (id: string | number, label: string) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
    else setQuery('')
  }, [open])
  const displayField = dim.display_field || 'name'
  const { data: options, isFetching } = useQuery<Record<string, unknown>[]>({
    queryKey: ['team-scope-options', dim.target_collection, query.trim()],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${dim.target_collection}`, {
            limit: 30,
            search: query.trim() || undefined,
            sort: displayField
          })
        )
        .then((r) => r.data)
        .catch(() => []),
    enabled: open,
    staleTime: 60_000
  })
  const picked = new Set(selectedIds.map(String))
  const labelOf = (row: Record<string, unknown>) =>
    String(row[displayField] ?? row.name ?? row.id ?? '')
  const available = (options ?? []).filter((row) => !picked.has(String(row.id)))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={`Add ${dim.label} value`}
          className='inline-flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-slate-300 text-slate-400 transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-border dark:hover:text-violet-300'
        >
          <Plus className='h-3 w-3' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='z-[150] w-64 p-0' sideOffset={4}>
        <div className='border-b border-slate-100 px-2 py-1.5 dark:border-border'>
          <div className='relative'>
            <Search className='absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${dim.label.toLowerCase()}…`}
              className='h-7 w-full rounded-md bg-slate-50 pl-7 pr-2 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-400/40 dark:bg-muted'
            />
          </div>
        </div>
        <div className='max-h-48 overflow-y-auto py-1'>
          {isFetching && available.length === 0 ? (
            <div className='flex justify-center py-3'>
              <Loader2 className='h-3.5 w-3.5 animate-spin text-slate-400' />
            </div>
          ) : (
            available.map((row) => (
              <button
                key={String(row.id)}
                type='button'
                onClick={() => {
                  onPick(row.id as string | number, labelOf(row))
                  setOpen(false)
                }}
                className='flex w-full items-center px-3 py-1.5 text-left text-[12px] text-slate-700 hover:bg-muted dark:text-slate-200'
              >
                {labelOf(row)}
              </button>
            ))
          )}
          {!isFetching && available.length === 0 && (
            <p className='px-3 py-2 text-[12px] text-slate-400'>No matches</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function TeamScopeEditor({
  teamId,
  scopes,
  onSaved
}: {
  teamId: number
  /** The team's saved scopes ({dimension: ids[]}). */
  scopes: TeamScopeMap
  onSaved?: (next: TeamScopeMap) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const dims = useScopeDimensions()
  const [draft, setDraft] = useState<TeamScopeMap>(scopes)
  const [labels, setLabels] = useState<Record<string, string>>({})
  // Re-seed when the team (or its saved scopes) changes under us.
  const seedKey = `${teamId}:${JSON.stringify(scopes)}`
  const seededRef = useRef('')
  useEffect(() => {
    if (seededRef.current === seedKey) return
    seededRef.current = seedKey
    setDraft(scopes)
  }, [seedKey, scopes])

  // Resolve display labels for saved ids (draft additions carry their label
  // from the picker; only ids loaded from the server need a lookup).
  const lookups = useQueries({
    queries: dims
      .filter((d) => (draft[d.name] ?? []).length > 0)
      .map((d) => ({
        queryKey: ['team-scope-labels', d.target_collection, (draft[d.name] ?? []).join(',')],
        queryFn: () =>
          client
            .request<{ data: Record<string, unknown>[] }>(
              get(`/items/${d.target_collection}`, {
                limit: 200,
                filter: JSON.stringify({ id: { _in: draft[d.name] } })
              })
            )
            .then((r) =>
              Object.fromEntries(
                r.data.map((row) => [
                  `${d.name}:${row.id}`,
                  String(row[d.display_field || 'name'] ?? row.id)
                ])
              )
            )
            .catch(() => ({}) as Record<string, string>),
        staleTime: 5 * 60_000
      }))
  })
  const resolvedLabels: Record<string, string> = Object.assign(
    {},
    ...lookups.map((q) => q.data ?? {}),
    labels
  )

  const dirty = JSON.stringify(draft) !== JSON.stringify(scopes)
  const save = useMutation({
    mutationFn: () => client.request(put(`/user-groups/${teamId}/scopes`, { scopes: draft })),
    onSuccess: () => {
      toast.success('Team scope saved')
      void qc.invalidateQueries({ queryKey: ['user-groups-teams'] })
      void qc.invalidateQueries({ queryKey: ['user-groups'] })
      void qc.invalidateQueries({ queryKey: ['team-candidates'] })
      onSaved?.(draft)
    },
    onError: (e) =>
      toast.error((e as { response?: { error?: string } })?.response?.error ?? 'Save failed')
  })

  if (dims.length === 0) return null
  return (
    <div className='space-y-1.5'>
      <div className='flex items-center gap-2'>
        <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>Scope</p>
        <span className='text-[10.5px] text-slate-400'>
          unset = all · pickers rank matches first, never a gate
        </span>
        {dirty && (
          <span className='ml-auto flex items-center gap-1'>
            <Button
              size='sm'
              variant='ghost'
              className='h-5 px-1.5 text-[10.5px]'
              onClick={() => setDraft(scopes)}
            >
              Reset
            </Button>
            <Button
              size='sm'
              className='h-5 bg-violet-600 px-2 text-[10.5px] text-white hover:bg-violet-700'
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save scope'}
            </Button>
          </span>
        )}
      </div>
      <div className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border/60 dark:border-border'>
        {dims.map((d) => {
          const ids = draft[d.name] ?? []
          return (
            <div key={d.name} className='flex items-center gap-2 px-2.5 py-1.5'>
              <span className='w-20 shrink-0 truncate text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
                {d.label}
              </span>
              <span className='flex min-w-0 flex-1 flex-wrap items-center gap-1'>
                {ids.length === 0 ? (
                  <span className='text-[11.5px] italic text-slate-400'>
                    All {d.label.toLowerCase()}s
                  </span>
                ) : (
                  ids.map((id) => (
                    <span
                      key={String(id)}
                      className='inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-px text-[11px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
                    >
                      {resolvedLabels[`${d.name}:${id}`] ?? String(id)}
                      <button
                        type='button'
                        aria-label='Remove value'
                        className='text-violet-400 hover:text-violet-700 dark:hover:text-violet-200'
                        onClick={() =>
                          setDraft({
                            ...draft,
                            [d.name]: ids.filter((x) => String(x) !== String(id))
                          })
                        }
                      >
                        <X className='h-3 w-3' />
                      </button>
                    </span>
                  ))
                )}
                <ScopeValuePicker
                  dim={d}
                  selectedIds={ids}
                  onPick={(id, label) => {
                    setLabels((prev) => ({ ...prev, [`${d.name}:${id}`]: label }))
                    setDraft({ ...draft, [d.name]: [...ids, id] })
                  }}
                />
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
