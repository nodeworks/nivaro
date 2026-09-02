import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Database, Loader2, Play, Plus, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Developer → Procedures — manage the database's stored procedures in-app.
 *
 * The database is the runtime source of truth; on EFP deployments the
 * efp-ops vendored registry (/efp/procedures) adds per-proc drift status
 * (in-sync / drifted / live-only / app-managed) which renders as chips —
 * absent on plain deployments, the page degrades to plain management.
 *
 * Parameters come from sys.parameters via the API (the engine's own
 * catalog), so the Run form always matches the deployed signature.
 */

interface ProcRow {
  name: string
  created: string
  modified: string
  bytes: number
  param_count: number
}

interface ProcParam {
  name: string
  type: string
  is_output: boolean
  position: number
}

interface ProcDetail {
  name: string
  created: string
  modified: string
  definition: string
  params: ProcParam[]
}

type VendorStatus = 'in-sync' | 'drifted' | 'missing-live' | 'live-only' | 'app-managed'

const STATUS_CHIP: Record<VendorStatus, { label: string; cls: string; tip: string }> = {
  'in-sync': {
    label: 'in sync',
    cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    tip: 'Matches the vendored definition in efp-ops/procedures'
  },
  drifted: {
    label: 'drifted',
    cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    tip: 'The live definition differs from the vendored file — run proc:dump to re-vendor, or proc:deploy to push the file out'
  },
  'live-only': {
    label: 'unvendored',
    cls: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
    tip: 'Exists in the database but has no vendored file yet — run proc:dump'
  },
  'missing-live': {
    label: 'missing',
    cls: 'bg-red-500/10 text-red-700 dark:text-red-400',
    tip: 'Vendored file exists but the procedure is absent from this database'
  },
  'app-managed': {
    label: 'app-managed',
    cls: 'bg-slate-500/10 text-slate-500 dark:text-slate-400',
    tip: 'Body owned by an import definition (nivaro_import_definitions) — edit it there, not here'
  }
}

const NEW_TEMPLATE = (name: string) => `CREATE OR ALTER PROCEDURE ${name}
  -- @Param INT = NULL
AS
BEGIN
  SET NOCOUNT ON;

  SELECT 1 AS ok;
END
`

function paramInputType(sqlType: string): 'number' | 'date' | 'text' {
  if (/int|decimal|numeric|float|real|money|bit/i.test(sqlType)) return 'number'
  if (/^date$/i.test(sqlType)) return 'date'
  if (/datetime/i.test(sqlType)) return 'text'
  return 'text'
}

export function ProceduresPage() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const { data: procs = [], isLoading } = useQuery<ProcRow[]>({
    queryKey: ['procedures'],
    queryFn: () => api.get<{ data: ProcRow[] }>('/procedures').then((r) => r.data.data)
  })
  // EFP vendored registry — optional enrichment, 404s cleanly elsewhere.
  const { data: vendor } = useQuery<Record<string, VendorStatus>>({
    queryKey: ['procedures-vendor'],
    queryFn: () =>
      api
        .get<{ data: { procs: Array<{ name: string; status: VendorStatus }> } }>('/efp/procedures')
        .then((r) => Object.fromEntries(r.data.data.procs.map((p) => [p.name.toLowerCase(), p.status])))
        .catch(() => ({})),
    staleTime: 60_000,
    retry: false
  })

  const filtered = useMemo(
    () => procs.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase())),
    [procs, search]
  )
  const vendorOf = (name: string): VendorStatus | undefined => vendor?.[name.toLowerCase()]

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-6 py-3.5 dark:border-border dark:bg-card'>
        <Database className='h-4 w-4 text-nvr-cyan' />
        <div className='min-w-0'>
          <h1 className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>Procedures</h1>
          <p className='text-[11.5px] text-slate-400 dark:text-muted-foreground'>
            The database's stored procedures — inspect, run with parsed parameters, edit and deploy.
          </p>
        </div>
        <div className='ml-auto flex items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            className='h-8 gap-1.5 text-[12px]'
            onClick={() => {
              setCreating(true)
              setSelected(null)
            }}
          >
            <Plus className='h-3.5 w-3.5' /> New procedure
          </Button>
          <Button
            size='sm'
            variant='ghost'
            className='h-8 w-8 p-0'
            aria-label='Refresh'
            onClick={() => {
              void qc.invalidateQueries({ queryKey: ['procedures'] })
              void qc.invalidateQueries({ queryKey: ['procedures-vendor'] })
            }}
          >
            <RefreshCw className='h-3.5 w-3.5' />
          </Button>
        </div>
      </header>
      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='flex w-[272px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='shrink-0 border-b border-slate-100 p-2.5 dark:border-border'>
            <div className='relative'>
              <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-300' />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${procs.length} procedures…`}
                className='h-8 pl-8 text-[12.5px]'
              />
            </div>
          </div>
          <div className='min-h-0 flex-1 overflow-y-auto'>
            {isLoading && (
              <div className='space-y-1.5 p-2.5'>
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className='h-9 w-full rounded-md' />
                ))}
              </div>
            )}
            {filtered.map((p) => {
              const vs = vendorOf(p.name)
              return (
                <button
                  key={p.name}
                  type='button'
                  onClick={() => {
                    setSelected(p.name)
                    setCreating(false)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 border-b border-slate-50 px-3 py-2 text-left transition-colors dark:border-border/50',
                    selected === p.name
                      ? 'bg-[#00ceff]/10'
                      : 'hover:bg-slate-50 dark:hover:bg-muted/50'
                  )}
                >
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate font-mono text-[12px] text-slate-800 dark:text-slate-200'>
                      {p.name}
                    </span>
                    <span className='block text-[10.5px] text-slate-400'>
                      {p.param_count} param{p.param_count === 1 ? '' : 's'} · edited{' '}
                      {formatRelative(p.modified)}
                    </span>
                  </span>
                  {vs && vs !== 'in-sync' && (
                    <span
                      className={cn('shrink-0 rounded-full px-1.5 py-px text-[9.5px] font-medium', STATUS_CHIP[vs].cls)}
                      data-tip={STATUS_CHIP[vs].tip}
                    >
                      {STATUS_CHIP[vs].label}
                    </span>
                  )}
                </button>
              )
            })}
            {!isLoading && filtered.length === 0 && (
              <p className='p-4 text-center text-[12px] text-slate-400'>No procedures match.</p>
            )}
          </div>
        </aside>
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {creating ? (
            <NewProcedurePanel
              name={newName}
              onName={setNewName}
              onCreated={(n) => {
                setCreating(false)
                setNewName('')
                setSelected(n)
                void qc.invalidateQueries({ queryKey: ['procedures'] })
              }}
              onCancel={() => setCreating(false)}
            />
          ) : selected ? (
            <ProcedureDetail key={selected} name={selected} vendorStatus={vendorOf(selected)} onDropped={() => {
              setSelected(null)
              void qc.invalidateQueries({ queryKey: ['procedures'] })
            }} />
          ) : (
            <div className='flex h-full items-center justify-center'>
              <div className='text-center'>
                <Database className='mx-auto h-8 w-8 text-slate-200 dark:text-slate-700' />
                <p className='mt-2 text-[13px] text-slate-400'>Select a procedure to inspect, run, or edit it.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function NewProcedurePanel({
  name,
  onName,
  onCreated,
  onCancel
}: {
  name: string
  onName: (v: string) => void
  onCreated: (name: string) => void
  onCancel: () => void
}) {
  const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim())
  const [definition, setDefinition] = useState('')
  const body = definition || (valid ? NEW_TEMPLATE(name.trim()) : '')
  const create = useMutation({
    mutationFn: () => api.put(`/procedures/${name.trim()}`, { definition: body }),
    onSuccess: () => {
      toast.success(`Procedure ${name.trim()} created`)
      onCreated(name.trim())
    },
    onError: (err: unknown) =>
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Create failed',
        { duration: 10000 }
      )
  })
  return (
    <div className='p-6'>
      <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>New procedure</h2>
      <div className='mt-3 max-w-sm'>
        <Input
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder='procedure_name'
          className='h-8 font-mono text-[13px]'
        />
        {name.trim() !== '' && !valid && (
          <p className='mt-1 text-[11px] text-red-500'>Letters, digits and underscores only.</p>
        )}
      </div>
      <textarea
        value={body}
        onChange={(e) => setDefinition(e.target.value)}
        spellCheck={false}
        className='mt-3 h-72 w-full rounded-lg border border-slate-200 bg-white p-3 font-mono text-[12px] leading-relaxed text-slate-800 outline-none focus:border-nvr-cyan/50 dark:border-border dark:bg-card dark:text-slate-200'
      />
      <div className='mt-3 flex gap-2'>
        <Button size='sm' disabled={!valid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? <Loader2 className='mr-1 h-3.5 w-3.5 animate-spin' /> : <Check className='mr-1 h-3.5 w-3.5' />}
          Create & deploy
        </Button>
        <Button size='sm' variant='ghost' onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function ProcedureDetail({
  name,
  vendorStatus,
  onDropped
}: {
  name: string
  vendorStatus?: VendorStatus
  onDropped: () => void
}) {
  const qc = useQueryClient()
  const { data: detail, isLoading } = useQuery<ProcDetail>({
    queryKey: ['procedure', name],
    queryFn: () => api.get<{ data: ProcDetail }>(`/procedures/${name}`).then((r) => r.data.data)
  })
  const [draft, setDraft] = useState<string | null>(null)
  const [confirmDeploy, setConfirmDeploy] = useState(false)
  const [confirmDrop, setConfirmDrop] = useState(false)
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{
    rows: Array<Record<string, unknown>>
    row_count: number
    truncated: boolean
    duration_ms: number
  } | null>(null)

  const definition = draft ?? detail?.definition ?? ''
  const dirty = draft !== null && draft !== detail?.definition
  const appManaged = vendorStatus === 'app-managed'

  const deploy = useMutation({
    mutationFn: () => api.put(`/procedures/${name}`, { definition }),
    onSuccess: () => {
      toast.success(`${name} deployed`)
      setDraft(null)
      setConfirmDeploy(false)
      void qc.invalidateQueries({ queryKey: ['procedure', name] })
      void qc.invalidateQueries({ queryKey: ['procedures'] })
      void qc.invalidateQueries({ queryKey: ['procedures-vendor'] })
    },
    onError: (err: unknown) => {
      setConfirmDeploy(false)
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Deploy failed',
        { duration: 12000 }
      )
    }
  })
  const drop = useMutation({
    mutationFn: () => api.delete(`/procedures/${name}`),
    onSuccess: () => {
      toast.success(`${name} dropped`)
      onDropped()
    },
    onError: (err: unknown) =>
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Drop failed'
      )
  })
  interface AiReview {
    summary?: string
    improvements?: string[]
    index_suggestions?: Array<{ table: string; columns: string; reason: string; create_sql: string }>
    risks?: string[]
    tables_analyzed?: string[]
  }
  const [aiReview, setAiReview] = useState<AiReview | null>(null)
  const review = useMutation({
    mutationFn: () =>
      api.post<{ data: AiReview }>(`/procedures/${name}/ai-review`).then((r) => r.data.data),
    onSuccess: (data) => setAiReview(data),
    onError: (err: unknown) =>
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'AI review failed',
        { duration: 10000 }
      )
  })
  const run = useMutation({
    mutationFn: () => {
      const params: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(paramValues)) {
        if (v.trim() !== '') params[k] = v
      }
      return api
        .post<{ data: typeof result }>(`/procedures/${name}/execute`, { params })
        .then((r) => r.data.data)
    },
    onSuccess: (data) => setResult(data),
    onError: (err: unknown) =>
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Execution failed',
        { duration: 12000 }
      )
  })

  if (isLoading || !detail) {
    return (
      <div className='space-y-3 p-6'>
        <Skeleton className='h-6 w-64' />
        <Skeleton className='h-64 w-full rounded-lg' />
      </div>
    )
  }

  return (
    <div className='space-y-4 p-6'>
      <div className='flex flex-wrap items-center gap-2'>
        <h2 className='font-mono text-[15px] font-semibold text-slate-900 dark:text-foreground'>{name}</h2>
        {vendorStatus && (
          <span
            className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-medium', STATUS_CHIP[vendorStatus].cls)}
            data-tip={STATUS_CHIP[vendorStatus].tip}
          >
            {STATUS_CHIP[vendorStatus].label}
          </span>
        )}
        <span className='text-[11px] text-slate-400'>
          modified {formatRelative(detail.modified)} · {detail.params.length} parameter
          {detail.params.length === 1 ? '' : 's'}
        </span>
        <div className='ml-auto flex items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            className='h-7 gap-1.5 text-[11.5px]'
            disabled={review.isPending}
            onClick={() => review.mutate()}
            data-tip='Parse the procedure, compare it against the live schema and indexes of every table it touches, and suggest improvements'
          >
            {review.isPending ? (
              <Loader2 className='h-3 w-3 animate-spin' />
            ) : (
              <Sparkles className='h-3 w-3 text-nvr-cyan' />
            )}
            AI review
          </Button>
          {confirmDrop ? (
            <>
              <span className='text-[11.5px] text-red-500'>Drop {name} permanently?</span>
              <Button size='sm' variant='destructive' className='h-7 text-[11.5px]' disabled={drop.isPending} onClick={() => drop.mutate()}>
                Drop it
              </Button>
              <Button size='sm' variant='ghost' className='h-7 text-[11.5px]' onClick={() => setConfirmDrop(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size='sm' variant='ghost' className='h-7 gap-1 text-[11.5px] text-slate-400 hover:text-red-500' onClick={() => setConfirmDrop(true)}>
              <Trash2 className='h-3 w-3' /> Drop
            </Button>
          )}
        </div>
      </div>

      {appManaged && (
        <p className='rounded-lg border border-slate-200 bg-slate-100/60 px-3 py-2 text-[12px] text-slate-500 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'>
          This procedure's body is owned by an import definition — edits belong on the Imports
          Definitions page, or they'll be overwritten on the next definition deploy.
        </p>
      )}

      {review.isPending && (
        <p className='rounded-xl border border-slate-200 bg-white px-4 py-3 text-[12px] text-slate-400 dark:border-border dark:bg-card'>
          Analyzing — reading the definition, plus columns, indexes and row counts of every table it
          references…
        </p>
      )}
      {aiReview && !review.isPending && (
        <section className='rounded-xl border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
          <div className='mb-2 flex items-center gap-2'>
            <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' />
            <h3 className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>AI review</h3>
            {(aiReview.tables_analyzed ?? []).length > 0 && (
              <span className='text-[11px] text-slate-400'>
                analyzed {aiReview.tables_analyzed!.length} referenced table
                {aiReview.tables_analyzed!.length === 1 ? '' : 's'}:{' '}
                {aiReview.tables_analyzed!.join(', ')}
              </span>
            )}
          </div>
          {aiReview.summary && (
            <p className='max-w-[80ch] text-[12.5px] leading-relaxed text-slate-700 dark:text-slate-300'>
              {aiReview.summary}
            </p>
          )}
          {(aiReview.improvements ?? []).length > 0 && (
            <div className='mt-3'>
              <h4 className='mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
                Improvements
              </h4>
              <ul className='max-w-[80ch] list-disc space-y-1 pl-5 text-[12px] text-slate-600 dark:text-slate-300'>
                {aiReview.improvements!.map((imp, i) => (
                  <li key={i}>{imp}</li>
                ))}
              </ul>
            </div>
          )}
          {(aiReview.index_suggestions ?? []).length > 0 && (
            <div className='mt-3'>
              <h4 className='mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
                Index suggestions
              </h4>
              <div className='space-y-2'>
                {aiReview.index_suggestions!.map((ix, i) => (
                  <div
                    key={i}
                    className='rounded-lg border border-slate-100 bg-slate-50/60 p-2.5 dark:border-border dark:bg-muted/30'
                  >
                    <p className='text-[12px] text-slate-600 dark:text-slate-300'>
                      <span className='font-mono text-[11.5px] text-slate-800 dark:text-slate-200'>
                        {ix.table}({ix.columns})
                      </span>{' '}
                      — {ix.reason}
                    </p>
                    <div className='mt-1.5 flex items-start gap-2'>
                      <code className='min-w-0 flex-1 overflow-x-auto whitespace-pre rounded bg-white px-2 py-1 font-mono text-[11px] text-slate-700 dark:bg-background dark:text-slate-300'>
                        {ix.create_sql}
                      </code>
                      <button
                        type='button'
                        className='shrink-0 rounded p-1 text-slate-400 hover:text-nvr-cyan'
                        data-tip='Copy CREATE INDEX'
                        onClick={() => {
                          navigator.clipboard.writeText(ix.create_sql).catch(() => {})
                          toast.success('Copied')
                        }}
                      >
                        <Copy className='h-3.5 w-3.5' />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <p className='mt-1.5 text-[11px] text-slate-400'>
                Suggestions only — nothing is created automatically. Validate against real query
                plans (DB Health → Explain) before adding indexes to hot tables.
              </p>
            </div>
          )}
          {(aiReview.risks ?? []).length > 0 && (
            <div className='mt-3'>
              <h4 className='mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
                Risks
              </h4>
              <ul className='max-w-[80ch] list-disc space-y-1 pl-5 text-[12px] text-amber-700 dark:text-amber-400'>
                {aiReview.risks!.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* ── Run ── */}
      <section className='rounded-xl border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <div className='mb-2 flex items-center gap-2'>
          <Play className='h-3.5 w-3.5 text-nvr-cyan' />
          <h3 className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>Run</h3>
          <span className='text-[11px] text-slate-400'>
            parameters parsed from the deployed signature — blank ones use the procedure's defaults
          </span>
        </div>
        {detail.params.length > 0 && (
          <div className='mb-3 grid grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-4'>
            {detail.params.map((p) => (
              <div key={p.name}>
                <label className='mb-0.5 block font-mono text-[10.5px] text-slate-500 dark:text-muted-foreground' htmlFor={`p-${p.name}`}>
                  {p.name} <span className='text-slate-300 dark:text-slate-600'>{p.type}</span>
                  {p.is_output && <span className='ml-1 text-amber-500'>out</span>}
                </label>
                <Input
                  id={`p-${p.name}`}
                  type={paramInputType(p.type)}
                  value={paramValues[p.name.replace(/^@/, '')] ?? ''}
                  onChange={(e) =>
                    setParamValues((prev) => ({ ...prev, [p.name.replace(/^@/, '')]: e.target.value }))
                  }
                  className='h-7 font-mono text-[12px]'
                />
              </div>
            ))}
          </div>
        )}
        <div className='flex items-center gap-3'>
          <Button size='sm' className='h-7 gap-1.5 text-[12px]' disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? <Loader2 className='h-3 w-3 animate-spin' /> : <Play className='h-3 w-3' />}
            Execute
          </Button>
          {result && (
            <span className='text-[11.5px] text-slate-400'>
              {result.row_count} row{result.row_count === 1 ? '' : 's'}
              {result.truncated ? ' (showing first 1000)' : ''} · {result.duration_ms}ms
            </span>
          )}
        </div>
        {result && result.rows.length > 0 && (
          <div className='mt-3 max-h-80 overflow-auto rounded-lg border border-slate-100 dark:border-border'>
            <table className='w-full text-[11.5px] tabular-nums'>
              <thead className='sticky top-0 bg-slate-50 dark:bg-muted'>
                <tr>
                  {Object.keys(result.rows[0]).map((c) => (
                    <th key={c} className='whitespace-nowrap px-2.5 py-1.5 text-left text-[10px] font-medium uppercase tracking-wide text-slate-400'>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100 dark:divide-border'>
                {result.rows.slice(0, 200).map((row, i) => (
                  <tr key={i}>
                    {Object.values(row).map((v, j) => (
                      <td key={j} className='max-w-[280px] truncate px-2.5 py-1 text-slate-700 dark:text-slate-300'>
                        {v === null || v === undefined ? '—' : String(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result && result.rows.length === 0 && (
          <p className='mt-2 text-[12px] text-slate-400'>Completed with no result rows.</p>
        )}
      </section>

      {/* ── Definition ── */}
      <section className='rounded-xl border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <div className='mb-2 flex items-center gap-2'>
          <h3 className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>Definition</h3>
          {dirty && (
            <span className='rounded-full bg-amber-500/10 px-2 py-px text-[10.5px] font-medium text-amber-700 dark:text-amber-400'>
              unsaved changes
            </span>
          )}
          <div className='ml-auto flex items-center gap-2'>
            {dirty && (
              <Button size='sm' variant='ghost' className='h-7 text-[11.5px]' onClick={() => setDraft(null)}>
                Discard
              </Button>
            )}
            {confirmDeploy ? (
              <>
                <span className='text-[11.5px] text-amber-600 dark:text-amber-400'>
                  Deploy over the live procedure?
                </span>
                <Button size='sm' className='h-7 text-[11.5px]' disabled={deploy.isPending} onClick={() => deploy.mutate()}>
                  {deploy.isPending ? <Loader2 className='mr-1 h-3 w-3 animate-spin' /> : null}
                  Deploy
                </Button>
                <Button size='sm' variant='ghost' className='h-7 text-[11.5px]' onClick={() => setConfirmDeploy(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size='sm' className='h-7 text-[11.5px]' disabled={!dirty} onClick={() => setConfirmDeploy(true)}>
                Deploy changes
              </Button>
            )}
          </div>
        </div>
        <textarea
          value={definition}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className='h-[480px] w-full resize-y rounded-lg border border-slate-200 bg-slate-50/50 p-3 font-mono text-[12px] leading-relaxed text-slate-800 outline-none focus:border-nvr-cyan/50 dark:border-border dark:bg-background dark:text-slate-200'
        />
        <p className='mt-1.5 text-[11px] text-slate-400 dark:text-muted-foreground'>
          Deploys as CREATE OR ALTER on this database. Vendored deployments: re-run{' '}
          <span className='font-mono text-[10.5px]'>proc:dump</span> after editing here so the repo
          stays the source of truth (the readiness scorecard warns about drift until then).
        </p>
      </section>
    </div>
  )
}
