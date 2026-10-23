import { createNivaro } from '@nivaro/sdk'
import {
  breaksThroughDnd,
  holdNotification,
  huddleCallLayerMounted,
  huddleHolds,
  isDndActive,
  NivaroProvider,
  type NotificationRouteMap,
  playNotificationSound,
  NotificationBell as SharedNotificationBell,
  soundForCategory
} from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, KeyRound } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { getSocket } from '@/lib/socket'
import { cn } from '@/lib/utils'

/** Where a notification's click lands in the admin app. */
const NOTIF_ROUTES: NotificationRouteMap = {
  record: (c, i) => `/collections/${c}/${i}`,
  list: (c) => `/collections/${c}`,
  report: (id) => `/report-studio/${id}`,
  queue: (id) => `/queues/${id}`,
  dashboard: (id) => `/dashboards/${id}`,
  alerts: () => '/alerts/metrics',
  imports: () => '/imports',
  issues: () => '/issues',
  tasks: () => '/tasks',
  approvals: () => '/approvals',
  access_requests: () => '/access',
  my_work: () => '/my-work',
  support: (id) => (id ? `/support?ticket=${id}` : '/support')
}

const bellClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '', {
  timeoutMs: 90_000
})

/**
 * The admin's bell = the shared NotificationBell (lanes, delivery chips,
 * reply actions, record grouping) hosted in the sidebar footer, plus the
 * admin-only extras: the pending access-requests strip and the badge share
 * those count, the shared socket feeds new-notification refreshes, and the
 * sound preference chimes on arrival.
 */
export function NotificationBell({
  collapsed,
  compact
}: {
  collapsed: boolean
  compact?: boolean
}) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // Access requests waiting on an admin (#19). Non-admins get a 403 → 0, so
  // no client-side role check is needed; the badge counts them with unread.
  const { data: pendingAccess = 0 } = useQuery<number>({
    queryKey: ['access-requests-pending-count'],
    queryFn: () =>
      api
        .get('/access-requests', { params: { status: 'pending' } })
        .then((r: { data?: { data?: unknown[] } }) =>
          Array.isArray(r.data?.data) ? r.data.data.length : 0
        )
        .catch(() => 0),
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false
  })

  const prefsRef = useRef(user?.preferences)
  useEffect(() => {
    prefsRef.current = user?.preferences
  }, [user?.preferences])

  const subscribe = useCallback(
    (onNew: () => void) => {
      const socket = getSocket()
      const handler = (n: {
        title?: string
        subject?: string
        category?: string
        lane?: string
      }) => {
        onNew()
        queryClient.invalidateQueries({ queryKey: ['notifications'] })
        // Do not disturb (#2114) holds the toast and the sound; the inbox row and the badge
        // still arrive, and a critical notification still breaks through.
        if (isDndActive(prefsRef.current as Record<string, unknown>) && !breaksThroughDnd(n)) return
        // A call shows its own card (HuddleCallLayer) — no second toast for it.
        if (n.category === 'huddle' && huddleCallLayerMounted()) return
        // In a huddle (#2852): held, counted on the stage, released as one summary on leave.
        if (huddleHolds(prefsRef.current as Record<string, unknown>) && !breaksThroughDnd(n)) {
          holdNotification({ kind: 'notification', title: n.subject ?? n.title ?? 'Notification' })
          return
        }
        toast.info(n.subject ?? n.title ?? 'New notification')
        playNotificationSound(
          soundForCategory(prefsRef.current as Record<string, unknown>, n.category)
        )
      }
      socket.on('notification:new', handler)
      return () => {
        socket.off('notification:new', handler)
      }
    },
    [queryClient]
  )

  return (
    <NivaroProvider client={bellClient}>
      <SharedNotificationBell
        routes={NOTIF_ROUTES}
        onNavigate={(p) => navigate(p)}
        app='admin'
        subscribe={subscribe}
        extraBadge={pendingAccess}
        mailLogUrl={(id) => `/delivery?id=${id}`}
        allPath='/notifications'
        subscriptionsPath='/alerts/subscriptions'
        onActionError={(m) => toast.error(m)}
        // The sidebar footer sits bottom-left inside an overflow-clipped rail:
        // portal the panel beside the trigger instead of below it.
        panelPlacement='right'
        renderTrigger={({ badge, toggle }) => (
          <button
            type='button'
            aria-label='Notifications'
            onClick={toggle}
            className={cn(
              'relative flex items-center rounded-md text-[13px] font-medium text-slate-400 transition-colors hover:bg-white/[0.05] hover:text-white',
              collapsed || compact ? 'h-8 w-8 justify-center' : 'w-full gap-2.5 px-2.5 py-[7px]'
            )}
          >
            <span className='relative flex'>
              <Bell className='h-[15px] w-[15px] shrink-0' />
              {badge > 0 && (
                <span
                  data-nvr-recording-hide
                  className='absolute -right-1.5 -top-1.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold leading-none text-white'
                >
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </span>
            {!collapsed && !compact && 'Notifications'}
          </button>
        )}
        beforeList={
          pendingAccess > 0 ? (
            <button
              type='button'
              onClick={() => navigate('/access')}
              className='flex w-full items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-left text-[12px] text-amber-800 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/15'
            >
              <KeyRound className='h-3.5 w-3.5 shrink-0' />
              <span className='flex-1'>
                <span className='font-semibold'>{pendingAccess}</span> access{' '}
                {pendingAccess === 1 ? 'request' : 'requests'} waiting on an admin
              </span>
              <span className='text-[11px] font-medium underline decoration-dotted'>Review</span>
            </button>
          ) : null
        }
      />
    </NivaroProvider>
  )
}
