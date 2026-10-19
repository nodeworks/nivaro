import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Play, SearchCheck, Settings2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatNumber, formatRelative } from '@/lib/utils'
import { FindingsTab } from './sql-checks/FindingsTab'
import { FixesTab, RunsTab, TrendsTab } from './sql-checks/OtherTabs'
import { errorText, fmtMs, type SqlCheckSettings, type Summary } from './sql-checks/shared'

/**
 * SQL checks (#2562): nightly checks over every procedure, function, view and trigger
 * definition in the database (plus import definitions' stored bodies and custom queries) —
 * findings tracked across runs, trends, applied fixes and run history. Admin only.
 */

const TABS = [
  { key: 'findings', label: 'Findings' },
  { key: 'trends', label: 'Trends' },
  { key: 'fixes', label: 'Fixes' },
  { key: 'runs', label: 'Runs' }
] as const
type TabKey = (typeof TABS)[number]['key']

export default function SqlChecks() {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const tab = (
    TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'findings'
  ) as TabKey
  const object = params.get('object')
  const [showSettings, setShowSettings] = useState(false)
  const [armed, setArmed] = useState(false)

  const summary = useQuery({
    queryKey: ['sql-checks', 'summary'],
    queryFn: () => api.get<{ data: Summary }>('/sql-checks/summary').then((r) => r.data.data),
    refetchInterval: (q) => (q.state.data?.is_running ? 5000 : false)
  })
  const s = summary.data
  const wasRunning = useWasRunning(!!s?.is_running)
  useEffect(() => {
    if (wasRunning) void qc.invalidateQueries({ queryKey: ['sql-checks'] })
  }, [wasRunning, qc])

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])

  const run = useMutation({
    mutationFn: () => api.post('/sql-checks/run'),
    onSuccess: () => {
      toast.success('SQL checks started. Findings update when the run finishes.')
      void qc.invalidateQueries({ queryKey: ['sql-checks'] })
    },
    onError: (err) => toast.error(errorText(err, 'Couldn’t start a run.'))
  })

  const setTab = (key: TabKey, extra?: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('tab', key)
        for (const [k, v] of Object.entries(extra ?? {}))
          v == null ? next.delete(k) : next.set(k, v)
        return next
      },
      { replace: true }
    )

  const open = s?.counts?.open ?? {}
  const last = s?.last_run

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-4 py-4 dark:border-border dark:bg-card sm:px-6'>
        <div className='flex flex-wrap items-start gap-3'>
          <div className='min-w-0 flex-1'>
            <div className='flex items-center gap-2.5'>
              <SearchCheck className='h-5 w-5 shrink-0 text-muted-foreground' aria-hidden='true' />
              <h1 className='m-0 text-lg font-semibold text-slate-900 dark:text-foreground'>
                SQL checks
              </h1>
            </div>
            <p className='m-0 mt-1 max-w-[80ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
              Every procedure, function, view and trigger in the database, plus import definitions’
              stored procedures and custom queries, checked for mistakes that corrupt or slow data:
              MERGE keys that miss NULLs, writes without WHERE, transactions left open and more.
              Checks read only; nothing is changed here.
            </p>
          </div>
          <div className='flex shrink-0 flex-wrap items-center gap-2'>
            <Button
              size='sm'
              variant='outline'
              className='h-8 text-[12.5px] [&_svg]:size-3.5'
              aria-expanded={showSettings}
              aria-controls='sql-checks-settings'
              onClick={() => setShowSettings((v) => !v)}
            >
              <Settings2 aria-hidden='true' /> Settings
            </Button>
            <Button
              size='sm'
              className={cn(
                'h-8 text-[12.5px] [&_svg]:size-3.5',
                armed
                  ? 'bg-amber-500 text-white hover:bg-amber-500/90'
                  : 'bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              )}
              disabled={run.isPending || !!s?.is_running || s?.ready === false}
              onClick={() => {
                if (!armed) return setArmed(true)
                setArmed(false)
                run.mutate()
              }}
            >
              {run.isPending || s?.is_running ? (
                <Loader2 className='animate-spin' aria-hidden='true' />
              ) : (
                <Play aria-hidden='true' />
              )}
              {s?.is_running ? 'Running…' : armed ? 'Click again to run' : 'Run now'}
            </Button>
          </div>
        </div>
        <div
          className='mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]'
          aria-live='polite'
        >
          {summary.isLoading ? (
            <Skeleton className='h-4 w-72' />
          ) : !s?.ready ? (
            <span className='text-muted-foreground'>
              Waiting for the database update that adds SQL checks.
            </span>
          ) : (
            <>
              <span>
                <span className='font-semibold text-red-600 dark:text-red-400'>
                  {formatNumber(open.critical ?? 0)}
                </span>{' '}
                critical
              </span>
              <span>
                <span className='font-semibold text-amber-700 dark:text-amber-300'>
                  {formatNumber(open.warning ?? 0)}
                </span>{' '}
                warnings
              </span>
              <span>
                <span className='font-semibold'>{formatNumber(open.info ?? 0)}</span> info
              </span>
              <span className='text-muted-foreground'>
                {last
                  ? `Last run ${formatRelative(last.started_at)} · ${
                      last.status === 'ok'
                        ? `took ${fmtMs(last.duration_ms)}`
                        : last.status === 'failed'
                          ? 'failed'
                          : 'running'
                    } · SQLFluff ${last.sqlfluff === 'on' ? 'ran' : last.sqlfluff === 'unavailable' ? 'unavailable' : 'off'}`
                  : 'No runs yet'}
              </span>
              <span className='text-muted-foreground'>
                Nightly at 03:30: {s.nightly?.enabled ? 'on' : 'off'}
                {s.nightly?.forced_by_env != null ? ' (server configuration)' : ''}
              </span>
            </>
          )}
        </div>
        {last?.status === 'failed' && last.error && (
          <p className='m-0 mt-2 text-[12px] text-red-600 dark:text-red-400'>
            Last run failed: {last.error}
          </p>
        )}
      </header>

      {showSettings && s?.ready && (
        <SettingsCard
          settings={s.settings}
          forcedByEnv={s.nightly?.forced_by_env ?? null}
          sqlfluff={!!s.sqlfluff_configured}
        />
      )}

      <div
        role='tablist'
        aria-label='SQL checks sections'
        className='flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-white px-4 dark:border-border dark:bg-card sm:px-6'
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type='button'
            role='tab'
            id={`sql-checks-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls='sql-checks-panel'
            onClick={() => setTab(t.key)}
            className={cn(
              '-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-[12.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
              tab === t.key
                ? 'border-nvr-cyan text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
            {t.key === 'fixes' && (s?.fixes_30d ?? 0) > 0 && (
              <span className='ml-1.5 text-[11px] text-muted-foreground'>{s?.fixes_30d}</span>
            )}
          </button>
        ))}
      </div>

      <div
        id='sql-checks-panel'
        role='tabpanel'
        aria-labelledby={`sql-checks-tab-${tab}`}
        className='flex min-h-0 flex-1 flex-col overflow-y-auto bg-slate-50 dark:bg-background'
      >
        {tab === 'findings' && <FindingsTab initialObject={object} />}
        {tab === 'trends' && s?.ready && (
          <TrendsTab summary={s} onObject={(name) => setTab('findings', { object: name })} />
        )}
        {tab === 'fixes' && <FixesTab />}
        {tab === 'runs' && <RunsTab />}
      </div>
    </div>
  )
}

/** True on the render where `running` goes from true to false (a run just finished). */
function useWasRunning(running: boolean): boolean {
  const [prev, setPrev] = useState(running)
  const [finished, setFinished] = useState(false)
  if (prev !== running) {
    setPrev(running)
    setFinished(prev && !running)
  }
  return finished
}

function SettingsCard({
  settings,
  forcedByEnv,
  sqlfluff
}: {
  settings: SqlCheckSettings
  forcedByEnv: boolean | null
  sqlfluff: boolean
}) {
  const qc = useQueryClient()
  const id = useId()
  const [rowCap, setRowCap] = useState(String(settings.row_cap))
  const [timeout, setTimeoutS] = useState(String(settings.data_timeout_s))
  useEffect(() => {
    setRowCap(String(settings.row_cap))
    setTimeoutS(String(settings.data_timeout_s))
  }, [settings.row_cap, settings.data_timeout_s])
  const save = useMutation({
    mutationFn: (patch: Partial<SqlCheckSettings>) => api.patch('/sql-checks/settings', patch),
    onSuccess: () => {
      toast.success('Settings saved')
      void qc.invalidateQueries({ queryKey: ['sql-checks', 'summary'] })
    },
    onError: (err) => toast.error(errorText(err, 'Couldn’t save the settings.'))
  })
  const toggle = (
    key: keyof SqlCheckSettings,
    label: string,
    hint: string,
    opts?: { disabled?: boolean; checked?: boolean; note?: string }
  ) => (
    <div className='flex items-start gap-3'>
      <Switch
        id={`${id}-${key}`}
        checked={opts?.checked ?? (settings[key] as boolean)}
        disabled={opts?.disabled || save.isPending}
        onCheckedChange={(v) => save.mutate({ [key]: v })}
        className='mt-0.5'
      />
      <label htmlFor={`${id}-${key}`} className='grid gap-0.5 text-[12.5px]'>
        <span className='font-medium'>{label}</span>
        <span className='text-[11.5px] text-muted-foreground'>{opts?.note ?? hint}</span>
      </label>
    </div>
  )
  const numberField = (
    key: 'row_cap' | 'data_timeout_s',
    label: string,
    value: string,
    set: (v: string) => void,
    hint: string
  ) => (
    <div className='grid gap-1'>
      <label htmlFor={`${id}-${key}`} className='text-[12.5px] font-medium'>
        {label}
      </label>
      <Input
        id={`${id}-${key}`}
        inputMode='numeric'
        value={value}
        onChange={(e) => set(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={() => {
          const n = Number(value)
          if (Number.isFinite(n) && n !== settings[key]) save.mutate({ [key]: n })
        }}
        className='h-8 max-w-[200px] text-[12.5px]'
      />
      <span className='text-[11.5px] text-muted-foreground'>{hint}</span>
    </div>
  )
  return (
    <section
      id='sql-checks-settings'
      aria-label='SQL checks settings'
      className='shrink-0 border-b border-slate-200 bg-white px-4 py-4 dark:border-border dark:bg-card sm:px-6'
    >
      <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
        {toggle('enabled', 'Run nightly at 03:30', 'Run now always works.', {
          disabled: forcedByEnv != null,
          checked: forcedByEnv ?? settings.enabled,
          note:
            forcedByEnv == null
              ? undefined
              : forcedByEnv
                ? 'Turned on by the server’s configuration (SQL_CHECKS=on).'
                : 'Turned off by the server’s configuration (SQL_CHECKS=off).'
        })}
        {toggle(
          'data_checks',
          'Count NULL keys and copies',
          'Reads the tables a MERGE writes, to show how many rows are affected now.'
        )}
        {toggle(
          'include_import_definitions',
          'Check import definitions',
          'Their stored procedure bodies, and whether they match the deployed procedure.'
        )}
        {toggle('include_custom_queries', 'Check custom queries', 'The SQL of every custom query.')}
        {numberField(
          'row_cap',
          'Largest table to count (rows)',
          rowCap,
          setRowCap,
          'Bigger tables skip the live counts.'
        )}
        {numberField(
          'data_timeout_s',
          'Count timeout (seconds)',
          timeout,
          setTimeoutS,
          'Per table, 10 to 1800.'
        )}
      </div>
      <p className='m-0 mt-3 text-[11.5px] text-muted-foreground'>
        SQLFluff:{' '}
        {sqlfluff
          ? 'connected (SQL_LINT_URL)'
          : 'not set up. Set SQL_LINT_URL and SQL_LINT_TOKEN to add its correctness rules.'}
      </p>
    </section>
  )
}
