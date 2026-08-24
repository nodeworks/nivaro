import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Check, ExternalLink } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { io, type Socket } from 'socket.io-client'
import { toast } from 'sonner'
import { resolveNotificationTarget, runNotificationTarget, type NotificationRouteMap } from '@nivaro/react'

/** Where a notification's click lands in the admin app. */
const NOTIF_ROUTES: NotificationRouteMap = {
  record: (c, i) => `/collections/${c}/${i}`,
  list: (c) => `/collections/${c}`,
  report: (id) => `/report-studio/${id}`,
  queue: (id) => `/queues/${id}`,
  dashboard: (id) => `/dashboards/${id}`,
  alerts: () => '/alert-manager',
  imports: () => '/imports',
  issues: () => '/issues'
}
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  type CMSNotification,
  getNotifications,
  getUnreadCount,
  markAllRead,
  markRead,
  markReadBatch
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

  const { data: unread = 0 } = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: getUnreadCount,
    refetchInterval: 30_000
  })

  // Notification sounds (#179): a soft two-tone chime (WebAudio, no asset)
  // when the unread count RISES — preference-gated, off by default. The
  // watermark ref means a mount never chimes for existing unread.
  const prevUnreadRef = useRef<number | null>(null)
  useEffect(() => {
    const prefs = (user as { preferences?: { notification_sound?: { enabled?: boolean; volume?: number } } } | null)
      ?.preferences?.notification_sound
    const prev = prevUnreadRef.current
    prevUnreadRef.current = unread
    if (prev === null || unread <= prev) return
    if (!prefs?.enabled) return
    try {
      const AC = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      const ctx = new AC()
      const vol = Math.min(1, Math.max(0.05, prefs.volume ?? 0.4))
      const play = (freq: number, at: number) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.frequency.value = freq
        osc.type = 'sine'
        gain.gain.setValueAtTime(0, ctx.currentTime + at)
        gain.gain.linearRampToValueAtTime(vol * 0.25, ctx.currentTime + at + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + 0.35)
        osc.connect(gain).connect(ctx.destination)
        osc.start(ctx.currentTime + at)
        osc.stop(ctx.currentTime + at + 0.4)
      }
      play(880, 0)
      play(1174.66, 0.12)
      setTimeout(() => void ctx.close(), 800)
    } catch {
      /* audio blocked pre-gesture — silent */
    }
  }, [unread, user])

  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => getNotifications()
  })

  useEffect(() => {
    const socket = io(API_URL, {
      transports: ['websocket', 'polling'],
      withCredentials: true
    })
    socketRef.current = socket

    socket.on('connect', () => {
      const token = user?.static_token
      if (token) socket.emit('auth', { token })
    })

    socket.on('notification:new', (notification: CMSNotification) => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
      toast.info(notification.title)
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [user?.static_token, queryClient])

  const navigate = useNavigate()
  const [tab, setTab] = useState<'unread' | 'all'>('unread')

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

  async function markGroup(ids: number[]) {
    await markReadBatch(ids)
    queryClient.invalidateQueries({ queryKey: ['notifications'] })
  }

  // Group by record — five updates on one workflow read as one story, not
  // five rows. Record-less notifications stay individual under 'Other'.
  const shown = useMemo(
    () => (tab === 'unread' ? notifications.filter((n) => !n.read) : notifications).slice(0, 40),
    [notifications, tab]
  )
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; collection: string | null; item: string | null; rows: CMSNotification[] }>()
    for (const n of shown) {
      const key = n.collection && n.item ? `${n.collection}:${n.item}` : `single:${n.id}`
      const g = map.get(key) ?? { key, collection: n.collection ?? null, item: n.item ?? null, rows: [] }
      g.rows.push(n)
      map.set(key, g)
    }
    return [...map.values()]
  }, [shown])

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
      <PopoverContent side='right' align='end' sideOffset={12} className='w-[340px] p-0'>
        <div className='flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-border'>
          <div className='flex items-center gap-1 rounded-md bg-slate-100 p-0.5 dark:bg-muted'>
            {(['unread', 'all'] as const).map((t) => (
              <button
                key={t}
                type='button'
                onClick={() => setTab(t)}
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] font-medium capitalize',
                  tab === t
                    ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-foreground'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'
                )}
              >
                {t}
              </button>
            ))}
          </div>
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
        <div className='max-h-96 overflow-y-auto'>
          {groups.length === 0 ? (
            <p className='px-3 py-6 text-center text-[12px] text-slate-400'>
              {tab === 'unread' ? "You're all caught up." : 'No notifications'}
            </p>
          ) : (
            groups.map((g) => {
              const unreadIds = g.rows.filter((n) => !n.read).map((n) => n.id)
              const target = resolveNotificationTarget(g.collection, g.item, NOTIF_ROUTES)
              const hasRecord = !!target
              return (
                <div
                  key={g.key}
                  className='border-b border-slate-50 last:border-b-0 dark:border-border/50'
                >
                  {hasRecord && (
                    <div className='flex items-center gap-1.5 px-3 pt-2'>
                      <span className='truncate text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                        {String(g.collection) === '__chat__'
                          ? 'Chat'
                          : `${String(g.collection).replace(/_/g, ' ')} · ${g.item ?? ''}`}
                        {g.rows.length > 1 ? ` · ${g.rows.length}` : ''}
                      </span>
                      <span className='ml-auto flex items-center gap-0.5'>
                        <button
                          type='button'
                          title='Open record'
                          onClick={() => {
                            if (unreadIds.length) void markGroup(unreadIds)
                            runNotificationTarget(target, navigate)
                          }}
                          className='rounded p-1 text-slate-400 hover:bg-muted hover:text-foreground'
                        >
                          <ExternalLink className='h-3 w-3' />
                        </button>
                        {unreadIds.length > 0 && (
                          <button
                            type='button'
                            title='Mark read'
                            onClick={() => markGroup(unreadIds)}
                            className='rounded p-1 text-slate-400 hover:bg-muted hover:text-foreground'
                          >
                            <Check className='h-3 w-3' />
                          </button>
                        )}
                      </span>
                    </div>
                  )}
                  {g.rows.map((n) => (
                    <button
                      type='button'
                      key={n.id}
                      onClick={() => {
                        void handleClick(n)
                        runNotificationTarget(target, navigate)
                      }}
                      className={cn(
                        'flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors',
                        hasRecord ? 'hover:bg-slate-50 dark:hover:bg-muted' : 'cursor-default'
                      )}
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
                            n.read
                              ? 'font-normal text-slate-600 dark:text-slate-400'
                              : 'font-medium text-slate-900 dark:text-foreground'
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
                      {!hasRecord && !n.read && (
                        <span
                          role='button'
                          tabIndex={-1}
                          title='Mark read'
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleClick(n)
                          }}
                          className='mt-0.5 rounded p-1 text-slate-400 hover:bg-muted hover:text-foreground'
                        >
                          <Check className='h-3 w-3' />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
