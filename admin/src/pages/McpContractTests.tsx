import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, FlaskConical, Loader2, Play, Save, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Tool contract tests (#3215) in the MCP console: a call run here can be kept as a test — its
 * tool, arguments, the tool's input schema and the shape of its answer — and re-run later (here,
 * or `pnpm mcp:contract-tests` in CI) to prove the tool still takes those arguments and still
 * answers in that shape. Values are never compared. Reads /api/mcp-console/tests.
 */

interface RunOutcome {
  problems: string[]
  notes: string[]
  message?: string
  observed?: unknown
}

export interface ContractTest {
  id: number
  name: string
  tool: string
  arguments: Record<string, unknown>
  expect_error: boolean
  enabled: boolean
  created_at: string | null
  last_run_at: string | null
  last_status: 'pass' | 'fail' | 'error' | null
  last_result: RunOutcome | null
  last_ms: number | null
}

interface RunAnswer {
  summary: { total: number; passed: number; failed: number; errored: number }
  results: Array<{ id: number; status: 'pass' | 'fail' | 'error' }>
}

const TESTS_KEY = ['mcp-console', 'tests'] as const

const errMsg = (e: unknown) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
  (e as Error)?.message ??
  'Something went wrong'

export function useContractTests() {
  return useQuery({
    queryKey: TESTS_KEY,
    queryFn: async () =>
      (await api.get<{ data: { tests: ContractTest[] } }>('/mcp-console/tests')).data.data.tests,
    // 409 = migration 509 has not run: show that, do not retry it.
    retry: false,
    staleTime: 30_000
  })
}

function useRunTests() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (ids?: number[]) =>
      (await api.post<{ data: RunAnswer }>('/mcp-console/tests/run', ids ? { ids } : {})).data.data,
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: TESTS_KEY })
      const { passed, total, failed, errored } = d.summary
      if (failed + errored === 0) toast.success(`${passed} of ${total} passed`)
      else toast.error(`${failed + errored} of ${total} did not pass`)
    },
    onError: (e) => toast.error(errMsg(e))
  })
}

/** Keep the call just run as a test. */
export function SaveTestButton({
  tool,
  args,
  output,
  isError
}: {
  tool: string
  args: Record<string, unknown>
  output: unknown
  isError: boolean
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)
  const save = useMutation({
    mutationFn: async () =>
      (
        await api.post('/mcp-console/tests', {
          name: name.trim() || tool,
          tool,
          arguments: args,
          output,
          is_error: isError
        })
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TESTS_KEY })
      setOpen(false)
      setSaved(true)
      toast.success('Saved as a contract test')
    },
    onError: (e) => toast.error(errMsg(e))
  })
  if (saved)
    return (
      <span className='inline-flex items-center gap-1 text-[12px] text-emerald-700 dark:text-emerald-400'>
        <Check className='h-3.5 w-3.5' /> Saved as a test
      </span>
    )
  if (!open)
    return (
      <button
        type='button'
        onClick={() => setOpen(true)}
        data-tip='Re-run this call later to prove the tool still takes these inputs and answers in this shape'
        className='inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
      >
        <FlaskConical className='h-3.5 w-3.5' /> Save as test
      </button>
    )
  return (
    <form
      className='flex items-center gap-1.5'
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value.slice(0, 120))}
        placeholder={`${tool} — what it proves`}
        aria-label='Test name'
        className='h-7 w-56 text-[12px]'
      />
      <Button
        type='submit'
        size='sm'
        disabled={save.isPending}
        className='h-7 bg-nvr-cyan px-2.5 text-[12px] text-white hover:bg-nvr-cyan/90'
      >
        {save.isPending ? (
          <Loader2 className='h-3.5 w-3.5 animate-spin' />
        ) : (
          <Save className='mr-1 h-3.5 w-3.5' />
        )}
        Save
      </Button>
      <Button
        type='button'
        size='sm'
        variant='ghost'
        className='h-7 px-2 text-[12px]'
        onClick={() => setOpen(false)}
      >
        Cancel
      </Button>
    </form>
  )
}

const STATUS: Record<'pass' | 'fail' | 'error' | 'none', { label: string; cls: string }> = {
  pass: {
    label: 'Pass',
    cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
  },
  fail: { label: 'Fail', cls: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300' },
  error: {
    label: 'Error',
    cls: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
  },
  none: { label: 'Not run', cls: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-slate-300' }
}

function TestRow({ t, showTool }: { t: ContractTest; showTool: boolean }) {
  const qc = useQueryClient()
  const run = useRunTests()
  const [open, setOpen] = useState(false)
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const id = window.setTimeout(() => setArmed(false), 3000)
    return () => window.clearTimeout(id)
  }, [armed])
  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      api.patch(`/mcp-console/tests/${t.id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: TESTS_KEY }),
    onError: (e) => toast.error(errMsg(e))
  })
  const remove = useMutation({
    mutationFn: async () => api.delete(`/mcp-console/tests/${t.id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: TESTS_KEY }),
    onError: (e) => toast.error(errMsg(e))
  })
  const status = STATUS[t.last_status ?? 'none']
  const r = t.last_result
  const detail = (r?.problems.length ?? 0) + (r?.notes.length ?? 0) + (r?.message ? 1 : 0)
  return (
    <li className='px-4 py-2.5'>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1.5'>
        <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', status.cls)}>
          {status.label}
        </span>
        <span
          className={cn(
            'min-w-0 truncate text-[12.5px] font-medium text-slate-800 dark:text-slate-100',
            !t.enabled && 'opacity-60'
          )}
        >
          {t.name}
        </span>
        {showTool && (
          <span className='font-mono text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {t.tool}
          </span>
        )}
        {!t.enabled && (
          <span className='rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500 dark:bg-muted dark:text-muted-foreground'>
            Off
          </span>
        )}
        <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {t.last_run_at
            ? `${formatRelative(t.last_run_at)}${t.last_ms != null ? ` · ${t.last_ms} ms` : ''}`
            : 'never run'}
        </span>
        <span className='ml-auto flex items-center gap-1'>
          {detail > 0 && (
            <button
              type='button'
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              className='inline-flex h-7 items-center gap-0.5 rounded-md px-2 text-[12px] text-slate-600 hover:bg-muted dark:text-muted-foreground'
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 transition-transform motion-reduce:transition-none',
                  open && 'rotate-90'
                )}
              />
              Details
            </button>
          )}
          {t.last_status === 'fail' && r?.observed !== undefined && (
            <button
              type='button'
              disabled={patch.isPending}
              onClick={() => patch.mutate({ accept: true })}
              data-tip='The tool changed on purpose: take this run as the new contract'
              className='h-7 rounded-md px-2 text-[12px] font-medium text-slate-600 hover:bg-muted hover:text-slate-900 disabled:opacity-40 dark:text-muted-foreground dark:hover:text-foreground'
            >
              Accept changes
            </button>
          )}
          <button
            type='button'
            disabled={patch.isPending}
            onClick={() => patch.mutate({ enabled: !t.enabled })}
            className='h-7 rounded-md px-2 text-[12px] font-medium text-slate-600 hover:bg-muted hover:text-slate-900 disabled:opacity-40 dark:text-muted-foreground dark:hover:text-foreground'
          >
            {t.enabled ? 'Turn off' : 'Turn on'}
          </button>
          <button
            type='button'
            disabled={run.isPending}
            onClick={() => run.mutate([t.id])}
            aria-label={`Run ${t.name}`}
            className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-slate-600 hover:bg-muted hover:text-slate-900 disabled:opacity-40 dark:text-muted-foreground dark:hover:text-foreground'
          >
            {run.isPending ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
            ) : (
              <Play className='h-3.5 w-3.5' />
            )}
            Run
          </button>
          <button
            type='button'
            disabled={remove.isPending}
            onClick={() => (armed ? remove.mutate() : setArmed(true))}
            aria-label={armed ? `Remove ${t.name}?` : `Remove ${t.name}`}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium transition-colors',
              armed
                ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                : 'text-slate-500 hover:bg-muted hover:text-red-600 dark:text-muted-foreground dark:hover:text-red-400'
            )}
          >
            <Trash2 className='h-3.5 w-3.5' />
            {armed && 'Remove?'}
          </button>
        </span>
      </div>
      {open && r && (
        <div className='mt-2 space-y-1 pl-1 text-[12px]'>
          {r.message && <p className='text-amber-800 dark:text-amber-300'>{r.message}</p>}
          {r.problems.map((p) => (
            <p key={p} className='text-red-700 dark:text-red-300'>
              {p}
            </p>
          ))}
          {r.notes.map((n) => (
            <p key={n} className='text-slate-500 dark:text-muted-foreground'>
              {n}
            </p>
          ))}
        </div>
      )}
    </li>
  )
}

/** The saved tests — every one, or one tool's — with Run all. */
export function ContractTestsPanel({ tool }: { tool?: string }) {
  const tests = useContractTests()
  const run = useRunTests()
  const notReady =
    (tests.error as { response?: { status?: number } } | null)?.response?.status === 409
  const list = (tests.data ?? []).filter((t) => !tool || t.tool === tool)
  if (tool && !tests.isLoading && (notReady || list.length === 0)) return null
  const counts = {
    pass: list.filter((t) => t.last_status === 'pass').length,
    bad: list.filter((t) => t.last_status === 'fail' || t.last_status === 'error').length
  }
  return (
    <section
      aria-label='Contract tests'
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <div className='flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-3 dark:border-border'>
        <h3 className='flex items-center gap-1.5 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          <FlaskConical className='h-4 w-4 text-nvr-navy dark:text-nvr-cyan' />
          {tool ? 'Contract tests for this tool' : 'Contract tests'}
        </h3>
        {list.length > 0 && (
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            {counts.pass} passing{counts.bad ? ` · ${counts.bad} not` : ''} · {list.length} in all
          </span>
        )}
        {list.length > 0 && (
          <Button
            size='sm'
            variant='outline'
            className='ml-auto h-7 text-[12px]'
            disabled={run.isPending}
            onClick={() => run.mutate(tool ? list.map((t) => t.id) : undefined)}
          >
            {run.isPending ? (
              <Loader2 className='mr-1 h-3.5 w-3.5 animate-spin' />
            ) : (
              <Play className='mr-1 h-3.5 w-3.5' />
            )}
            {tool ? 'Run these' : 'Run all'}
          </Button>
        )}
      </div>
      {tests.isLoading ? (
        <div className='space-y-2 p-4'>
          <Skeleton className='h-6 w-full' />
          <Skeleton className='h-6 w-2/3' />
        </div>
      ) : notReady ? (
        <p className='px-4 py-3 text-[12.5px] text-amber-700 dark:text-amber-400'>
          Contract tests need database migration 509. They work once it has run.
        </p>
      ) : tests.isError ? (
        <p className='px-4 py-3 text-[12.5px] text-red-600 dark:text-red-400'>
          {errMsg(tests.error)}
        </p>
      ) : list.length === 0 ? (
        <p className='max-w-[75ch] px-4 py-3 text-[12.5px] text-slate-600 dark:text-muted-foreground'>
          None yet. Run a tool, then choose <strong className='font-medium'>Save as test</strong> on
          its result. A test re-runs that call (writes held, as a dry run) and fails when the tool
          stops taking those inputs or answers in another shape. CI runs them with{' '}
          <code className='font-mono text-[11.5px]'>pnpm mcp:contract-tests</code>.
        </p>
      ) : (
        <ul className='divide-y divide-slate-100 dark:divide-border'>
          {list.map((t) => (
            <TestRow key={t.id} t={t} showTool={!tool} />
          ))}
        </ul>
      )}
    </section>
  )
}
