import { QueryErrorState } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { Search, X } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router'
import { HubEnvTag } from '@/components/hub-brand/HubBits'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { ghostButton } from '../hub-parts'
import {
  DEP_KIND_LABEL,
  type DependencyMap,
  type DepKind,
  type DepNode,
  type DepUse,
  fetchDependencies,
  insightKeys
} from './insight-api'

/**
 * Dependencies (Apps hub tab): what each app depends on — partner API hosts, webhook hosts, the
 * mail relay, sign-in, issue trackers and extensions (as the app reported them: host names only,
 * never a path or a credential), plus its database server, shared deployment and driver from the
 * Hub's own records. Desktop: a two-column map (apps ← dependencies); pick a dependency to see
 * everything a change to it would touch, production first (`?node=` keeps the pick in the URL).
 * Phone: the dependencies as a list, same impact panel.
 */

const KIND_ORDER: DepKind[] = [
  'database',
  'shared',
  'driver',
  'partner_api',
  'webhook',
  'mail',
  'signin',
  'tracker',
  'extension'
]

const ROW = 30
const HEAD = 26
const W = 760
const LEFT_X = 8
const NODE_W = 220
const RIGHT_X = W - NODE_W - 8

export default function HubDependencies() {
  const deps = useQuery({
    queryKey: insightKeys.deps(),
    queryFn: fetchDependencies,
    staleTime: 5 * 60_000
  })
  const [params, setParams] = useSearchParams()
  const node = params.get('node') ?? ''
  const kind = params.get('kind') ?? ''
  const q = params.get('q') ?? ''
  const set = (k: string, v: string) =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p)
        if (v) out.set(k, v)
        else out.delete(k)
        return out
      },
      { replace: true }
    )

  const view = useMemo(() => filterMap(deps.data, kind, q), [deps.data, kind, q])
  const selected = deps.data?.nodes.find((n) => n.id === node && n.kind !== 'app') ?? null
  const affected = useMemo(
    () =>
      selected
        ? (deps.data?.uses ?? [])
            .filter((u) => u.node === selected.id)
            .sort(
              (a, b) =>
                Number(b.production) - Number(a.production) ||
                a.app_name.localeCompare(b.app_name) ||
                a.env_key.localeCompare(b.env_key)
            )
        : [],
    [deps.data, selected]
  )
  const kinds = useMemo(
    () => KIND_ORDER.filter((k) => deps.data?.nodes.some((n) => n.kind === k)),
    [deps.data]
  )
  const unread = (deps.data?.states ?? []).filter((s) => s.state && s.state !== 'ok').length

  return (
    <div className='flex flex-1 min-h-0 flex-col bg-slate-50 dark:bg-background'>
      <div className='shrink-0 border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
          <p className='m-0 text-[13px] font-medium text-slate-900 dark:text-foreground'>
            {deps.data
              ? `${deps.data.nodes.filter((n) => n.kind !== 'app').length} dependencies across ${deps.data.nodes.filter((n) => n.kind === 'app').length} apps`
              : 'Dependencies'}
          </p>
          {unread > 0 && (
            <p className='m-0 text-[12px] text-amber-800 dark:text-amber-300'>
              {unread} environment{unread === 1 ? '' : 's'} could not be read last time
            </p>
          )}
          <Link
            to='/docs?section=hub-insight'
            className='ml-auto px-2 text-[12px] text-slate-500 hover:underline dark:text-muted-foreground'
          >
            How this works
          </Link>
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
              placeholder='Find a host, extension or app'
              aria-label='Find'
              className='h-8 pl-8 text-[13px]'
            />
          </div>
          <SimpleSelect
            value={kind}
            onChange={(v) => set('kind', v)}
            ariaLabel='Kind'
            className='h-8 w-[180px] text-[12px]'
            options={[
              { value: '', label: 'Every kind' },
              ...kinds.map((k) => ({ value: k, label: DEP_KIND_LABEL[k] }))
            ]}
          />
        </div>
      </div>

      {deps.isPending ? (
        <div className='space-y-2 p-4'>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className='h-14 w-full' />
          ))}
        </div>
      ) : deps.isError ? (
        <div className='p-4'>
          <QueryErrorState
            error={deps.error}
            what='the dependency map'
            onRetry={() => void deps.refetch()}
          />
        </div>
      ) : (
        <div className='flex flex-1 min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden'>
          <div className='min-w-0 flex-1 p-4 lg:overflow-y-auto'>
            {view.deps.length === 0 ? (
              <div className='rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center dark:border-border dark:bg-card'>
                <p className='m-0 text-[13px] font-medium text-slate-900 dark:text-foreground'>
                  {q || kind ? 'Nothing matches' : 'No dependencies known yet'}
                </p>
                <p className='m-0 mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  {q || kind
                    ? 'Try another search or kind.'
                    : 'The Hub reads each app’s dependencies once a day over its hub link (apps 0.3.215 or later).'}
                </p>
              </div>
            ) : (
              <>
                <div className='hidden rounded-lg border border-slate-200 bg-white p-3 md:block dark:border-border dark:bg-card'>
                  <DepGraph
                    view={view}
                    selected={selected?.id ?? null}
                    onPick={(id) => set('node', id)}
                  />
                </div>
                <DepList
                  view={view}
                  selected={selected?.id ?? null}
                  onPick={(id) => set('node', id)}
                />
              </>
            )}
          </div>
          <aside
            className='shrink-0 border-t border-slate-200 bg-white lg:w-[340px] lg:overflow-y-auto lg:border-t-0 lg:border-l dark:border-border dark:bg-card'
            aria-label='Impact'
          >
            <ImpactPanel node={selected} affected={affected} onClear={() => set('node', '')} />
          </aside>
        </div>
      )}
    </div>
  )
}

interface View {
  apps: DepNode[]
  deps: DepNode[]
  edges: DependencyMap['edges']
}

function filterMap(map: DependencyMap | undefined, kind: string, q: string): View {
  if (!map) return { apps: [], deps: [], edges: [] }
  const needle = q.trim().toLowerCase()
  const appNodes = map.nodes.filter((n) => n.kind === 'app')
  const appMatch = new Set(
    appNodes.filter((a) => needle && a.label.toLowerCase().includes(needle)).map((a) => a.id)
  )
  const deps = map.nodes
    .filter((n) => n.kind !== 'app')
    .filter((n) => !kind || n.kind === kind)
    .filter(
      (n) =>
        !needle ||
        `${n.label} ${n.target}`.toLowerCase().includes(needle) ||
        map.edges.some((e) => e.to === n.id && appMatch.has(e.from))
    )
    .sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        b.environments - a.environments ||
        a.label.localeCompare(b.label)
    )
  const depIds = new Set(deps.map((d) => d.id))
  const edges = map.edges.filter((e) => depIds.has(e.to))
  const appIds = new Set(edges.map((e) => e.from))
  const apps = appNodes
    .filter((a) => appIds.has(a.id))
    .sort((a, b) => a.label.localeCompare(b.label))
  return { apps, deps, edges }
}

function DepGraph({
  view,
  selected,
  onPick
}: {
  view: View
  selected: string | null
  onPick: (id: string) => void
}) {
  // Right column: dependencies grouped by kind, a header row per group.
  const rightY = new Map<string, number>()
  const heads: Array<{ kind: DepKind; y: number }> = []
  let y = 4
  let last: DepKind | null = null
  for (const d of view.deps) {
    if (d.kind !== last) {
      heads.push({ kind: d.kind, y })
      y += HEAD
      last = d.kind
    }
    rightY.set(d.id, y)
    y += ROW
  }
  const rightH = y
  const leftGap = Math.max(ROW, (rightH - 8) / Math.max(1, view.apps.length))
  const leftY = new Map(view.apps.map((a, i) => [a.id, 4 + i * Math.min(leftGap, ROW * 1.6)]))
  const height = Math.max(rightH, 8 + view.apps.length * Math.min(leftGap, ROW * 1.6)) + 4
  const linked = selected
    ? new Set(view.edges.filter((e) => e.to === selected).map((e) => e.from))
    : null
  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      className='h-auto w-full text-[11px]'
      role='img'
      aria-label='Dependency map: apps on the left, what they depend on on the right'
    >
      {view.edges.map((e) => {
        const y1 = (leftY.get(e.from) ?? 0) + 12
        const y2 = (rightY.get(e.to) ?? 0) + 12
        const x1 = LEFT_X + NODE_W
        const x2 = RIGHT_X
        const on = selected === e.to
        const dim = selected != null && !on
        return (
          <path
            key={`${e.from}>${e.to}`}
            d={`M${x1},${y1} C${x1 + 90},${y1} ${x2 - 90},${y2} ${x2},${y2}`}
            fill='none'
            className={cn(
              'transition-[stroke-opacity] duration-200',
              on ? 'stroke-nvr-cyan' : 'stroke-slate-300 dark:stroke-slate-600'
            )}
            strokeOpacity={dim ? 0.25 : 1}
            strokeWidth={on ? 1.75 : 1}
          />
        )
      })}
      {view.apps.map((a) => {
        const ay = leftY.get(a.id) ?? 0
        const dim = linked != null && !linked.has(a.id)
        return (
          <g key={a.id} opacity={dim ? 0.4 : 1}>
            <rect
              x={LEFT_X}
              y={ay}
              width={NODE_W}
              height={24}
              rx={6}
              className='fill-slate-100 stroke-slate-300 dark:fill-muted dark:stroke-border'
            />
            <text
              x={LEFT_X + 10}
              y={ay + 16}
              className='fill-slate-900 font-medium dark:fill-foreground'
            >
              {clip(a.label, 30)}
            </text>
          </g>
        )
      })}
      {heads.map((h) => (
        <text
          key={h.kind}
          x={RIGHT_X}
          y={h.y + 16}
          className='fill-slate-500 text-[10px] font-semibold dark:fill-muted-foreground'
        >
          {DEP_KIND_LABEL[h.kind]}
        </text>
      ))}
      {view.deps.map((d) => {
        const dy = rightY.get(d.id) ?? 0
        const on = selected === d.id
        return (
          // biome-ignore lint/a11y/useSemanticElements: an SVG node cannot be a <button>; it is focusable and keyboard-operable
          <g
            key={d.id}
            role='button'
            tabIndex={0}
            aria-pressed={on}
            aria-label={`${DEP_KIND_LABEL[d.kind]}: ${d.label}, ${d.environments} environment${d.environments === 1 ? '' : 's'}`}
            className='cursor-pointer outline-none [&:focus-visible>rect]:stroke-nvr-cyan'
            onClick={() => onPick(on ? '' : d.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onPick(on ? '' : d.id)
              }
            }}
          >
            <rect
              x={RIGHT_X}
              y={dy}
              width={NODE_W}
              height={24}
              rx={6}
              strokeWidth={on ? 1.75 : 1}
              className={cn(
                'transition-colors duration-150',
                on
                  ? 'fill-nvr-cyan/10 stroke-nvr-cyan'
                  : 'fill-card stroke-slate-300 hover:fill-slate-50 dark:stroke-border dark:hover:fill-muted'
              )}
            />
            <text x={RIGHT_X + 10} y={dy + 16} className='fill-slate-900 dark:fill-foreground'>
              {clip(d.label, 26)}
            </text>
            <text
              x={RIGHT_X + NODE_W - 10}
              y={dy + 16}
              textAnchor='end'
              className='fill-slate-500 tabular-nums dark:fill-muted-foreground'
            >
              {d.environments}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function DepList({
  view,
  selected,
  onPick
}: {
  view: View
  selected: string | null
  onPick: (id: string) => void
}) {
  const groups = KIND_ORDER.map((k) => ({
    kind: k,
    items: view.deps.filter((d) => d.kind === k)
  })).filter((g) => g.items.length)
  return (
    <div className='space-y-3 md:hidden'>
      {groups.map((g) => (
        <section
          key={g.kind}
          className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
        >
          <h3 className='m-0 border-b border-slate-200 px-3 py-2 text-[12px] font-semibold text-slate-600 dark:border-border dark:text-slate-300'>
            {DEP_KIND_LABEL[g.kind]}
          </h3>
          <ul className='m-0 list-none p-1'>
            {g.items.map((d) => (
              <li key={d.id}>
                <button
                  type='button'
                  aria-pressed={selected === d.id}
                  onClick={() => onPick(selected === d.id ? '' : d.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                    selected === d.id && 'bg-accent'
                  )}
                >
                  <span className='min-w-0 flex-1 truncate text-slate-900 dark:text-foreground'>
                    {d.label}
                  </span>
                  <span className='text-[12px] tabular-nums text-slate-500 dark:text-muted-foreground'>
                    {d.environments}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function ImpactPanel({
  node,
  affected,
  onClear
}: {
  node: DepNode | null
  affected: DepUse[]
  onClear: () => void
}) {
  if (!node)
    return (
      <div className='p-4'>
        <p className='m-0 text-[13px] font-medium text-slate-900 dark:text-foreground'>
          Impact of a change
        </p>
        <p className='m-0 mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Pick a dependency to list every app and environment that would feel a change to it — a
          host moving, a database server patched, an extension upgraded.
        </p>
      </div>
    )
  const apps = new Set(affected.map((a) => a.app_id)).size
  const prod = affected.filter((a) => a.production).length
  return (
    <div className='p-4'>
      <div className='flex items-start gap-2'>
        <div className='min-w-0 flex-1'>
          <p className='m-0 text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
            {DEP_KIND_LABEL[node.kind]}
          </p>
          <h2 className='m-0 break-words text-[14px] font-semibold text-slate-900 dark:text-foreground'>
            {node.label}
          </h2>
          {node.label !== node.target && (
            <p className='m-0 break-all font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
              {node.target}
            </p>
          )}
        </div>
        <button type='button' className={ghostButton} onClick={onClear} aria-label='Clear the pick'>
          <X className='h-3.5 w-3.5' aria-hidden />
        </button>
      </div>
      <p className='m-0 mt-3 text-[12px] text-slate-700 dark:text-slate-200'>
        {affected.length} environment{affected.length === 1 ? '' : 's'} in {apps} app
        {apps === 1 ? '' : 's'}
        {prod > 0 && (
          <>
            {' · '}
            <span className='font-medium text-red-700 dark:text-red-300'>{prod} production</span>
          </>
        )}
      </p>
      <ul className='m-0 mt-3 list-none space-y-1 p-0'>
        {affected.map((a) => (
          <li
            key={`${a.environment_id}-${a.label ?? ''}`}
            className='rounded-md border border-slate-200 px-3 py-2 dark:border-border'
          >
            <Link
              to={`/hub?app=${a.app_id}`}
              className='text-[13px] font-medium text-slate-900 hover:underline dark:text-foreground'
            >
              {a.app_name} <span className='text-slate-400'>/</span> {a.env_key}
            </Link>
            <HubEnvTag envKey={a.env_key} className='ml-1.5 align-[1px]' />
            {(a.label || a.detail) && (
              <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
                {[a.label, a.detail].filter(Boolean).join(' · ')}
                {a.source === 'hub' ? ' · Hub record' : ''}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
