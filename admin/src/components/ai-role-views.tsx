import { useMutation, useQuery } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

/**
 * Suggested saved views per role (#1965) — a Roles tab. The server reads the
 * filters people in each role kept applying by hand in collection lists (the
 * API log, last 14 days), drops filter sets a shared view already covers, and
 * the AI names them. Creating one writes a shared view scoped to the role.
 */

interface ActiveFilterLike {
  id: string
  path: string[]
  pathLabels: string[]
  op: string
  value: string | Array<string | number>
}

interface Suggestion {
  id: string
  role: { id: string; name: string; members: number }
  collection: string
  collection_label: string
  filters: ActiveFilterLike[]
  sort: string | null
  columns: string[] | null
  name: string
  description: string | null
  people: number
  uses: number
}

interface SuggestResult {
  days: number
  suggestions: Suggestion[]
  ai_used: boolean
  ai_error: string | null
  ai_configured: boolean
}

const OPS: Record<string, string> = {
  _eq: 'is',
  _neq: 'is not',
  _in: 'is any of',
  _nin: 'is none of',
  _gt: '>',
  _gte: '≥',
  _lt: '<',
  _lte: '≤',
  _contains: 'contains',
  _null: 'is empty',
  _nnull: 'is set'
}

const errOf = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback

const sameId = (a: string, b: string) => a.toUpperCase() === b.toUpperCase()

export function RoleViewSuggestions({ roleId }: { roleId: string }) {
  const [asked, setAsked] = useState(false)
  const [names, setNames] = useState<Record<string, string>>({})
  const [created, setCreated] = useState<Record<string, number>>({})

  // One fetch serves every role's tab — the analysis spans all roles.
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['ai-design-role-views'],
    queryFn: () =>
      api
        .post<{ data: SuggestResult }>('/ai-design/role-views/suggest', { days: 14 })
        .then((r) => r.data.data),
    enabled: asked,
    staleTime: 10 * 60_000
  })

  const create = useMutation({
    mutationFn: (s: Suggestion) =>
      api
        .post<{ data: { id: number } }>('/ai-design/role-views/apply', {
          role: s.role.id,
          collection: s.collection,
          name: names[s.id] ?? s.name,
          filters: s.filters,
          sort: s.sort,
          columns: s.columns
        })
        .then((r) => r.data.data),
    onSuccess: (d, s) => {
      setCreated((m) => ({ ...m, [s.id]: d.id }))
      toast.success(`View created for ${s.role.name}`)
    },
    onError: (e) => toast.error(errOf(e, 'Could not create the view'))
  })

  const mine = (data?.suggestions ?? []).filter((s) => sameId(s.role.id, roleId))

  return (
    <div className='space-y-3' data-ai-role-views>
      <div className='flex items-start justify-between gap-3'>
        <p className='max-w-[560px] text-[12px] text-slate-500'>
          Filters people in this role keep applying by hand in collection lists (last 14 days),
          proposed as shared views for the role. Filter sets an existing shared view already covers
          are left out.
        </p>
        <Button
          size='sm'
          variant='outline'
          disabled={isFetching}
          onClick={() => (asked ? refetch() : setAsked(true))}
        >
          <Sparkles className='mr-1.5 h-3.5 w-3.5 text-nvr-cyan' />
          {isFetching ? 'Looking…' : data ? 'Look again' : 'Find suggestions'}
        </Button>
      </div>
      {data?.ai_error && (
        <p className='text-[11px] text-amber-600'>
          The AI could not name the views ({data.ai_error}) — showing plain names.
        </p>
      )}
      {data && mine.length === 0 && (
        <p className='text-[12px] text-slate-400'>
          No repeated hand-applied filters for this role yet.
        </p>
      )}
      {mine.map((s) => (
        <div
          key={s.id}
          className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
        >
          <div className='flex items-start justify-between gap-3'>
            <div className='min-w-0 flex-1'>
              <input
                value={names[s.id] ?? s.name}
                onChange={(e) => setNames((m) => ({ ...m, [s.id]: e.target.value }))}
                disabled={s.id in created}
                aria-label='View name'
                className='w-full rounded border border-transparent bg-transparent px-1 text-[13px] font-medium text-slate-800 hover:border-slate-200 focus:border-slate-300 dark:text-foreground dark:hover:border-border'
              />
              <p className='px-1 text-[11.5px] text-slate-500'>
                {s.collection_label}
                {s.description ? ` · ${s.description}` : ''}
              </p>
            </div>
            {s.id in created ? (
              <span className='shrink-0 text-[12px] text-emerald-600'>Created</span>
            ) : (
              <Button
                size='sm'
                disabled={create.isPending || !(names[s.id] ?? s.name).trim()}
                onClick={() => create.mutate(s)}
              >
                Create view
              </Button>
            )}
          </div>
          <div className='mt-2 flex flex-wrap gap-1 px-1'>
            {s.filters.map((f) => (
              <span
                key={f.id}
                className='rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-muted dark:text-slate-300'
              >
                {f.pathLabels.join(' › ')} {OPS[f.op] ?? f.op}{' '}
                {Array.isArray(f.value) ? f.value.join(', ') : f.value}
              </span>
            ))}
            {s.sort && (
              <span className='rounded px-1.5 py-0.5 text-[11px] text-slate-400'>
                sorted by {s.sort}
              </span>
            )}
          </div>
          <p className='mt-2 px-1 text-[11px] text-slate-400'>
            {s.people} of {s.role.members} member{s.role.members === 1 ? '' : 's'} applied this by
            hand · {s.uses} person-day{s.uses === 1 ? '' : 's'}
            {s.columns ? ` · columns: ${s.columns.join(', ')}` : ''}
          </p>
        </div>
      ))}
    </div>
  )
}
