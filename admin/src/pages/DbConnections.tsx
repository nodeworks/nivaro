import { QueryErrorState } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Pause, Play, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { requestStoryPath } from '@/lib/recent-requests'
import { cn } from '@/lib/utils'

/**
 * Database → Connections (#pool-holders): who holds a database connection right now, and who
 * waits for one, on every API process. GET /api/ops-db/pool-holders (admin) merges every
 * process's snapshot (services/pool-holders.ts); this page polls it every 3 s while the tab is
 * visible. A person or feature over a quarter of one process's pool is marked; every row opens
 * the request story, the person, or the job behind it.
 */

type PoolName = 'main' | 'background'

interface PoolSnap {
  name: PoolName
  max: number
  used: number
  free: number
  pending_acquires: number
  pending_creates: number
  holding: number
  waiting: number
  wait_p95_ms: number
  saturated_pct: number
}

interface Person {
  key: string
  kind: 'person' | 'api_key' | 'mcp' | 'system' | 'anon'
  label: string | null
  user_id: string | null
}

interface Feature {
  key: string
  kind: string
  label: string
}

interface HolderRow {
  node: string
  pool: PoolName
  state: 'holding' | 'waiting'
  since: number
  age_ms: number
  person: Person
  feature: Feature
  request_id: string | null
  read_gate: boolean
}

interface GroupRow {
  key: string
  label: string
  kind: string
  user_id?: string | null
  holding: number
  waiting: number
  by_pool: Record<string, number>
  max_share: number
  max_share_node: string | null
  max_share_pool: PoolName | null
  hot: boolean
  oldest_ms: number
  top: Array<{ label: string; n: number }>
  sample_request_id: string | null
}

interface HogEvent {
  node: string
  pool: PoolName
  dimension: 'person' | 'feature'
  key: string
  label: string
  held: number
  max: number
  since: number
  at: number
}

interface ClusterView {
  available: boolean
  at: string
  partial: boolean
  nodes: Array<{
    node: string
    host: string
    role: string | null
    self: boolean
    age_ms: number
    pools: PoolSnap[]
    read_gate: { active: number; queued: number; limit: number | null; overflow_running: number }
  }>
  missing: Array<{ node: string; host: string | null; role: string | null }>
  totals: Array<{
    name: PoolName
    max: number
    used: number
    free: number
    holding: number
    waiting: number
  }>
  by_person: GroupRow[]
  by_feature: GroupRow[]
  longest: HolderRow[]
  waiters: HolderRow[]
  read_gate: { active: number; queued: number; overflow_running: number }
  hogs: HogEvent[]
  thresholds: { hot_share: number; hog_share: number; hog_seconds: number }
}

const POLL_MS = 3000
const POOL_LABEL: Record<PoolName, string> = { main: 'Requests', background: 'Background' }

function fmtAge(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`
}

function nodeName(n: { node: string; host?: string | null; role?: string | null }): string {
  const role = n.role ? `${n.role} · ` : ''
  return `${role}${n.host ?? 'process'} · ${n.node}`
}

/** Where a row leads: the request story, else the person, the API key, MCP, the job. */
function drillPath(
  person: { kind: string; user_id?: string | null },
  feature: { kind: string; key: string },
  requestId: string | null
): string | null {
  if (requestId) return requestStoryPath(requestId)
  return groupPath('person', person.kind, person.user_id ?? null, '') ?? featurePath(feature)
}

function featurePath(f: { kind: string; key: string }): string | null {
  if (f.kind === 'job') return '/jobs'
  if (f.kind === 'flow') {
    const id = f.key.startsWith('flow:') ? f.key.slice(5) : ''
    return id ? `/flows/${encodeURIComponent(id)}` : '/flows'
  }
  if (f.kind === 'import') return '/imports'
  return null
}

function groupPath(
  dim: 'person' | 'feature',
  kind: string,
  userId: string | null,
  key: string
): string | null {
  if (dim === 'feature') return featurePath({ kind, key })
  if (kind === 'person' && userId) return `/users/${encodeURIComponent(userId)}?tab=activity`
  if (kind === 'api_key') return '/api-keys'
  if (kind === 'mcp') return '/mcp'
  return null
}

const KIND_LABEL: Record<string, string> = {
  person: 'Person',
  api_key: 'API key',
  mcp: 'Assistant',
  system: 'System',
  anon: 'Signed out',
  route: 'Route',
  job: 'Job',
  flow: 'Flow',
  import: 'Import',
  socket: 'Socket',
  label: 'Task',
  trace: 'Background',
  other: 'Other'
}

// ─── Process bars ──────────────────────────────────────────────────────────────

function PoolBar({ p, hot }: { p: PoolSnap; hot: boolean }) {
  const waiting = Math.max(p.waiting, p.pending_acquires)
  const scale = Math.max(1, p.max + waiting)
  const used = Math.min(p.used, p.max)
  const w = (n: number) => `${(n / scale) * 100}%`
  return (
    <div className='min-w-0'>
      <div className='mb-1 flex items-baseline justify-between gap-2 text-[11px]'>
        <span className='text-slate-500 dark:text-muted-foreground'>{POOL_LABEL[p.name]}</span>
        <span className='tabular-nums text-slate-600 dark:text-slate-300'>
          <b className={cn('font-semibold', hot && 'text-amber-700 dark:text-amber-400')}>
            {p.used}
          </b>
          /{p.max} in use
          {waiting > 0 && (
            <span className='ml-1 font-semibold text-amber-700 dark:text-amber-400'>
              · {waiting} waiting
            </span>
          )}
        </span>
      </div>
      <div
        className='relative flex h-2.5 overflow-hidden rounded-sm bg-slate-100 dark:bg-muted'
        role='img'
        aria-label={`${POOL_LABEL[p.name]} pool: ${p.used} of ${p.max} in use, ${p.free} free, ${waiting} waiting`}
      >
        <div
          className='h-full bg-nvr-cyan transition-[width] duration-500 ease-out motion-reduce:transition-none'
          style={{ width: w(used) }}
        />
        <div
          className='h-full transition-[width] duration-500 ease-out motion-reduce:transition-none'
          style={{ width: w(p.max - used) }}
        />
        {waiting > 0 && (
          <div
            className='h-full bg-amber-500 transition-[width] duration-500 ease-out motion-reduce:transition-none dark:bg-amber-400'
            style={{
              width: w(waiting),
              backgroundImage:
                'repeating-linear-gradient(135deg, transparent 0 3px, rgb(255 255 255 / 0.35) 3px 5px)'
            }}
          />
        )}
        {waiting > 0 && (
          <span
            aria-hidden
            className='absolute inset-y-[-2px] w-px bg-slate-500 dark:bg-slate-300'
            style={{ left: w(p.max) }}
          />
        )}
      </div>
    </div>
  )
}

function ProcessList({ view }: { view: ClusterView }) {
  const hotNodes = useMemo(() => {
    const s = new Set<string>()
    for (const g of [...view.by_person, ...view.by_feature])
      if (g.hot && g.max_share_node) s.add(`${g.max_share_node}|${g.max_share_pool}`)
    return s
  }, [view])
  return (
    <ul className='divide-y divide-slate-100 dark:divide-border/60'>
      {view.nodes.map((n) => (
        <li
          key={n.node}
          className='grid gap-x-6 gap-y-2 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,14rem)_1fr]'
          data-pool-node={n.node}
        >
          <div className='min-w-0 text-[12px]'>
            <p className='truncate font-medium text-slate-700 dark:text-foreground'>
              {n.role ?? 'process'} <span className='font-normal text-slate-400'>{n.node}</span>
              {n.self && <span className='ml-1.5 text-[10.5px] text-slate-400'>(answering)</span>}
            </p>
            <p className='truncate text-[11px] text-slate-400'>
              {n.host}
              {n.read_gate.active + n.read_gate.queued > 0 &&
                ` · read slots ${n.read_gate.active}${n.read_gate.limit ? `/${n.read_gate.limit}` : ''}${n.read_gate.queued ? `, ${n.read_gate.queued} queued` : ''}`}
            </p>
          </div>
          <div className='grid gap-3 sm:grid-cols-2'>
            {n.pools.map((p) => (
              <PoolBar key={p.name} p={p} hot={hotNodes.has(`${n.node}|${p.name}`)} />
            ))}
          </div>
        </li>
      ))}
    </ul>
  )
}

// ─── Group table ───────────────────────────────────────────────────────────────

type SortKey = 'label' | 'holding' | 'waiting' | 'max_share' | 'oldest_ms'

function SortHead({
  label,
  k,
  sort,
  onSort,
  align = 'right'
}: {
  label: string
  k: SortKey
  sort: { key: SortKey; dir: 'asc' | 'desc' }
  onSort: (k: SortKey) => void
  align?: 'left' | 'right'
}) {
  const active = sort.key === k
  return (
    <th
      scope='col'
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('pb-1.5 pr-4 last:pr-0', align === 'right' ? 'text-right' : 'text-left')}
    >
      <button
        type='button'
        onClick={() => onSort(k)}
        className={cn(
          'inline-flex items-center gap-0.5 rounded-sm text-[10.5px] font-medium uppercase tracking-wide outline-none hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:hover:text-foreground',
          active ? 'text-slate-700 dark:text-foreground' : 'text-slate-400'
        )}
      >
        {label}
        {active &&
          (sort.dir === 'asc' ? (
            <ArrowUp className='h-3 w-3' aria-hidden />
          ) : (
            <ArrowDown className='h-3 w-3' aria-hidden />
          ))}
      </button>
    </th>
  )
}

function GroupTable({
  rows,
  dim,
  hotShare
}: {
  rows: GroupRow[]
  dim: 'person' | 'feature'
  hotShare: number
}) {
  const navigate = useNavigate()
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'holding',
    dir: 'desc'
  })
  const sorted = useMemo(() => {
    const out = [...rows]
    out.sort((a, b) => {
      const d =
        sort.key === 'label'
          ? a.label.localeCompare(b.label)
          : (a[sort.key] as number) - (b[sort.key] as number)
      return sort.dir === 'asc' ? d : -d
    })
    return out
  }, [rows, sort])
  const onSort = (k: SortKey) =>
    setSort((s) => ({ key: k, dir: s.key === k && s.dir === 'desc' ? 'asc' : 'desc' }))

  if (rows.length === 0)
    return (
      <p className='text-[12px] text-slate-400'>
        Nobody holds a connection right now — every pool is idle.
      </p>
    )
  const toOf = (g: GroupRow) =>
    (g.sample_request_id && g.holding === 1 ? requestStoryPath(g.sample_request_id) : null) ??
    groupPath(dim, g.kind, g.user_id ?? null, g.key) ??
    (g.sample_request_id ? requestStoryPath(g.sample_request_id) : null)
  return (
    <>
      {/* Phone: one line of figures under each name; the sort is a chooser. */}
      <div className='sm:hidden'>
        <div className='mb-2 flex items-center gap-2 text-[11px] text-slate-400'>
          Sort
          <Segmented
            label='Sort by'
            value={sort.key === 'label' ? 'holding' : sort.key}
            onChange={(k) => setSort({ key: k, dir: 'desc' })}
            options={[
              ['holding', 'Holding'],
              ['waiting', 'Waiting'],
              ['max_share', 'Share'],
              ['oldest_ms', 'Oldest']
            ]}
          />
        </div>
        <ul className='divide-y divide-slate-100 dark:divide-border/60'>
          {sorted.map((g) => {
            const to = toOf(g)
            return (
              <li key={g.key} data-pool-group={g.key} data-hot={g.hot || undefined}>
                <button
                  type='button'
                  disabled={!to}
                  onClick={to ? () => navigate(to) : undefined}
                  className={cn(
                    '-mx-2 block w-[calc(100%+1rem)] rounded-sm px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 disabled:cursor-default',
                    g.hot && 'bg-amber-50 dark:bg-amber-950/40'
                  )}
                >
                  <span className='block truncate text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
                    {g.label}
                  </span>
                  <span className='mt-0.5 block text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'>
                    <b className='font-semibold text-slate-700 dark:text-slate-200'>{g.holding}</b>{' '}
                    holding
                    {g.waiting > 0 && (
                      <span className='font-semibold text-amber-700 dark:text-amber-400'>
                        {' '}
                        · {g.waiting} waiting
                      </span>
                    )}
                    {g.max_share > 0 && (
                      <span
                        className={cn(g.hot && 'font-semibold text-amber-800 dark:text-amber-300')}
                      >
                        {' '}
                        · {pct(g.max_share)} of a pool
                      </span>
                    )}
                    {g.holding > 0 && ` · oldest ${fmtAge(g.oldest_ms)}`}
                  </span>
                  <span className='block truncate text-[11px] text-slate-400'>
                    {KIND_LABEL[g.kind] ?? g.kind}
                    {g.top.length > 0 &&
                      ` · ${g.top.map((t) => (t.n > 1 ? `${t.label} ×${t.n}` : t.label)).join(', ')}`}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      <div className='-mx-4 hidden overflow-x-auto px-4 sm:block'>
        <table className='w-full min-w-[560px] text-left'>
          <thead>
            <tr>
              <SortHead
                label={dim === 'person' ? 'Who' : 'Feature'}
                k='label'
                sort={sort}
                onSort={onSort}
                align='left'
              />
              <SortHead label='Holding' k='holding' sort={sort} onSort={onSort} />
              <SortHead label='Waiting' k='waiting' sort={sort} onSort={onSort} />
              <SortHead label='Biggest share' k='max_share' sort={sort} onSort={onSort} />
              <SortHead label='Oldest' k='oldest_ms' sort={sort} onSort={onSort} />
            </tr>
          </thead>
          <tbody className='tabular-nums'>
            {sorted.map((g) => {
              const to = toOf(g)
              return (
                <tr
                  key={g.key}
                  data-pool-group={g.key}
                  data-hot={g.hot || undefined}
                  tabIndex={to ? 0 : undefined}
                  onClick={to ? () => navigate(to) : undefined}
                  onKeyDown={
                    to
                      ? (e) => {
                          if (e.key === 'Enter') navigate(to)
                        }
                      : undefined
                  }
                  className={cn(
                    'border-t border-slate-100 align-top outline-none dark:border-border/60',
                    to &&
                      'cursor-pointer hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60',
                    g.hot &&
                      'bg-amber-50 hover:bg-amber-100/70 dark:bg-amber-950/40 dark:hover:bg-amber-950/60'
                  )}
                >
                  <td className='max-w-[22rem] py-1.5 pr-4'>
                    <p className='truncate text-[12px] font-medium text-slate-700 dark:text-foreground'>
                      {g.label}
                    </p>
                    <p className='truncate text-[11px] text-slate-400'>
                      {KIND_LABEL[g.kind] ?? g.kind}
                      {g.top.length > 0 &&
                        ` · ${g.top.map((t) => (t.n > 1 ? `${t.label} ×${t.n}` : t.label)).join(', ')}`}
                    </p>
                  </td>
                  <td className='py-1.5 pr-4 text-right text-[12px] text-slate-700 dark:text-slate-200'>
                    {g.holding}
                    {g.by_pool.background ? (
                      <span className='ml-1 text-[10.5px] text-slate-400'>
                        ({g.by_pool.background} bg)
                      </span>
                    ) : null}
                  </td>
                  <td
                    className={cn(
                      'py-1.5 pr-4 text-right text-[12px]',
                      g.waiting > 0
                        ? 'font-semibold text-amber-700 dark:text-amber-400'
                        : 'text-slate-400'
                    )}
                  >
                    {g.waiting}
                  </td>
                  <td className='py-1.5 pr-4 text-right text-[12px]'>
                    {g.max_share > 0 ? (
                      <span
                        className={cn(
                          g.hot
                            ? 'rounded-sm bg-amber-200/70 px-1 font-semibold text-amber-900 dark:bg-amber-500/25 dark:text-amber-200'
                            : 'text-slate-600 dark:text-slate-300'
                        )}
                        data-tip={
                          g.max_share_node
                            ? `${pct(g.max_share)} of the ${POOL_LABEL[g.max_share_pool ?? 'main'].toLowerCase()} pool on process ${g.max_share_node}${g.hot ? ` — over ${pct(hotShare)}` : ''}`
                            : undefined
                        }
                      >
                        {pct(g.max_share)}
                      </span>
                    ) : (
                      <span className='text-slate-400'>—</span>
                    )}
                  </td>
                  <td className='py-1.5 text-right text-[12px] text-slate-600 dark:text-slate-300'>
                    {g.holding > 0 ? fmtAge(g.oldest_ms) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ─── Holder list ───────────────────────────────────────────────────────────────

const HOLDERS_FIRST = 8

function HolderList({ rows, empty }: { rows: HolderRow[]; empty: string }) {
  const navigate = useNavigate()
  const [all, setAll] = useState(false)
  if (rows.length === 0) return <p className='text-[12px] text-slate-400'>{empty}</p>
  const shown = all ? rows : rows.slice(0, HOLDERS_FIRST)
  return (
    <>
      <ul className='divide-y divide-slate-100 dark:divide-border/60'>
        {shown.map((r) => {
          const to = drillPath(r.person, r.feature, r.request_id)
          const body = (
            <>
              <span
                className={cn(
                  'w-16 shrink-0 text-right text-[12px] font-semibold tabular-nums',
                  r.age_ms >= 30_000
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-slate-700 dark:text-slate-200'
                )}
              >
                {fmtAge(r.age_ms)}
              </span>
              <span className='min-w-0 flex-1'>
                <span className='block truncate text-[12px] text-slate-700 dark:text-foreground'>
                  {r.feature.label}
                </span>
                <span className='block truncate text-[11px] text-slate-400'>
                  {r.person.label ?? r.person.key} · {POOL_LABEL[r.pool]} · {r.node}
                  {r.read_gate && ' · read slot'}
                </span>
              </span>
            </>
          )
          return (
            <li key={`${r.node}-${r.pool}-${r.since}-${r.feature.key}-${r.request_id ?? ''}`}>
              {to ? (
                <button
                  type='button'
                  onClick={() => navigate(to)}
                  className='flex w-full items-center gap-3 rounded-sm px-1 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
                >
                  {body}
                </button>
              ) : (
                <div className='flex items-center gap-3 px-1 py-1.5'>{body}</div>
              )}
            </li>
          )
        })}
      </ul>
      {rows.length > HOLDERS_FIRST && (
        <button
          type='button'
          onClick={() => setAll((v) => !v)}
          className='mt-2 rounded-sm px-1 text-[11.5px] font-medium text-nvr-cyan outline-none hover:underline focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
          aria-expanded={all}
        >
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────────

function Section({
  title,
  sub,
  right,
  children
}: {
  title: string
  sub?: string
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className='min-w-0 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <header className='flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <div className='min-w-0'>
          <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>{title}</h2>
          {sub && <p className='mt-0.5 text-[11px] text-slate-400'>{sub}</p>}
        </div>
        {right}
      </header>
      <div className='p-4'>{children}</div>
    </section>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: Array<[T, string]>
  onChange: (v: T) => void
  label: string
}) {
  return (
    <fieldset
      aria-label={label}
      className='m-0 inline-flex min-w-0 rounded-md border border-slate-200 p-0.5 dark:border-border'
    >
      {options.map(([v, l]) => (
        <button
          key={v}
          type='button'
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn(
            'rounded px-2.5 py-1 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
            value === v
              ? 'bg-accent font-medium text-slate-800 dark:text-foreground'
              : 'text-slate-500 hover:bg-muted dark:text-muted-foreground'
          )}
        >
          {l}
        </button>
      ))}
    </fieldset>
  )
}

export default function DbConnectionsPage() {
  const [paused, setPaused] = useState(false)
  const [dim, setDim] = useState<'person' | 'feature'>('person')
  const q = useQuery({
    queryKey: ['pool-holders'],
    queryFn: () => api.get<{ data: ClusterView }>('/ops-db/pool-holders').then((r) => r.data.data),
    refetchInterval: paused ? false : POLL_MS,
    // Hidden tab = no polling (TanStack's default, said out loud).
    refetchIntervalInBackground: false,
    staleTime: 1000
  })
  const view = q.data

  const hotCount = view ? [...view.by_person, ...view.by_feature].filter((g) => g.hot).length : 0

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description='Who holds a database connection right now, and who is waiting for one, on every API process.'
        actions={
          <div className='flex items-center gap-2'>
            <span
              className='hidden items-center gap-1.5 text-[11px] text-slate-500 sm:inline-flex dark:text-muted-foreground'
              aria-live='polite'
            >
              <span
                aria-hidden
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  paused
                    ? 'bg-slate-400'
                    : q.isError
                      ? 'bg-amber-500'
                      : 'bg-emerald-500 motion-safe:animate-pulse'
                )}
              />
              {paused
                ? 'Paused'
                : view
                  ? `Live · ${new Date(view.at).toLocaleTimeString()}`
                  : 'Loading'}
            </span>
            <Button
              size='sm'
              variant='outline'
              className='h-8 text-[12px]'
              onClick={() => setPaused((p) => !p)}
              aria-pressed={paused}
            >
              {paused ? (
                <Play className='mr-1.5 h-3.5 w-3.5' />
              ) : (
                <Pause className='mr-1.5 h-3.5 w-3.5' />
              )}
              {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button
              size='sm'
              variant='outline'
              className='h-8 text-[12px]'
              onClick={() => void q.refetch()}
              disabled={q.isFetching}
            >
              <RefreshCw
                className={cn('mr-1.5 h-3.5 w-3.5', q.isFetching && 'motion-safe:animate-spin')}
              />
              Refresh
            </Button>
          </div>
        }
      />

      <div
        className='flex-1 space-y-4 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'
        data-pool-holders
      >
        {q.isLoading && (
          <div className='space-y-4'>
            <Skeleton className='h-28 w-full' />
            <Skeleton className='h-64 w-full' />
          </div>
        )}
        {q.isError && !view && (
          <QueryErrorState
            error={q.error}
            what='the connection holders'
            onRetry={() => void q.refetch()}
          />
        )}
        {view && !view.available && (
          <p className='rounded-lg border border-slate-200 bg-white p-4 text-[12px] text-slate-500 dark:border-border dark:bg-card'>
            Connection holders are not tracked on this deployment.
          </p>
        )}
        {view?.available && (
          <>
            {view.partial && (
              <p
                className='rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200'
                data-pool-partial
              >
                <b className='font-semibold'>
                  {view.missing.length === 1
                    ? '1 process did not answer'
                    : `${view.missing.length} processes did not answer`}
                </b>{' '}
                — the figures below leave {view.missing.length === 1 ? 'it' : 'them'} out:{' '}
                {view.missing.map((m) => nodeName(m)).join(', ')}. A process that just stopped drops
                off within 90 s.
              </p>
            )}
            {q.isError && (
              <p className='text-[11.5px] text-amber-700 dark:text-amber-400'>
                The last refresh failed — showing figures from{' '}
                {new Date(view.at).toLocaleTimeString()}.
              </p>
            )}

            <div className='grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-border dark:bg-border'>
              {view.totals.map((t) => (
                <div key={t.name} className='bg-white px-4 py-2.5 dark:bg-card'>
                  <p className='text-[11px] text-slate-400'>{POOL_LABEL[t.name]} pools</p>
                  <p className='mt-0.5 text-[15px] font-semibold tabular-nums text-slate-800 dark:text-foreground'>
                    {t.used}
                    <span className='text-[12px] font-normal text-slate-400'>
                      {' '}
                      / {t.max} in use
                    </span>
                  </p>
                </div>
              ))}
              <div className='bg-white px-4 py-2.5 dark:bg-card'>
                <p className='text-[11px] text-slate-400'>Waiting for a connection</p>
                <p
                  className={cn(
                    'mt-0.5 text-[15px] font-semibold tabular-nums',
                    view.totals.some((t) => t.waiting > 0)
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-slate-800 dark:text-foreground'
                  )}
                >
                  {view.totals.reduce((n, t) => n + t.waiting, 0)}
                </p>
              </div>
              <div className='bg-white px-4 py-2.5 dark:bg-card'>
                <p className='text-[11px] text-slate-400'>Heavy-read slots</p>
                <p className='mt-0.5 text-[15px] font-semibold tabular-nums text-slate-800 dark:text-foreground'>
                  {view.read_gate.active}
                  <span className='text-[12px] font-normal text-slate-400'>
                    {' '}
                    held · {view.read_gate.queued} queued
                  </span>
                </p>
              </div>
            </div>

            <Section
              title='Processes'
              sub={`${view.nodes.length} answering. Cyan = in use, grey = free, striped amber past the line = waiting.`}
            >
              <ProcessList view={view} />
            </Section>

            <div className='grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'>
              <Section
                title={dim === 'person' ? 'Who holds connections' : 'What holds connections'}
                sub={
                  hotCount > 0
                    ? `Marked: over ${pct(view.thresholds.hot_share)} of one process's pool.`
                    : `Nobody holds over ${pct(view.thresholds.hot_share)} of a pool.`
                }
                right={
                  <Segmented
                    label='Group by'
                    value={dim}
                    onChange={setDim}
                    options={[
                      ['person', 'By person'],
                      ['feature', 'By feature']
                    ]}
                  />
                }
              >
                <GroupTable
                  key={dim}
                  rows={dim === 'person' ? view.by_person : view.by_feature}
                  dim={dim}
                  hotShare={view.thresholds.hot_share}
                />
              </Section>

              <div className='min-w-0 space-y-4'>
                <Section title='Longest holders' sub='Open one for its request story.'>
                  <HolderList rows={view.longest} empty='No connection is checked out right now.' />
                </Section>
                {view.waiters.length > 0 && (
                  <Section title='Waiting' sub='Oldest first.'>
                    <HolderList rows={view.waiters} empty='' />
                  </Section>
                )}
              </div>
            </div>

            {view.hogs.length > 0 && (
              <Section
                title='Held most of a pool'
                sub={`Last 24 hours: one person or feature over ${pct(view.thresholds.hog_share)} of a pool for ${view.thresholds.hog_seconds} s or more.`}
              >
                <ul className='divide-y divide-slate-100 text-[12px] dark:divide-border/60'>
                  {view.hogs.map((h) => (
                    <li
                      key={`${h.node}-${h.pool}-${h.dimension}-${h.key}-${h.at}`}
                      className='flex flex-wrap gap-x-3 py-1.5'
                    >
                      <span className='tabular-nums text-slate-400'>
                        {new Date(h.since).toLocaleString()}
                      </span>
                      <span className='text-slate-700 dark:text-foreground'>
                        {h.label}{' '}
                        <span className='text-slate-400'>
                          ({h.dimension}) held {h.held} of {h.max}{' '}
                          {POOL_LABEL[h.pool].toLowerCase()} connections on {h.node}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
