import { QueryErrorState, toastError } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, AlertTriangle, ArrowUpRight, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { ghostButton, StatusChip } from '../hub-parts'
import { FleetSettingsCard } from './FleetSettingsCard'
import { checkFleetNow, type FleetRow, fetchFleet, fleetKeys, pct } from './fleet-api'
import { UptimeSheet } from './UptimeSheet'

/**
 * Fleet (Apps hub tab): every app × environment on one screen — version and how far behind the
 * newest, health, readiness, open issues, uptime and this month's SLO, the last Hub deploy, shared
 * or dedicated placement and open drift alerts. Read from the Hub's own tables (the probe job
 * refreshes them every minute); nothing here makes the Hub call an app. Admins also get Check now
 * and the alert rules / SLO targets below the table.
 */

type Health = 'any' | 'attention' | 'down' | 'alerts'
type Sort = 'app' | 'behind' | 'uptime' | 'deploy' | 'readiness'

const SORT_OPTIONS = [
  { value: 'app', label: 'App and environment' },
  { value: 'behind', label: 'Most releases behind' },
  { value: 'uptime', label: 'Lowest uptime (30 days)' },
  { value: 'deploy', label: 'Longest since a deploy' },
  { value: 'readiness', label: 'Lowest readiness' }
]

const needsAttention = (r: FleetRow) =>
  r.up === false || (r.state != null && r.state !== 'ok') || r.alerts.length > 0

function compare(sort: Sort) {
  const nullsLast = (a: number | null, b: number | null, dir: 1 | -1) =>
    a == null ? (b == null ? 0 : 1) : b == null ? -1 : (a - b) * dir
  const byApp = (a: FleetRow, b: FleetRow) =>
    a.app_key.localeCompare(b.app_key) ||
    a.position - b.position ||
    a.environment_id - b.environment_id
  return (a: FleetRow, b: FleetRow) => {
    let d = 0
    if (sort === 'behind') d = nullsLast(a.behind, b.behind, -1)
    else if (sort === 'uptime') d = nullsLast(a.uptime_30d, b.uptime_30d, 1)
    else if (sort === 'readiness') d = nullsLast(a.readiness_score, b.readiness_score, 1)
    else if (sort === 'deploy')
      d = nullsLast(
        a.deployed_at ? new Date(a.deployed_at).getTime() : null,
        b.deployed_at ? new Date(b.deployed_at).getTime() : null,
        1
      )
    return d || byApp(a, b)
  }
}

export default function HubFleet() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const navigate = useNavigate()
  const qc = useQueryClient()
  const fleet = useQuery({
    queryKey: fleetKeys.fleet(),
    queryFn: fetchFleet,
    staleTime: 30_000,
    refetchInterval: 60_000
  })
  const [q, setQ] = useState('')
  const [app, setApp] = useState('')
  const [placement, setPlacement] = useState('')
  const [health, setHealth] = useState<Health>('any')
  const [sort, setSort] = useState<Sort>('app')
  const [uptimeOf, setUptimeOf] = useState<FleetRow | null>(null)

  const check = useMutation({
    mutationFn: checkFleetNow,
    onSuccess: (d) => {
      toast.success(
        `Checked ${d.probe.probed} environment${d.probe.probed === 1 ? '' : 's'}${d.probe.down ? ` — ${d.probe.down} not answering` : ''}`
      )
      void qc.invalidateQueries({ queryKey: fleetKeys.fleet() })
    },
    onError: (e) => toastError(e, 'Could not check the fleet')
  })

  const rows = fleet.data?.rows ?? []
  const apps = useMemo(() => {
    const m = new Map<number, string>()
    for (const r of rows) m.set(r.app_id, r.app_name)
    return [...m].sort((a, b) => a[1].localeCompare(b[1]))
  }, [rows])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows
      .filter((r) => !app || String(r.app_id) === app)
      .filter((r) => !placement || r.placement === placement)
      .filter((r) =>
        health === 'any'
          ? true
          : health === 'down'
            ? r.up === false
            : health === 'alerts'
              ? r.alerts.length > 0
              : needsAttention(r)
      )
      .filter(
        (r) =>
          !needle ||
          `${r.app_key} ${r.app_name} ${r.env_key} ${r.version ?? ''} ${r.shared_key ?? ''}`
            .toLowerCase()
            .includes(needle)
      )
      .sort(compare(sort))
  }, [rows, q, app, placement, health, sort])

  const down = rows.filter((r) => r.up === false).length
  const alerting = rows.filter((r) => r.alerts.length > 0).length

  return (
    <div className='flex flex-1 min-h-0 flex-col overflow-y-auto bg-slate-50 dark:bg-background'>
      <div className='shrink-0 border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-center gap-x-4 gap-y-1'>
          <p className='m-0 text-[13px] font-medium text-slate-900 dark:text-foreground'>
            {fleet.data ? `${rows.length} environment${rows.length === 1 ? '' : 's'}` : 'Fleet'}
          </p>
          {fleet.data?.newest && (
            <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Newest <code className='font-mono'>{fleet.data.newest}</code>
            </p>
          )}
          {down > 0 && (
            <p className='m-0 text-[12px] font-medium text-red-700 dark:text-red-300'>
              {down} not answering
            </p>
          )}
          {alerting > 0 && (
            <p className='m-0 text-[12px] font-medium text-amber-800 dark:text-amber-300'>
              {alerting} with drift alerts
            </p>
          )}
          {isAdmin && (
            <button
              type='button'
              className={cn(ghostButton, 'ml-auto')}
              disabled={check.isPending}
              onClick={() => check.mutate()}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', check.isPending && 'animate-spin')}
                aria-hidden
              />
              Check now
            </button>
          )}
        </div>
        <div className='mt-2 flex flex-wrap items-center gap-2'>
          <div className='relative w-full sm:w-[220px]'>
            <Search
              className='pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400'
              aria-hidden
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder='Find an app, environment or version'
              aria-label='Find'
              className='h-8 pl-8 text-[13px]'
            />
          </div>
          <SimpleSelect
            value={app}
            onChange={setApp}
            ariaLabel='App'
            className='h-8 w-[160px] text-[12px]'
            options={[
              { value: '', label: 'Every app' },
              ...apps.map(([id, name]) => ({ value: String(id), label: name }))
            ]}
          />
          <SimpleSelect
            value={placement}
            onChange={setPlacement}
            ariaLabel='Placement'
            className='h-8 w-[150px] text-[12px]'
            options={[
              { value: '', label: 'Any placement' },
              { value: 'dedicated', label: 'Dedicated' },
              { value: 'shared', label: 'Shared' },
              { value: 'none', label: 'Watch only' }
            ]}
          />
          <SimpleSelect
            value={health}
            onChange={(v) => setHealth(v as Health)}
            ariaLabel='Health'
            className='h-8 w-[170px] text-[12px]'
            options={[
              { value: 'any', label: 'Any health' },
              { value: 'attention', label: 'Needs attention' },
              { value: 'down', label: 'Not answering' },
              { value: 'alerts', label: 'With drift alerts' }
            ]}
          />
          <SimpleSelect
            value={sort}
            onChange={(v) => setSort(v as Sort)}
            ariaLabel='Sort'
            className='h-8 w-[200px] text-[12px]'
            options={SORT_OPTIONS}
          />
        </div>
      </div>

      <div className='space-y-4 p-4'>
        {fleet.isPending ? (
          <div className='space-y-2'>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className='h-12 w-full' />
            ))}
          </div>
        ) : fleet.isError ? (
          <QueryErrorState
            error={fleet.error}
            what='the fleet'
            onRetry={() => void fleet.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyFleet />
        ) : (
          <>
            {fleet.data.unprobed > 0 && (
              <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
                {fleet.data.unprobed} environment{fleet.data.unprobed === 1 ? ' has' : 's have'} not
                been checked yet — the Hub checks every environment once a minute.
              </p>
            )}
            <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
              <table className='w-full min-w-[1080px] border-collapse text-[12px]'>
                <thead>
                  <tr className='border-b border-slate-200 text-left text-[11px] font-medium text-slate-500 dark:border-border dark:text-muted-foreground'>
                    <th className='px-3 py-2 font-medium'>App / environment</th>
                    <th className='px-3 py-2 font-medium'>Version</th>
                    <th className='px-3 py-2 font-medium'>Health</th>
                    <th className='px-3 py-2 font-medium'>Readiness</th>
                    <th className='px-3 py-2 font-medium'>Issues</th>
                    <th className='px-3 py-2 font-medium'>Uptime 24 h / 30 d</th>
                    <th className='px-3 py-2 font-medium'>SLO this month</th>
                    <th className='px-3 py-2 font-medium'>Last deploy</th>
                    <th className='px-3 py-2 font-medium'>Placement</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <FleetTableRow
                      key={r.environment_id}
                      row={r}
                      onOpen={() => navigate(`/hub?app=${r.app_id}`)}
                      onUptime={() => setUptimeOf(r)}
                    />
                  ))}
                  {shown.length === 0 && (
                    <tr>
                      <td
                        colSpan={9}
                        className='px-3 py-8 text-center text-slate-500 dark:text-muted-foreground'
                      >
                        Nothing matches these filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
        {isAdmin && fleet.data && <FleetSettingsCard rows={rows} />}
      </div>
      <UptimeSheet row={uptimeOf} onClose={() => setUptimeOf(null)} />
    </div>
  )
}

function FleetTableRow({
  row: r,
  onOpen,
  onUptime
}: {
  row: FleetRow
  onOpen: () => void
  onUptime: () => void
}) {
  const behind =
    r.behind == null
      ? r.version
        ? 'other line'
        : null
      : r.behind === 0
        ? null
        : `${r.behind} behind`
  const sloTone =
    r.slo.met == null
      ? 'text-slate-500 dark:text-muted-foreground'
      : r.slo.met
        ? 'text-emerald-700 dark:text-emerald-300'
        : 'text-red-700 dark:text-red-300'
  return (
    <tr className='border-b border-slate-100 align-top last:border-b-0 hover:bg-muted/50 dark:border-border'>
      <td className='px-3 py-2'>
        <button
          type='button'
          onClick={onOpen}
          className='group inline-flex items-center gap-1 text-left font-medium text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-foreground'
        >
          {r.app_name} <span className='text-slate-400'>/</span> {r.env_key}
          <ArrowUpRight
            className='h-3 w-3 text-slate-400 opacity-0 group-hover:opacity-100'
            aria-hidden
          />
        </button>
        {r.env_status !== 'active' && (
          <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
            {r.env_status}
          </p>
        )}
        {r.alerts.length > 0 && (
          <div className='mt-1 flex flex-wrap gap-1'>
            {r.alerts.map((a) => (
              <span
                key={a.id}
                data-tip={a.message}
                className='inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300'
              >
                <AlertTriangle className='h-2.5 w-2.5' aria-hidden />
                {a.kind === 'stale_deploy'
                  ? 'Not deployed'
                  : a.kind === 'pair_apart'
                    ? 'Apart'
                    : 'Behind'}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className='px-3 py-2'>
        <code className='font-mono text-slate-800 dark:text-foreground'>{r.version ?? '—'}</code>
        {behind && (
          <p
            className={cn(
              'm-0 text-[11px]',
              r.behind == null || r.behind >= 5
                ? 'text-amber-800 dark:text-amber-300'
                : 'text-slate-500 dark:text-muted-foreground'
            )}
          >
            {behind}
          </p>
        )}
      </td>
      <td className='px-3 py-2'>
        {r.state ? (
          <StatusChip
            state={r.state}
            compact
            glyph
            tip={r.failing.length ? `Failing: ${r.failing.join(', ')}` : (r.error ?? undefined)}
          />
        ) : (
          <span className='text-slate-400'>Not read yet</span>
        )}
        {r.up === false && (
          <p className='m-0 mt-0.5 text-[11px] font-medium text-red-700 dark:text-red-300'>
            Not answering
          </p>
        )}
        {r.checked_at && (
          <p
            className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'
            data-tip={formatDateTime(r.checked_at)}
          >
            {formatRelative(r.checked_at)}
          </p>
        )}
      </td>
      <td className='px-3 py-2 tabular-nums'>{r.readiness_score ?? '—'}</td>
      <td className='px-3 py-2 tabular-nums'>{r.open_issues ?? '—'}</td>
      <td className='px-3 py-2 tabular-nums'>
        <button
          type='button'
          onClick={onUptime}
          className='inline-flex items-center gap-1 rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
          aria-label={`Uptime of ${r.app_name} ${r.env_key}`}
        >
          <Activity className='h-3 w-3 text-slate-400' aria-hidden />
          {pct(r.uptime_24h)} / {pct(r.uptime_30d)}
        </button>
      </td>
      <td className='px-3 py-2 tabular-nums'>
        <span className={sloTone}>{pct(r.slo.uptime)}</span>
        <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
          target {r.slo.target} %
          {r.slo.met === false ? ' · missed' : r.slo.met ? ' · on track' : ''}
        </p>
      </td>
      <td className='px-3 py-2'>
        {r.last_deploy ? (
          <>
            <span className='text-slate-800 dark:text-foreground'>
              {r.last_deploy.kind === 'rollback' ? 'Rollback' : 'Promotion'} to{' '}
              <code className='font-mono'>{r.last_deploy.version}</code>
            </span>
            <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
              {r.last_deploy.status}
              {r.last_deploy.at ? ` · ${formatRelative(r.last_deploy.at)}` : ''}
              {r.last_deploy.by_name ? ` · ${r.last_deploy.by_name}` : ''}
            </p>
          </>
        ) : r.deployed_at ? (
          <span className='text-slate-500 dark:text-muted-foreground'>
            Version seen {formatRelative(r.deployed_at)}
          </span>
        ) : (
          <span className='text-slate-400'>—</span>
        )}
      </td>
      <td className='px-3 py-2'>
        {r.placement === 'shared' ? (
          <span>
            Shared
            {r.shared_key ? (
              <code className='ml-1 font-mono text-[11px]'>{r.shared_key}</code>
            ) : null}
          </span>
        ) : r.placement === 'dedicated' ? (
          'Dedicated'
        ) : (
          <span className='text-slate-500 dark:text-muted-foreground'>Watch only</span>
        )}
      </td>
    </tr>
  )
}

function EmptyFleet() {
  return (
    <div className='rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center dark:border-border dark:bg-card'>
      <p className='m-0 text-[13px] font-medium text-slate-700 dark:text-foreground'>
        No environments yet
      </p>
      <p className='m-0 mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
        Environments of the apps on the Apps tab show up here once the Hub has checked them.
      </p>
    </div>
  )
}
