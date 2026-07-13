import { Radio, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { io } from 'socket.io-client'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Live presence map — who's on which admin page right now. Feed from the
 * admin-gated presence-map socket room; entries group by page.
 */

interface PresenceEntry {
  user: { id: string; name: string }
  path: string
  since: number
}

const API_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3055'

function pageLabel(path: string): string {
  if (path === '/') return 'Dashboard'
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'collections' && parts[1]) {
    return parts[2] ? `${parts[1]} · record ${parts[2]}` : `${parts[1]} (browser)`
  }
  return parts
    .map((p) => p.replace(/-/g, ' '))
    .join(' › ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

export function PresenceLiveMap() {
  const { user } = useAuth()
  const [entries, setEntries] = useState<PresenceEntry[]>([])
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const socket = io(API_URL, { transports: ['websocket', 'polling'], withCredentials: true })
    socket.on('connect', async () => {
      let token = user?.static_token ?? null
      if (!token) {
        try {
          const r = await api.get<{ data?: { token?: string }; token?: string }>('/auth/ws-token')
          token = r.data.data?.token ?? r.data.token ?? null
        } catch {
          token = null
        }
      }
      if (token) socket.emit('auth', { token })
    })
    socket.on('auth:ok', () => {
      socket.emit('presence-map:join')
      setConnected(true)
    })
    socket.on('presence-map:update', (snapshot: PresenceEntry[]) => setEntries(snapshot))
    socket.on('disconnect', () => setConnected(false))
    return () => {
      socket.emit('presence-map:leave')
      socket.disconnect()
    }
  }, [user?.static_token])

  const byPage = useMemo(() => {
    const groups = new Map<string, PresenceEntry[]>()
    for (const e of entries) {
      const list = groups.get(e.path) ?? []
      list.push(e)
      groups.set(e.path, list)
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [entries])

  const uniqueUsers = new Set(entries.map((e) => e.user.id)).size

  return (
    <div className='rounded-xl border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
      <div className='mb-3 flex items-center gap-2'>
        <Radio className={cn('h-3.5 w-3.5', connected ? 'text-green-500' : 'text-slate-300')} />
        <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>Live map</h2>
        <span className='text-[11.5px] text-slate-400'>
          {connected
            ? `${uniqueUsers} ${uniqueUsers === 1 ? 'person' : 'people'} in the admin right now`
            : 'Connecting…'}
        </span>
      </div>

      {entries.length === 0 ? (
        <div className='py-6 text-center text-slate-400'>
          <Users className='mx-auto h-6 w-6 opacity-40' />
          <p className='mt-2 text-[12px]'>
            Nobody visible yet — presence appears as people navigate the admin.
          </p>
        </div>
      ) : (
        <div className='space-y-2'>
          {byPage.map(([path, people]) => (
            <div
              key={path}
              className='rounded-lg border border-slate-100 bg-slate-50/60 p-3 dark:border-border dark:bg-muted/40'
            >
              <div className='flex items-center justify-between'>
                <Link
                  to={path}
                  className='text-[12.5px] font-medium text-slate-800 hover:text-nvr-navy hover:underline dark:text-foreground dark:hover:text-nvr-cyan'
                >
                  {pageLabel(path)}
                </Link>
                <code className='font-mono text-[10px] text-slate-400'>{path}</code>
              </div>
              <div className='mt-2 flex flex-wrap gap-1.5'>
                {people.map((p, i) => (
                  <div
                    key={`${p.user.id}-${i}`}
                    className='flex items-center gap-1.5 rounded-full border border-slate-200 bg-white py-0.5 pl-0.5 pr-2.5 dark:border-border dark:bg-card'
                  >
                    <Avatar className='h-5 w-5'>
                      <AvatarFallback className='bg-nvr-navy text-[8px] text-white'>
                        {initials(p.user.name)}
                      </AvatarFallback>
                    </Avatar>
                    <span className='text-[11.5px] text-slate-700 dark:text-slate-300'>
                      {p.user.name}
                    </span>
                    <span className='text-[10px] text-slate-400'>
                      {formatRelative(new Date(p.since).toISOString())}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
