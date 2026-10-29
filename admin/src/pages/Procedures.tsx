import { useOverflowTip, useUnsavedWork } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Check,
  Copy,
  Database,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { DiffView } from './procedures/DiffView'
import { ConflictPanel, OwnerBanner, StatusChip, TOUCH } from './procedures/ProcedureBanners'
import { ProcedureHistory } from './procedures/ProcedureHistory'
import {
  createRequest,
  type ProcDetail,
  type ProcRow,
  procedureChip,
  procedureState,
  readProcError
} from './procedures/status'
import { procKeys, useProcWrites } from './procedures/use-proc-writes'

/**
 * Developer → Procedures — the database's stored procedures, kept in config.
 *
 * A procedure has one owner: an import definition (read-only here, edited on the definition),
 * a managed row in config (edits save a new version, then CREATE OR ALTER here; other
 * environments get it through promote), or nobody yet (the first edit or drop adopts it, and
 * Adopt does so on its own). Status chips come from the API's `managed` answer.
 *
 * Parameters come from sys.parameters via the API (the engine's own catalog), so the Run form
 * always matches the deployed signature.
 *
 * Below md the master-detail collapses: the list alone, or the detail alone with a Back button.
 */

const NEW_TEMPLATE = (name: string) => `CREATE OR ALTER PROCEDURE ${name}
  -- @Param INT = NULL
AS
BEGIN
  SET NOCOUNT ON;

  SELECT 1 AS ok;
END
`

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const DEPLOY_HINT =
  'Deploys from config: saved as a new version, then CREATE OR ALTER on this database. Other environments get it through promote.'

const BTN = cn('h-7 gap-1.5 text-[12px]', TOUCH)

function paramInputType(sqlType: string): 'number' | 'date' | 'text' {
  if (/int|decimal|numeric|float|real|money|bit/i.test(sqlType)) return 'number'
  if (/^date$/i.test(sqlType)) return 'date'
  return 'text'
}

export function ProceduresPage() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  // ?name= opens a procedure straight away (links from SQL checks)
  const [searchParams] = useSearchParams()
  const [selected, setSelected] = useState<string | null>(() => searchParams.get('name'))
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const {
    data: procs = [],
    isLoading,
    isError,
    refetch
  } = useQuery<ProcRow[]>({
    queryKey: procKeys.list,
    queryFn: () => api.get<{ data: ProcRow[] }>('/procedures').then((r) => r.data.data)
  })

  const q = search.trim().toLowerCase()
  const filtered = q ? procs.filter((p) => p.name.toLowerCase().includes(q)) : procs
  // An unsaved edit (or a half-written new procedure) is never dropped silently: switching
  // away asks inline first.
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState<NavTarget | null>(null)
  const go = (t: NavTarget) => {
    setPending(null)
    setDirty(false)
    setCreating(t.kind === 'new')
    setSelected(t.kind === 'open' ? t.name : null)
  }
  const request = (t: NavTarget) => {
    if (t.kind === 'open' && t.name === selected && !creating) return
    if (t.kind === 'new' && creating) return
    if (dirty) setPending(t)
    else go(t)
  }
  const open = (name: string) => request({ kind: 'open', name })
  const showingDetail = creating || selected !== null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-white px-4 py-3 sm:px-6 sm:py-3.5 dark:border-border dark:bg-card'>
        <Database aria-hidden className='hidden h-4 w-4 shrink-0 text-nvr-cyan sm:block' />
        <div className='min-w-0 flex-1'>
          <h1 className='truncate text-[15px] font-semibold text-slate-900 dark:text-foreground'>
            Procedures
          </h1>
          <p className='hidden text-[12px] text-slate-500 sm:block dark:text-muted-foreground'>
            The database's stored procedures, kept in config: inspect, run, edit and deploy, with
            every version kept.
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            className={cn('h-8 gap-1.5 text-[12px]', TOUCH)}
            aria-label='New procedure'
            onClick={() => request({ kind: 'new' })}
          >
            <Plus aria-hidden className='h-3.5 w-3.5' />
            {/* Phones keep the title readable: the label folds to "New". */}
            <span className='sm:hidden'>New</span>
            <span className='hidden sm:inline'>New procedure</span>
          </Button>
          <Button
            size='sm'
            variant='ghost'
            className={cn('h-8 w-8 p-0 [@media(hover:none)]:min-w-11', TOUCH)}
            aria-label='Refresh'
            data-tip='Refresh'
            onClick={() => {
              void qc.invalidateQueries({ queryKey: procKeys.list })
              if (selected) void qc.invalidateQueries({ queryKey: procKeys.one(selected) })
            }}
          >
            <RefreshCw aria-hidden className='h-3.5 w-3.5' />
          </Button>
        </div>
      </header>
      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside
          aria-label='Procedures'
          className={cn(
            'w-full shrink-0 flex-col border-r border-slate-200 bg-white md:flex md:w-[272px] dark:border-border dark:bg-card',
            showingDetail ? 'hidden' : 'flex'
          )}
        >
          <div className='shrink-0 border-b border-slate-100 p-2.5 dark:border-border'>
            <div className='relative'>
              <Search
                aria-hidden
                className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-muted-foreground'
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${procs.length} procedures…`}
                aria-label='Search procedures'
                className={cn('h-8 pl-8 text-[12.5px]', TOUCH)}
              />
            </div>
          </div>
          <div className='min-h-0 flex-1 overflow-y-auto'>
            {isLoading && (
              <div className='space-y-1.5 p-2.5'>
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className='h-10 w-full rounded-md' />
                ))}
              </div>
            )}
            {isError && (
              <p className='p-4 text-[12px] text-red-700 dark:text-red-300'>
                Procedures could not load.{' '}
                <button
                  type='button'
                  className='font-medium underline underline-offset-2'
                  onClick={() => void refetch()}
                >
                  Retry
                </button>
              </p>
            )}
            {filtered.map((p) => (
              <ProcListRow
                key={p.name}
                row={p}
                active={selected === p.name}
                onOpen={() => open(p.name)}
              />
            ))}
            {!isLoading && !isError && filtered.length === 0 && (
              <p className='p-4 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
                {procs.length === 0
                  ? 'No procedures on this database yet.'
                  : 'No procedures match.'}
              </p>
            )}
          </div>
        </aside>
        <div
          className={cn(
            'min-w-0 flex-1 overflow-y-auto bg-slate-50 md:block dark:bg-background',
            showingDetail ? 'block' : 'hidden'
          )}
        >
          {showingDetail && (
            <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-2 py-1.5 md:hidden dark:border-border dark:bg-card'>
              <Button
                size='sm'
                variant='ghost'
                className={cn('h-8 gap-1 text-[12px]', TOUCH)}
                onClick={() => request({ kind: 'back' })}
              >
                <ArrowLeft aria-hidden className='h-3.5 w-3.5' /> All procedures
              </Button>
            </div>
          )}
          {pending && (
            <LeaveConfirm
              what={creating ? 'the new procedure' : (selected ?? '')}
              target={pending}
              onLeave={() => go(pending)}
              onStay={() => setPending(null)}
            />
          )}
          {creating ? (
            <NewProcedurePanel
              name={newName}
              onName={setNewName}
              onCreated={(n) => {
                setNewName('')
                go({ kind: 'open', name: n })
                void qc.invalidateQueries({ queryKey: procKeys.list })
              }}
              onOpen={(n) => go({ kind: 'open', name: n })}
              onCancel={() => request({ kind: 'back' })}
              onDirtyChange={setDirty}
            />
          ) : selected ? (
            <ProcedureDetail key={selected} name={selected} onDirtyChange={setDirty} />
          ) : (
            <div className='flex h-full items-center justify-center p-6'>
              <div className='max-w-sm text-center'>
                <Database
                  aria-hidden
                  className='mx-auto h-8 w-8 text-slate-300 dark:text-slate-600'
                />
                <p className='mt-2 text-[13px] text-slate-600 dark:text-slate-300'>
                  Select a procedure to inspect, run or edit it.
                </p>
                <p className='mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  Edits are saved to config as versions, so every change can be compared and
                  restored.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ProcListRow({
  row,
  active,
  onOpen
}: {
  row: ProcRow
  active: boolean
  onOpen: () => void
}) {
  const nameRef = useOverflowTip<HTMLSpanElement>(row.name)
  const chip = procedureChip(row)
  const version = row.managed?.kind === 'managed' ? row.managed.version : null
  const dropped = !row.live && row.managed?.kind === 'managed' && row.managed.status === 'dropped'
  const meta = row.live
    ? `${row.param_count} param${row.param_count === 1 ? '' : 's'}${row.modified ? ` · edited ${formatRelative(row.modified)}` : ''}`
    : 'not on this database'
  return (
    <button
      type='button'
      onClick={onOpen}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex min-h-11 w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan dark:border-border/60',
        active ? 'bg-nvr-cyan/10' : 'hover:bg-slate-50 dark:hover:bg-muted/50'
      )}
    >
      <span className='min-w-0 flex-1'>
        <span
          ref={nameRef}
          className={cn(
            'block truncate font-mono text-[12px]',
            // Not on this database: dimmed by ink (not opacity, which would fail contrast).
            row.live
              ? 'text-slate-800 dark:text-slate-200'
              : 'text-slate-500 dark:text-muted-foreground',
            dropped && 'line-through decoration-slate-400/70'
          )}
        >
          {row.name}
        </span>
        <span className='block truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
          {version !== null && <span className='font-mono'>v{version} · </span>}
          {meta}
        </span>
      </span>
      {chip && <StatusChip chip={chip} />}
    </button>
  )
}

function NewProcedurePanel({
  name,
  onName,
  onCreated,
  onOpen,
  onCancel,
  onDirtyChange
}: {
  name: string
  onName: (v: string) => void
  onCreated: (name: string) => void
  onOpen: (name: string) => void
  onCancel: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const trimmed = name.trim()
  const valid = NAME_RE.test(trimmed)
  const [definition, setDefinition] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  // A typed or generated body is work a reload or a switch would lose (the name alone is not).
  const unsaved = definition.trim() !== '' || aiPrompt.trim() !== ''
  useUnsavedWork(unsaved, 'New procedure')
  useReportDirty(unsaved, onDirtyChange)
  const [aiNote, setAiNote] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ message: string; existing: boolean } | null>(null)
  const generate = useMutation({
    mutationFn: () =>
      api
        .post<{ data: { definition: string; explanation: string } }>('/procedures/ai-generate', {
          name: trimmed,
          prompt: aiPrompt
        })
        .then((r) => r.data.data),
    onSuccess: ({ definition: gen, explanation }) => {
      setDefinition(gen)
      setAiNote(explanation || null)
      toast.success('Draft generated. Review it, then Create & deploy')
    },
    onError: (err: unknown) =>
      toast.error(readProcError(err, 'Generation failed').message, { duration: 10000 })
  })
  const body = definition || (valid ? NEW_TEMPLATE(trimmed) : '')
  const create = useMutation({
    mutationFn: () => api.put(`/procedures/${encodeURIComponent(trimmed)}`, createRequest(body)),
    onMutate: () => setFailure(null),
    onSuccess: () => {
      toast.success(`${trimmed} saved as version 1 and deployed`)
      onCreated(trimmed)
    },
    onError: (err: unknown) => {
      const e = readProcError(err, 'Create failed')
      if (e.stampOnly) {
        toast.warning(`${trimmed} deployed, but recording the deploy failed`, {
          description: 'Config keeps version 1; the next deploy records it.',
          duration: 12_000
        })
        onCreated(trimmed)
        return
      }
      setFailure({ message: e.message, existing: e.code === 'PROC_EXISTS' })
    }
  })
  return (
    <div className='space-y-3 p-4 sm:p-6'>
      <div>
        <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
          New procedure
        </h2>
        <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Born managed: it lives in config from its first version.
        </p>
      </div>
      <div className='w-full sm:max-w-sm'>
        <label
          htmlFor='proc-new-name'
          className='mb-1 block text-[12px] font-medium text-slate-700 dark:text-slate-200'
        >
          Name
        </label>
        <Input
          id='proc-new-name'
          value={name}
          onChange={(e) => {
            onName(e.target.value)
            setFailure(null)
          }}
          placeholder='procedure_name'
          aria-invalid={trimmed !== '' && !valid}
          className={cn('h-8 font-mono text-[13px]', TOUCH)}
        />
        {trimmed !== '' && !valid && (
          <p className='mt-1 text-[11.5px] text-red-700 dark:text-red-300'>
            Letters, digits and underscores only, not starting with a digit.
          </p>
        )}
      </div>
      <div className='rounded-lg border border-nvr-cyan/25 bg-nvr-cyan/5 p-3'>
        <label
          htmlFor='proc-ai-prompt'
          className='mb-1 flex items-center gap-1.5 text-[12px] font-medium text-slate-700 dark:text-slate-200'
        >
          <Sparkles aria-hidden className='h-3.5 w-3.5 text-nvr-cyan' /> Describe it, and AI writes
          the first draft
        </label>
        <textarea
          id='proc-ai-prompt'
          value={aiPrompt}
          onChange={(e) => setAiPrompt(e.target.value)}
          placeholder='e.g. For a given @Year, sum total_amount per category from orders joined through orders_regions, excluding cancelled orders…'
          className='h-20 w-full resize-y rounded-md border border-slate-200 bg-white p-2 text-[12px] leading-relaxed text-slate-700 outline-none placeholder:text-slate-500 focus:border-nvr-cyan/60 dark:border-border dark:bg-card dark:text-slate-300 dark:placeholder:text-muted-foreground'
        />
        <div className='mt-1.5 flex flex-wrap items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            className={BTN}
            disabled={!valid || !aiPrompt.trim() || generate.isPending}
            onClick={() => generate.mutate()}
          >
            {generate.isPending ? (
              <Loader2 className='h-3 w-3 animate-spin' />
            ) : (
              <Sparkles aria-hidden className='h-3 w-3 text-nvr-cyan' />
            )}
            Generate draft
          </Button>
          <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {!valid && aiPrompt.trim() !== ''
              ? 'Name the procedure first.'
              : 'Writes against the real schema; the draft lands below for you to review.'}
          </span>
        </div>
        {aiNote && (
          <p className='mt-2 max-w-[80ch] text-[12px] text-slate-600 dark:text-slate-300'>
            {aiNote}
          </p>
        )}
      </div>
      <textarea
        value={body}
        onChange={(e) => setDefinition(e.target.value)}
        spellCheck={false}
        aria-label='Definition'
        placeholder='Name the procedure to start from a template.'
        className='h-[min(18rem,50vh)] w-full resize-y rounded-lg border border-slate-200 bg-white p-3 font-mono text-[12px] leading-relaxed text-slate-800 outline-none placeholder:text-slate-500 focus:border-nvr-cyan/60 dark:border-border dark:bg-card dark:text-slate-200 dark:placeholder:text-muted-foreground'
      />
      {failure && (
        <div
          role='alert'
          className='rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-100'
        >
          <p>{failure.message}</p>
          {failure.existing && (
            <Button
              size='sm'
              variant='outline'
              className={cn(BTN, 'mt-2')}
              onClick={() => onOpen(trimmed)}
            >
              Open {trimmed}
            </Button>
          )}
        </div>
      )}
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          className={cn('h-8 gap-1.5 text-[12px]', TOUCH)}
          disabled={!valid || !body.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <Check aria-hidden className='h-3.5 w-3.5' />
          )}
          Create & deploy
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className={cn('h-8 text-[12px]', TOUCH)}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          Saved to config as version 1, then deployed.
        </span>
      </div>
    </div>
  )
}

interface AiReview {
  summary?: string
  improvements?: string[]
  index_suggestions?: Array<{ table: string; columns: string; reason: string; create_sql: string }>
  risks?: string[]
  tables_analyzed?: string[]
}

function ProcedureDetail({
  name,
  onDirtyChange
}: {
  name: string
  onDirtyChange: (dirty: boolean) => void
}) {
  const detailQ = useQuery<ProcDetail>({
    queryKey: procKeys.one(name),
    queryFn: () =>
      api
        .get<{ data: ProcDetail }>(`/procedures/${encodeURIComponent(name)}`)
        .then((r) => r.data.data)
  })
  const detail = detailQ.data
  const [draft, setDraft] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [confirmDeploy, setConfirmDeploy] = useState(false)
  const [confirmDrop, setConfirmDrop] = useState(false)
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{
    rows: Array<Record<string, unknown>>
    row_count: number
    truncated: boolean
    duration_ms: number
  } | null>(null)
  const [aiReview, setAiReview] = useState<AiReview | null>(null)
  const [lastFix, setLastFix] = useState<{ issue: string; explanation: string } | null>(null)
  // Which findings already have a fix in the pending draft, and which one is being fixed right
  // now — drives per-button state (Fix / spinner / drafted).
  const [fixedIssues, setFixedIssues] = useState<Set<string>>(new Set())
  const [fixingIssue, setFixingIssue] = useState<string | null>(null)
  const [fixAllSection, setFixAllSection] = useState<string | null>(null)
  const [defView, setDefView] = useState<'edit' | 'diff'>('edit')
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null)
  const titleRef = useOverflowTip<HTMLHeadingElement>(name)

  const resetEdit = () => {
    setDraft(null)
    setNote('')
    setFixedIssues(new Set())
    setLastFix(null)
    setDefView('edit')
    setConfirmDeploy(false)
  }

  const writes = useProcWrites(detail, {
    onSaved: () => {
      resetEdit()
      setRestoringVersion(null)
    },
    onKeptLive: (version) => {
      const mine = draft
      resetEdit()
      toast.success(`Kept the database's version as version ${version}`, {
        ...(mine !== null
          ? {
              description: 'Your edit was set aside.',
              action: { label: 'Put my edit back', onClick: () => setDraft(mine) },
              duration: 15_000
            }
          : {})
      })
    }
  })

  const state = detail ? procedureState(detail) : null
  const base = state?.base ?? ''
  const definition = draft ?? base
  const dirty = draft !== null && draft !== base
  useUnsavedWork(dirty, 'Procedure edit')
  useReportDirty(dirty, onDirtyChange)
  const editable = !!state?.editable

  const review = useMutation({
    mutationFn: () =>
      api
        .post<{ data: AiReview }>(`/procedures/${encodeURIComponent(name)}/ai-review`)
        .then((r) => r.data.data),
    onSuccess: (data) => {
      setAiReview(data)
      setFixedIssues(new Set())
    },
    onError: (err: unknown) =>
      toast.error(readProcError(err, 'AI review failed').message, { duration: 10000 })
  })
  const fix = useMutation({
    mutationFn: (issue: string) => {
      setFixingIssue(issue)
      return api
        .post<{ data: { definition: string; explanation: string } }>(
          `/procedures/${encodeURIComponent(name)}/ai-fix`,
          // Fix on top of what the editor shows (the draft, else config or live) so fixes stack.
          { issue, definition }
        )
        .then((r) => ({ issue, ...r.data.data }))
    },
    onSettled: () => setFixingIssue(null),
    onSuccess: ({ issue, definition: fixed, explanation }) => {
      setDraft(fixed)
      setLastFix({ issue, explanation })
      setFixedIssues((prev) => new Set(prev).add(issue))
      setDefView('diff')
      toast.success('Fix drafted. The changes are highlighted below; Deploy to apply')
    },
    onError: (err: unknown) =>
      toast.error(readProcError(err, 'AI fix failed').message, { duration: 10000 })
  })
  const fixAll = useMutation({
    mutationFn: ({ section, issues }: { section: string; issues: string[] }) => {
      setFixAllSection(section)
      return api
        .post<{ data: { definition: string; explanation: string } }>(
          `/procedures/${encodeURIComponent(name)}/ai-fix`,
          { issues, definition }
        )
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
      toast.success(
        `Batch fix drafted for ${issues.length} findings. Review the highlighted changes`
      )
    },
    onError: (err: unknown) =>
      toast.error(readProcError(err, 'Batch fix failed').message, { duration: 10000 })
  })
  const run = useMutation({
    mutationFn: () => {
      const params: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(paramValues)) {
        if (v.trim() !== '') params[k] = v
      }
      return api
        .post<{ data: typeof result }>(`/procedures/${encodeURIComponent(name)}/execute`, {
          params
        })
        .then((r) => r.data.data)
    },
    onSuccess: (data) => setResult(data),
    onError: (err: unknown) =>
      toast.error(readProcError(err, 'Execution failed').message, { duration: 12000 })
  })

  if (detailQ.isError) {
    const e = readProcError(detailQ.error, 'The procedure could not load')
    return (
      <div className='p-4 sm:p-6'>
        <p className='text-[13px] text-slate-700 dark:text-slate-200'>
          {e.status === 404 ? `${name} is not on this database or in config.` : e.message}
        </p>
        <Button
          size='sm'
          variant='outline'
          className={cn(BTN, 'mt-2')}
          onClick={() => void detailQ.refetch()}
        >
          Retry
        </Button>
      </div>
    )
  }
  if (!detail || !state) {
    return (
      <div className='space-y-3 p-4 sm:p-6'>
        <Skeleton className='h-6 w-64 max-w-full' />
        <Skeleton className='h-16 w-full rounded-lg' />
        <Skeleton className='h-64 w-full rounded-lg' />
      </div>
    )
  }

  const chip = procedureChip({ live: state.live, managed: detail.managed })
  const config = detail.config
  const nextVersion = (config?.version ?? 0) + 1
  const fixesOn = editable
  const fixState = (issue: string) =>
    fixedIssues.has(issue)
      ? 'drafted'
      : fixingIssue === issue
        ? 'fixing'
        : fix.isPending || fixAll.isPending
          ? 'blocked'
          : 'idle'

  const deployConfirmCopy = state.adoptsOnWrite
    ? `${name} becomes app-managed: today's definition is saved as version 1 and yours as version 2, then deployed here. From then on it travels to staging and production through the nightly promote.`
    : state.live
      ? `Save as version ${nextVersion} and deploy it over the live procedure?`
      : `Save as version ${nextVersion} and create it on this database?`

  return (
    <div className='space-y-4 p-4 sm:p-6'>
      {/* ── Header ── */}
      <div className='space-y-2'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1.5'>
          <h2
            ref={titleRef}
            className='min-w-0 max-w-full truncate font-mono text-[15px] font-semibold text-slate-900 dark:text-foreground'
          >
            {detail.name}
          </h2>
          {chip && <StatusChip chip={chip} className='text-[11px]' />}
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            {config && <span className='font-mono'>v{config.version} · </span>}
            {state.live ? (
              <>
                modified{' '}
                <span data-tip={detail.modified ? formatDateTime(detail.modified) : undefined}>
                  {detail.modified ? formatRelative(detail.modified) : '—'}
                </span>{' '}
                · {detail.params.length} parameter{detail.params.length === 1 ? '' : 's'}
              </>
            ) : (
              'not on this database'
            )}
          </span>
          <div className='ml-auto flex flex-wrap items-center gap-2'>
            <span data-tip={state.reviewOff}>
              <Button
                size='sm'
                variant='outline'
                className={BTN}
                disabled={!state.canReview || review.isPending}
                onClick={() => review.mutate()}
                data-tip={
                  state.canReview
                    ? 'Read the procedure on this database, compare it against the live schema and indexes of every table it touches, and suggest improvements'
                    : undefined
                }
              >
                {review.isPending ? (
                  <Loader2 className='h-3 w-3 animate-spin' />
                ) : (
                  <Sparkles aria-hidden className='h-3 w-3 text-nvr-cyan' />
                )}
                AI review
              </Button>
            </span>
            {state.canDrop && !confirmDrop && (
              <Button
                size='sm'
                variant='ghost'
                className={cn(
                  BTN,
                  'text-slate-600 hover:text-red-700 dark:text-muted-foreground dark:hover:text-red-300'
                )}
                disabled={writes.busy}
                onClick={() => setConfirmDrop(true)}
              >
                <Trash2 aria-hidden className='h-3 w-3' /> Drop
              </Button>
            )}
          </div>
        </div>
        {state.canDrop && confirmDrop && (
          <div className='rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-red-900 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-100'>
            <p className='max-w-[80ch] text-[12.5px]'>
              {state.adoptsOnWrite && (
                <>
                  {name} is adopted into config first, so the drop travels to staging and production
                  through the nightly promote.{' '}
                </>
              )}
              Drop removes the procedure from this database and from every environment config
              reaches. Its versions are kept.
            </p>
            <div className='mt-2 flex flex-wrap items-center gap-2'>
              <Button
                size='sm'
                variant='destructive'
                className={BTN}
                disabled={writes.busy}
                onClick={() =>
                  writes.drop.mutate(undefined, { onSettled: () => setConfirmDrop(false) })
                }
              >
                {writes.drop.isPending && <Loader2 className='h-3 w-3 animate-spin' />}
                Drop {name}
              </Button>
              <Button
                size='sm'
                variant='ghost'
                className={BTN}
                onClick={() => setConfirmDrop(false)}
              >
                Keep it
              </Button>
            </div>
          </div>
        )}
      </div>

      <OwnerBanner detail={detail} state={state} writes={writes} />
      {writes.conflict && (
        <ConflictPanel
          key={`${writes.conflict.kind}:${writes.conflict.op}`}
          conflict={writes.conflict}
          state={state}
          writes={writes}
        />
      )}

      {/* ── AI review ── */}
      {review.isPending && (
        <p className='rounded-xl border border-slate-200 bg-white px-4 py-3 text-[12px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
          Analyzing: reading the definition, plus columns, indexes and row counts of every table it
          references…
        </p>
      )}
      {aiReview && !review.isPending && (
        <section className='rounded-xl border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
          <div className='mb-2 flex flex-wrap items-center gap-x-2 gap-y-1'>
            <Sparkles aria-hidden className='h-3.5 w-3.5 text-nvr-cyan' />
            <h3 className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>
              AI review
            </h3>
            {(aiReview.tables_analyzed ?? []).length > 0 && (
              <span className='min-w-0 break-words text-[11.5px] text-slate-500 dark:text-muted-foreground'>
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
                <h4 className='text-[12px] font-semibold text-slate-600 dark:text-slate-300'>
                  Improvements
                </h4>
                {fixesOn && (
                  <FixAllButton
                    section='improvements'
                    issues={aiReview.improvements!}
                    fixedIssues={fixedIssues}
                    busySection={fixAllSection}
                    anyBusy={fix.isPending || fixAll.isPending}
                    onFixAll={(section, issues) => fixAll.mutate({ section, issues })}
                  />
                )}
              </div>
              <ul className='max-w-[86ch] space-y-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
                {aiReview.improvements!.map((imp, i) => (
                  <li key={i} className='flex items-start gap-2'>
                    <span
                      aria-hidden
                      className='mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-400 dark:bg-slate-500'
                    />
                    <span className='min-w-0 flex-1 break-words'>{imp}</span>
                    {fixesOn && <FixButton state={fixState(imp)} onFix={() => fix.mutate(imp)} />}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(aiReview.index_suggestions ?? []).length > 0 && (
            <div className='mt-3'>
              <h4 className='mb-1 text-[12px] font-semibold text-slate-600 dark:text-slate-300'>
                Index suggestions
              </h4>
              <div className='space-y-2'>
                {aiReview.index_suggestions!.map((ix, i) => (
                  <div
                    key={i}
                    className='rounded-lg border border-slate-100 bg-slate-50/60 p-2.5 dark:border-border dark:bg-muted/30'
                  >
                    <p className='break-words text-[12px] text-slate-600 dark:text-slate-300'>
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
                        aria-label='Copy CREATE INDEX'
                        className='inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:text-[#007a99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:text-nvr-cyan [@media(hover:none)]:min-h-11 [@media(hover:none)]:min-w-11'
                        data-tip='Copy CREATE INDEX'
                        onClick={() => {
                          navigator.clipboard.writeText(ix.create_sql).catch(() => {})
                          toast.success('Copied')
                        }}
                      >
                        <Copy aria-hidden className='h-3.5 w-3.5' />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <p className='mt-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                Suggestions only; nothing is created automatically. Validate against real query
                plans (DB Health → Explain) before adding indexes to hot tables.
              </p>
            </div>
          )}
          {(aiReview.risks ?? []).length > 0 && (
            <div className='mt-3'>
              <div className='mb-1 flex items-center gap-2'>
                <h4 className='text-[12px] font-semibold text-slate-600 dark:text-slate-300'>
                  Risks
                </h4>
                {fixesOn && (
                  <FixAllButton
                    section='risks'
                    issues={aiReview.risks!}
                    fixedIssues={fixedIssues}
                    busySection={fixAllSection}
                    anyBusy={fix.isPending || fixAll.isPending}
                    onFixAll={(section, issues) => fixAll.mutate({ section, issues })}
                  />
                )}
              </div>
              <ul className='max-w-[86ch] space-y-1.5 text-[12px] text-amber-800 dark:text-amber-200'>
                {aiReview.risks!.map((r, i) => (
                  <li key={i} className='flex items-start gap-2'>
                    <span
                      aria-hidden
                      className='mt-[7px] h-1 w-1 shrink-0 rounded-full bg-amber-500'
                    />
                    <span className='min-w-0 flex-1 break-words'>{r}</span>
                    {fixesOn && <FixButton state={fixState(r)} onFix={() => fix.mutate(r)} />}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* ── Run ── */}
      {state.canRun && (
        <section className='rounded-xl border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
          <div className='mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5'>
            <Play aria-hidden className='h-3.5 w-3.5 text-nvr-cyan' />
            <h3 className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>Run</h3>
            <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              parameters parsed from the deployed signature; blank ones use the procedure's defaults
            </span>
          </div>
          {detail.params.length > 0 && (
            <div className='mb-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4'>
              {detail.params.map((p) => (
                <div key={p.name} className='min-w-0'>
                  <label
                    className='mb-0.5 block truncate font-mono text-[11px] text-slate-600 dark:text-muted-foreground'
                    htmlFor={`p-${p.name}`}
                  >
                    {p.name} <span className='text-slate-500 dark:text-slate-500'>{p.type}</span>
                    {p.is_output && (
                      <span className='ml-1 text-amber-700 dark:text-amber-300'>out</span>
                    )}
                  </label>
                  <Input
                    id={`p-${p.name}`}
                    type={paramInputType(p.type)}
                    value={paramValues[p.name.replace(/^@/, '')] ?? ''}
                    onChange={(e) =>
                      setParamValues((prev) => ({
                        ...prev,
                        [p.name.replace(/^@/, '')]: e.target.value
                      }))
                    }
                    className={cn('h-7 font-mono text-[12px]', TOUCH)}
                  />
                </div>
              ))}
            </div>
          )}
          <div className='flex flex-wrap items-center gap-3'>
            <Button size='sm' className={BTN} disabled={run.isPending} onClick={() => run.mutate()}>
              {run.isPending ? (
                <Loader2 className='h-3 w-3 animate-spin' />
              ) : (
                <Play aria-hidden className='h-3 w-3' />
              )}
              Execute
            </Button>
            {result && (
              <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
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
                      <th
                        key={c}
                        className='whitespace-nowrap px-2.5 py-1.5 text-left text-[11px] font-medium text-slate-600 dark:text-slate-300'
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className='divide-y divide-slate-100 dark:divide-border'>
                  {result.rows.slice(0, 200).map((row, i) => (
                    <tr key={i}>
                      {Object.values(row).map((v, j) => (
                        <td
                          key={j}
                          className='max-w-[280px] truncate px-2.5 py-1 text-slate-700 dark:text-slate-300'
                        >
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
            <p className='mt-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Completed with no result rows.
            </p>
          )}
        </section>
      )}

      {/* ── Definition ── */}
      <section className='rounded-xl border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        {lastFix && dirty && (
          <div className='mb-3 rounded-lg border border-nvr-cyan/30 bg-nvr-cyan/5 px-3 py-2'>
            <p className='break-words text-[12px] text-slate-700 dark:text-slate-300'>
              <span className='font-medium'>AI fix drafted</span> for: “
              {lastFix.issue.slice(0, 140)}
              {lastFix.issue.length > 140 ? '…' : ''}”
            </p>
            {lastFix.explanation && (
              <p className='mt-0.5 max-w-[80ch] text-[12px] text-slate-600 dark:text-slate-300'>
                {lastFix.explanation}
              </p>
            )}
            <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              Nothing is deployed yet. Review the definition below, then Deploy changes (or
              Discard).
            </p>
          </div>
        )}
        <div className='mb-2 flex flex-wrap items-center gap-x-2 gap-y-2'>
          <h3 className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>Definition</h3>
          {config && (
            <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              {state.dropped
                ? `last saved version ${config.version}`
                : `saved version ${config.version}`}
            </span>
          )}
          {!editable && (
            <span className='rounded bg-slate-100 px-1.5 py-px text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200 dark:bg-muted dark:text-muted-foreground dark:ring-border'>
              read-only
            </span>
          )}
          {dirty && (
            <span className='rounded-full bg-amber-50 px-2 py-px text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-400/30'>
              unsaved changes
            </span>
          )}
          {editable && (
            <div className='flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto'>
              {dirty && !confirmDeploy && (
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder='What changed? (optional)'
                  aria-label='Note for this version'
                  maxLength={500}
                  className={cn('h-7 w-full text-[12px] sm:w-64', TOUCH)}
                />
              )}
              {dirty && !confirmDeploy && (
                <Button size='sm' variant='ghost' className={BTN} onClick={resetEdit}>
                  Discard
                </Button>
              )}
              {!confirmDeploy && (
                <Button
                  size='sm'
                  className={BTN}
                  disabled={!dirty || writes.busy}
                  onClick={() => setConfirmDeploy(true)}
                >
                  Deploy changes
                </Button>
              )}
            </div>
          )}
        </div>
        {editable && confirmDeploy && (
          <div className='mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100'>
            <p className='max-w-[80ch] text-[12.5px]'>{deployConfirmCopy}</p>
            {note.trim() && (
              <p className='mt-0.5 break-words text-[12px] text-amber-800 dark:text-amber-200'>
                Note: {note.trim()}
              </p>
            )}
            <div className='mt-2 flex flex-wrap items-center gap-2'>
              <Button
                size='sm'
                className={BTN}
                disabled={writes.busy}
                onClick={() =>
                  writes.save.mutate(
                    { definition, note },
                    { onSettled: () => setConfirmDeploy(false) }
                  )
                }
              >
                {writes.save.isPending && <Loader2 className='h-3 w-3 animate-spin' />}
                Deploy
              </Button>
              <Button
                size='sm'
                variant='ghost'
                className={BTN}
                onClick={() => setConfirmDeploy(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {dirty && (
          <fieldset className='mb-2 inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-border'>
            <legend className='sr-only'>Definition view</legend>
            {(
              [
                ['edit', 'Edit'],
                ['diff', 'Highlighted changes']
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type='button'
                aria-pressed={defView === mode}
                onClick={() => setDefView(mode)}
                className={cn(
                  'min-h-6 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan [@media(hover:none)]:min-h-11',
                  defView === mode
                    ? 'bg-nvr-cyan/10 text-[#007a99] dark:text-nvr-cyan'
                    : 'text-slate-600 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
                )}
              >
                {label}
              </button>
            ))}
          </fieldset>
        )}
        {dirty && defView === 'diff' ? (
          <DiffView
            base={base}
            draft={definition}
            baseLabel={config ? `saved version ${config.version}` : 'the live definition'}
            className='h-[min(480px,60vh)]'
          />
        ) : !editable ? (
          // Read-only text sizes to its content (a short proc is not a tall empty box).
          <section
            aria-label={`Definition of ${name} (read-only)`}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll box must take focus to be scrolled from the keyboard
            tabIndex={0}
            className='max-h-[min(480px,60vh)] min-h-24 overflow-auto rounded-lg border border-slate-200 bg-slate-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-muted/40'
          >
            <pre className='m-0 min-w-max p-3 font-mono text-[12px] leading-relaxed text-slate-700 dark:text-slate-300'>
              {definition || (
                <span className='text-slate-500 dark:text-muted-foreground'>
                  The text of this procedure cannot be read.
                </span>
              )}
            </pre>
          </section>
        ) : (
          <textarea
            value={definition}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            aria-label={`Definition of ${name}`}
            className='h-[min(480px,60vh)] w-full resize-y rounded-lg border border-slate-200 bg-slate-50/50 p-3 font-mono text-[12px] leading-relaxed text-slate-800 outline-none focus:border-nvr-cyan/60 dark:border-border dark:bg-background dark:text-slate-200'
          />
        )}
        {editable && (
          <div className='mt-1.5 max-w-[86ch] space-y-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            <p>{DEPLOY_HINT}</p>
            {state.adoptsOnWrite && (
              <p>
                Not managed yet: deploying adopts it first, so today's definition is kept as version
                1 and your edit becomes version 2.
              </p>
            )}
          </div>
        )}
      </section>

      {/* ── History ── */}
      {state.owner === 'managed' && config && (
        <ProcedureHistory
          detail={detail}
          state={state}
          busy={writes.busy}
          dirty={dirty}
          restoring={writes.restore.isPending ? restoringVersion : null}
          onRestore={(version, body) => {
            setRestoringVersion(version)
            writes.restore.mutate({ version, body })
          }}
        />
      )}
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
        className='inline-flex min-h-6 shrink-0 items-center rounded-full bg-nvr-cyan/10 px-2 text-[11px] font-medium text-[#007a99] dark:text-nvr-cyan'
        data-tip='A fix for this finding is in the pending draft below; Deploy to apply it'
      >
        <Check aria-hidden className='mr-0.5 h-3 w-3' /> drafted
      </span>
    )
  }
  if (state === 'fixing') {
    return (
      <span className='inline-flex min-h-6 shrink-0 items-center gap-1 rounded border border-slate-200 px-2 text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
        <Loader2 className='h-3 w-3 animate-spin' /> fixing…
      </span>
    )
  }
  return (
    <button
      type='button'
      disabled={state === 'blocked'}
      onClick={onFix}
      className='inline-flex min-h-6 shrink-0 items-center rounded border border-slate-200 px-2 text-[11px] font-medium text-slate-600 transition-colors hover:border-nvr-cyan/60 hover:text-[#007a99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-50 dark:border-border dark:text-slate-300 dark:hover:text-nvr-cyan [@media(hover:none)]:min-h-11'
      data-tip='Draft an AI fix for this finding into the definition editor; you review and deploy'
    >
      Fix
    </button>
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
      <span className='inline-flex min-h-6 items-center gap-1 rounded border border-slate-200 px-2 text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
        <Loader2 className='h-3 w-3 animate-spin' /> fixing {pending.length}…
      </span>
    )
  }
  return (
    <button
      type='button'
      disabled={anyBusy}
      onClick={() => onFixAll(section, pending)}
      className='inline-flex min-h-6 items-center rounded border border-slate-200 px-2 text-[11px] font-medium text-slate-600 transition-colors hover:border-nvr-cyan/60 hover:text-[#007a99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-50 dark:border-border dark:text-slate-300 dark:hover:text-nvr-cyan [@media(hover:none)]:min-h-11'
      data-tip={`One combined AI fix for the ${pending.length} remaining findings in this section; drafts into the editor for review`}
    >
      Fix all ({pending.length})
    </button>
  )
}

type NavTarget = { kind: 'open'; name: string } | { kind: 'new' } | { kind: 'back' }

/** Tell the page whether this panel holds unsaved work (and that it holds none once gone). */
function useReportDirty(dirty: boolean, report: (dirty: boolean) => void) {
  useEffect(() => {
    report(dirty)
  }, [dirty, report])
  useEffect(() => () => report(false), [report])
}

/** Switching away from unsaved work: asked inline at the top of the detail, never a modal. */
function LeaveConfirm({
  what,
  target,
  onLeave,
  onStay
}: {
  what: string
  target: NavTarget
  onLeave: () => void
  onStay: () => void
}) {
  const leave =
    target.kind === 'open'
      ? `Discard and open ${target.name}`
      : target.kind === 'new'
        ? 'Discard and start a new one'
        : 'Discard and go back'
  return (
    <div
      role='alert'
      className='sticky top-0 z-20 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-amber-900 sm:px-6 dark:border-amber-400/30 dark:bg-[#2a2210] dark:text-amber-100'
    >
      <p className='break-words text-[12.5px]'>
        You have unsaved changes to <span className='font-mono'>{what}</span>. Leave them?
      </p>
      <div className='mt-2 flex flex-wrap items-center gap-2'>
        <Button size='sm' variant='destructive' className={cn(BTN, 'max-w-full')} onClick={onLeave}>
          <span className='truncate'>{leave}</span>
        </Button>
        <Button size='sm' variant='ghost' className={BTN} onClick={onStay}>
          Keep editing
        </Button>
      </div>
    </div>
  )
}
