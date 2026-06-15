import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  ArrowRight,
  Database,
  FileImage,
  GitBranch,
  LayoutGrid,
  PuzzleIcon,
  Radio,
  TrendingUp,
  Users,
  Zap
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { type CMSField, type Collection, api } from "@/lib/api"
import { useAuth } from '@/lib/auth'
import { extractTemplateFields, renderDisplayTemplate } from '@/lib/relations'
import { cn, formatDateTime, formatNumber, titleCase } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type HealthData = {
  status: 'ok' | 'degraded'
  version: string
  environment: string
  db: { status: 'connected' | 'disconnected'; database: string; host: string }
  redis: { status: 'connected' | 'disconnected'; url: string }
}

type ActivityEntry = {
  id: number
  action: 'create' | 'update' | 'delete' | 'read' | string
  user: string | null
  first_name: string | null
  last_name: string | null
  user_email: string | null
  collection: string
  item: string | null
  comment: string | null
  timestamp: string
}

const PIPELINE_ACTIONS = new Set(['pipeline-transition', 'pipeline-start'])
const ITEM_LABEL_FALLBACKS = ['name', 'title', 'label', 'display_name', 'subject', 'email', 'slug']

function useActivityItemLabel(collection: string | null, item: string | null) {
  const isSystem = !collection || collection.startsWith('nivaro_') || collection.startsWith('directus_')
  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    staleTime: 120_000, enabled: !isSystem && !!collection, retry: false
  })
  const displayTemplate: string | null = colMeta?.display_template ?? null
  const actualFields: string[] = (colMeta?.fields ?? []).map((f: CMSField) => f.field)
  const wantedFields = [...new Set(['id', ...extractTemplateFields(displayTemplate), ...ITEM_LABEL_FALLBACKS])]
  const safeFields = actualFields.length
    ? wantedFields.filter((f) => f === 'id' || actualFields.includes(f)).join(',')
    : null
  const { data: itemData } = useQuery({
    queryKey: ['activity-item-label', collection, item, safeFields],
    queryFn: () =>
      api.get(`/items/${collection}/${item}`, { params: { fields: safeFields } }).then((r) => r.data.data),
    staleTime: 120_000, enabled: !isSystem && !!safeFields && !!item, retry: false
  })
  const label = itemData ? renderDisplayTemplate(displayTemplate, itemData) : null
  return label && label !== item && label.trim() !== '' ? label : null
}

function ActivityItemRow({
  entry,
  collections,
  onClick
}: {
  entry: ActivityEntry
  collections: Collection[]
  onClick: () => void
}) {
  const itemLabel = useActivityItemLabel(entry.collection, entry.item)
  const isPipeline = PIPELINE_ACTIONS.has(entry.action)

  const colDisplay = (() => {
    const found = collections.find((c) => c.collection === entry.collection)
    if (found?.display_name) return found.display_name
    return entry.collection ? titleCase(entry.collection.replace(/^nivaro_/, '').replace(/_/g, ' ')) : 'System'
  })()

  return (
    <button
      type='button'
      className='flex w-full cursor-pointer items-start gap-3 px-5 py-3 text-left transition-colors hover:bg-slate-50/70'
      onClick={onClick}
    >
      <ActionBadge action={entry.action} />
      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-baseline gap-x-1.5'>
          <span className='text-[12px] font-medium text-slate-700'>{colDisplay}</span>
          {!isPipeline && entry.item && (
            <span className='text-[11px] text-slate-500'>
              {itemLabel ?? <span className='font-mono'>#{entry.item}</span>}
            </span>
          )}
          {entryUserName(entry) && (
            <span className='text-[11px] text-slate-400'>· {entryUserName(entry)}</span>
          )}
        </div>
        {isPipeline && entry.comment && (
          <p className='mt-0.5 truncate text-[11px] text-slate-500'>{entry.comment}</p>
        )}
      </div>
      <span className='shrink-0 text-[11px] text-slate-400'>
        {formatDateTime(entry.timestamp)}
      </span>
    </button>
  )
}

function entryUserName(entry: ActivityEntry): string | null {
  if (entry.first_name || entry.last_name)
    return [entry.first_name, entry.last_name].filter(Boolean).join(' ')
  if (entry.user_email) return entry.user_email
  return null
}

type Extension = { id: string; name?: string }
type Flow = { id: string; name?: string }

// ─── Action badge ─────────────────────────────────────────────────────────────

function formatAction(action: string): string {
  return action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const ACTION_CLS: Record<string, string> = {
  create: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  update: 'bg-sky-50 text-sky-700 border-sky-200',
  delete: 'bg-red-50 text-red-600 border-red-200',
  read: 'bg-slate-50 text-slate-500 border-slate-200',
  login: 'bg-violet-50 text-violet-700 border-violet-200'
}

function ActionBadge({ action }: { action: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-semibold',
        ACTION_CLS[action] ?? 'bg-slate-50 text-slate-500 border-slate-200'
      )}
    >
      {formatAction(action)}
    </span>
  )
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  iconCls,
  loading
}: {
  label: string
  value: React.ReactNode
  sub?: string
  icon: React.ElementType
  iconCls: string
  loading?: boolean
}) {
  return (
    <div className='rounded-xl border border-slate-200 bg-white p-5'>
      <div className='flex items-start justify-between'>
        <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg', iconCls)}>
          <Icon className='h-4 w-4' />
        </div>
        <TrendingUp className='h-3.5 w-3.5 text-slate-300' />
      </div>
      <div className='mt-4'>
        {loading ? (
          <Skeleton className='h-8 w-14 rounded' />
        ) : (
          <p className='text-[30px] font-semibold tabular-nums leading-none tracking-tight text-slate-900'>
            {value}
          </p>
        )}
        <p className='mt-1.5 text-[11px] font-medium text-slate-500'>{label}</p>
        {sub && <p className='mt-0.5 text-[11px] text-slate-400'>{sub}</p>}
      </div>
    </div>
  )
}

// ─── Quick action card ────────────────────────────────────────────────────────

function QuickAction({
  label,
  description,
  icon: Icon,
  iconCls,
  onClick
}: {
  label: string
  description: string
  icon: React.ElementType
  iconCls: string
  onClick: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      className='group flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 text-left transition-all hover:border-nvr-cyan/40 hover:shadow-sm hover:shadow-nvr-cyan/10'
    >
      <div
        className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', iconCls)}
      >
        <Icon className='h-5 w-5' />
      </div>
      <div className='min-w-0 flex-1'>
        <p className='text-[13px] font-semibold text-slate-800'>{label}</p>
        <p className='text-[11px] text-slate-400'>{description}</p>
      </div>
      <ArrowRight className='h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-nvr-cyan' />
    </button>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { user } = useAuth()
  const navigate = useNavigate()

  const { data: collectionsData, isLoading: collectionsLoading } = useQuery({
    queryKey: ['dashboard-stats', 'collections'],
    queryFn: () => api.get('/collections').then((r) => r.data.data)
  })

  const { data: usersData, isLoading: usersLoading } = useQuery({
    queryKey: ['dashboard-stats', 'users'],
    queryFn: () => api.get('/users?limit=1').then((r) => r.data)
  })

  const { data: filesData, isLoading: filesLoading } = useQuery({
    queryKey: ['dashboard-stats', 'files'],
    queryFn: () =>
      api
        .get('/files?limit=1')
        .then((r) => r.data)
        .catch(() => null)
  })

  const { data: activityData, isLoading: activityLoading } = useQuery({
    queryKey: ['activity', 'recent'],
    queryFn: () => api.get('/activity?limit=10&sort=-timestamp').then((r) => r.data)
  })

  const { data: extensionsData } = useQuery({
    queryKey: ['dashboard-stats', 'extensions'],
    queryFn: () =>
      api
        .get('/extensions')
        .then((r) => r.data)
        .catch(() => ({ data: [] }))
  })

  const { data: flowsData } = useQuery({
    queryKey: ['dashboard-stats', 'flows'],
    queryFn: () =>
      api
        .get('/flows')
        .then((r) => r.data)
        .catch(() => ({ data: [] }))
  })

  const { data: presenceData } = useQuery({
    queryKey: ['presence-sessions'],
    queryFn: () =>
      api
        .get<{ data: unknown[]; total: number }>('/presence/sessions')
        .then((r) => r.data)
        .catch(() => null),
    refetchInterval: 10_000
  })

  const [onlineCount, setOnlineCount] = useState<number | null>(null)
  const liveCount = onlineCount ?? presenceData?.total ?? null

  useEffect(() => {
    let socket: {
      emit(...a: unknown[]): void
      on(ev: string, cb: (...a: unknown[]) => void): void
      disconnect(): void
    } | null = null
    import('socket.io-client')
      .then(({ io }) => {
        socket = io(window.location.origin, {
          transports: ["websocket", "polling"],
          path: '/socket.io'
        }) as typeof socket
        socket?.on('connect', () => socket?.emit('presence:join', 'admin'))
        socket?.on('presence:update', (p: unknown) => {
          const payload = p as { sessions: unknown[] }
          setOnlineCount(payload.sessions.length)
        })
      })
      .catch(() => {})
    return () => {
      socket?.disconnect()
    }
  }, [])

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () =>
      api
        .get<HealthData>('/health')
        .then((r) => r.data)
        .catch(() => null),
    refetchInterval: 30_000
  })

  const greeting = (() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
  })()

  const displayName =
    [user?.first_name, user?.last_name]
      .map((s) => s?.trim())
      .filter(Boolean)
      .join(' ') || user?.email

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })

  const activityEntries: ActivityEntry[] = activityData?.data ?? []
  const extensions: Extension[] = extensionsData?.data ?? []
  const flows: Flow[] = flowsData?.data ?? []

  // Count activity in last 24h
  const yesterday = Date.now() - 86_400_000
  const recentCount = activityEntries.filter(
    (a) => new Date(a.timestamp).getTime() > yesterday
  ).length

  return (
    <>
      {/* ── Page header ──────────────────────────────────────────── */}
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5'>
        <div className='flex items-center justify-between'>
          <div>
            <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900'>
              {greeting}, {displayName}
            </h1>
          </div>
          {health && (
            <div
              className={cn(
                'flex items-center gap-1.5 text-[12px] font-medium',
                health.status === 'ok' ? 'text-emerald-600' : 'text-amber-600'
              )}
            >
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full',
                  health.status === 'ok' ? 'animate-pulse bg-emerald-500' : 'bg-amber-500'
                )}
              />
              {health.status === 'ok' ? 'All systems operational' : 'System degraded'}
            </div>
          )}
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────── */}
      <div className='p-8'>
        <div className='grid grid-cols-1 gap-8 lg:grid-cols-[1fr_280px]'>
          {/* ── Left column ──────────────────────────────────── */}
          <div className='space-y-6'>
            {/* Stats row */}
            <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
              <StatCard
                label='Users'
                value={formatNumber(usersData?.total)}
                sub='Registered accounts'
                icon={Users}
                iconCls='bg-nvr-cyan/[0.1] text-nvr-navy dark:bg-nvr-cyan/20 dark:text-nvr-cyan'
                loading={usersLoading}
              />
              <StatCard
                label='Collections'
                value={formatNumber(collectionsData?.length)}
                sub='Metadata registry'
                icon={Database}
                iconCls='bg-nvr-cyan/[0.1] text-nvr-navy dark:bg-nvr-cyan/20 dark:text-nvr-cyan'
                loading={collectionsLoading}
              />
              <StatCard
                label='Files'
                value={formatNumber(filesData?.total)}
                sub='Stored assets'
                icon={FileImage}
                iconCls='bg-amber-50 text-amber-600'
                loading={filesLoading}
              />
              <StatCard
                label='Activity (24h)'
                value={activityLoading ? undefined : formatNumber(recentCount)}
                sub='Events recorded'
                icon={Activity}
                iconCls='bg-emerald-50 text-emerald-600'
                loading={activityLoading}
              />
            </div>

            {/* Quick actions */}
            <div>
              <h2 className='mb-3 text-[11px] font-medium text-slate-500'>Quick Actions</h2>
              <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
                <QuickAction
                  label='Browse Collections'
                  description='View and manage data registries'
                  icon={LayoutGrid}
                  iconCls='bg-nvr-cyan/[0.1] text-nvr-navy dark:bg-nvr-cyan/20 dark:text-nvr-cyan'
                  onClick={() => navigate('/collections')}
                />
                <QuickAction
                  label='Manage Users'
                  description='Add, edit, or suspend accounts'
                  icon={Users}
                  iconCls='bg-slate-100 text-slate-600'
                  onClick={() => navigate('/users')}
                />
                <QuickAction
                  label='Upload Files'
                  description='Add assets to the file library'
                  icon={FileImage}
                  iconCls='bg-amber-50 text-amber-600'
                  onClick={() => navigate('/files')}
                />
                <QuickAction
                  label='View Activity Log'
                  description='Full audit trail of all events'
                  icon={Activity}
                  iconCls='bg-emerald-50 text-emerald-600'
                  onClick={() => navigate('/activity')}
                />
              </div>
            </div>

            {/* Recent activity feed */}
            <div>
              <div className='mb-3 flex items-center justify-between'>
                <h2 className='text-[11px] font-medium text-slate-500'>Recent Activity</h2>
                <button
                  type='button'
                  onClick={() => navigate('/activity')}
                  className='flex items-center gap-1 text-[11px] font-medium text-nvr-cyan hover:underline'
                >
                  View all <ArrowRight className='h-3 w-3' />
                </button>
              </div>

              <div className='overflow-hidden rounded-xl border border-slate-200 bg-white'>
                {activityLoading ? (
                  <div className='divide-y divide-slate-100'>
                    {(['a', 'b', 'c', 'd', 'e', 'f'] as const).map((k) => (
                      <div key={k} className='flex items-center gap-3 px-5 py-3.5'>
                        <Skeleton className='h-5 w-14 rounded' />
                        <Skeleton className='h-4 w-40' />
                        <Skeleton className='ml-auto h-4 w-16' />
                      </div>
                    ))}
                  </div>
                ) : activityEntries.length === 0 ? (
                  <div className='py-16 text-center'>
                    <Activity className='mx-auto h-8 w-8 text-slate-200' />
                    <p className='mt-3 text-[13px] text-slate-400'>No activity yet.</p>
                  </div>
                ) : (
                  <div className='divide-y divide-slate-100'>
                    {activityEntries.map((entry) => (
                      <ActivityItemRow
                        key={entry.id}
                        entry={entry}
                        collections={collectionsData ?? []}
                        onClick={() => navigate(`/activity/${entry.id}`)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Right sidebar ─────────────────────────────────── */}
          <div className='space-y-4'>
            {/* Version / env panel */}
            <div className='rounded-xl border border-slate-200 bg-white p-5'>
              <div className='mb-4 flex items-center gap-2.5'>
                <div className='flex h-8 w-8 items-center justify-center rounded-lg bg-nvr-navy'>
                  <svg width='18' height='18' viewBox='0 0 24 24' fill='none' aria-hidden='true'>
                    <polyline
                      points='4,20 4,4 20,20 20,4'
                      fill='none'
                      stroke='#00ceff'
                      strokeWidth='3.5'
                      strokeLinecap='round'
                      strokeLinejoin='miter'
                    />
                  </svg>
                </div>
                <div>
                  <p className='text-[13px] font-semibold text-slate-900'>Nivaro</p>
                  <p className='text-[11px] text-slate-400'>Headless CMS</p>
                </div>
              </div>
              <div className='space-y-2.5'>
                <InfoRow label='Version' value={health?.version ?? '—'} />
                <InfoRow
                  label='Environment'
                  value={health?.environment ?? '—'}
                  highlight={health?.environment === 'production'}
                />
                <InfoRow
                  label='Database'
                  value={health ? `${health.db.database} (MSSQL)` : '—'}
                  ok={health?.db.status === 'connected'}
                  err={health?.db.status === 'disconnected'}
                />
                <InfoRow
                  label='Session store'
                  value={health ? 'Redis' : '—'}
                  ok={health?.redis.status === 'connected'}
                  err={health?.redis.status === 'disconnected'}
                />
              </div>
            </div>

            {/* Extensions */}
            <div className='rounded-xl border border-slate-200 bg-white p-5'>
              <div className='mb-3 flex items-center justify-between'>
                <div className='flex items-center gap-2'>
                  <PuzzleIcon className='h-3.5 w-3.5 text-slate-400' />
                  <p className='text-[12px] font-semibold text-slate-700'>Extensions</p>
                </div>
                <button
                  type='button'
                  onClick={() => navigate('/extensions')}
                  className='text-[11px] text-nvr-cyan hover:underline'
                >
                  View all
                </button>
              </div>
              <p className='text-[28px] font-semibold tabular-nums leading-none text-slate-900'>
                {formatNumber(extensions.length)}
              </p>
              <p className='mt-1 text-[11px] text-slate-400'>
                {extensions.length === 1 ? 'plugin active' : 'plugins active'}
              </p>
            </div>

            {/* Flows */}
            <div className='rounded-xl border border-slate-200 bg-white p-5'>
              <div className='mb-3 flex items-center justify-between'>
                <div className='flex items-center gap-2'>
                  <GitBranch className='h-3.5 w-3.5 text-slate-400' />
                  <p className='text-[12px] font-semibold text-slate-700'>Flows</p>
                </div>
                <button
                  type='button'
                  onClick={() => navigate('/flows')}
                  className='text-[11px] text-nvr-cyan hover:underline'
                >
                  View all
                </button>
              </div>
              <p className='text-[28px] font-semibold tabular-nums leading-none text-slate-900'>
                {formatNumber(flows.length)}
              </p>
              <p className='mt-1 text-[11px] text-slate-400'>
                {flows.length === 1 ? 'automation flow' : 'automation flows'}
              </p>
            </div>

            {/* Online users */}
            <div className='rounded-xl border border-slate-200 bg-white p-5'>
              <div className='mb-3 flex items-center justify-between'>
                <div className='flex items-center gap-2'>
                  <Radio className='h-3.5 w-3.5 text-slate-400' />
                  <p className='text-[12px] font-semibold text-slate-700'>Online Now</p>
                </div>
                <div className='flex items-center gap-2'>
                  <span className='relative flex h-2 w-2'>
                    <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75' />
                    <span className='relative inline-flex h-2 w-2 rounded-full bg-emerald-500' />
                  </span>
                  <button
                    type='button'
                    onClick={() => navigate('/presence')}
                    className='text-[11px] text-nvr-cyan hover:underline'
                  >
                    View all
                  </button>
                </div>
              </div>
              <p className='text-[28px] font-semibold tabular-nums leading-none text-slate-900'>
                {liveCount ?? '—'}
              </p>
              <p className='mt-1 text-[11px] text-slate-400'>
                {liveCount === 1 ? 'active session' : 'active sessions'}
              </p>
            </div>

            {/* Quick links */}
            <div className='rounded-xl border border-slate-200 bg-white p-5'>
              <div className='mb-3 flex items-center gap-2'>
                <Zap className='h-3.5 w-3.5 text-slate-400' />
                <p className='text-[12px] font-semibold text-slate-700'>Quick Links</p>
              </div>
              <div className='space-y-1'>
                {[
                  { label: 'Roles & Permissions', to: '/roles' },
                  { label: 'Settings', to: '/settings' },
                  { label: 'Extensions', to: '/extensions' },
                  { label: 'Flows', to: '/flows' }
                ].map((link) => (
                  <button
                    key={link.to}
                    type='button'
                    onClick={() => navigate(link.to)}
                    className='flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-[12px] text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900'
                  >
                    {link.label}
                    <ArrowRight className='h-3 w-3 text-slate-300' />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function InfoRow({
  label,
  value,
  highlight,
  ok,
  err
}: {
  label: string
  value: string
  highlight?: boolean
  ok?: boolean
  err?: boolean
}) {
  return (
    <div className='flex items-center justify-between'>
      <span className='text-[11px] text-slate-400'>{label}</span>
      <div className='flex items-center gap-1.5'>
        {ok && <span className='h-1.5 w-1.5 rounded-full bg-emerald-500' />}
        {err && <span className='h-1.5 w-1.5 rounded-full bg-red-500' />}
        <span
          className={cn(
            'text-[11px] font-medium',
            err ? 'text-red-600' : highlight ? 'text-emerald-600' : 'text-slate-700'
          )}
        >
          {value}
        </span>
      </div>
    </div>
  )
}
