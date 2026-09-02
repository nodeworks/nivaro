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
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiNote, setAiNote] = useState<string | null>(null)
  const generate = useMutation({
    mutationFn: () =>
      api
        .post<{ data: { definition: string; explanation: string } }>('/procedures/ai-generate', {
          name: name.trim(),
          prompt: aiPrompt
        })
        .then((r) => r.data.data),
    onSuccess: ({ definition: gen, explanation }) => {
      setDefinition(gen)
      setAiNote(explanation || null)
      toast.success('Draft generated — review, adjust, then Create & deploy')
    },
    onError: (err: unknown) =>
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Generation failed',
        { duration: 10000 }
      )
  })
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
      <div className='mt-3 rounded-lg border border-nvr-cyan/25 bg-[#00ceff]/5 p-3'>
        <label
          htmlFor='proc-ai-prompt'
          className='mb-1 flex items-center gap-1.5 text-[12px] font-medium text-slate-700 dark:text-slate-200'
        >
          <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' /> Describe it, and AI writes the first draft
        </label>
        <textarea
          id='proc-ai-prompt'
          value={aiPrompt}
          onChange={(e) => setAiPrompt(e.target.value)}
          placeholder='e.g. For a given @FundingYear, sum requisition_amount per project type from workflows joined through workflows_regions, excluding CAR workflows…'
          className='h-20 w-full resize-y rounded-md border border-slate-200 bg-white p-2 text-[12px] leading-relaxed text-slate-700 outline-none placeholder:text-slate-400 focus:border-nvr-cyan/50 dark:border-border dark:bg-card dark:text-slate-300'
        />
        <div className='mt-1.5 flex items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            className='h-7 gap-1.5 text-[11.5px]'
            disabled={!valid || !aiPrompt.trim() || generate.isPending}
            onClick={() => generate.mutate()}
          >
            {generate.isPending ? (
              <Loader2 className='h-3 w-3 animate-spin' />
            ) : (
              <Sparkles className='h-3 w-3 text-nvr-cyan' />
            )}
            Generate draft
          </Button>
          {!valid && aiPrompt.trim() !== '' && (
            <span className='text-[11px] text-slate-400'>Name the procedure first.</span>
          )}
          <span className='text-[11px] text-slate-400'>
            Writes against the real schema — the draft lands below for you to review.
          </span>
        </div>
        {aiNote && (
          <p className='mt-2 max-w-[86ch] text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {aiNote}
          </p>
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
      setFixedIssues(new Set())
      setLastFix(null)
      setDefView('edit')
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
    onSuccess: (data) => {
      setAiReview(data)
      setFixedIssues(new Set())
    },
    onError: (err: unknown) =>
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'AI review failed',
        { duration: 10000 }
      )
  })
  const [lastFix, setLastFix] = useState<{ issue: string; explanation: string } | null>(null)
  // Which findings already have a fix in the pending draft, and which one is
  // being fixed right now — drives per-button state (Fix / spinner / drafted).
  const [fixedIssues, setFixedIssues] = useState<Set<string>>(new Set())
  const [fixingIssue, setFixingIssue] = useState<string | null>(null)
  const [defView, setDefView] = useState<'edit' | 'diff'>('edit')
  const fix = useMutation({
    mutationFn: (issue: string) => {
      setFixingIssue(issue)
      return api
        .post<{ data: { definition: string; explanation: string } }>(`/procedures/${name}/ai-fix`, {
          issue,
          // Fix on top of the editor's current draft so fixes stack.
          definition: draft ?? undefined
        })
        .then((r) => ({ issue, ...r.data.data }))
    },
    onSettled: () => setFixingIssue(null),
    onSuccess: ({ issue, definition: fixed, explanation }) => {
      setDraft(fixed)
      setLastFix({ issue, explanation })
      setFixedIssues((prev) => new Set(prev).add(issue))
      setDefView('diff')
      toast.success('Fix drafted — highlighted changes below; Deploy to apply')
    },
    onError: (err: unknown) =>
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'AI fix failed',
        { duration: 10000 }
      )
  })
  const [fixAllSection, setFixAllSection] = useState<string | null>(null)
  const fixAll = useMutation({
    mutationFn: ({ section, issues }: { section: string; issues: string[] }) => {
      setFixAllSection(section)
      return api
        .post<{ data: { definition: string; explanation: string } }>(`/procedures/${name}/ai-fix`, {
          issues,
          definition: draft ?? undefined
        })
        .then((r) => ({ issues, ...r.data.data }))
    },
    onSettled: () => setFixAllSection(null),
    onSuccess: ({ issues, definition: fixed, explanation }) => {
      setDraft(fixed)
      setLastFix({ issue: `${issues.length} findings (batch)`, explanation })
      setFixedIssues((prev) => {
        const next = new Set(prev)
        for (const i of issues) next.add(i)
        return next
      })
      setDefView('diff')
      toast.success(`Batch fix drafted for ${issues.length} findings — review the highlighted changes`)
    },
    onError: (err: unknown) =>
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Batch fix failed',
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
              <div className='mb-1 flex items-center gap-2'>
                <h4 className='text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
                  Improvements
                </h4>
                <FixAllButton
                  section='improvements'
                  issues={aiReview.improvements!}
                  fixedIssues={fixedIssues}
                  busySection={fixAllSection}
                  anyBusy={fix.isPending || fixAll.isPending}
                  onFixAll={(section, issues) => fixAll.mutate({ section, issues })}
                />
              </div>
              <ul className='max-w-[86ch] space-y-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
                {aiReview.improvements!.map((imp, i) => (
                  <li key={i} className='flex items-start gap-2'>
                    <span className='mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600' />
                    <span className='min-w-0 flex-1'>{imp}</span>
                    <FixButton
                      state={fixedIssues.has(imp) ? 'drafted' : fixingIssue === imp ? 'fixing' : fix.isPending || fixAll.isPending ? 'blocked' : 'idle'}
                      onFix={() => fix.mutate(imp)}
                    />
                  </li>
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
              <div className='mb-1 flex items-center gap-2'>
                <h4 className='text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
                  Risks
                </h4>
                <FixAllButton
                  section='risks'
                  issues={aiReview.risks!}
                  fixedIssues={fixedIssues}
                  busySection={fixAllSection}
                  anyBusy={fix.isPending || fixAll.isPending}
                  onFixAll={(section, issues) => fixAll.mutate({ section, issues })}
                />
              </div>
              <ul className='max-w-[86ch] space-y-1.5 text-[12px] text-amber-700 dark:text-amber-400'>
                {aiReview.risks!.map((r, i) => (
                  <li key={i} className='flex items-start gap-2'>
                    <span className='mt-[7px] h-1 w-1 shrink-0 rounded-full bg-amber-400' />
                    <span className='min-w-0 flex-1'>{r}</span>
                    <FixButton
                      state={fixedIssues.has(r) ? 'drafted' : fixingIssue === r ? 'fixing' : fix.isPending || fixAll.isPending ? 'blocked' : 'idle'}
                      onFix={() => fix.mutate(r)}
                    />
                  </li>
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
        {lastFix && dirty && (
          <div className='mb-3 rounded-lg border border-nvr-cyan/30 bg-[#00ceff]/5 px-3 py-2'>
            <p className='text-[12px] text-slate-700 dark:text-slate-300'>
              <span className='font-medium'>AI fix drafted</span> for: “{lastFix.issue.slice(0, 140)}
              {lastFix.issue.length > 140 ? '…' : ''}”
            </p>
            {lastFix.explanation && (
              <p className='mt-0.5 max-w-[86ch] text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                {lastFix.explanation}
              </p>
            )}
            <p className='mt-0.5 text-[11px] text-slate-400'>
              Nothing is deployed yet — review the definition below, then Deploy changes (or
              Discard).
            </p>
          </div>
        )}
        <div className='mb-2 flex items-center gap-2'>
          <h3 className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>Definition</h3>
          {dirty && (
            <span className='rounded-full bg-amber-500/10 px-2 py-px text-[10.5px] font-medium text-amber-700 dark:text-amber-400'>
              unsaved changes
            </span>
          )}
          <div className='ml-auto flex items-center gap-2'>
            {dirty && (
              <Button
                size='sm'
                variant='ghost'
                className='h-7 text-[11.5px]'
                onClick={() => {
                  setDraft(null)
                  setFixedIssues(new Set())
                  setLastFix(null)
                  setDefView('edit')
                }}
              >
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
        {dirty && (
          <div className='mb-2 inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-border'>
            {(
              [
                ['edit', 'Edit'],
                ['diff', 'Highlighted changes']
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type='button'
                onClick={() => setDefView(mode)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                  defView === mode
                    ? 'bg-[#00ceff]/10 text-[#009abe] dark:text-nvr-cyan'
                    : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {dirty && defView === 'diff' ? (
          <DiffView base={detail.definition} draft={definition} />
        ) : (
          <textarea
            value={definition}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className='h-[480px] w-full resize-y rounded-lg border border-slate-200 bg-slate-50/50 p-3 font-mono text-[12px] leading-relaxed text-slate-800 outline-none focus:border-nvr-cyan/50 dark:border-border dark:bg-background dark:text-slate-200'
          />
        )}
        <p className='mt-1.5 text-[11px] text-slate-400 dark:text-muted-foreground'>
          Deploys as CREATE OR ALTER on this database. Vendored deployments: re-run{' '}
          <span className='font-mono text-[10.5px]'>proc:dump</span> after editing here so the repo
          stays the source of truth (the readiness scorecard warns about drift until then).
        </p>
      </section>
    </div>
  )
}

function FixButton({
  state,
  onFix
}: {
  state: 'idle' | 'fixing' | 'blocked' | 'drafted'
  onFix: () => void
}) {
  if (state === 'drafted') {
    return (
      <span
        className='shrink-0 rounded-full bg-[#00ceff]/10 px-1.5 py-px text-[10px] font-medium text-[#009abe] dark:text-nvr-cyan'
        data-tip='A fix for this finding is in the pending draft below — Deploy to apply it'
      >
        ✓ drafted
      </span>
    )
  }
  if (state === 'fixing') {
    return (
      <span className='inline-flex shrink-0 items-center gap-1 rounded border border-slate-200 px-1.5 py-px text-[10.5px] text-slate-400 dark:border-border'>
        <Loader2 className='h-3 w-3 animate-spin' /> fixing…
      </span>
    )
  }
  return (
    <button
      type='button'
      disabled={state === 'blocked'}
      onClick={onFix}
      className='shrink-0 rounded border border-slate-200 px-1.5 py-px text-[10.5px] font-medium text-slate-500 transition-colors hover:border-nvr-cyan/50 hover:text-[#009abe] disabled:opacity-40 dark:border-border dark:text-slate-400'
      data-tip='Draft an AI fix for this finding into the definition editor — you review and deploy'
    >
      Fix
    </button>
  )
}

// ── Pending-changes diff ─────────────────────────────────────────────────────
// Line-level LCS between the deployed definition and the draft — enough to
// make an AI fix reviewable at a glance without a diff library.
type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.replace(/\r/g, '').split('\n')
  const B = b.replace(/\r/g, '').split('\n')
  // Cap the quadratic table for pathological sizes; beyond it, show all-changed.
  if (A.length * B.length > 4_000_000) {
    return [...A.map((t) => ({ kind: 'del' as const, text: t })), ...B.map((t) => ({ kind: 'add' as const, text: t }))]
  }
  const m = A.length
  const n = B.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ kind: 'same', text: A[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: A[i] })
      i++
    } else {
      out.push({ kind: 'add', text: B[j] })
      j++
    }
  }
  while (i < m) out.push({ kind: 'del', text: A[i++] })
  while (j < n) out.push({ kind: 'add', text: B[j++] })
  return out
}

/** Collapse long unchanged runs so the changes carry the view. */
function DiffView({ base, draft }: { base: string; draft: string }) {
  const lines = useMemo(() => lineDiff(base, draft), [base, draft])
  const rendered: Array<DiffLine | { kind: 'fold'; count: number }> = []
  let run: DiffLine[] = []
  const flushRun = () => {
    if (run.length > 8) {
      rendered.push(...run.slice(0, 3))
      rendered.push({ kind: 'fold', count: run.length - 6 })
      rendered.push(...run.slice(-3))
    } else {
      rendered.push(...run)
    }
    run = []
  }
  for (const l of lines) {
    if (l.kind === 'same') run.push(l)
    else {
      flushRun()
      rendered.push(l)
    }
  }
  flushRun()
  const changes = lines.filter((l) => l.kind !== 'same').length
  return (
    <div className='h-[480px] overflow-auto rounded-lg border border-slate-200 bg-slate-50/50 dark:border-border dark:bg-background'>
      <div className='sticky top-0 border-b border-slate-100 bg-white px-3 py-1 text-[10.5px] text-slate-400 dark:border-border dark:bg-card'>
        {changes} changed line{changes === 1 ? '' : 's'} vs the deployed definition —{' '}
        <span className='text-emerald-600 dark:text-emerald-400'>green added</span>,{' '}
        <span className='text-red-500 dark:text-red-400'>red removed</span>
      </div>
      <pre className='p-3 font-mono text-[11.5px] leading-[1.5]'>
        {rendered.map((l, i) =>
          l.kind === 'fold' ? (
            <div key={i} className='select-none py-0.5 text-center text-[10px] text-slate-300 dark:text-slate-600'>
              ⋯ {l.count} unchanged lines ⋯
            </div>
          ) : (
            <div
              key={i}
              className={
                l.kind === 'add'
                  ? 'whitespace-pre-wrap bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
                  : l.kind === 'del'
                    ? 'whitespace-pre-wrap bg-red-500/10 text-red-700 line-through decoration-red-300/60 dark:text-red-400'
                    : 'whitespace-pre-wrap text-slate-600 dark:text-slate-400'
              }
            >
              {l.text || ' '}
            </div>
          )
        )}
      </pre>
    </div>
  )
}

function FixAllButton({
  section,
  issues,
  fixedIssues,
  busySection,
  anyBusy,
  onFixAll
}: {
  section: string
  issues: string[]
  fixedIssues: Set<string>
  busySection: string | null
  anyBusy: boolean
  onFixAll: (section: string, issues: string[]) => void
}) {
  const pending = issues.filter((i) => !fixedIssues.has(i))
  if (pending.length < 2) return null
  if (busySection === section) {
    return (
      <span className='inline-flex items-center gap-1 rounded border border-slate-200 px-1.5 py-px text-[10.5px] text-slate-400 dark:border-border'>
        <Loader2 className='h-3 w-3 animate-spin' /> fixing {pending.length}…
      </span>
    )
  }
  return (
    <button
      type='button'
      disabled={anyBusy}
      onClick={() => onFixAll(section, pending)}
      className='rounded border border-slate-200 px-1.5 py-px text-[10.5px] font-medium text-slate-500 transition-colors hover:border-nvr-cyan/50 hover:text-[#009abe] disabled:opacity-40 dark:border-border dark:text-slate-400'
      data-tip={`One combined AI fix for the ${pending.length} remaining findings in this section — drafts into the editor for review`}
    >
      Fix all ({pending.length})
    </button>
  )
}
