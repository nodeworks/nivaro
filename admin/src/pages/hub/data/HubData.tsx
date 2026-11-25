import { ConfirmButton, ErrorNotice, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ChevronLeft,
  DatabaseBackup,
  FolderArchive,
  History,
  Loader2,
  ShieldCheck
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { HubEnvTag } from '@/components/hub-brand/HubBits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { hubError } from '../hub-api'
import {
  countLabel,
  dangerArmed,
  Field,
  ghostButton,
  ListPaneHeader,
  listPaneClass,
  SecretInput,
  SectionCard
} from '../hub-parts'
import { RefreshCard, RehearsalCard, RunsCard } from './DataOps'
import {
  ago,
  type BackupPolicy,
  backupAge,
  type DataEnvRow,
  type DataGate,
  type DataRun,
  type DataRunKind,
  dataKeys,
  describeCron,
  type EnvDataView,
  KIND_LABEL,
  useDataEnvs,
  useEnvData
} from './data-api'

/**
 * Data (Apps hub tab, administrators): per environment, the Hub's database backups (SQL
 * Server, through the server's own BACKUP), files backups (the app copies its files to a
 * folder or a bucket), restore drills, refreshes from a higher environment and move rehearsals.
 * For a database the Hub cannot back up itself, the DBA checklist and the last backup seen.
 */
export default function HubData() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  if (!isAdmin)
    return (
      <div className='flex flex-1 items-center justify-center bg-slate-50 p-8 text-center dark:bg-background'>
        <p className='m-0 max-w-[48ch] text-[13px] text-slate-600 dark:text-muted-foreground'>
          Only administrators manage backups, refreshes and rehearsals.
        </p>
      </div>
    )
  return <DataAdmin />
}

const AGE_TONE = {
  fresh: 'text-emerald-700 dark:text-emerald-400',
  late: 'text-amber-700 dark:text-amber-400',
  stale: 'text-red-700 dark:text-red-400',
  none: 'text-amber-700 dark:text-amber-400'
} as const

const BAD_DRILL = new Set(['failed', 'refused', 'interrupted'])
const OPEN = new Set(['running', 'waiting', 'interrupted'])

function newestOf(r: DataEnvRow): string | null {
  return (
    [r.last.db_backup, r.last.backup_seen]
      .filter((x): x is string => !!x)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null
  )
}

function DataAdmin() {
  const envs = useDataEnvs()
  const [params, setParams] = useSearchParams()
  const envId = Number(params.get('env')) || null
  const pick = (id: number | null) =>
    setParams((p) => {
      const out = new URLSearchParams(p)
      if (id) out.set('env', String(id))
      else out.delete('env')
      return out
    })

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      <aside className={cn(listPaneClass, envId ? 'hidden' : 'flex')}>
        <ListPaneHeader label={countLabel(envs.data?.length, 'environment', 'environments')} />
        {envs.isPending ? (
          <div className='space-y-2 p-3'>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className='h-12 w-full' />
            ))}
          </div>
        ) : envs.isError ? (
          <QueryErrorState
            error={envs.error}
            what='the environments'
            onRetry={() => void envs.refetch()}
            className='m-3'
          />
        ) : envs.data.length === 0 ? (
          <p className='m-0 px-4 py-6 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
            No environments yet. Add an app on the Apps tab first.
          </p>
        ) : (
          <ul className='m-0 list-none space-y-0.5 p-2'>
            {envs.data.map((r) => {
              const newest = newestOf(r)
              const age = backupAge(newest)
              return (
                <li key={r.env_id}>
                  <button
                    type='button'
                    onClick={() => pick(r.env_id)}
                    aria-current={r.env_id === envId ? 'true' : undefined}
                    className={cn(
                      'w-full rounded-md px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                      r.env_id === envId ? 'bg-accent' : 'hover:bg-muted'
                    )}
                  >
                    <span className='block truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
                      {r.app_name}{' '}
                      <span className='font-normal text-slate-500 dark:text-muted-foreground'>
                        / {r.env_key}
                      </span>
                      <HubEnvTag envKey={r.env_key} className='ml-1 align-[1px]' />
                    </span>
                    <span className='mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px]'>
                      <span className={AGE_TONE[age]}>
                        {newest ? `Hub backup ${ago(newest)}` : 'No Hub backup'}
                      </span>
                      {r.policy.db && (
                        <span className='text-slate-500 dark:text-muted-foreground'>
                          · scheduled
                        </span>
                      )}
                      {r.drill ? (
                        BAD_DRILL.has(r.drill.status) ? (
                          <span className='inline-flex items-center gap-1 text-red-700 dark:text-red-400'>
                            <AlertTriangle className='h-3 w-3' aria-hidden /> drill {r.drill.status}{' '}
                            {ago(r.drill.at)}
                          </span>
                        ) : r.drill.status === 'done' ? (
                          <span className='text-slate-500 dark:text-muted-foreground'>
                            · drilled {ago(r.drill.at)}
                          </span>
                        ) : null
                      ) : null}
                      {r.open && OPEN.has(r.open.status) && (
                        <span className='inline-flex items-center gap-1 text-sky-700 dark:text-sky-400'>
                          <Loader2
                            className='h-3 w-3 animate-spin motion-reduce:animate-none'
                            aria-hidden
                          />
                          {KIND_LABEL[r.open.kind].toLowerCase()} {r.open.status}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <SwitchesPanel />
      </aside>
      <div
        className={cn(
          'min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background',
          envId ? 'block' : 'hidden md:block'
        )}
      >
        {envId ? (
          <>
            <div className='border-b border-slate-200 bg-white px-2 py-1.5 md:hidden dark:border-border dark:bg-card'>
              <button type='button' className={ghostButton} onClick={() => pick(null)}>
                <ChevronLeft className='h-3.5 w-3.5' aria-hidden /> All environments
              </button>
            </div>
            <EnvDataPanel key={envId} envId={envId} />
          </>
        ) : (
          <div className='flex h-full flex-col items-center justify-center p-8 text-center'>
            <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
              <DatabaseBackup
                className='h-5 w-5 text-slate-400 dark:text-muted-foreground'
                aria-hidden
              />
            </div>
            <p className='mt-3 mb-0 text-[13px] font-medium text-slate-700 dark:text-foreground'>
              Pick an environment
            </p>
            <p className='m-0 mt-1 max-w-[46ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
              See when its database and files were last backed up, set a schedule, run a restore
              drill, refresh it from a higher environment or rehearse a move.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

const SWITCHES: Array<{ key: keyof DataGate; label: string }> = [
  { key: 'refresh_enabled', label: 'Refreshes' },
  { key: 'drill_enabled', label: 'Restore drills' },
  { key: 'rehearsal_enabled', label: 'Move rehearsals' }
]

/**
 * The Hub-wide switches: refreshes, drills and rehearsals restore databases on live servers, so
 * they are off until an administrator turns them on (two presses; turning off is one).
 */
function SwitchesPanel() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['hub', 'data', 'switches'] as const,
    queryFn: () =>
      api
        .get<{ data: DataGate & { warning: string } }>('/hub/data/switches')
        .then((r) => r.data.data)
  })
  const save = useMutation({
    mutationFn: (patch: Partial<DataGate>) => api.put('/hub/data/switches', patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hub', 'data'] })
    }
  })
  if (!q.data) return null
  const g = q.data
  return (
    <section className='mt-auto border-t border-slate-200 p-3 dark:border-border'>
      <h3 className='m-0 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
        Switches
      </h3>
      <p className='m-0 mt-0.5 text-[11px] text-amber-700 dark:text-amber-400'>{g.warning}</p>
      <ul className='m-0 mt-2 list-none space-y-1.5 p-0'>
        {SWITCHES.map((sw) => (
          <li key={sw.key} className='flex items-center justify-between gap-2 text-[12px]'>
            <span className='text-slate-700 dark:text-foreground'>
              {sw.label}{' '}
              <span
                className={
                  g[sw.key]
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-slate-500 dark:text-muted-foreground'
                }
              >
                {g[sw.key] ? 'on' : 'off'}
              </span>
            </span>
            {g[sw.key] ? (
              <button
                type='button'
                className={ghostButton}
                disabled={save.isPending}
                onClick={() => save.mutate({ [sw.key]: false })}
              >
                Turn off
              </button>
            ) : (
              <ConfirmButton
                title={`Turn ${sw.label.toLowerCase()} on`}
                confirmLabel='Turn on?'
                className={ghostButton}
                armedClassName={dangerArmed}
                disabled={save.isPending}
                onConfirm={() => save.mutate({ [sw.key]: true })}
              >
                Turn on
              </ConfirmButton>
            )}
          </li>
        ))}
      </ul>
      {save.isError && <ErrorNotice description={hubError(save.error, 'Could not change it')} />}
    </section>
  )
}

function EnvDataPanel({ envId }: { envId: number }) {
  const q = useEnvData(envId)
  if (q.isPending)
    return (
      <div className='space-y-3 p-4'>
        <Skeleton className='h-24 w-full' />
        <Skeleton className='h-48 w-full' />
      </div>
    )
  if (q.isError)
    return (
      <QueryErrorState
        error={q.error}
        what='this environment’s data care'
        onRetry={() => void q.refetch()}
        className='m-4'
      />
    )
  const v = q.data
  return (
    <div className='space-y-4 p-4 sm:p-6'>
      <header>
        <h2 className='m-0 text-[18px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
          {v.app.name} / {v.environment.key}
          {v.environment.production && (
            <span className='ml-2 rounded border border-orange-300 bg-orange-50 px-1.5 py-px align-middle text-[11px] font-medium text-orange-800 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300'>
              Production
            </span>
          )}
        </h2>
        <p className='m-0 mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
          {v.database
            ? `${v.database.database_name} (${v.database.engine})${v.server ? ` on ${v.server.name}, ${v.server.provision_mode} server` : ''}`
            : 'No Hub database record: attach one on the Databases tab.'}
        </p>
      </header>
      <OpenRunStrip v={v} />
      <BackupStatusCard v={v} />
      <PolicyCard v={v} />
      <RefreshCard v={v} />
      <RehearsalCard v={v} />
      <RunsCard envId={envId} />
    </div>
  )
}

function useStart(envId: number, path: string, done: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown> = {}) =>
      api
        .post<{ data: { run_id: number } }>(`/hub/environments/${envId}/data/${path}`, body)
        .then((r) => r.data.data),
    onSuccess: () => {
      toast.success(done)
      void qc.invalidateQueries({ queryKey: dataKeys.env(envId) })
      void qc.invalidateQueries({ queryKey: dataKeys.runs(envId) })
      void qc.invalidateQueries({ queryKey: dataKeys.envs() })
    }
  })
}

function Row({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className='bg-white px-3 py-2 dark:bg-card'>
      <dt className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</dt>
      <dd className={cn('m-0 mt-0.5 text-[13px] text-slate-900 dark:text-foreground', tone)}>
        {value}
      </dd>
    </div>
  )
}

/** The newest run still open on this environment (running, waiting or interrupted). */
function openRun(v: EnvDataView): DataRun | null {
  return (
    Object.values(v.latest)
      .filter((r): r is DataRun => !!r && OPEN.has(r.status))
      .sort((a, b) => b.id - a.id)[0] ?? null
  )
}

function OpenRunStrip({ v }: { v: EnvDataView }) {
  const r = openRun(v)
  if (!r) return null
  const i = r.steps.findIndex((s) => s.state === 'running' || s.state === 'failed')
  const at = i >= 0 ? i + 1 : r.steps.filter((s) => s.state !== 'pending').length
  const interrupted = r.status === 'interrupted'
  return (
    <a
      href='#data-history'
      className={cn(
        'flex items-center gap-2 rounded-md border px-3 py-2 text-[12px] no-underline',
        interrupted
          ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
          : 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200'
      )}
    >
      {interrupted ? (
        <AlertTriangle className='h-3.5 w-3.5 shrink-0' aria-hidden />
      ) : (
        <Loader2
          className='h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none'
          aria-hidden
        />
      )}
      <span className='min-w-0 flex-1'>
        {KIND_LABEL[r.kind]} #{r.id} {interrupted ? 'was interrupted' : 'is running'}
        {r.steps.length ? ` · step ${Math.max(1, at)} of ${r.steps.length}` : ''}
        {r.step ? ` (${r.steps.find((s) => s.key === r.step)?.label ?? r.step})` : ''}
      </span>
      <span className='shrink-0 underline underline-offset-2'>See it in History</span>
    </a>
  )
}

/** A start button: a spinner while it is asked, off (with the reason as a tip) when it cannot. */
function StartButton({
  onClick,
  pending,
  blocked,
  icon,
  children,
  primary
}: {
  onClick: () => void
  pending: boolean
  blocked: string | null
  icon: ReactNode
  children: ReactNode
  primary?: boolean
}) {
  const btn = (
    <Button
      size='sm'
      variant={primary ? 'default' : 'outline'}
      disabled={pending || !!blocked}
      onClick={onClick}
    >
      {pending ? (
        <Loader2 className='h-3.5 w-3.5 animate-spin motion-reduce:animate-none' aria-hidden />
      ) : (
        icon
      )}
      {children}
    </Button>
  )
  // A disabled button gets no hover: the tip sits on a wrapper.
  return blocked ? (
    <span data-tip={blocked} className='relative inline-flex'>
      {btn}
      <span className='sr-only'>{blocked}</span>
    </span>
  ) : (
    btn
  )
}

function BackupStatusCard({ v }: { v: EnvDataView }) {
  const envId = v.environment.id
  const backup = useStart(envId, 'backup', 'Database backup started')
  const drill = useStart(envId, 'drill', 'Restore drill started')
  const files = useStart(envId, 'files-backup', 'Files backup started')
  const seen = useStart(envId, 'backup-seen', 'Backup recorded')
  const [note, setNote] = useState('')
  const s = v.last_seen
  const newest = s?.newest_at ?? null
  const failure = [backup, drill, files, seen].find((m) => m.isError)?.error
  const busy = (kind: DataRunKind) => {
    const r = v.latest[kind]
    return r && OPEN.has(r.status) ? `${KIND_LABEL[kind]} #${r.id} is ${r.status}` : null
  }
  const notNative = v.native
    ? null
    : 'The Hub can only back up SQL Server databases with a stored server login.'
  const lastDrill = v.latest.restore_drill
  const drillBad = !!lastDrill && BAD_DRILL.has(lastDrill.status)
  return (
    <SectionCard
      title='Backups'
      description={
        v.native
          ? 'The Hub asks the database server for copy-only backups (they never break the DBA’s own backup chain).'
          : (v.reason ?? 'The Hub cannot back up this database itself.')
      }
      actions={
        <>
          <StartButton
            primary
            pending={backup.isPending}
            blocked={notNative ?? busy('db_backup')}
            onClick={() => backup.mutate({})}
            icon={<DatabaseBackup className='h-3.5 w-3.5' aria-hidden />}
          >
            Back up now
          </StartButton>
          <StartButton
            pending={drill.isPending}
            blocked={
              v.gate.drill_enabled
                ? (notNative ?? busy('restore_drill'))
                : 'Restore drills are switched off on this Hub (Switches).'
            }
            onClick={() => drill.mutate({})}
            icon={<ShieldCheck className='h-3.5 w-3.5' aria-hidden />}
          >
            Run a restore drill
          </StartButton>
          <StartButton
            pending={files.isPending}
            blocked={
              v.policy.files_target
                ? busy('files_backup')
                : 'Set a files target under Schedule and retention first.'
            }
            onClick={() => files.mutate({})}
            icon={<FolderArchive className='h-3.5 w-3.5' aria-hidden />}
          >
            Back up files
          </StartButton>
        </>
      }
    >
      <div className='space-y-3 p-4'>
        <dl className='m-0 grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-3 dark:border-border dark:bg-border'>
          <Row
            label='Newest backup seen'
            value={newest ? ago(newest) : 'none seen'}
            tone={AGE_TONE[backupAge(newest)]}
          />
          <Row
            label='Last full (server history)'
            value={
              s?.full_at
                ? ago(s.full_at)
                : s?.source === 'pg_archiver'
                  ? `WAL archived ${ago(s.archived_at)}`
                  : '—'
            }
          />
          <Row label='Last Hub backup' value={ago(s?.hub_at)} />
          <Row label='Last log backup' value={s?.log_at ? ago(s.log_at) : '—'} />
          <Row label='Last files backup' value={ago(v.latest.files_backup?.finished_at)} />
          <Row
            label='Last restore drill'
            tone={drillBad ? 'text-red-700 dark:text-red-400' : undefined}
            value={
              lastDrill ? (
                <span className='inline-flex items-center gap-1'>
                  {drillBad && <AlertTriangle className='h-3.5 w-3.5' aria-hidden />}
                  {ago(lastDrill.started_at)} · {lastDrill.status}
                </span>
              ) : (
                'never'
              )
            }
          />
        </dl>
        {s?.error && (
          <p className='m-0 text-[12px] text-amber-700 dark:text-amber-400'>{s.error}</p>
        )}
        {failure != null && <ErrorNotice description={hubError(failure, 'Could not start')} />}
        {!v.native && (
          <div className='rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-muted/40'>
            <p className='m-0 text-[12px] font-medium text-slate-700 dark:text-foreground'>
              For the DBA
            </p>
            <dl className='m-0 mt-2 grid gap-x-4 gap-y-1 text-[12px] sm:grid-cols-[160px_1fr]'>
              {v.checklist.map((c) => (
                <div key={c.label} className='contents'>
                  <dt className='text-slate-500 dark:text-muted-foreground'>{c.label}</dt>
                  <dd className='m-0 text-slate-900 [overflow-wrap:anywhere] dark:text-foreground'>
                    {c.value}
                  </dd>
                </div>
              ))}
            </dl>
            <div className='mt-3 flex flex-wrap items-end gap-2'>
              <div className='min-w-[220px] flex-1'>
                <Field
                  id='seen-note'
                  label='Record a backup the DBA took'
                  hint='Saved with your name and now as its time.'
                >
                  <Input
                    id='seen-note'
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder='Where it went (optional)'
                    className='h-8 text-[13px]'
                  />
                </Field>
              </div>
              <StartButton
                pending={seen.isPending}
                blocked={null}
                onClick={() => seen.mutate({ note }, { onSuccess: () => setNote('') })}
                icon={<History className='h-3.5 w-3.5' aria-hidden />}
              >
                Record backup
              </StartButton>
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  )
}

interface PolicyDraft {
  db_enabled: boolean
  db_schedule: string
  db_path: string
  db_keep_days: string
  db_keep_count: string
  db_verify: boolean
  files_enabled: boolean
  files_schedule: string
  kind: 'dir' | 's3'
  path: string
  bucket: string
  prefix: string
  region: string
  endpoint: string
  access_key_id: string
  secret_access_key: string
  files_keep_count: string
  drill_enabled: boolean
  drill_schedule: string
  drill_checkdb: boolean
}

function draftOf(p: BackupPolicy): PolicyDraft {
  const t = p.files_target
  const mask = p.target_secret ?? ''
  return {
    db_enabled: p.db_enabled,
    db_schedule: p.db_schedule ?? '0 2 * * *',
    db_path: p.db_path ?? '',
    db_keep_days: p.db_keep_days?.toString() ?? '',
    db_keep_count: p.db_keep_count?.toString() ?? '',
    db_verify: p.db_verify,
    files_enabled: p.files_enabled,
    files_schedule: p.files_schedule ?? '0 3 * * *',
    kind: t?.kind ?? 'dir',
    path: t?.kind === 'dir' ? t.path : '',
    bucket: t?.kind === 's3' ? t.bucket : '',
    prefix: t?.kind === 's3' ? t.prefix : '',
    region: t?.kind === 's3' ? (t.region ?? '') : '',
    endpoint: t?.kind === 's3' ? (t.endpoint ?? '') : '',
    access_key_id: mask,
    secret_access_key: mask,
    files_keep_count: p.files_keep_count?.toString() ?? '',
    drill_enabled: p.drill_enabled,
    drill_schedule: p.drill_schedule ?? '0 4 * * 0',
    drill_checkdb: p.drill_checkdb
  }
}

function bodyOf(d: PolicyDraft, stored: BackupPolicy): Record<string, unknown> {
  const hasTarget = d.kind === 'dir' ? !!d.path.trim() : !!d.bucket.trim()
  const target = !hasTarget
    ? null
    : d.kind === 'dir'
      ? { kind: 'dir', path: d.path.trim() }
      : {
          kind: 's3',
          bucket: d.bucket.trim(),
          prefix: d.prefix.trim(),
          region: d.region.trim() || null,
          endpoint: d.endpoint.trim() || null
        }
  const secretUnchanged =
    stored.target_secret &&
    d.access_key_id === stored.target_secret &&
    d.secret_access_key === stored.target_secret
  return {
    db_enabled: d.db_enabled,
    db_schedule: d.db_schedule.trim() || null,
    db_path: d.db_path.trim() || null,
    db_keep_days: d.db_keep_days.trim() || null,
    db_keep_count: d.db_keep_count.trim() || null,
    db_verify: d.db_verify,
    files_enabled: d.files_enabled,
    files_schedule: d.files_schedule.trim() || null,
    files_target: target,
    ...(d.kind === 's3' && !secretUnchanged
      ? {
          target_secret:
            d.access_key_id || d.secret_access_key
              ? { access_key_id: d.access_key_id, secret_access_key: d.secret_access_key }
              : null
        }
      : {}),
    files_keep_count: d.files_keep_count.trim() || null,
    drill_enabled: d.drill_enabled,
    drill_schedule: d.drill_schedule.trim() || null,
    drill_checkdb: d.drill_checkdb
  }
}

function Toggle({
  id,
  label,
  checked,
  onChange
}: {
  id: string
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label
      htmlFor={id}
      className='flex items-center gap-2 text-[12px] font-medium text-slate-700 dark:text-foreground'
    >
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  )
}

function PolicyCard({ v }: { v: EnvDataView }) {
  const qc = useQueryClient()
  const [d, setD] = useState(() => draftOf(v.policy))
  useEffect(() => setD(draftOf(v.policy)), [v.policy])
  const set = (p: Partial<PolicyDraft>) => setD((x) => ({ ...x, ...p }))
  const save = useMutation({
    mutationFn: () =>
      api.put(`/hub/environments/${v.environment.id}/data/policy`, bodyOf(d, v.policy)),
    onSuccess: () => {
      toast.success('Backup policy saved')
      void qc.invalidateQueries({ queryKey: dataKeys.env(v.environment.id) })
      void qc.invalidateQueries({ queryKey: dataKeys.envs() })
    }
  })
  const id = (k: string) => `pol-${v.environment.id}-${k}`
  const stored = useMemo(() => JSON.stringify(draftOf(v.policy)), [v.policy])
  const dirty = JSON.stringify(d) !== stored
  const saveButton = (
    <Button size='sm' disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
      {save.isPending && (
        <Loader2 className='h-3.5 w-3.5 animate-spin motion-reduce:animate-none' aria-hidden />
      )}
      Save
    </Button>
  )
  return (
    <SectionCard
      title='Schedule and retention'
      description='Schedules are cron expressions in UTC (minute hour day month weekday), at least an hour apart.'
      actions={
        <>
          {dirty && (
            <span className='text-[12px] text-amber-700 dark:text-amber-400'>Unsaved changes</span>
          )}
          {saveButton}
        </>
      }
    >
      <div className='grid gap-5 p-4 lg:grid-cols-3'>
        <fieldset className='m-0 min-w-0 space-y-3 border-0 p-0'>
          <Toggle
            id={id('db')}
            label='Database backups'
            checked={d.db_enabled}
            onChange={(x) => set({ db_enabled: x })}
          />
          <Field id={id('dbs')} label='Schedule' hint={describeCron(d.db_schedule)}>
            <Input
              id={id('dbs')}
              value={d.db_schedule}
              onChange={(e) => set({ db_schedule: e.target.value })}
              className='h-8 font-mono text-[13px]'
            />
          </Field>
          <Field
            id={id('dbp')}
            label='Folder on the database server'
            hint='Empty = the server’s default backup folder. A UNC share keeps copies off the server.'
          >
            <Input
              id={id('dbp')}
              value={d.db_path}
              onChange={(e) => set({ db_path: e.target.value })}
              placeholder='\\backup01\sql\hub'
              className='h-8 font-mono text-[13px]'
            />
          </Field>
          <div className='grid grid-cols-2 gap-2'>
            <Field id={id('dbc')} label='Keep backups' hint='Newest N kept.'>
              <Input
                id={id('dbc')}
                inputMode='numeric'
                value={d.db_keep_count}
                onChange={(e) => set({ db_keep_count: e.target.value })}
                placeholder='7'
                className='h-8 text-[13px]'
              />
            </Field>
            <Field id={id('dbd')} label='Or days' hint='Either rule deletes.'>
              <Input
                id={id('dbd')}
                inputMode='numeric'
                value={d.db_keep_days}
                onChange={(e) => set({ db_keep_days: e.target.value })}
                className='h-8 text-[13px]'
              />
            </Field>
          </div>
          <Toggle
            id={id('dbv')}
            label='Verify each backup'
            checked={d.db_verify}
            onChange={(x) => set({ db_verify: x })}
          />
        </fieldset>
        <fieldset className='m-0 min-w-0 space-y-3 border-0 border-t border-slate-200 p-0 pt-4 lg:border-t-0 lg:pt-0 dark:border-border'>
          <Toggle
            id={id('f')}
            label='Files backups'
            checked={d.files_enabled}
            onChange={(x) => set({ files_enabled: x })}
          />
          <Field id={id('fs')} label='Schedule' hint={describeCron(d.files_schedule)}>
            <Input
              id={id('fs')}
              value={d.files_schedule}
              onChange={(e) => set({ files_schedule: e.target.value })}
              className='h-8 font-mono text-[13px]'
            />
          </Field>
          <Field
            id={id('fk')}
            label='Where'
            hint={
              d.kind === 's3'
                ? 'The app must list the bucket in HUB_FILES_BACKUP_S3.'
                : 'The app must list the folder (or a parent) in HUB_FILES_BACKUP_DIRS.'
            }
          >
            <SimpleSelect
              value={d.kind}
              onChange={(x) => set({ kind: x as 'dir' | 's3' })}
              ariaLabel='Files backup target'
              className='h-8 text-[13px]'
              options={[
                { value: 'dir', label: 'A folder on the app’s host' },
                { value: 's3', label: 'An S3 bucket' }
              ]}
            />
          </Field>
          {d.kind === 'dir' ? (
            <Field id={id('fp')} label='Folder'>
              <Input
                id={id('fp')}
                value={d.path}
                onChange={(e) => set({ path: e.target.value })}
                placeholder='/backups/nivaro'
                className='h-8 font-mono text-[13px]'
              />
            </Field>
          ) : (
            <>
              <div className='grid grid-cols-2 gap-2'>
                <Field id={id('fb')} label='Bucket'>
                  <Input
                    id={id('fb')}
                    value={d.bucket}
                    onChange={(e) => set({ bucket: e.target.value })}
                    className='h-8 text-[13px]'
                  />
                </Field>
                <Field id={id('fx')} label='Prefix'>
                  <Input
                    id={id('fx')}
                    value={d.prefix}
                    onChange={(e) => set({ prefix: e.target.value })}
                    className='h-8 text-[13px]'
                  />
                </Field>
                <Field id={id('fr')} label='Region'>
                  <Input
                    id={id('fr')}
                    value={d.region}
                    onChange={(e) => set({ region: e.target.value })}
                    placeholder='us-east-1'
                    className='h-8 text-[13px]'
                  />
                </Field>
                <Field id={id('fe')} label='Endpoint (optional)'>
                  <Input
                    id={id('fe')}
                    value={d.endpoint}
                    onChange={(e) => set({ endpoint: e.target.value })}
                    placeholder='https://…'
                    className='h-8 text-[13px]'
                  />
                </Field>
              </div>
              <Field id={id('fa')} label='Access key id'>
                <SecretInput
                  id={id('fa')}
                  value={d.access_key_id}
                  onChange={(x) => set({ access_key_id: x })}
                  stored={!!v.policy.target_secret}
                />
              </Field>
              <Field id={id('fz')} label='Secret access key'>
                <SecretInput
                  id={id('fz')}
                  value={d.secret_access_key}
                  onChange={(x) => set({ secret_access_key: x })}
                  stored={!!v.policy.target_secret}
                />
              </Field>
            </>
          )}
          <Field id={id('fc')} label='Keep sets'>
            <Input
              id={id('fc')}
              inputMode='numeric'
              value={d.files_keep_count}
              onChange={(e) => set({ files_keep_count: e.target.value })}
              placeholder='3'
              className='h-8 text-[13px]'
            />
          </Field>
        </fieldset>
        <fieldset className='m-0 min-w-0 space-y-3 border-0 border-t border-slate-200 p-0 pt-4 lg:border-t-0 lg:pt-0 dark:border-border'>
          <Toggle
            id={id('d')}
            label='Restore drills'
            checked={d.drill_enabled}
            onChange={(x) => set({ drill_enabled: x })}
          />
          <Field
            id={id('ds')}
            label='Schedule'
            hint={`${describeCron(d.drill_schedule)}. Restores the newest backup into a scratch database, checks it and drops it.`}
          >
            <Input
              id={id('ds')}
              value={d.drill_schedule}
              onChange={(e) => set({ drill_schedule: e.target.value })}
              className='h-8 font-mono text-[13px]'
            />
          </Field>
          <Toggle
            id={id('dc')}
            label='Consistency check (DBCC CHECKDB)'
            checked={d.drill_checkdb}
            onChange={(x) => set({ drill_checkdb: x })}
          />
        </fieldset>
      </div>
      {save.isError && (
        <div className='px-4 pb-4'>
          <ErrorNotice description={hubError(save.error, 'Could not save the policy')} />
        </div>
      )}
      {dirty && <div className='flex justify-end px-4 pb-4 lg:hidden'>{saveButton}</div>}
    </SectionCard>
  )
}
