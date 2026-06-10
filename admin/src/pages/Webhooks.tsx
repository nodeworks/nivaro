import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Webhook } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, truncate } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type WebhookItem = {
  id: string
  name: string
  collections: string[]
  events: string[]
  url: string
  method: string
  enabled: boolean
}

const EVENT_CONFIG: Record<string, string> = {
  create: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  update: 'bg-amber-50 text-amber-700 border-amber-200',
  delete: 'bg-red-50 text-red-700 border-red-200'
}

function EventBadge({ event }: { event: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold',
        EVENT_CONFIG[event] ?? 'bg-slate-50 text-slate-600 border-slate-200'
      )}
    >
      {event}
    </span>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function WebhooksPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api.get('/webhooks').then((r) => r.data)
  })

  const webhooks: WebhookItem[] = data?.data ?? []

  const deleteWebhook = useMutation({
    mutationFn: (id: string) => api.delete(`/webhooks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] })
      setPendingDelete(null)
      toast.success('Webhook deleted')
    },
    onError: () => toast.error('Failed to delete webhook')
  })

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch(`/webhooks/${id}`, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] })
    },
    onError: () => toast.error('Failed to update webhook')
  })

  return (
    <>
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900'>
              Webhooks
            </h1>
            {data && (
              <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500'>
                {webhooks.length}
              </span>
            )}
          </div>
          <Button size='sm' onClick={() => navigate('/webhooks/new')}>
            <Plus className='mr-1.5 h-3.5 w-3.5' /> New Webhook
          </Button>
        </div>
      </div>

      <div className='p-8'>
        {isLoading ? (
          <div className='overflow-hidden rounded-xl border border-slate-200 bg-white'>
            <div className='divide-y divide-slate-100'>
              {(['a', 'b', 'c', 'd'] as const).map((k) => (
                <div key={k} className='flex items-center gap-4 px-5 py-4'>
                  <Skeleton className='h-4 w-40' />
                  <Skeleton className='h-4 w-16 rounded-full' />
                  <Skeleton className='ml-auto h-4 w-24' />
                </div>
              ))}
            </div>
          </div>
        ) : isError ? (
          <div className='py-20 text-center text-[13px] text-red-500'>Failed to load webhooks.</div>
        ) : webhooks.length === 0 ? (
          <div className='flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white py-20'>
            <div className='flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100'>
              <Webhook className='h-8 w-8 text-slate-400' />
            </div>
            <h3 className='mt-4 text-[15px] font-semibold text-slate-700'>No webhooks yet</h3>
            <p className='mt-1.5 text-[13px] text-slate-400'>
              Webhooks deliver HTTP requests when collection items change.
            </p>
            <Button className='mt-6' onClick={() => navigate('/webhooks/new')}>
              <Plus className='mr-1.5 h-3.5 w-3.5' /> Create your first webhook
            </Button>
          </div>
        ) : (
          <div className='overflow-hidden rounded-xl border border-slate-200 bg-white'>
            <table className='w-full text-left'>
              <thead>
                <tr className='border-b border-slate-100 bg-slate-50'>
                  <th className='px-5 py-2.5 text-[11px] font-medium text-slate-500'>Name</th>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>
                    Collections
                  </th>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Events</th>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>URL</th>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Enabled</th>
                  <th className='w-24 px-5 py-2.5' />
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100'>
                {webhooks.map((wh) => (
                  <tr key={wh.id} className='group hover:bg-slate-50'>
                    <td className='px-5 py-3.5'>
                      <p className='text-[13px] font-medium text-slate-800'>{wh.name}</p>
                    </td>
                    <td className='px-4 py-3.5 text-[13px] text-slate-600'>
                      {(wh.collections ?? []).length === 0 ? (
                        <span className='text-muted-foreground text-sm'>All collections</span>
                      ) : (
                        <div className='flex flex-wrap gap-1'>
                          {wh.collections.slice(0, 3).map((c) => (
                            <Badge key={c} variant='outline' className='text-xs'>
                              {c}
                            </Badge>
                          ))}
                          {wh.collections.length > 3 && (
                            <Badge variant='outline' className='text-xs'>
                              +{wh.collections.length - 3}
                            </Badge>
                          )}
                        </div>
                      )}
                    </td>
                    <td className='px-4 py-3.5'>
                      <div className='flex flex-wrap gap-1'>
                        {(wh.events ?? []).map((e) => (
                          <EventBadge key={e} event={e} />
                        ))}
                      </div>
                    </td>
                    <td className='px-4 py-3.5'>
                      <span className='font-mono text-[11px] text-slate-500'>
                        {truncate(wh.url ?? '', 40)}
                      </span>
                    </td>
                    <td className='px-4 py-3.5'>
                      <Switch
                        checked={wh.enabled}
                        onCheckedChange={(v) => toggleEnabled.mutate({ id: wh.id, enabled: v })}
                      />
                    </td>
                    <td className='px-5 py-3.5'>
                      <div className='flex items-center justify-end gap-1'>
                        <button
                          type='button'
                          onClick={() => navigate(`/webhooks/${wh.id}`)}
                          className='rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-500 opacity-0 transition-[opacity,colors] group-hover:opacity-100 hover:bg-slate-100 hover:text-slate-800'
                        >
                          Edit
                        </button>
                        {pendingDelete === wh.id ? (
                          <div className='flex items-center gap-1'>
                            <button
                              type='button'
                              className='rounded bg-red-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-600'
                              onClick={() => deleteWebhook.mutate(wh.id)}
                            >
                              Confirm
                            </button>
                            <button
                              type='button'
                              className='rounded border px-2 py-0.5 text-[11px] hover:bg-slate-50'
                              onClick={() => setPendingDelete(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type='button'
                            className='rounded-lg p-1.5 text-slate-400 opacity-0 transition-[opacity,colors] group-hover:opacity-100 hover:bg-red-50 hover:text-red-500'
                            onClick={() => setPendingDelete(wh.id)}
                            aria-label='Delete webhook'
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
