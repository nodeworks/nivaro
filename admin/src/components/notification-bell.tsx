import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { io, type Socket } from 'socket.io-client'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  type CMSNotification,
  cloudAccount,
  getNotifications,
  getUnreadCount,
  markAllRead,
  markRead
} from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatRelative } from '@/lib/utils'

// Use same-origin so WebSocket goes through Cloudflare Worker → Railway
const API_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3055'

export function NotificationBell({
  collapsed,
  compact
}: {
  collapsed: boolean
  compact?: boolean
}) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const socketRef = useRef<Socket | null>(null)

  // Cloud mode detection — same pattern as Account.tsx
  const { data: cloudInfo, isSuccess: isCloud } = useQuery({
    queryKey: ['cloud-account-info'],
    queryFn: cloudAccount.info,
    retry: false,
    staleTime: 5 * 60_000
  })

  const { data: unread = 0 } = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: getUnreadCount,
    refetchInterval: 30_000
  })

  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => getNotifications()
  })

  // Maintain a persistent websocket connection for real-time notifications.
  useEffect(() => {
    const socket = io(API_URL, {
      transports: ['websocket', 'polling'],
      withCredentials: true
    })
    socketRef.current = socket

    socket.on('connect', () => {
      const token = user?.static_token
      if (token) socket.emit('auth', { token })

      // In cloud mode, join the tenant room so operator broadcasts reach this socket.
      if (isCloud && cloudInfo?.id) {
        socket.emit('tenant:join', cloudInfo.id)
      }
    })

    socket.on('notification:new', (notification: CMSNotification) => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
      toast.info(notification.title)
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [user?.static_token, queryClient, isCloud, cloudInfo?.id])

  async function handleMarkAll() {
    await markAllRead()
    queryClient.invalidateQueries({ queryKey: ['notifications'] })
  }

  async function handleClick(n: CMSNotification) {
    if (!n.read) {
      await markRead(n.id)
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
    }
  }

  const recent = notifications.slice(0, 10)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='Notifications'
          className={cn(
            'relative flex items-center rounded-md text-[13px] font-medium text-slate-400 transition-colors hover:bg-white/[0.05] hover:text-white',
            collapsed || compact ? 'h-8 w-8 justify-center' : 'w-full gap-2.5 px-2.5 py-[7px]'
          )}
        >
          <span className='relative flex'>
            <Bell className='h-[15px] w-[15px] shrink-0' />
            {unread > 0 && (
              <span className='absolute -right-1.5 -top-1.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold leading-none text-white'>
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </span>
          {!collapsed && !compact && 'Notifications'}
        </button>
      </PopoverTrigger>
      <PopoverContent side='right' align='end' sideOffset={12} className='w-80 p-0'>
        <div className='flex items-center justify-between border-b border-slate-100 px-3 py-2.5'>
          <p className='text-[13px] font-semibold text-slate-900'>Notifications</p>
          {unread > 0 && (
            <button
              type='button'
              onClick={handleMarkAll}
              className='text-[11px] font-medium text-nvr-cyan hover:underline'
            >
              Mark all read
            </button>
          )}
        </div>
        <div className='max-h-80 overflow-y-auto'>
          {recent.length === 0 ? (
            <p className='px-3 py-6 text-center text-[12px] text-slate-400'>No notifications</p>
          ) : (
            recent.map((n) => (
              <button
                type='button'
                key={n.id}
                onClick={() => handleClick(n)}
                className='flex w-full items-start gap-2.5 border-b border-slate-50 px-3 py-2.5 text-left transition-colors hover:bg-slate-50 last:border-b-0'
              >
                <span
                  className={cn(
                    'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                    n.read ? 'bg-transparent' : 'bg-nvr-cyan'
                  )}
                />
                <span className='min-w-0 flex-1'>
                  <span
                    className={cn(
                      'block truncate text-[12.5px]',
                      n.read ? 'font-normal text-slate-600' : 'font-medium text-slate-900'
                    )}
                  >
                    {n.title}
                  </span>
                  {n.message && (
                    <span className='mt-0.5 block truncate text-[11px] text-slate-500'>
                      {n.message}
                    </span>
                  )}
                  <span className='mt-0.5 block text-[10.5px] text-slate-400'>
                    {formatRelative(n.created_at)}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
