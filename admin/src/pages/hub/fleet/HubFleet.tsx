import { QueryErrorState, toastError } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  RefreshCw,
  Search,
  SlidersHorizontal
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { envTone } from '@/components/hub-brand/env-tone'
import { HubEnvTag } from '@/components/hub-brand/HubBits'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { ghostButton, StatusChip } from '../hub-parts'
import { HealthScore, useHealthByEnv } from '../insight/HealthScore'
import type { EnvHealth } from '../insight/insight-api'
import { FleetSettingsCard } from './FleetSettingsCard'
import { checkFleetNow, type FleetRow, fetchFleet, fleetKeys, pct } from './fleet-api'
import { UptimeSheet } from './UptimeSheet'

/**
 * Fleet (Apps hub tab): every app × environment on one screen — version and how far behind the
 * newest, health, readiness, open issues, uptime and this month's SLO, the last Hub deploy, shared
 * or dedicated placement and open drift alerts. Read from the Hub's own tables (the probe job
 * refreshes them every minute); nothing here makes the Hub call an app. Filters and the sort live
 * in the URL (q, app, placement, health, sort) so a view can be shared. Admins also get Check now
 * and, behind "Rules and targets", the drift rules and uptime targets.
 */

type Health = 'any' | 'attention' | 'down' | 'alerts'
type Sort = 'app' | 'behind' | 'uptime' | 'deploy' | 'readiness'

const SORTS: readonly Sort[] = ['app', 'behind', 'uptime', 'deploy', 'readiness']
const HEALTHS: readonly Health[] = ['any', 'attention', 'down', 'alerts']

const ALERT_CHIP: Record<string, string> = {
  stale_deploy: 'Not deployed',
  pair_apart: 'Envs apart',
  behind_newest: 'Behind'
}

const needsAttention = (r: FleetRow) =>
  r.up === false || (r.state != null && r.state !== 'ok') || r.alerts.length > 0

function compare(sort: Sort) {
  const nullsLast = (a: number | null, b: number | null, dir: 1 | -1) =>
    a == null ? (b == null ? 0 : 1) : b == null ? -1 : (a - b) * dir
  const byApp = (a: FleetRow, b: FleetRow) =>
    a.app_name.localeCompare(b.app_name) ||
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
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const app = params.get('app') ?? ''
  const placement = params.get('placement') ?? ''
  const health = (HEALTHS as readonly string[]).includes(params.get('health') ?? '')
    ? (params.get('health') as Health)
    : 'any'
  const sort = (SORTS as readonly string[]).includes(params.get('sort') ?? '')
    ? (params.get('sort') as Sort)
    : 'app'
  const set = (k: string, v: string, empty = '') =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p)
        if (v && v !== empty) out.set(k, v)
        else out.delete(k)
        return out
      },
      { replace: true }
    )
  const [uptimeOf, setUptimeOf] = useState<FleetRow | null>(null)
  // Hub insight: the health score per environment (one shared read; '—' until it answers).
  const healthByEnv = useHealthByEnv(!!fleet.data)
  const [rulesOpen, setRulesOpen] = useState(false)

  const check = useMutation({
    mutationFn: checkFleetNow,
    onSuccess: (d) => {
      const p = d.result?.probe
      if (d.status === 'done' && p)
        toast.success(
          `Checked ${p.probed} environment${p.probed === 1 ? '' : 's'}${p.down ? ` — ${p.down} not answering` : ''}`
        )
      else if (d.status === 'running')
        toast('The check is still running — the page updates when it ends')
      else toast.error('The check did not finish — try again in a minute')
      void qc.invalidateQueries({ queryKey: fleetKeys.fleet() })
    },
    onError: (e) => toastError(e, 'Could not check the fleet')
  })

  const rows = useMemo(() => fleet.data?.rows ?? [], [fleet.data])
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
  const sortBy = (s: Sort) => set('sort', sort === s ? 'app' : s, 'app')

  return (
    <div className='flex flex-1 min-h-0 flex-col overflow-y-auto bg-slate-50 dark:bg-background'>
      <div className='shrink-0 border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
          <p className='m-0 text-[13px] font-medium text-slate-900 dark:text-foreground'>
            {fleet.data ? `${rows.length} environment${rows.length === 1 ? '' : 's'}` : 'Fleet'}
          </p>
          {fleet.data?.newest && (
            <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Newest <code className='font-mono'>{fleet.data.newest}</code>
            </p>
          )}
          {down > 0 && (
            <CountToggle
              active={health === 'down'}
              onClick={() => set('health', health === 'down' ? '' : 'down')}
              tone='text-red-700 dark:text-red-300'
            >
              {down} not answering
            </CountToggle>
          )}
          {alerting > 0 && (
            <CountToggle
              active={health === 'alerts'}
              onClick={() => set('health', health === 'alerts' ? '' : 'alerts')}
              tone='text-amber-800 dark:text-amber-300'
            >
              {alerting} with drift alerts
            </CountToggle>
          )}
          <div className='ml-auto flex items-center gap-1'>
            <Link
              to='/docs?section=hub-fleet'
              className='px-2 text-[12px] text-slate-500 hover:underline dark:text-muted-foreground'
            >
              How this works
            </Link>
            {isAdmin && (
              <button
                type='button'
                className={cn(ghostButton, rulesOpen && 'bg-accent')}
                aria-expanded={rulesOpen}
                onClick={() => setRulesOpen((o) => !o)}
              >
                <SlidersHorizontal className='h-3.5 w-3.5' aria-hidden />
                Rules and targets
              </button>
            )}
            {isAdmin && (
              <button
                type='button'
                className={ghostButton}
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
        </div>
        <div className='mt-2 flex flex-wrap items-center gap-2'>
          <div className='relative w-full sm:w-[240px]'>
            <Search
              className='pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400'
              aria-hidden
            />
            <Input
              value={q}
              onChange={(e) => set('q', e.target.value)}
              placeholder='Find an app, environment or version'
              aria-label='Find'
              className='h-8 pl-8 text-[13px]'
            />
          </div>
          <SimpleSelect
            value={app}
            onChange={(v) => set('app', v)}
            ariaLabel='App'
            className='h-8 w-[160px] text-[12px]'
            options={[
              { value: '', label: 'Every app' },
              ...apps.map(([id, name]) => ({ value: String(id), label: name }))
            ]}
          />
          <SimpleSelect
            value={placement}
            onChange={(v) => set('placement', v)}
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
            onChange={(v) => set('health', v, 'any')}
            ariaLabel='Health'
            className='h-8 w-[170px] text-[12px]'
            options={[
              { value: 'any', label: 'Any health' },
              { value: 'attention', label: 'Needs attention' },
              { value: 'down', label: 'Not answering' },
              { value: 'alerts', label: 'With drift alerts' }
            ]}
          />
        </div>
      </div>

      <div className='space-y-4 p-4'>
        {isAdmin && rulesOpen && fleet.data && <FleetSettingsCard rows={rows} />}
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
              <table className='w-full min-w-[1160px] border-collapse text-[12px]'>
                <thead>
                  <tr className='border-b border-slate-200 text-left text-[11px] font-medium text-slate-500 dark:border-border dark:text-muted-foreground'>
                    <SortHeader label='App / environment' col='app' sort={sort} onSort={sortBy} />
                    <SortHeader
                      label='Version'
                      col='behind'
                      sort={sort}
                      onSort={sortBy}
                      dir='desc'
                    />
                    <th className='px-3 py-2 font-medium'>Health</th>
                    <th className='px-3 py-2 font-medium'>
                      <Link to='/hub/health' className='hover:underline'>
                        Score
                      </Link>
                    </th>
                    <SortHeader label='Readiness' col='readiness' sort={sort} onSort={sortBy} />
                    <th className='px-3 py-2 font-medium'>Open issues</th>
                    <SortHeader
                      label='Uptime 24 h / 30 d'
                      col='uptime'
                      sort={sort}
                      onSort={sortBy}
                    />
                    <th className='px-3 py-2 font-medium'>Uptime this month</th>
                    <SortHeader label='Last deploy' col='deploy' sort={sort} onSort={sortBy} />
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
                      health={healthByEnv?.get(r.environment_id) ?? null}
                    />
                  ))}
                  {shown.length === 0 && (
                    <tr>
                      <td
                        colSpan={10}
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
      </div>
      <UptimeSheet row={uptimeOf} onClose={() => setUptimeOf(null)} />
    </div>
  )
}

/** A summary count that filters the table to what it counts (and back). */
function CountToggle({
  active,
  onClick,
  tone,
  children
}: {
  active: boolean
  onClick: () => void
  tone: string
  children: ReactNode
}) {
  return (
    <button
      type='button'
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-md px-1.5 py-0.5 text-[12px] font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
        tone,
        active && 'bg-accent'
      )}
    >
      {children}
    </button>
  )
}

/** A column header that sorts the table by it; a second press goes back to app order. */
function SortHeader({
  label,
  col,
  sort,
  onSort,
  dir = 'asc'
}: {
  label: string
  col: Sort
  sort: Sort
  onSort: (s: Sort) => void
  dir?: 'asc' | 'desc'
}) {
  const active = sort === col
  const Arrow = dir === 'desc' ? ArrowDown : ArrowUp
  return (
    <th
      className='px-3 py-2 font-medium'
      aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type='button'
        onClick={() => onSort(col)}
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap rounded hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:text-foreground',
          active && 'text-slate-900 dark:text-foreground'
        )}
      >
        {label}
        <Arrow className={cn('h-3 w-3', active ? 'opacity-100' : 'opacity-0')} aria-hidden />
      </button>
    </th>
  )
}

function FleetTableRow({
  row: r,
  onOpen,
  onUptime,
  health
}: {
  row: FleetRow
  onOpen: () => void
  onUptime: () => void
  health: EnvHealth | null
}) {
  const behind = r.behind == null ? null : r.behind === 0 ? null : `${r.behind} behind`
  const sloTone =
    r.slo.met == null
      ? 'text-slate-500 dark:text-muted-foreground'
      : r.slo.met
        ? 'text-emerald-700 dark:text-emerald-300'
        : 'text-red-700 dark:text-red-300'
  const neverProbed = r.uptime_24h == null && r.uptime_30d == null
  return (
    <tr
      className='border-b border-slate-100 align-top last:border-b-0 hover:bg-slate-50 dark:border-border dark:hover:bg-muted'
      data-env-tone={envTone(r.env_key)}
    >
      <td className='px-3 py-2'>
        <button
          type='button'
          onClick={onOpen}
          className='group text-left font-medium text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-foreground'
        >
          <span>{r.app_name}</span>{' '}
          <span className='whitespace-nowrap'>
            <span className='text-slate-400'>/</span> {r.env_key}
            <ArrowUpRight
              className='ml-0.5 inline h-3 w-3 align-[-1px] text-slate-400 opacity-0 group-hover:opacity-100'
              aria-hidden
            />
          </span>
        </button>
        <HubEnvTag envKey={r.env_key} className='ml-1.5 align-[1px]' />
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
                {ALERT_CHIP[a.kind] ?? 'Drift'}
                <span className='sr-only'>: {a.message}</span>
              </span>
            ))}
          </div>
        )}
      </td>
      <td className='px-3 py-2'>
        <code className='hub-fact font-mono text-slate-800 dark:text-foreground'>
          {r.version ?? '—'}
        </code>
        {r.version_unverified && (
          <p
            className='m-0 whitespace-nowrap text-[11px] text-amber-800 dark:text-amber-300'
            data-tip='Newer than every release the Hub deployed or found published — not counted for drift'
          >
            not a known release
          </p>
        )}
        {behind && (
          <p
            className={cn(
              'm-0 whitespace-nowrap text-[11px]',
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
          <span className='text-slate-500 dark:text-muted-foreground'>Not checked yet</span>
        )}
        {r.up === false && r.state !== 'unreachable' && (
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
        {r.state && r.probe_stale && (
          <p className='m-0 text-[11px] text-amber-800 dark:text-amber-300'>Not checked lately</p>
        )}
      </td>
      <td className='px-3 py-2'>
        <HealthScore health={health} compact />
      </td>
      <td className='px-3 py-2 tabular-nums'>
        {r.readiness_score == null ? (
          '—'
        ) : (
          <span>
            {r.readiness_score}
            <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>/100</span>
          </span>
        )}
      </td>
      <td className='px-3 py-2 tabular-nums'>{r.open_issues ?? '—'}</td>
      <td className='whitespace-nowrap px-3 py-2 tabular-nums'>
        {neverProbed ? (
          <span className='text-slate-400'>—</span>
        ) : (
          <button
            type='button'
            onClick={onUptime}
            className='inline-flex items-center gap-1 rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
          >
            <Activity className='h-3 w-3 text-slate-400' aria-hidden />
            <span>
              {pct(r.uptime_24h)} / {pct(r.uptime_30d)}
            </span>
            <span className='sr-only'>
              — uptime of {r.app_name} {r.env_key}
            </span>
          </button>
        )}
      </td>
      <td className='px-3 py-2 tabular-nums'>
        <span className={cn('whitespace-nowrap', sloTone)}>{pct(r.slo.uptime)}</span>
        <p className='m-0 whitespace-nowrap text-[11px] text-slate-500 dark:text-muted-foreground'>
          target {r.slo.target}&nbsp;%
          {r.slo.met === false ? ' · missed' : r.slo.met ? ' · on track' : ''}
        </p>
      </td>
      <td className='px-3 py-2'>
        {r.last_deploy ? (
          <>
            <span className='text-slate-800 dark:text-foreground'>
              {r.last_deploy.kind === 'rollback' ? 'Rollback' : 'Promotion'}{' '}
              <code className='whitespace-nowrap font-mono'>{r.last_deploy.version}</code>
            </span>
            <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
              {r.last_deploy.status === 'success' ? 'Succeeded' : r.last_deploy.status}
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
          <span className='whitespace-nowrap'>
            Shared{r.shared_key ? ' · ' : ''}
            {r.shared_key ? <code className='font-mono text-[11px]'>{r.shared_key}</code> : null}
          </span>
        ) : r.placement === 'dedicated' ? (
          'Dedicated'
        ) : (
          <span
            className='text-slate-500 dark:text-muted-foreground'
            data-tip='The Hub watches this environment but does not deploy it'
          >
            Watch only
          </span>
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
