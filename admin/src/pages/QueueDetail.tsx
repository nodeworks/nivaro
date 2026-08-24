import { createNivaro } from '@nivaro/sdk'
import {
  ItemEditAuthContext,
  NavigationContext,
  NivaroProvider,
  type QueueRealtimeAdapter,
  QueueWorklist
} from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router'
import { io } from 'socket.io-client'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'

const API_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3055'

// Socket adapter: same auth handshake + collection:join protocol the page used
// inline before (joins only after auth:ok — see api/src/plugins/socketio.ts).
// static_token comes from the authed user; the server gates collection:join on a
// completed auth handshake (joins only after auth:ok — api/src/plugins/socketio.ts).
function createSocketRealtime(staticToken: string | null): QueueRealtimeAdapter {
  return {
    subscribe(collections, onUpdate) {
      const socket = io(API_URL, { transports: ['websocket', 'polling'], withCredentials: true })
      socket.on('connect', () => {
        if (staticToken) socket.emit('auth', { token: staticToken })
      })
      socket.on('auth:ok', () => {
        for (const collection of collections) {
          socket.emit('collection:join', { collection })
        }
      })
      socket.on('collection:update', onUpdate)
      return () => {
        socket.disconnect()
      }
    }
  }
}

export function QueueDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { user } = useAuth()

  const client = useMemo(() => createNivaro(window.location.origin), [])
  const realtime = useMemo(
    () => createSocketRealtime(user?.static_token ?? null),
    [user?.static_token]
  )

  const { data: queue } = useQuery<{ name: string; description: string | null }>({
    queryKey: ['queue-meta', id],
    queryFn: () => api.get(`/queues/${id}`).then((r) => r.data.data),
    enabled: !!id
  })

  const { data: subs } = useQuery<{
    data: Array<{ id: number; queue_id: string | null; digest_frequency: string }>
  }>({
    queryKey: ['notification-subscriptions'],
    queryFn: () => api.get('/notification-subscriptions').then((r) => r.data)
  })
  const mySub = subs?.data.find((s) => s.queue_id === id)

  const subscribeMut = useMutation({
    mutationFn: (frequency: 'instant' | 'daily' | 'weekly') =>
      api.post('/notification-subscriptions', { queue_id: id, digest_frequency: frequency }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-subscriptions'] })
      toast.success('Subscribed to digest')
    },
    onError: () => toast.error('Failed to subscribe')
  })

  const unsubscribeMut = useMutation({
    mutationFn: (subId: number) => api.delete(`/notification-subscriptions/${subId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-subscriptions'] })
      toast.success('Unsubscribed')
    },
    onError: () => toast.error('Failed to unsubscribe')
  })

  // Host provider trio for the shared queue components (QueueItemSheet,
  // QueueWorkloadView, RecordDrilldownSheet all consume useNivaroClient /
  // navigation / auth from context) — mirrors ItemEdit's provider tree.
  //
  // DOM note: QueueWorklist renders its own `flex flex-1 min-h-0 flex-col` root
  // (it owns the scrollable body). This outer div wraps the sticky header +
  // QueueWorklist in the same class so the page still presents as a single
  // `flex flex-1 min-h-0 flex-col` column to AppLayout's outlet, matching the
  // old single-page layout — that nests one extra `flex flex-1 min-h-0
  // flex-col` div (QueueWorklist's own root) inside this one. That nesting is
  // a no-op for layout (same pattern used throughout the app per the
  // Master-detail convention) so visually/behaviorally it's identical to the
  // pre-refactor single-div page.
  return (
    <NivaroProvider client={client}>
      <NavigationContext.Provider value={{ navigate }}>
        <ItemEditAuthContext.Provider
          value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}
        >
          <div className='flex flex-1 min-h-0 flex-col'>
            <div className='sticky top-0 z-10 flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-3 dark:border-border dark:bg-card'>
              <div className='flex min-w-0 items-baseline gap-2.5'>
                <h1 className='shrink-0 truncate text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
                  {queue?.name ?? 'Queue'}
                </h1>
                {queue?.description && (
                  <p className='hidden truncate text-[12px] text-slate-500 sm:block dark:text-muted-foreground'>
                    {queue.description}
                  </p>
                )}
              </div>
              {mySub ? (
                <button
                  type='button'
                  onClick={() => unsubscribeMut.mutate(mySub.id)}
                  className='shrink-0 rounded-md px-3 py-1.5 text-[12px] font-medium text-slate-500 hover:text-slate-700 dark:hover:text-foreground'
                >
                  Subscribed ({mySub.digest_frequency}) · Unsubscribe
                </button>
              ) : (
                <div className='flex shrink-0 items-center gap-1'>
                  {/* Instant queue-entry notifications (#121) alongside digests. */}
                  <button
                    type='button'
                    onClick={() => subscribeMut.mutate('instant')}
                    className='rounded-md px-2.5 py-1.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/10 dark:text-nvr-cyan'
                    data-tip='Notify me the moment an item enters this queue (checked every 5 min)'
                  >
                    Notify on arrival
                  </button>
                  <button
                    type='button'
                    onClick={() => subscribeMut.mutate('daily')}
                    className='rounded-md px-2.5 py-1.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/10 dark:text-nvr-cyan'
                  >
                    Get daily digest
                  </button>
                </div>
              )}
            </div>

            <QueueWorklist queueId={id!} realtime={realtime} />
          </div>
        </ItemEditAuthContext.Provider>
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}
