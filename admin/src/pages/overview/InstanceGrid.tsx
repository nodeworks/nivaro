import { useLiveRefetchInterval } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { getSocket } from '@/lib/socket'
import { cn } from '@/lib/utils'
import { Bone, Section } from './parts'
import { fmt } from './text'

/**
 * This instance — one meta grid of the facts an administrator checks: version, environment,
 * database, session store, extensions, flows and who is online. Administrators only (the
 * section is adminOnly in the registry; the reads behind it are admin routes).
 */

type HealthData = {
  status: 'ok' | 'degraded'
  version: string
  environment: string
  db: { status: 'connected' | 'disconnected'; database?: string }
  redis: { status: 'connected' | 'disconnected' }
}

function Cell({
  label,
  children,
  to,
  status
}: {
  label: string
  children: ReactNode
  to?: string
  status?: 'ok' | 'down' | null
}) {
  const body = (
    <>
      <span className='block text-[11px] text-slate-500 dark:text-slate-400'>{label}</span>
      <span className='mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
        {status && (
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              status === 'ok' ? 'bg-emerald-500' : 'bg-red-500'
            )}
            aria-hidden
          />
        )}
        <span className='truncate'>{children}</span>
        {status === 'down' && <span className='sr-only'>(not reachable)</span>}
      </span>
    </>
  )
  const cls = 'block min-w-0 bg-white px-3 py-2.5 dark:bg-card'
  return to ? (
    <Link
      to={to}
      className={cn(
        cls,
        'hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 dark:hover:bg-white/[0.04]'
      )}
    >
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  )
}

export function InstanceSection() {
  const { data: health, isLoading } = useQuery({
    queryKey: ['health'],
    queryFn: () =>
      api
        .get<HealthData>('/health')
        .then((r) => r.data)
        .catch(() => null),
    refetchInterval: 30_000
  })
  const { data: extensions } = useQuery({
    queryKey: ['dashboard-stats', 'extensions'],
    queryFn: () =>
      api
        .get('/extensions')
        .then((r) => r.data)
        .catch(() => ({ data: [] }))
  })
  const { data: flows } = useQuery({
    queryKey: ['dashboard-stats', 'flows'],
    queryFn: () =>
      api
        .get('/flows')
        .then((r) => r.data)
        .catch(() => ({ data: [] }))
  })
  // #2450 — the socket's presence:update carries the live count; the read is the first figure
  // and a safety net while the socket is up.
  const presencePoll = useLiveRefetchInterval(10_000)
  const { data: presence } = useQuery({
    queryKey: ['presence-sessions'],
    queryFn: () =>
      api
        .get<{ data: unknown[]; total: number }>('/presence/sessions')
        .then((r) => r.data)
        .catch(() => null),
    refetchInterval: presencePoll
  })
  const [online, setOnline] = useState<number | null>(null)
  useEffect(() => {
    const socket = getSocket()
    const join = () => socket.emit('presence:join', 'admin')
    const onUpdate = (p: unknown) => setOnline((p as { sessions: unknown[] }).sessions.length)
    if (socket.connected) join()
    socket.on('auth:ok', join)
    socket.on('presence:update', onUpdate)
    return () => {
      socket.emit('presence:leave', 'admin')
      socket.off('auth:ok', join)
      socket.off('presence:update', onUpdate)
    }
  }, [])
  const onlineNow = online ?? presence?.total ?? null
  const extCount = ((extensions as { data?: unknown[] } | undefined)?.data ?? []).length
  const flowCount = ((flows as { data?: unknown[] } | undefined)?.data ?? []).length

  return (
    <Section id='instance' title='This instance' plain>
      <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
        {isLoading ? (
          Array.from({ length: 6 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton cells
            <div key={i} className='bg-white px-3 py-2.5 dark:bg-card' aria-hidden>
              <Bone className='h-2.5 w-14' />
              <Bone className='mt-1.5 h-3.5 w-20' />
            </div>
          ))
        ) : (
          <>
            <Cell label='Version'>{health?.version ?? 'Unknown'}</Cell>
            <Cell label='Environment'>{health?.environment ?? 'Unknown'}</Cell>
            <Cell
              label='Database'
              status={health ? (health.db.status === 'connected' ? 'ok' : 'down') : null}
              to='/database'
            >
              {health?.db.database ?? (health ? 'SQL Server' : 'Unknown')}
            </Cell>
            <Cell
              label='Session store'
              status={health ? (health.redis.status === 'connected' ? 'ok' : 'down') : null}
              to='/database/redis'
            >
              Redis
            </Cell>
            <Cell label='Extensions' to='/extensions'>
              {fmt(extCount)} loaded
            </Cell>
            <Cell label='Flows' to='/flows'>
              {fmt(flowCount)}
            </Cell>
            <Cell label='Online now' to='/security-center/presence'>
              {onlineNow == null
                ? 'Checking…'
                : `${fmt(onlineNow)} ${onlineNow === 1 ? 'session' : 'sessions'}`}
            </Cell>
            <Cell
              label='Status'
              status={health ? (health.status === 'ok' ? 'ok' : 'down') : null}
              to='/health'
            >
              {health ? (health.status === 'ok' ? 'All checks passing' : 'Degraded') : 'Unknown'}
            </Cell>
          </>
        )}
      </div>
    </Section>
  )
}
