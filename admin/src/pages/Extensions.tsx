import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Download,
  Inbox,
  Package,
  Puzzle,
  RefreshCw,
  ScrollText,
  Settings as SettingsIcon,
  Store,
  Trash2,
  XCircle
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePersistedTab } from '@/hooks/usePersistedTab'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type Extension = {
  id: string
  status: 'loaded' | 'error' | 'missing'
  enabled: boolean
  path: string
  error?: string
  scopes?: string[]
  requires?: string[]
  has_settings?: boolean
  has_health_check?: boolean
  /** Capability manifest (#660): declared by the export vs observed by the loader. */
  capabilities?: { declared: string[]; observed: string[] }
}

type ExtensionEvent = {
  id: number
  extension: string
  event_type: string
  payload: string | null
  status: 'pending' | 'delivered' | 'failed' | 'dead'
  attempts: number
  last_error: string | null
  next_attempt_at: string | null
  created_at: string
  delivered_at: string | null
}

type MarketplaceExtension = {
  name: string
  description: string
  version: string
  tarball_url?: string
  builtin?: boolean
  installed: boolean
}

function StatusIcon({ status }: { status: Extension['status'] }) {
  if (status === 'loaded') return <CheckCircle2 className='h-3.5 w-3.5 text-emerald-500' />
  if (status === 'error') return <XCircle className='h-3.5 w-3.5 text-red-500' />
  return <AlertTriangle className='h-3.5 w-3.5 text-amber-500' />
}

// ─── Marketplace tab ──────────────────────────────────────────────────────────

function MarketplaceTab() {
  const queryClient = useQueryClient()
  const [confirmAction, setConfirmAction] = useState<{
    name: string
    action: 'install' | 'uninstall'
  } | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['extensions-marketplace'],
    queryFn: () =>
      api
        .get<{ data: MarketplaceExtension[]; source: string; error?: string }>(
          '/extensions/marketplace'
        )
        .then((r) => r.data)
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['extensions-marketplace'] })
    queryClient.invalidateQueries({ queryKey: ['extensions'] })
  }

  const installMut = useMutation({
    mutationFn: (ext: MarketplaceExtension) =>
      api.post('/extensions/marketplace/install', {
        name: ext.name,
        ...(ext.tarball_url ? { tarball_url: ext.tarball_url } : {})
      }),
    onSuccess: (_r, ext) => {
      setConfirmAction(null)
      toast.success(`Installed ${ext.name}`)
      invalidate()
    },
    onError: (err) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Install failed')
    }
  })

  const uninstallMut = useMutation({
    mutationFn: (name: string) => api.post('/extensions/marketplace/uninstall', { name }),
    onSuccess: (_r, name) => {
      setConfirmAction(null)
      toast.success(`Uninstalled ${name}`)
      invalidate()
    },
    onError: () => toast.error('Uninstall failed')
  })

  if (isLoading) {
    return (
      <div className='grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3'>
        {[1, 2, 3].map((k) => (
          <Skeleton key={k} className='h-32 rounded-xl' />
        ))}
      </div>
    )
  }

  const entries = data?.data ?? []

  return (
    <div>
      {data?.error && (
        <div className='mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400'>
          Registry unreachable: {data.error}
        </div>
      )}
      {entries.length === 0 ? (
        <div className='flex flex-col items-center justify-center py-20 text-center'>
          <Store className='mb-3 h-9 w-9 text-slate-300 dark:text-slate-600' />
          <p className='text-[13px] font-medium text-slate-600 dark:text-foreground'>
            No extensions available
          </p>
          <p className='mt-1 text-[12px] text-slate-400 dark:text-muted-foreground'>
            Set{' '}
            <code className='rounded bg-slate-100 px-1 py-0.5 text-[11px] dark:bg-muted'>
              EXTENSION_REGISTRY_URL
            </code>{' '}
            to point at a registry index.
          </p>
        </div>
      ) : (
        <div className='grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3'>
          {entries.map((ext) => {
            const confirming = confirmAction?.name === ext.name
            return (
              <div
                key={ext.name}
                className='flex flex-col rounded-xl border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
              >
                <div className='flex items-start gap-2.5'>
                  <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-nvr-cyan/10'>
                    <Package className='h-4 w-4 text-nvr-cyan' />
                  </div>
                  <div className='min-w-0 flex-1'>
                    <div className='flex items-center gap-1.5'>
                      <code className='truncate font-mono text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
                        {ext.name}
                      </code>
                      {ext.installed && (
                        <Badge variant='success' className='text-[10px]'>
                          installed
                        </Badge>
                      )}
                    </div>
                    <p className='mt-0.5 text-[10.5px] text-slate-400'>
                      v{ext.version}
                      {ext.builtin ? ' · built-in example' : ''}
                    </p>
                  </div>
                </div>
                <p className='mt-2.5 flex-1 text-[12px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
                  {ext.description}
                </p>
                <div className='mt-3 flex items-center justify-end gap-2 border-t border-slate-100 pt-3 dark:border-border'>
                  {confirming && confirmAction ? (
                    <>
                      <span className='mr-auto text-[11px] text-slate-500'>
                        {confirmAction.action === 'install' ? 'Install' : 'Uninstall'} {ext.name}?
                      </span>
                      <Button
                        size='sm'
                        variant={confirmAction.action === 'uninstall' ? 'destructive' : 'default'}
                        className='h-6 text-[11px]'
                        disabled={installMut.isPending || uninstallMut.isPending}
                        onClick={() =>
                          confirmAction.action === 'install'
                            ? installMut.mutate(ext)
                            : uninstallMut.mutate(ext.name)
                        }
                      >
                        {installMut.isPending || uninstallMut.isPending ? 'Working…' : 'Confirm'}
                      </Button>
                      <Button
                        size='sm'
                        variant='outline'
                        className='h-6 text-[11px]'
                        onClick={() => setConfirmAction(null)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : ext.installed ? (
                    <Button
                      size='sm'
                      variant='outline'
                      className='h-6 gap-1.5 text-[11px] text-red-600 hover:text-red-700'
                      onClick={() => setConfirmAction({ name: ext.name, action: 'uninstall' })}
                    >
                      <Trash2 className='h-3 w-3' />
                      Uninstall
                    </Button>
                  ) : (
                    <Button
                      size='sm'
                      className='h-6 gap-1.5 text-[11px]'
                      onClick={() => setConfirmAction({ name: ext.name, action: 'install' })}
                    >
                      <Download className='h-3 w-3' />
                      Install
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Extension event outbox tab (#504) ───────────────────────────────────────

const EVENT_STATUSES = ['all', 'pending', 'failed', 'dead', 'delivered'] as const

const EVENT_BADGE: Record<ExtensionEvent['status'], 'success' | 'warning' | 'destructive'> = {
  delivered: 'success',
  pending: 'warning',
  failed: 'warning',
  dead: 'destructive'
}

function EventsTab() {
  const qc = useQueryClient()
  const [status, setStatus] = useState<(typeof EVENT_STATUSES)[number]>('all')
  const [page, setPage] = useState(1)

  const { data, isLoading } = useQuery({
    queryKey: ['extension-events', status, page],
    queryFn: () =>
      api
        .get<{ data: ExtensionEvent[]; total: number; limit: number }>('/extension-events', {
          params: { ...(status !== 'all' ? { status } : {}), page, limit: 50 }
        })
        .then((r) => r.data),
    refetchInterval: 15_000
  })

  const act = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'retry' | 'discard' }) =>
      api.post(`/extension-events/${id}/${action}`),
    onSuccess: (_r, v) => {
      toast.success(v.action === 'retry' ? 'Queued for redelivery' : 'Discarded')
      void qc.invalidateQueries({ queryKey: ['extension-events'] })
    },
    onError: (err) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Action failed')
    }
  })

  const rows = data?.data ?? []
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / (data?.limit ?? 50)))

  return (
    <div>
      <div className='mb-4 flex items-center gap-1.5'>
        {EVENT_STATUSES.map((s) => (
          <button
            key={s}
            type='button'
            onClick={() => {
              setStatus(s)
              setPage(1)
            }}
            className={cn(
              'rounded-full px-2.5 py-1 text-[11.5px] font-medium capitalize transition-colors',
              status === s
                ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                : 'text-slate-500 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
            )}
          >
            {s}
          </button>
        ))}
        <span className='ml-auto text-[11.5px] text-slate-400 dark:text-muted-foreground'>
          {total} event{total === 1 ? '' : 's'}
        </span>
      </div>

      {isLoading ? (
        <div className='space-y-px overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
          {[1, 2, 3].map((k) => (
            <Skeleton key={k} className='h-11 rounded-none' />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className='flex flex-col items-center justify-center py-20 text-center'>
          <Inbox className='mb-3 h-9 w-9 text-slate-300 dark:text-slate-600' />
          <p className='text-[13px] font-medium text-slate-600 dark:text-foreground'>
            No {status === 'all' ? '' : `${status} `}extension events
          </p>
          <p className='mt-1 max-w-md text-[12px] text-slate-400 dark:text-muted-foreground'>
            Extensions publish durable events via{' '}
            <code className='font-mono'>ctx.events.publish()</code>; delivery attempts, backoff and
            dead letters land here.
          </p>
        </div>
      ) : (
        <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
          <table className='w-full text-[12.5px]'>
            <thead>
              <tr className='border-b border-slate-100 bg-slate-50 dark:border-border dark:bg-muted/30'>
                {['Event', 'Status', 'Attempts', 'Created', 'Next attempt', ''].map((h) => (
                  <th
                    key={h}
                    className='px-4 py-2.5 text-left text-[11px] font-medium text-slate-400 dark:text-muted-foreground'
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-100 dark:divide-border'>
              {rows.map((ev) => (
                <tr key={ev.id} className='bg-white dark:bg-card'>
                  <td className='px-4 py-3'>
                    <code className='font-mono text-[12px] font-semibold text-slate-800 dark:text-foreground'>
                      {ev.extension}
                      <span className='text-slate-400'>:</span>
                      {ev.event_type}
                    </code>
                    {ev.last_error && (
                      <p
                        className='mt-0.5 line-clamp-1 font-mono text-[10.5px] text-red-500'
                        data-tip={ev.last_error}
                      >
                        {ev.last_error}
                      </p>
                    )}
                  </td>
                  <td className='px-4 py-3'>
                    <Badge variant={EVENT_BADGE[ev.status]} className='text-[10.5px] capitalize'>
                      {ev.status}
                    </Badge>
                  </td>
                  <td className='px-4 py-3 tabular-nums text-slate-500 dark:text-muted-foreground'>
                    {ev.attempts}
                  </td>
                  <td
                    className='px-4 py-3 text-[11.5px] text-slate-400 dark:text-muted-foreground'
                    data-tip={ev.created_at}
                  >
                    {new Date(ev.created_at).toLocaleString()}
                  </td>
                  <td className='px-4 py-3 text-[11.5px] text-slate-400 dark:text-muted-foreground'>
                    {ev.status === 'delivered' && ev.delivered_at
                      ? `delivered ${new Date(ev.delivered_at).toLocaleTimeString()}`
                      : ev.next_attempt_at
                        ? new Date(ev.next_attempt_at).toLocaleString()
                        : '—'}
                  </td>
                  <td className='px-4 py-3 text-right'>
                    {ev.status !== 'delivered' && (
                      <span className='inline-flex items-center gap-1.5'>
                        <Button
                          size='sm'
                          variant='outline'
                          className='h-6 text-[11px]'
                          disabled={act.isPending}
                          onClick={() => act.mutate({ id: ev.id, action: 'retry' })}
                        >
                          Retry
                        </Button>
                        {ev.status !== 'dead' && (
                          <Button
                            size='sm'
                            variant='outline'
                            className='h-6 text-[11px] text-red-600 hover:text-red-700'
                            disabled={act.isPending}
                            onClick={() => act.mutate({ id: ev.id, action: 'discard' })}
                          >
                            Discard
                          </Button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className='mt-3 flex items-center justify-end gap-2 text-[12px] text-slate-500'>
          <Button
            size='sm'
            variant='outline'
            className='h-6 text-[11px]'
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Prev
          </Button>
          <span>
            {page} / {pages}
          </span>
          <Button
            size='sm'
            variant='outline'
            className='h-6 text-[11px]'
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}

export function ExtensionsPage() {
  const queryClient = useQueryClient()
  const [tab, setTab] = usePersistedTab<string>('nvr_tab_extensions', 'installed')

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['extensions'],
    queryFn: () => api.get<{ data: Extension[] }>('/extensions').then((r) => r.data.data)
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<{ data: Extension }>(`/extensions/${id}`, { enabled }).then((r) => r.data.data),
    onSuccess: (updated) => {
      queryClient.setQueryData<Extension[]>(['extensions'], (old) =>
        old?.map((e) => (e.id === updated.id ? updated : e))
      )
    }
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/extensions/${id}`),
    onSuccess: (_, id) => {
      queryClient.setQueryData<Extension[]>(['extensions'], (old) =>
        old?.filter((e) => e.id !== id)
      )
    }
  })

  // Settings sheet (#112), logs viewer (#427), probe results (#262).
  const [settingsFor, setSettingsFor] = useState<string | null>(null)
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const runProbe = (id: string) => {
    void api
      .get<{ data: { ok: boolean; note?: string } }>(`/extensions/${id}/health`)
      .then((r) => {
        const d = r.data.data
        if (d.ok) toast.success(`${id}: healthy${d.note ? ` — ${d.note}` : ''}`)
        else toast.error(`${id}: unhealthy${d.note ? ` — ${d.note}` : ''}`)
      })
      .catch(() => toast.error('Health check failed to run'))
  }

  const reloadMutation = useMutation({
    mutationFn: () =>
      api.post<{ data: Extension[]; loaded: string[] }>('/extensions/reload').then((r) => r.data),
    onSuccess: (result) => {
      queryClient.setQueryData<Extension[]>(['extensions'], result.data)
    }
  })

  const extensions = data ?? []

  // Per-extension health: crons + latest outcomes + 7-day error counts, all
  // from the unified job-run registry (same source as /background-jobs).
  const { data: jobRegistry } = useQuery({
    queryKey: ['job-registry'],
    queryFn: () => api.get('/job-runs/registry').then((r) => r.data.data),
    refetchInterval: 30_000
  })
  const healthByExt = (() => {
    const m = new Map<
      string,
      { crons: number; errors7d: number; lastError: string | null; lastRun: string | null }
    >()
    for (const c of (jobRegistry?.crons ?? []) as Array<{
      extension_id: string | null
      errors_7d: number
      last: { status: string; started_at: string; error: string | null } | null
    }>) {
      if (!c.extension_id) continue
      const h = m.get(c.extension_id) ?? { crons: 0, errors7d: 0, lastError: null, lastRun: null }
      h.crons++
      h.errors7d += c.errors_7d
      if (c.last) {
        if (!h.lastRun || c.last.started_at > h.lastRun) h.lastRun = c.last.started_at
        if (c.last.status === 'error' && c.last.error) h.lastError = c.last.error
      }
      m.set(c.extension_id, h)
    }
    return m
  })()

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Extensions
            </h1>
            {data && (
              <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-muted dark:text-muted-foreground'>
                {extensions.length}
              </span>
            )}
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className='h-7'>
                <TabsTrigger value='installed' className='text-[12px]'>
                  Installed
                </TabsTrigger>
                <TabsTrigger value='marketplace' className='gap-1.5 text-[12px]'>
                  <Store className='h-3 w-3' />
                  Marketplace
                </TabsTrigger>
                <TabsTrigger value='events' className='gap-1.5 text-[12px]'>
                  <Inbox className='h-3 w-3' />
                  Events
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {tab === 'installed' && (
            <Button
              size='sm'
              variant='outline'
              onClick={() => reloadMutation.mutate()}
              disabled={reloadMutation.isPending || isFetching}
            >
              <RefreshCw
                className={cn(
                  'mr-1.5 h-3.5 w-3.5',
                  (reloadMutation.isPending || isFetching) && 'animate-spin'
                )}
              />
              Scan for new
            </Button>
          )}
          <Button
            size='sm'
            variant='outline'
            onClick={() => {
              void api.get('/extensions/scaffold', { responseType: 'blob' }).then((r) => {
                const url = URL.createObjectURL(r.data as Blob)
                const a = document.createElement('a')
                a.href = url
                a.download = 'index.ts'
                a.click()
                URL.revokeObjectURL(url)
              })
            }}
            data-tip='Download a starter extension (typed ctx, example hook/cron/route/setting)'
          >
            <Download className='mr-1.5 h-3.5 w-3.5' />
            Starter
          </Button>
        </div>
      </div>

      {tab === 'marketplace' ? (
        <div className='flex-1 overflow-y-auto p-6'>
          <MarketplaceTab />
        </div>
      ) : tab === 'events' ? (
        <div className='flex-1 overflow-y-auto p-6'>
          <EventsTab />
        </div>
      ) : (
        <div className='flex-1 overflow-y-auto p-6'>
          {reloadMutation.isSuccess && reloadMutation.data.loaded.length > 0 && (
            <div className='mb-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300'>
              Loaded {reloadMutation.data.loaded.length} new extension
              {reloadMutation.data.loaded.length !== 1 ? 's' : ''}:{' '}
              <span className='font-mono'>{reloadMutation.data.loaded.join(', ')}</span>
            </div>
          )}

          {isLoading ? (
            <div className='space-y-px overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
              {[1, 2, 3].map((k) => (
                <div key={k} className='flex items-center gap-4 bg-white px-4 py-3.5 dark:bg-card'>
                  <Skeleton className='h-4 w-4 rounded' />
                  <Skeleton className='h-4 w-40' />
                  <Skeleton className='ml-auto h-4 w-24' />
                </div>
              ))}
            </div>
          ) : extensions.length === 0 ? (
            <div className='flex flex-col items-center justify-center py-20 text-center'>
              <Puzzle className='mb-3 h-9 w-9 text-slate-300 dark:text-slate-600' />
              <p className='text-[13px] font-medium text-slate-600 dark:text-foreground'>
                No extensions loaded
              </p>
              <p className='mt-1 text-[12px] text-slate-400 dark:text-muted-foreground'>
                Drop a folder into{' '}
                <code className='rounded bg-slate-100 px-1 py-0.5 text-[11px] dark:bg-muted'>
                  api/extensions/
                </code>{' '}
                then scan.
              </p>
            </div>
          ) : (
            <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
              <table className='w-full text-[13px]'>
                <thead>
                  <tr className='border-b border-slate-100 bg-slate-50 dark:border-border dark:bg-muted/30'>
                    <th className='px-4 py-2.5 text-left text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
                      Extension
                    </th>
                    <th className='px-4 py-2.5 text-left text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
                      Path
                    </th>
                    <th className='px-4 py-2.5 text-left text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
                      Status
                    </th>
                    <th className='px-4 py-2.5 text-left text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
                      Health
                    </th>
                    <th className='px-4 py-2.5 text-right text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
                      Enabled
                    </th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-slate-100 dark:divide-border'>
                  {extensions.map((ext) => (
                    <tr
                      key={ext.id}
                      className={cn(
                        'bg-white dark:bg-card',
                        !ext.enabled && ext.status === 'loaded' && 'opacity-60',
                        ext.status === 'missing' && 'bg-amber-50/40 dark:bg-amber-950/10'
                      )}
                    >
                      <td className='px-4 py-3.5'>
                        <code className='font-mono text-[12px] font-semibold text-slate-800 dark:text-foreground'>
                          {ext.id}
                        </code>
                        {ext.error && (
                          <p className='mt-1 line-clamp-1 font-mono text-[11px] text-red-500'>
                            {ext.error}
                          </p>
                        )}
                        {ext.status === 'missing' && (
                          <p className='mt-0.5 text-[11px] text-amber-600 dark:text-amber-400'>
                            Folder not found on disk
                          </p>
                        )}
                        {(ext.scopes?.length ?? 0) > 0 && (
                          <div className='mt-1 flex flex-wrap gap-1'>
                            {ext.scopes?.map((sc) => (
                              <span
                                key={sc}
                                className='rounded bg-slate-100 px-1.5 py-px font-mono text-[10px] text-slate-500 dark:bg-muted dark:text-muted-foreground'
                                data-tip='Declared permission scope'
                              >
                                {sc}
                              </span>
                            ))}
                          </div>
                        )}
                        {(() => {
                          // Capability manifest (#660): declared vs observed —
                          // observed-but-undeclared chips render amber.
                          const declared = ext.capabilities?.declared ?? []
                          const observed = ext.capabilities?.observed ?? []
                          const all = Array.from(new Set([...declared, ...observed])).sort()
                          if (all.length === 0) return null
                          return (
                            <div className='mt-1 flex flex-wrap gap-1'>
                              {all.map((cap) => {
                                const undeclared = !declared.includes(cap)
                                return (
                                  <span
                                    key={cap}
                                    className={cn(
                                      'rounded px-1.5 py-px font-mono text-[10px]',
                                      undeclared
                                        ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                                        : 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                                    )}
                                    data-tip={
                                      undeclared
                                        ? 'Used but not declared — add it to the extension’s `capabilities` list'
                                        : observed.includes(cap)
                                          ? 'Declared capability, observed at load'
                                          : 'Declared capability (not observed this boot)'
                                    }
                                  >
                                    {cap}
                                  </span>
                                )
                              })}
                            </div>
                          )
                        })()}
                        {(ext.requires?.length ?? 0) > 0 && (
                          <p className='mt-0.5 text-[10.5px] text-slate-400'>
                            requires: {ext.requires?.join(', ')}
                          </p>
                        )}
                      </td>
                      <td className='px-4 py-3.5'>
                        <code className='font-mono text-[11px] text-slate-400 dark:text-muted-foreground'>
                          {ext.path}
                        </code>
                      </td>
                      <td className='px-4 py-3.5'>
                        <div className='flex items-center gap-1.5'>
                          <StatusIcon status={ext.status} />
                          <Badge
                            variant={
                              ext.status === 'loaded'
                                ? 'success'
                                : ext.status === 'missing'
                                  ? 'warning'
                                  : 'destructive'
                            }
                            className='text-[11px]'
                          >
                            {ext.status}
                          </Badge>
                        </div>
                      </td>
                      <td className='px-4 py-3.5'>
                        {(() => {
                          const h = healthByExt.get(ext.id)
                          if (!h) {
                            return <span className='text-[11px] text-slate-300'>no jobs</span>
                          }
                          return (
                            <div className='text-[11.5px]'>
                              <span className='text-slate-600 dark:text-muted-foreground'>
                                {h.crons} cron{h.crons === 1 ? '' : 's'}
                              </span>
                              {h.errors7d > 0 ? (
                                <span
                                  className='ml-1.5 rounded bg-red-500/10 px-1.5 py-px text-[10.5px] font-medium text-red-600 dark:text-red-400'
                                  title={h.lastError ?? ''}
                                >
                                  {h.errors7d} error{h.errors7d === 1 ? '' : 's'} · 7d
                                </span>
                              ) : (
                                <span className='ml-1.5 rounded bg-emerald-500/10 px-1.5 py-px text-[10.5px] font-medium text-emerald-700 dark:text-emerald-400'>
                                  healthy
                                </span>
                              )}
                              {h.lastRun && (
                                <span className='ml-1.5 text-[10.5px] text-slate-400'>
                                  last run {new Date(h.lastRun).toLocaleTimeString()}
                                </span>
                              )}
                            </div>
                          )
                        })()}
                      </td>
                      <td className='px-4 py-3.5 text-right'>
                        <span className='mr-2 inline-flex items-center gap-1 align-middle'>
                          {ext.has_health_check && (
                            <button
                              type='button'
                              onClick={() => runProbe(ext.id)}
                              className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-emerald-600 dark:hover:bg-muted'
                              data-tip='Run health check'
                              aria-label={`Probe ${ext.id}`}
                            >
                              <Activity className='h-3.5 w-3.5' />
                            </button>
                          )}
                          {ext.has_settings && (
                            <button
                              type='button'
                              onClick={() => setSettingsFor(ext.id)}
                              className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-nvr-navy dark:hover:bg-muted dark:hover:text-nvr-cyan'
                              data-tip='Extension settings'
                              aria-label={`Settings for ${ext.id}`}
                            >
                              <SettingsIcon className='h-3.5 w-3.5' />
                            </button>
                          )}
                          {ext.status === 'loaded' && (
                            <button
                              type='button'
                              onClick={() => setLogsFor(ext.id)}
                              className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-nvr-navy dark:hover:bg-muted dark:hover:text-nvr-cyan'
                              data-tip='Recent log lines'
                              aria-label={`Logs for ${ext.id}`}
                            >
                              <ScrollText className='h-3.5 w-3.5' />
                            </button>
                          )}
                        </span>
                        {ext.status === 'missing' ? (
                          <button
                            type='button'
                            onClick={() => deleteMutation.mutate(ext.id)}
                            disabled={deleteMutation.isPending}
                            className='rounded p-1 text-amber-400 transition-colors hover:bg-amber-100 hover:text-amber-700 dark:hover:bg-amber-900/30'
                            aria-label='Remove from registry'
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </button>
                        ) : ext.status === 'loaded' ? (
                          <Switch
                            checked={ext.enabled}
                            disabled={toggleMutation.isPending}
                            onCheckedChange={(checked) =>
                              toggleMutation.mutate({ id: ext.id, enabled: checked })
                            }
                            aria-label={`${ext.enabled ? 'Disable' : 'Enable'} ${ext.id}`}
                          />
                        ) : (
                          <span className='text-[11px] text-slate-400'>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className='mt-4 text-[12px] text-slate-400 dark:text-muted-foreground'>
            Place extension folders in{' '}
            <code className='rounded bg-slate-100 px-1 py-0.5 text-[11px] dark:bg-muted'>
              api/extensions/
            </code>{' '}
            and click "Scan for new" to load them.
          </p>
        </div>
      )}
      {settingsFor && (
        <ExtensionSettingsSheet id={settingsFor} onClose={() => setSettingsFor(null)} />
      )}
      {logsFor && <ExtensionLogsSheet id={logsFor} onClose={() => setLogsFor(null)} />}
    </div>
  )
}

// ─── Extension settings sheet (#112/#505) — rendered FROM the declared schema ─
type SettingDecl = {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'secret'
  description?: string
  default?: string
  value: string | null
}

function ExtensionSettingsSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const { data: decls = [], isLoading } = useQuery<SettingDecl[]>({
    queryKey: ['extension-settings', id],
    queryFn: () => api.get(`/extensions/${id}/settings`).then((r) => r.data.data)
  })
  const [draft, setDraft] = useState<Record<string, string>>({})
  const effective = (d: SettingDecl) => draft[d.key] ?? (d.value == null ? '' : String(d.value))
  const save = useMutation({
    mutationFn: () => api.put(`/extensions/${id}/settings`, { values: draft }),
    onSuccess: () => {
      toast.success('Settings saved — live within ~30s (settings cache)')
      void qc.invalidateQueries({ queryKey: ['extension-settings', id] })
      onClose()
    },
    onError: (err) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Save failed')
    }
  })
  return (
    <div className='fixed inset-0 z-[120] flex justify-end bg-black/30' onClick={onClose}>
      <div
        className='h-full w-[380px] overflow-y-auto border-l border-slate-200 bg-white p-5 shadow-2xl dark:border-border dark:bg-card'
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className='text-[14px] font-semibold'>
          <code className='font-mono'>{id}</code> settings
        </h2>
        <p className='mt-0.5 text-[11.5px] text-muted-foreground'>
          Declared by the extension; stored in the database — no redeploy needed.
        </p>
        {isLoading ? (
          <p className='mt-4 text-[12.5px] text-slate-400'>Loading…</p>
        ) : (
          <div className='mt-4 space-y-3'>
            {decls.map((d) =>
              d.type === 'boolean' ? (
                <div key={d.key} className='flex items-start justify-between gap-3'>
                  <div>
                    <span className='text-[12px] font-medium text-slate-600 dark:text-slate-300'>
                      {d.label}
                    </span>
                    {d.description && (
                      <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
                        {d.description}
                      </p>
                    )}
                    <span className='mt-0.5 block font-mono text-[10px] text-slate-400'>
                      {d.key}
                    </span>
                  </div>
                  <Switch
                    checked={effective(d) === 'true' || effective(d) === '1'}
                    onCheckedChange={(checked) =>
                      setDraft((prev) => ({ ...prev, [d.key]: checked ? 'true' : 'false' }))
                    }
                    aria-label={d.label}
                  />
                </div>
              ) : (
                <label key={d.key} className='block'>
                  <span className='text-[12px] font-medium text-slate-600 dark:text-slate-300'>
                    {d.label}
                  </span>
                  {d.description && (
                    <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
                      {d.description}
                    </p>
                  )}
                  <input
                    type={
                      d.type === 'secret' ? 'password' : d.type === 'number' ? 'number' : 'text'
                    }
                    defaultValue={d.value ?? ''}
                    placeholder={d.default ?? undefined}
                    onChange={(e) => setDraft((prev) => ({ ...prev, [d.key]: e.target.value }))}
                    className='mt-1 h-8 w-full rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] dark:border-border'
                  />
                  <span className='mt-0.5 block font-mono text-[10px] text-slate-400'>
                    {d.key}
                    {d.type === 'secret' && d.value === '••••••' && (
                      <span className='ml-1.5 text-slate-300'>
                        — leaving the mask keeps the stored value
                      </span>
                    )}
                  </span>
                </label>
              )
            )}
            <div className='flex justify-end gap-2 pt-2'>
              <Button size='sm' variant='outline' onClick={onClose}>
                Cancel
              </Button>
              <Button
                size='sm'
                onClick={() => save.mutate()}
                disabled={save.isPending || Object.keys(draft).length === 0}
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Extension logs sheet (#427) ─────────────────────────────────────────────
function ExtensionLogsSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: lines = [], isLoading } = useQuery<
    Array<{ at: string; level: string; msg: string }>
  >({
    queryKey: ['extension-logs', id],
    queryFn: () => api.get(`/extensions/${id}/logs`).then((r) => r.data.data),
    refetchInterval: 5000
  })
  return (
    <div className='fixed inset-0 z-[120] flex justify-end bg-black/30' onClick={onClose}>
      <div
        className='h-full w-[520px] overflow-y-auto border-l border-slate-200 bg-white p-5 shadow-2xl dark:border-border dark:bg-card'
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className='text-[14px] font-semibold'>
          <code className='font-mono'>{id}</code> log channel
        </h2>
        <p className='mt-0.5 text-[11.5px] text-muted-foreground'>
          Last {lines.length} lines from this extension (in-memory, this API node, refreshes every
          5s). Every line is also tagged in the server log.
        </p>
        {isLoading ? (
          <p className='mt-4 text-[12.5px] text-slate-400'>Loading…</p>
        ) : lines.length === 0 ? (
          <p className='mt-4 text-[12.5px] text-slate-400'>
            Nothing logged since this node started.
          </p>
        ) : (
          <div className='mt-3 space-y-0.5 font-mono text-[11px]'>
            {[...lines].reverse().map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only log lines
              <p key={i} className='break-words'>
                <span className='text-slate-400'>{new Date(l.at).toLocaleTimeString()}</span>{' '}
                <span
                  className={
                    l.level === 'error'
                      ? 'text-red-500'
                      : l.level === 'warn'
                        ? 'text-amber-500'
                        : 'text-slate-500'
                  }
                >
                  {l.level}
                </span>{' '}
                <span className='text-slate-700 dark:text-slate-200'>{l.msg}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
