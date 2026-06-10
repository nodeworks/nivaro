import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Monitor, RefreshCw, Smartphone, Tablet, Trash2, Users, Wifi, WifiOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

interface PresenceSession {
  sessionId: string
  userId: string | null
  userEmail: string | null
  userName: string | null
  pageUrl: string
  pageTitle: string | null
  deviceType: 'desktop' | 'mobile' | 'tablet'
  screenWidth: number | null
  screenHeight: number | null
  viewportWidth: number | null
  viewportHeight: number | null
  ip: string | null
  firstSeen: string
  lastSeen: string
}

function DeviceIcon({ type }: { type: string }) {
  if (type === 'mobile') return <Smartphone className='h-3.5 w-3.5' />
  if (type === 'tablet') return <Tablet className='h-3.5 w-3.5' />
  return <Monitor className='h-3.5 w-3.5' />
}

function durationStr(firstSeen: string): string {
  const s = Math.floor((Date.now() - new Date(firstSeen).getTime()) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function truncateUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname + u.search
    return path.length > 55 ? `${path.slice(0, 52)}…` : path
  } catch {
    return url.length > 55 ? `${url.slice(0, 52)}…` : url
  }
}

export function PresencePage() {
  const queryClient = useQueryClient()
  const [liveConnected, setLiveConnected] = useState(false)
  const [liveSessions, setLiveSessions] = useState<PresenceSession[] | null>(null)
  const socketRef = useRef<{ disconnect(): void } | null>(null)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['presence-sessions'],
    queryFn: () =>
      api.get<{ data: PresenceSession[]; total: number }>('/presence/sessions').then((r) => r.data),
    refetchInterval: 10_000
  })

  const removeMut = useMutation({
    mutationFn: (sessionId: string) => api.delete(`/presence/sessions/${sessionId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['presence-sessions'] })
      setLiveSessions(null)
      toast.success('Session removed')
    }
  })

  const sessions = liveSessions ?? data?.data ?? []

  useEffect(() => {
    let socket: {
      emit(ev: string, ...args: unknown[]): void
      on(ev: string, cb: (...args: unknown[]) => void): void
      disconnect(): void
    } | null = null

    import('socket.io-client')
      .then(({ io }) => {
        socket = io(window.location.origin, {
          transports: ['websocket', 'polling'],
          path: '/socket.io'
        }) as typeof socket

        socket?.on('connect', () => {
          setLiveConnected(true)
          socket?.emit('presence:join', 'admin')
        })
        socket?.on('disconnect', () => setLiveConnected(false))
        socket?.on('presence:update', (payload: unknown) => {
          const p = payload as { sessions: PresenceSession[] }
          setLiveSessions(p.sessions)
        })

        socketRef.current = socket
      })
      .catch(() => {})

    return () => {
      socket?.disconnect()
      setLiveConnected(false)
    }
  }, [])

  const deviceCounts = sessions.reduce(
    (acc, s) => {
      acc[s.deviceType] = (acc[s.deviceType] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>
  )

  return (
    <div className='flex flex-col gap-6 p-6'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div>
          <h1 className='text-xl font-semibold text-foreground'>Live Presence</h1>
          <p className='mt-0.5 text-sm text-muted-foreground'>
            Frontend users currently active on your website
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <div
            className={cn(
              'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
              liveConnected
                ? 'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400'
                : 'border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800'
            )}
          >
            {liveConnected ? <Wifi className='h-3 w-3' /> : <WifiOff className='h-3 w-3' />}
            {liveConnected ? 'Live' : 'Polling'}
          </div>
          <Button
            variant='outline'
            size='sm'
            onClick={() => {
              refetch()
              setLiveSessions(null)
            }}
          >
            <RefreshCw className='mr-1.5 h-3.5 w-3.5' />
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
        {(
          [
            { label: 'Active now', value: sessions.length, icon: Users },
            { label: 'Desktop', value: deviceCounts.desktop ?? 0, icon: Monitor },
            { label: 'Mobile', value: deviceCounts.mobile ?? 0, icon: Smartphone },
            { label: 'Tablet', value: deviceCounts.tablet ?? 0, icon: Tablet }
          ] as const
        ).map(({ label, value, icon: Icon }) => (
          <div key={label} className='flex items-center gap-3 rounded-lg border bg-card px-4 py-3'>
            <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-nvr-cyan/10 text-nvr-cyan'>
              <Icon className='h-4 w-4' />
            </div>
            <div>
              <p className='text-lg font-semibold leading-none'>{value}</p>
              <p className='mt-0.5 text-xs text-muted-foreground'>{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className='rounded-lg border bg-card'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className='w-[180px]'>User</TableHead>
              <TableHead>Page</TableHead>
              <TableHead className='w-[90px]'>Device</TableHead>
              <TableHead className='w-[120px]'>Screen</TableHead>
              <TableHead className='w-[100px]'>Duration</TableHead>
              <TableHead className='w-[110px]'>Last seen</TableHead>
              <TableHead className='w-[110px]'>IP</TableHead>
              <TableHead className='w-[48px]' />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && !liveSessions ? (
              <TableRow>
                <TableCell colSpan={8} className='h-24 text-center text-muted-foreground text-sm'>
                  Loading…
                </TableCell>
              </TableRow>
            ) : sessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className='h-32 text-center'>
                  <div className='flex flex-col items-center gap-2 text-muted-foreground'>
                    <WifiOff className='h-6 w-6 opacity-40' />
                    <p className='text-sm'>No active sessions</p>
                    <p className='text-xs opacity-70'>
                      Embed the tracker script on your frontend to see users here
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              sessions.map((s) => (
                <TableRow key={s.sessionId}>
                  <TableCell>
                    {s.userName || s.userEmail ? (
                      <div>
                        {s.userName && (
                          <p className='text-[13px] font-medium leading-tight'>{s.userName}</p>
                        )}
                        {s.userEmail && (
                          <p className='text-[11px] text-muted-foreground leading-tight'>
                            {s.userEmail}
                          </p>
                        )}
                      </div>
                    ) : (
                      <span className='text-[12px] text-muted-foreground italic'>Anonymous</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className='cursor-default'>
                          <p className='text-[12px] font-medium leading-tight'>
                            {s.pageTitle || '(no title)'}
                          </p>
                          <p className='font-mono text-[11px] text-muted-foreground leading-tight'>
                            {truncateUrl(s.pageUrl)}
                          </p>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side='bottom' className='max-w-[400px] break-all'>
                        {s.pageUrl}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Badge variant='outline' className='gap-1 text-[11px]'>
                      <DeviceIcon type={s.deviceType} />
                      {s.deviceType}
                    </Badge>
                  </TableCell>
                  <TableCell className='font-mono text-[12px] text-muted-foreground'>
                    {s.viewportWidth && s.viewportHeight
                      ? `${s.viewportWidth}×${s.viewportHeight}`
                      : s.screenWidth && s.screenHeight
                        ? `${s.screenWidth}×${s.screenHeight}`
                        : '—'}
                  </TableCell>
                  <TableCell className='text-[12px] text-muted-foreground'>
                    {durationStr(s.firstSeen)}
                  </TableCell>
                  <TableCell className='text-[12px] text-muted-foreground'>
                    {formatRelative(s.lastSeen)}
                  </TableCell>
                  <TableCell className='font-mono text-[12px] text-muted-foreground'>
                    {s.ip ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-7 w-7 text-muted-foreground hover:text-destructive'
                          onClick={() => removeMut.mutate(s.sessionId)}
                          disabled={removeMut.isPending}
                        >
                          <Trash2 className='h-3.5 w-3.5' />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Remove session</TooltipContent>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Embed snippet */}
      <div className='rounded-lg border bg-card p-4'>
        <p className='mb-2 text-sm font-medium'>Embed on your frontend</p>
        <p className='mb-3 text-xs text-muted-foreground'>
          Add before <code className='rounded bg-muted px-1 py-0.5 text-[11px]'>&lt;/body&gt;</code>
          . Use <code className='rounded bg-muted px-1 py-0.5 text-[11px]'>data-user-*</code> to
          identify logged-in users.
        </p>
        <pre className='overflow-x-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed'>
          {`<script src="${window.location.origin}/api/presence.js"\n  data-api-url="${window.location.origin}"\n  data-user-id="{{user.id}}"\n  data-user-email="{{user.email}}"\n  data-user-name="{{user.name}}"\n></script>`}
        </pre>
        <p className='mt-3 text-xs text-muted-foreground'>
          Or use <code className='rounded bg-muted px-1 py-0.5 text-[11px]'>createPresence()</code>{' '}
          from <code className='rounded bg-muted px-1 py-0.5 text-[11px]'>@nivaro/sdk</code> for
          bundled apps.
        </p>
      </div>
    </div>
  )
}
