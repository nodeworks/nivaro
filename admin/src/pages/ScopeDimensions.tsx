import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Scope Dimensions — the User Scopes registry. A dimension names a target
 * collection; how it filters each business collection is auto-resolved from
 * the relations graph, shown live in the coverage table. Per-user values are
 * set on the user page (restrictions) and the profile page (defaults).
 */

interface Dim {
  id: number
  name: string
  label: string
  target_collection: string
  display_field: string | null
  options_sort: string | null
  overrides: Record<string, string[]> | null
  exclusions: string[] | null
  strict: boolean
  is_active: boolean
}

interface CoverageRow {
  collection: string
  status: 'self' | 'auto' | 'override' | 'excluded' | 'unreachable'
  route: string | null
}

const STATUS_STYLE: Record<CoverageRow['status'], string> = {
  self: 'bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-400',
  auto: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
  override: 'bg-[#00ceff1a] text-nvr-navy dark:text-nvr-cyan',
  excluded: 'bg-slate-100 text-slate-400 line-through dark:bg-muted',
  unreachable: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400'
}

function CoverageTable({ dim }: { dim: Dim }) {
  const {
    data: rows = [],
    refetch,
    isFetching
  } = useQuery({
    queryKey: ['scope-coverage', dim.id],
    queryFn: () =>
      api
        .get<{ data: CoverageRow[] }>(`/scope-dimensions/${dim.id}/coverage`)
        .then((r) => r.data.data)
  })
  return (
    <div className='mt-3'>
      <div className='mb-1 flex items-center gap-2'>
        <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
          Coverage — how "{dim.label}" applies per collection
        </p>
        <button
          type='button'
          onClick={() => void refetch()}
          className='rounded p-0.5 text-slate-300 hover:text-slate-500'
          title='Re-resolve from live relations'
        >
          <RefreshCw className={cn('h-3 w-3', isFetching && 'animate-spin')} />
        </button>
      </div>
      <div className='max-h-72 overflow-y-auto rounded-md border border-slate-100 dark:border-border'>
        <table className='w-full text-[11.5px]'>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.collection}
                className='border-b border-slate-50 last:border-0 dark:border-border/40'
              >
                <td className='px-2 py-1 font-medium text-slate-700 dark:text-slate-300'>
                  {r.collection}
                </td>
                <td className='px-2 py-1'>
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-px text-[10px] font-semibold',
                      STATUS_STYLE[r.status]
                    )}
                  >
                    {r.status}
                  </span>
                </td>
                <td className='px-2 py-1 font-mono text-[10.5px] text-slate-400'>
                  {r.route ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className='mt-1 text-[10.5px] text-slate-400'>
        auto = derived from relations (self-heals with schema changes) · unreachable = dimension
        doesn't apply{dim.strict ? ' (strict: restricted users are denied there)' : ''} · pin an
        override or exclusion via PATCH /scope-dimensions/{dim.id}.
      </p>
    </div>
  )
}

// ─── Raw SQL scope coverage (#770) ────────────────────────────────────────────
// Custom queries and extension read routes are raw SQL — the items-service
// scope enforcement cannot reach them. A query is safe when its scope params
// carry every dimension that reaches the tables it reads.

interface CoverageQuery {
  id: number
  slug: string
  name: string
  tables: string[]
  reaching: Array<{ dimension: string; label: string; tables: string[] }>
  covered: string[]
  missing: Array<{ dimension: string; label: string }>
  used_by: Array<{ surface: string; name: string; link: string | null }>
  status: 'covered' | 'unscoped-tables' | 'gap' | 'leak'
}
interface CoverageRoute {
  extension: string
  method: string
  url: string
  gate: string
  scope: 'enforced' | 'not-scoped' | null
}
interface CoverageReport {
  queries: CoverageQuery[]
  routes: CoverageRoute[]
  totals: { queries: number; leaks: number; gaps: number; routes_undeclared: number }
  computed_at: string
}

const Q_STYLE: Record<CoverageQuery['status'], { label: string; cls: string }> = {
  leak: {
    label: 'Runs unscoped',
    cls: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
  },
  gap: {
    label: 'Unscoped, unused',
    cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
  },
  covered: {
    label: 'Scoped',
    cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
  },
  'unscoped-tables': {
    label: 'No scoped tables',
    cls: 'bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-400'
  }
}

function RawSqlCoverageCard() {
  const [fresh, setFresh] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const { data, isFetching } = useQuery({
    queryKey: ['raw-sql-scope-coverage', fresh],
    queryFn: () =>
      api
        .get<{ data: CoverageReport }>('/scope-dimensions/raw-sql-coverage', {
          params: fresh ? { fresh: 1 } : {}
        })
        .then((r) => r.data.data)
  })
  const shown = (data?.queries ?? []).filter(
    (q) => showAll || q.status === 'leak' || q.status === 'gap'
  )
  const undeclared = (data?.routes ?? []).filter((r) => !r.scope)
  return (
    <div
      data-raw-sql-coverage
      className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
    >
      <div className='flex flex-wrap items-center gap-2'>
        <p className='text-[13.5px] font-semibold text-slate-800 dark:text-slate-100'>
          Raw SQL coverage
        </p>
        <button
          type='button'
          onClick={() => setFresh((n) => n + 1)}
          className='rounded p-0.5 text-slate-300 hover:text-slate-500'
          title='Re-check now'
        >
          <RefreshCw className={cn('h-3 w-3', isFetching && 'animate-spin')} />
        </button>
        {data && (
          <span className='ml-auto text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {data.totals.leaks} run unscoped · {data.totals.gaps} unscoped but unused ·{' '}
            {data.totals.routes_undeclared} extension routes undeclared
          </span>
        )}
      </div>
      <p className='mt-1 max-w-[80ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
        Custom queries skip User Scopes unless their scope params name each dimension that reaches
        the tables they read. A query a page, report or alert runs without them shows a restricted
        person rows outside their scope.
      </p>
      {!data ? (
        <p className='mt-3 text-[12px] text-slate-400'>Checking every query…</p>
      ) : (
        <>
          <div className='mt-3 max-h-96 overflow-y-auto rounded-md border border-slate-100 dark:border-border'>
            <table className='w-full text-[11.5px]'>
              <tbody>
                {shown.map((q) => (
                  <tr
                    key={q.id}
                    data-raw-sql-query={q.slug}
                    data-raw-sql-status={q.status}
                    className='border-b border-slate-50 align-top last:border-0 dark:border-border/40'
                  >
                    <td className='px-2 py-1.5'>
                      <Link
                        to={`/custom-queries/${q.id}`}
                        className='font-medium text-slate-700 hover:underline dark:text-slate-200'
                      >
                        {q.slug}
                      </Link>
                      <p className='text-[10.5px] text-slate-400' title={q.tables.join(', ')}>
                        reads {q.tables.length} table{q.tables.length === 1 ? '' : 's'}
                      </p>
                    </td>
                    <td className='px-2 py-1.5'>
                      <span
                        className={cn(
                          'whitespace-nowrap rounded-full px-1.5 py-px text-[10px] font-semibold',
                          Q_STYLE[q.status].cls
                        )}
                      >
                        {Q_STYLE[q.status].label}
                      </span>
                    </td>
                    <td className='px-2 py-1.5 text-slate-600 dark:text-slate-300'>
                      {q.missing.length > 0 ? (
                        <>needs {q.missing.map((m) => m.label).join(', ')}</>
                      ) : (
                        <span className='text-slate-400'>—</span>
                      )}
                    </td>
                    <td className='px-2 py-1.5 text-slate-500 dark:text-muted-foreground'>
                      {q.used_by.slice(0, 3).map((d, i) => (
                        <span key={`${d.surface}-${d.name}-${i}`} className='block'>
                          {d.link ? (
                            <Link to={d.link} className='hover:underline'>
                              {d.name}
                            </Link>
                          ) : (
                            d.name
                          )}{' '}
                          <span className='text-slate-400'>· {d.surface}</span>
                        </span>
                      ))}
                      {q.used_by.length > 3 && (
                        <span className='text-slate-400'>+{q.used_by.length - 3} more</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type='button'
            onClick={() => setShowAll((v) => !v)}
            className='mt-1 text-[11px] text-slate-400 hover:text-slate-600'
          >
            {showAll ? 'Only the gaps' : `Show all ${data.queries.length} queries`}
          </button>
          {undeclared.length > 0 && (
            <details className='mt-3'>
              <summary className='cursor-pointer text-[12px] font-medium text-slate-600 dark:text-slate-300'>
                {undeclared.length} extension read routes have not said whether they apply scopes
              </summary>
              <p className='mt-1 text-[11px] text-slate-400'>
                The extension declares it on the route: config: {'{'} scope: 'enforced' |
                'not-scoped' {'}'}.
              </p>
              <ul className='mt-1 columns-2 gap-4 font-mono text-[10.5px] text-slate-500'>
                {undeclared.map((r) => (
                  <li key={`${r.extension}${r.url}`} data-raw-sql-route={r.url}>
                    {r.url}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  )
}

export function ScopeDimensionsPage() {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState<number | null>(null)
  const [draft, setDraft] = useState({
    name: '',
    label: '',
    target_collection: '',
    display_field: ''
  })

  const { data: dims = [] } = useQuery({
    queryKey: ['scope-dimensions'],
    queryFn: () => api.get<{ data: Dim[] }>('/scope-dimensions').then((r) => r.data.data)
  })
  const { data: collections = [] } = useQuery({
    queryKey: ['collections-list-scopes'],
    queryFn: () =>
      api
        .get<{ data: Array<{ collection: string }> }>('/collections')
        .then((r) => r.data.data.map((c) => c.collection).filter((c) => !c.startsWith('nivaro_')))
  })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['scope-dimensions'] })

  const create = useMutation({
    mutationFn: () => api.post('/scope-dimensions', draft),
    onSuccess: () => {
      setDraft({ name: '', label: '', target_collection: '', display_field: '' })
      invalidate()
      toast.success('Dimension created')
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Create failed')
  })
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api.patch(`/scope-dimensions/${id}`, body),
    onSuccess: invalidate
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/scope-dimensions/${id}`),
    onSuccess: () => {
      invalidate()
      toast.success('Dimension deleted (user scopes for it removed)')
    }
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2'>
          <SlidersHorizontal className='h-5 w-5 text-nvr-navy dark:text-nvr-cyan' />
          <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
            Scope Dimensions
          </h1>
        </div>
        <p className='mt-0.5 text-[12.5px] text-slate-500'>
          Per-user defaults and restrictions by dimension (zone, region, …). Paths auto-resolve from
          the relations graph — set values per user on their user page.
        </p>
      </header>

      <div className='min-h-0 flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        <div className='space-y-3'>
          <RawSqlCoverageCard />
          {dims.map((d) => (
            <div
              key={d.id}
              className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
            >
              <div className='flex flex-wrap items-center gap-3'>
                <div className='min-w-0'>
                  <p className='text-[13.5px] font-semibold text-slate-800 dark:text-slate-100'>
                    {d.label}
                    <span className='ml-2 font-mono text-[11px] font-normal text-slate-400'>
                      {d.name}
                    </span>
                  </p>
                  <p className='text-[11.5px] text-slate-400'>
                    → {d.target_collection}
                    {d.display_field ? ` · shows ${d.display_field}` : ''}
                  </p>
                </div>
                <div className='ml-auto flex items-center gap-3'>
                  <label className='flex items-center gap-1.5 text-[11.5px] text-slate-500'>
                    <Switch
                      checked={d.strict}
                      onCheckedChange={(v) => patch.mutate({ id: d.id, body: { strict: v } })}
                    />
                    Strict
                  </label>
                  <label className='flex items-center gap-1.5 text-[11.5px] text-slate-500'>
                    <Switch
                      checked={d.is_active}
                      onCheckedChange={(v) => patch.mutate({ id: d.id, body: { is_active: v } })}
                    />
                    Active
                  </label>
                  <button
                    type='button'
                    className='text-[11.5px] text-slate-400 hover:text-slate-600'
                    onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                  >
                    {expanded === d.id ? 'Hide coverage' : 'Coverage'}
                  </button>
                  <button
                    type='button'
                    className='p-1 text-slate-300 hover:text-red-500'
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete dimension "${d.label}" and every user's values for it?`
                        )
                      )
                        remove.mutate(d.id)
                    }}
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </button>
                </div>
              </div>
              {expanded === d.id && <CoverageTable dim={d} />}
            </div>
          ))}

          <div className='rounded-lg border border-dashed border-slate-300 bg-white p-4 dark:border-border dark:bg-card'>
            <p className='mb-2 text-[12.5px] font-semibold text-slate-700 dark:text-slate-200'>
              New dimension
            </p>
            <div className='flex flex-wrap items-end gap-2'>
              <div>
                <p className='mb-1 text-[10.5px] uppercase tracking-wide text-slate-400'>Label</p>
                <Input
                  value={draft.label}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      label: e.target.value,
                      name: draft.name || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_')
                    })
                  }
                  placeholder='Zone'
                  className='h-8 w-[140px] text-[12.5px]'
                />
              </div>
              <div>
                <p className='mb-1 text-[10.5px] uppercase tracking-wide text-slate-400'>Name</p>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder='division'
                  className='h-8 w-[130px] font-mono text-[12px]'
                />
              </div>
              <div>
                <p className='mb-1 text-[10.5px] uppercase tracking-wide text-slate-400'>
                  Target collection
                </p>
                <SimpleSelect
                  value={draft.target_collection}
                  onChange={(v) => setDraft({ ...draft, target_collection: v })}
                  className='h-8 w-[180px] rounded-md border-slate-200 bg-white px-2 text-[12.5px] dark:border-border dark:bg-card'
                  options={[
                    { value: '', label: 'Pick…' },
                    ...collections.map((c) => ({ value: c, label: c }))
                  ]}
                />
              </div>
              <div>
                <p className='mb-1 text-[10.5px] uppercase tracking-wide text-slate-400'>
                  Display field
                </p>
                <Input
                  value={draft.display_field}
                  onChange={(e) => setDraft({ ...draft, display_field: e.target.value })}
                  placeholder='short_name'
                  className='h-8 w-[130px] font-mono text-[12px]'
                />
              </div>
              <Button
                size='sm'
                className='h-8 gap-1'
                disabled={!draft.label || !draft.target_collection || create.isPending}
                onClick={() => create.mutate()}
              >
                <Plus className='h-3.5 w-3.5' /> Create
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
