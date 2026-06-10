import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Package,
  Puzzle,
  RefreshCw,
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
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type Extension = {
  id: string
  status: 'loaded' | 'error' | 'missing'
  enabled: boolean
  path: string
  error?: string
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

export function ExtensionsPage() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState('installed')

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

  const reloadMutation = useMutation({
    mutationFn: () =>
      api.post<{ data: Extension[]; loaded: string[] }>('/extensions/reload').then((r) => r.data),
    onSuccess: (result) => {
      queryClient.setQueryData<Extension[]>(['extensions'], result.data)
    }
  })

  const extensions = data ?? []

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
        </div>
      </div>

      {tab === 'marketplace' ? (
        <div className='flex-1 overflow-y-auto p-6'>
          <MarketplaceTab />
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
                      <td className='px-4 py-3.5 text-right'>
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
    </div>
  )
}
