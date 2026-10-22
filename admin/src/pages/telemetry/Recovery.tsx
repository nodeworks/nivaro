import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpRight,
  ChevronDown,
  FlaskConical,
  LifeBuoy,
  Loader2,
  Play,
  SlidersHorizontal
} from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatDateTime, formatNumber, formatRelative } from '@/lib/utils'
import { Card, Dot, PartError, TONE, type Tone } from './ui'

/**
 * Disaster recovery (#2801 restore drill, #2802 RPO / RTO): one judged row per question —
 * newest database backup and uploads backup against the RPO, the newest restore drill, its
 * measured restore time and chaos drills' recovery against the RTO — plus Run now / Dry run, the
 * drill's history, what the last drill checked, the targets and the runbook link.
 * GET /api/telemetry/recovery (administrators).
 */

type Verdict = 'passed' | 'failed' | 'blocked' | 'skipped' | 'ready'

interface Row {
  key: string
  label: string
  tone: Tone
  value: string
  reason: string
  target: string | null
}

interface DrillResult {
  verdict: Verdict
  mode: 'run' | 'dry_run'
  reason: string
  phase: string | null
  started_at: string
  finished_at: string | null
  scratch_db: string | null
  server: string | null
  plan: {
    full: { finish_utc: string; devices: string[] } | null
    diff: { finish_utc: string; devices: string[] } | null
    point_utc: string | null
    logs_after: number
    notes: string[]
  } | null
  backup_age_s: number | null
  files: Array<{
    logical: string
    physical: string
    type: string
    size_bytes: number | null
  }> | null
  needed_bytes: number | null
  free_bytes: number | null
  restore_ms: number | null
  steps: Array<{ step: 'full' | 'diff'; ms: number; ok: boolean; error: string | null }>
  smoke: {
    passed: boolean
    tables: Array<{
      ref: string
      live_rows: number | null
      restored_rows: number | null
      verdict: 'ok' | 'missing' | 'empty' | 'not_live'
      changed: boolean
    }>
    checksums: Array<{
      ref: string
      live: number | null
      restored: number | null
      match: boolean | null
    }>
  } | null
  checkdb: { ok: boolean; ms: number; error: string | null } | null
  dropped: boolean | null
  total_ms: number | null
}

interface DrillSettings {
  enabled: boolean
  scratch_db: string | null
  business_tables: string[]
  checkdb: boolean
  data_path: string | null
  log_path: string | null
  max_restore_minutes: number
}

interface RecoveryStatus {
  tone: Tone
  rows: Row[]
  targets: {
    rpo_minutes: number
    rto_minutes: number
    source: { rpo: 'env' | 'setting'; rto: 'env' | 'setting' }
  }
  runbook_url: string | null
  runbook_source: 'env' | 'setting' | null
  database: string
  drill: {
    enabled: boolean
    enabled_source: 'env' | 'setting'
    cloud: boolean
    scratch_db: string
    scratch_source: 'env' | 'setting' | 'default'
    scratch_refusal: string | null
    schedule: string
    running: { since: string; phase: string | null } | null
    queued: boolean
    last: DrillResult | null
    history: Array<{
      id: number
      status: string
      started_at: string
      verdict: Verdict | null
      reason: string | null
      restore_ms: number | null
    }>
    error: string | null
    settings: DrillSettings
  }
  computed_at: string
}

const KEY = ['telemetry', 'recovery']

const errorText = (err: unknown, fallback: string): string =>
  (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ?? fallback

export function fmtSpan(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`
  return `${Math.round(seconds / 86_400)} d`
}

const gb = (b: number | null) =>
  b == null
    ? '—'
    : b < 1024 ** 3
      ? `${Math.max(1, Math.round(b / 1024 ** 2))} MB`
      : `${Math.round((b / 1024 ** 3) * 10) / 10} GB`

const VERDICT_TONE: Record<Verdict, Tone> = {
  passed: 'ok',
  ready: 'ok',
  failed: 'bad',
  blocked: 'warn',
  skipped: 'off'
}
const VERDICT_LABEL: Record<Verdict, string> = {
  passed: 'Passed',
  ready: 'Ready',
  failed: 'Failed',
  blocked: 'Could not run',
  skipped: 'Skipped'
}

function RowItem({ row }: { row: Row }) {
  return (
    <li className='grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2.5' data-recovery-row={row.key}>
      <div className='flex min-w-0 items-center gap-2 text-[12.5px] font-medium'>
        <Dot tone={row.tone} />
        <span className='truncate'>{row.label}</span>
        {row.target && (
          <span className='shrink-0 rounded border border-slate-200 px-1.5 text-[10.5px] font-normal text-muted-foreground dark:border-border'>
            {row.target}
          </span>
        )}
      </div>
      <div className={cn('text-right text-[13px] font-semibold tabular-nums', TONE[row.tone].text)}>
        {row.value}
        <span className='sr-only'>
          {' '}
          (
          {row.tone === 'ok'
            ? 'good'
            : row.tone === 'warn'
              ? 'attention'
              : row.tone === 'bad'
                ? 'problem'
                : 'no data'}
          )
        </span>
      </div>
      <p className='col-span-2 m-0 mt-0.5 pl-4 text-[12px] leading-relaxed text-muted-foreground'>
        {row.reason}
      </p>
    </li>
  )
}

/** Small squares for the newest runs, oldest left; hover names each. */
function History({ runs }: { runs: RecoveryStatus['drill']['history'] }) {
  const shown = [...runs].reverse().slice(-14)
  if (!shown.length) return null
  return (
    <ul
      className='m-0 flex list-none flex-wrap items-center gap-1 p-0'
      aria-label='Recent restore drills'
    >
      {shown.map((h) => {
        const running = h.status === 'running'
        const tone: Tone = running
          ? 'off'
          : h.verdict
            ? VERDICT_TONE[h.verdict]
            : h.status === 'error'
              ? 'bad'
              : 'off'
        const what = running
          ? 'running'
          : h.verdict
            ? VERDICT_LABEL[h.verdict].toLowerCase()
            : h.status
        return (
          <li
            key={h.id}
            data-tip={`${formatDateTime(h.started_at)} · ${what}${h.restore_ms != null ? ` · restore ${fmtSpan(h.restore_ms / 1000)}` : ''}`}
            className={cn(
              'inline-block h-3 w-3 rounded-sm',
              TONE[tone].dot,
              running && 'animate-pulse'
            )}
          >
            <span className='sr-only'>
              {formatDateTime(h.started_at)} {what}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** A drill's result in detail: the plan, steps, files and what the smoke check saw. */
function DrillDetail({ r, title }: { r: DrillResult; title: string }) {
  const tone = VERDICT_TONE[r.verdict]
  return (
    <div
      className={cn('mt-3 rounded-md border bg-slate-50/60 p-3 dark:bg-muted/30', TONE[tone].ring)}
    >
      <div className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]'>
        <Dot tone={tone} />
        <span className='font-semibold'>{title}</span>
        <span className={cn('font-medium', TONE[tone].text)}>{VERDICT_LABEL[r.verdict]}</span>
        <span className='ml-auto text-[11.5px] text-muted-foreground'>
          {formatDateTime(r.started_at)}
          {r.server ? ` · ${r.server}` : ''}
        </span>
      </div>
      <p className='m-0 mt-1 text-[12px] leading-relaxed'>{r.reason}</p>
      <div className='mt-2 grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-[12px] dark:border-border dark:bg-border sm:grid-cols-4'>
        {[
          ['Restored point', r.plan?.point_utc ? formatDateTime(r.plan.point_utc) : '—'],
          ['Backup age then', r.backup_age_s == null ? '—' : fmtSpan(r.backup_age_s)],
          ['Restore time', r.restore_ms == null ? '—' : fmtSpan(r.restore_ms / 1000)],
          ['Copy size · free', `${gb(r.needed_bytes)} · ${gb(r.free_bytes)}`]
        ].map(([k, v]) => (
          <div key={k} className='min-w-0 bg-white px-3 py-2 dark:bg-card'>
            <div className='text-[11px] text-muted-foreground'>{k}</div>
            <div className='truncate font-medium tabular-nums'>{v}</div>
          </div>
        ))}
      </div>
      {!!r.plan?.notes.length && (
        <ul className='m-0 mt-2 list-disc space-y-0.5 pl-5 text-[11.5px] text-muted-foreground'>
          {r.plan.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {r.plan?.full && (
        <p className='m-0 mt-2 break-all font-mono text-[11px] text-muted-foreground'>
          {[...r.plan.full.devices, ...(r.plan.diff?.devices ?? [])].join(' · ')}
        </p>
      )}
      {r.smoke && (
        <div className='mt-2 overflow-x-auto'>
          <table className='w-full min-w-[420px] text-[11.5px] tabular-nums'>
            <thead>
              <tr className='text-left text-[10.5px] uppercase tracking-wide text-muted-foreground'>
                <th className='py-0.5 pr-2 font-semibold'>Table</th>
                <th className='py-0.5 pr-2 text-right font-semibold'>Live rows</th>
                <th className='py-0.5 pr-2 text-right font-semibold'>Restored rows</th>
                <th className='py-0.5 text-right font-semibold'>Check</th>
              </tr>
            </thead>
            <tbody>
              {r.smoke.tables.map((t) => {
                const tt: Tone =
                  t.verdict === 'missing' || t.verdict === 'empty'
                    ? 'bad'
                    : t.verdict === 'not_live'
                      ? 'off'
                      : 'ok'
                return (
                  <tr key={t.ref} className='border-t border-slate-100 dark:border-border/60'>
                    <td className='py-0.5 pr-2 font-mono'>{t.ref}</td>
                    <td className='py-0.5 pr-2 text-right'>{formatNumber(t.live_rows)}</td>
                    <td className='py-0.5 pr-2 text-right'>{formatNumber(t.restored_rows)}</td>
                    <td className={cn('py-0.5 text-right', TONE[tt].text)}>
                      {t.verdict === 'ok'
                        ? t.changed
                          ? 'Present (older)'
                          : 'Present'
                        : t.verdict === 'not_live'
                          ? 'Not in live'
                          : t.verdict === 'missing'
                            ? 'Missing'
                            : 'Empty'}
                    </td>
                  </tr>
                )
              })}
              {r.smoke.checksums.map((c) => (
                <tr
                  key={`sum-${c.ref}`}
                  className='border-t border-slate-100 dark:border-border/60'
                >
                  <td className='py-0.5 pr-2 font-mono'>checksum {c.ref}</td>
                  <td className='py-0.5 pr-2 text-right'>{c.live ?? '—'}</td>
                  <td className='py-0.5 pr-2 text-right'>{c.restored ?? '—'}</td>
                  <td className='py-0.5 text-right text-muted-foreground'>
                    {c.match == null ? '—' : c.match ? 'Same' : 'Changed since'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {r.checkdb && (
        <p className={cn('m-0 mt-2 text-[11.5px]', TONE[r.checkdb.ok ? 'ok' : 'bad'].text)}>
          DBCC CHECKDB (physical only):{' '}
          {r.checkdb.ok ? `clean in ${fmtSpan(r.checkdb.ms / 1000)}` : r.checkdb.error}
        </p>
      )}
      {r.mode === 'run' && r.dropped === false && (
        <PartError
          error={`The scratch copy ${r.scratch_db ?? ''} is still on the server: drop it by hand.`}
        />
      )}
    </div>
  )
}

function SettingsPanel({ s }: { s: RecoveryStatus }) {
  const qc = useQueryClient()
  const id = useId()
  const d = s.drill.settings
  const initial = {
    rpo: String(s.targets.rpo_minutes),
    rto: String(s.targets.rto_minutes),
    scratch: d.scratch_db ?? '',
    tables: d.business_tables.join(', '),
    data: d.data_path ?? '',
    log: d.log_path ?? '',
    timeout: String(d.max_restore_minutes),
    runbook: s.runbook_url ?? ''
  }
  const [f, setF] = useState(initial)
  const stamp = JSON.stringify(initial)
  useEffect(() => setF(JSON.parse(stamp)), [stamp])
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch('/telemetry/recovery/settings', patch),
    onSuccess: () => {
      toast.success('Recovery settings saved')
      void qc.invalidateQueries({ queryKey: KEY })
    },
    onError: (err) => {
      toast.error(errorText(err, 'Couldn’t save the recovery settings.'))
      setF(JSON.parse(stamp))
    }
  })
  const field = (
    key: keyof typeof initial,
    label: string,
    hint: string,
    patch: (v: string) => Record<string, unknown>,
    opts: { disabled?: boolean; placeholder?: string; numeric?: boolean } = {}
  ) => (
    <div className='grid content-start gap-1'>
      <label htmlFor={`${id}-${key}`} className='text-[12.5px] font-medium'>
        {label}
      </label>
      <Input
        id={`${id}-${key}`}
        value={f[key]}
        inputMode={opts.numeric ? 'numeric' : undefined}
        placeholder={opts.placeholder}
        disabled={opts.disabled || save.isPending}
        onChange={(e) =>
          setF({
            ...f,
            [key]: opts.numeric ? e.target.value.replace(/[^\d]/g, '') : e.target.value
          })
        }
        onBlur={() => {
          if (f[key] !== initial[key]) save.mutate(patch(f[key].trim()))
        }}
        className='h-8 text-[12.5px]'
      />
      <span className='text-[11.5px] text-muted-foreground'>{hint}</span>
    </div>
  )
  const envNote = (on: boolean, name: string) =>
    on ? `Set by the server’s configuration (${name}).` : null
  const toNum = (v: string) => (v === '' ? undefined : Number(v))
  return (
    <div className='mt-3 grid gap-4 border-t border-slate-100 pt-3 dark:border-border md:grid-cols-2 xl:grid-cols-3'>
      <div className='flex items-start gap-3'>
        <Switch
          id={`${id}-enabled`}
          checked={s.drill.enabled}
          disabled={s.drill.enabled_source === 'env' || s.drill.cloud || save.isPending}
          onCheckedChange={(v) => save.mutate({ restore_drill: { enabled: v } })}
          className='mt-0.5'
        />
        <label htmlFor={`${id}-enabled`} className='grid gap-0.5 text-[12.5px]'>
          <span className='font-medium'>Run the restore drill here (02:30 nightly)</span>
          <span className='text-[11.5px] text-muted-foreground'>
            {s.drill.cloud
              ? 'Not available on cloud instances.'
              : (envNote(s.drill.enabled_source === 'env', 'RESTORE_DRILL') ??
                'Needs CREATE ANY DATABASE and disk for a full copy. Dry run always works.')}
          </span>
        </label>
      </div>
      <div className='flex items-start gap-3'>
        <Switch
          id={`${id}-checkdb`}
          checked={d.checkdb}
          disabled={save.isPending}
          onCheckedChange={(v) => save.mutate({ restore_drill: { checkdb: v } })}
          className='mt-0.5'
        />
        <label htmlFor={`${id}-checkdb`} className='grid gap-0.5 text-[12.5px]'>
          <span className='font-medium'>DBCC CHECKDB on the copy</span>
          <span className='text-[11.5px] text-muted-foreground'>
            Physical checks only. Adds time on a big database.
          </span>
        </label>
      </div>
      {field(
        'rpo',
        'RPO (minutes)',
        envNote(s.targets.source.rpo === 'env', 'RECOVERY_RPO_MINUTES') ??
          `The most data a disaster may lose: ${fmtSpan(Number(f.rpo || 0) * 60)}.`,
        (v) => ({ targets: { rpo_minutes: toNum(v) } }),
        { disabled: s.targets.source.rpo === 'env', numeric: true }
      )}
      {field(
        'rto',
        'RTO (minutes)',
        envNote(s.targets.source.rto === 'env', 'RECOVERY_RTO_MINUTES') ??
          `How long getting back may take: ${fmtSpan(Number(f.rto || 0) * 60)}.`,
        (v) => ({ targets: { rto_minutes: toNum(v) } }),
        { disabled: s.targets.source.rto === 'env', numeric: true }
      )}
      {field(
        'scratch',
        'Scratch database',
        envNote(s.drill.scratch_source === 'env', 'RESTORE_DRILL_DB') ??
          'Must start with nivaro_restore_drill_. It is created and dropped by every drill.',
        (v) => ({ restore_drill: { scratch_db: v || null } }),
        { disabled: s.drill.scratch_source === 'env', placeholder: s.drill.scratch_db }
      )}
      {field(
        'tables',
        'Business tables to count',
        'Comma list, besides the nivaro_ key tables. Each must exist and hold rows in the copy.',
        (v) => ({
          restore_drill: {
            business_tables: v
              .split(/[\s,]+/)
              .map((x) => x.trim())
              .filter(Boolean)
          }
        }),
        { placeholder: 'workflows, dbo.projects' }
      )}
      {field(
        'data',
        'Data folder on the SQL Server',
        'Where the copy’s data files go. Empty = the server’s default.',
        (v) => ({ restore_drill: { data_path: v || null } }),
        { placeholder: 'Server default' }
      )}
      {field(
        'log',
        'Log folder on the SQL Server',
        'Empty = the server’s default log folder.',
        (v) => ({ restore_drill: { log_path: v || null } }),
        { placeholder: 'Server default' }
      )}
      {field(
        'timeout',
        'Restore timeout (minutes)',
        'Per RESTORE step, 5 to 1440.',
        (v) => ({ restore_drill: { max_restore_minutes: toNum(v) } }),
        { numeric: true }
      )}
      {field(
        'runbook',
        'Disaster-recovery runbook link',
        envNote(s.runbook_source === 'env', 'DR_RUNBOOK_URL') ?? 'Shown on this panel when set.',
        (v) => ({ runbook_url: v || null }),
        { disabled: s.runbook_source === 'env', placeholder: 'https://…/docs/disaster-recovery.md' }
      )}
    </div>
  )
}

export function RecoveryPanel() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: KEY,
    queryFn: () =>
      api.get<{ data: RecoveryStatus }>('/telemetry/recovery').then((r) => r.data.data),
    refetchInterval: (query) => {
      const d = query.state.data?.drill
      return d?.running || d?.queued ? 5_000 : 60_000
    }
  })
  const [showLast, setShowLast] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [dry, setDry] = useState<DrillResult | null>(null)

  const run = useMutation({
    mutationFn: () => api.post('/telemetry/restore-drill/run'),
    onSuccess: () => {
      toast.success('Restore drill started. It waits its turn for the heavy-job slot.')
      void qc.invalidateQueries({ queryKey: KEY })
    },
    onError: (err) => toast.error(errorText(err, 'Couldn’t start the restore drill.'))
  })
  const dryRun = useMutation({
    mutationFn: () =>
      api
        .post<{ data: DrillResult }>('/telemetry/restore-drill/run?dry_run=1')
        .then((r) => r.data.data),
    onSuccess: (r) => setDry(r),
    onError: (err) => toast.error(errorText(err, 'Couldn’t run the dry run.'))
  })

  const s = q.data
  if (q.isLoading)
    return <Skeleton className='h-[320px] rounded-lg' role='status' aria-label='Loading recovery' />
  if (!s)
    return (
      <Card title='Disaster recovery' icon={LifeBuoy}>
        <PartError error='The recovery status could not be read. Try Refresh in a moment.' />
      </Card>
    )

  const busy = !!s.drill.running || s.drill.queued
  const runBlock = s.drill.cloud
    ? 'Not available on cloud instances'
    : !s.drill.enabled
      ? 'The drill is off here. Turn it on in the settings below, or use Dry run.'
      : s.drill.scratch_refusal
        ? `Scratch database refused: ${s.drill.scratch_refusal}`
        : busy
          ? 'A drill is already running'
          : null
  const bad = s.rows.filter((r) => r.tone === 'bad').length
  const warn = s.rows.filter((r) => r.tone === 'warn').length

  return (
    <Card
      title='Disaster recovery'
      icon={LifeBuoy}
      aside={`${bad ? `${bad} red · ` : warn ? `${warn} amber · ` : ''}RPO ${fmtSpan(s.targets.rpo_minutes * 60)} · RTO ${fmtSpan(s.targets.rto_minutes * 60)}`}
      asideTone={s.tone === 'ok' ? 'off' : s.tone}
    >
      <ul className='m-0 -mt-2 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
        {s.rows.map((r) => (
          <RowItem key={r.key} row={r} />
        ))}
      </ul>

      <div className='mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-border'>
        <span data-tip={runBlock ?? undefined}>
          <Button
            size='sm'
            variant='outline'
            onClick={() => run.mutate()}
            disabled={!!runBlock || run.isPending}
            className='h-8 text-[12.5px] [&_svg]:size-3.5'
          >
            {run.isPending ? (
              <Loader2 className='animate-spin' aria-hidden='true' />
            ) : (
              <Play aria-hidden='true' />
            )}
            Run restore drill
          </Button>
        </span>
        <span data-tip='Reads msdb and RESTORE FILELISTONLY only: restores nothing'>
          <Button
            size='sm'
            variant='outline'
            onClick={() => dryRun.mutate()}
            disabled={dryRun.isPending || s.drill.cloud}
            className='h-8 text-[12.5px] [&_svg]:size-3.5'
          >
            {dryRun.isPending ? (
              <Loader2 className='animate-spin' aria-hidden='true' />
            ) : (
              <FlaskConical aria-hidden='true' />
            )}
            Dry run
          </Button>
        </span>
        {(s.drill.running || s.drill.queued) && (
          <span
            role='status'
            className='inline-flex items-center gap-1.5 text-[12px] text-muted-foreground'
          >
            <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden='true' />
            {s.drill.running
              ? `Running since ${formatRelative(s.drill.running.since)}${s.drill.running.phase ? ` · ${s.drill.running.phase}` : ''}`
              : 'Waiting for the heavy-job slot'}
          </span>
        )}
        <div className='ml-auto flex flex-wrap items-center gap-3'>
          <History runs={s.drill.history} />
          {s.runbook_url && (
            <a
              href={s.runbook_url}
              target='_blank'
              rel='noopener noreferrer'
              className='inline-flex items-center gap-1 text-[12.5px] text-nvr-cyan hover:underline'
            >
              Disaster-recovery runbook
              <ArrowUpRight className='h-3.5 w-3.5' aria-hidden='true' />
            </a>
          )}
        </div>
      </div>
      <PartError error={s.drill.error} />

      {dry && <DrillDetail r={dry} title='Dry run' />}

      <div className='mt-3 flex flex-wrap gap-x-4 gap-y-1'>
        {s.drill.last && (
          <button
            type='button'
            onClick={() => setShowLast((v) => !v)}
            aria-expanded={showLast}
            className='inline-flex items-center gap-1 rounded text-[12px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
          >
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', showLast && 'rotate-180')}
              aria-hidden='true'
            />
            What the last drill checked
          </button>
        )}
        <button
          type='button'
          onClick={() => setShowSettings((v) => !v)}
          aria-expanded={showSettings}
          className='inline-flex items-center gap-1 rounded text-[12px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          <SlidersHorizontal className='h-3.5 w-3.5' aria-hidden='true' />
          Targets and drill settings
        </button>
      </div>
      {showLast && s.drill.last && <DrillDetail r={s.drill.last} title='Last restore drill' />}
      {showSettings && <SettingsPanel s={s} />}
    </Card>
  )
}
