import { useLiveEvent, useLiveWatchRoom } from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * An open background-job run: the log lines and progress as the job writes
 * them. `job:log` / `job:update` (admin-only `jobs` watch room) carry the new
 * line / progress blob; the page asks `GET /job-runs/:id/log` for the lines it
 * missed, and keeps asking on a slow timer while the run is going so a lost
 * event or a replica without the socket never leaves it stale.
 */

interface LogLine {
  seq: number
  at: string
  level: 'info' | 'warn' | 'error'
  line: string
}

interface LogPayload {
  run: {
    id: number
    status: string
    progress: string | null
    outcome: string | null
    error: string | null
  }
  lines: LogLine[]
}

const LEVEL_CLASS: Record<LogLine['level'], string> = {
  info: 'text-slate-600 dark:text-muted-foreground',
  warn: 'text-amber-700 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400'
}

function parseProgress(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function JobRunLog({ runId, running }: { runId: number; running: boolean }) {
  const qc = useQueryClient()
  const live = useLiveWatchRoom('jobs', running)
  const key = ['job-run-log', runId] as const
  const log = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ data: LogPayload }>(`/job-runs/${runId}/log`).then((r) => r.data.data),
    refetchInterval: running ? (live ? 20_000 : 3_000) : false
  })
  const [liveProgress, setLiveProgress] = useState<Record<string, unknown> | null>(null)

  useLiveEvent(
    'job:log',
    (p: { id?: number; log?: LogLine }) => {
      if (p?.id !== runId || !p.log) return
      const line = p.log
      qc.setQueryData<LogPayload>(key, (prev) => {
        if (!prev) return prev
        if (prev.lines.some((l) => l.seq === line.seq)) return prev
        return { ...prev, lines: [...prev.lines, line].slice(-300) }
      })
    },
    { includeOwn: true, enabled: running }
  )
  useLiveEvent(
    'job:update',
    (p: { id?: number; progress?: Record<string, unknown> }) => {
      if (p?.id === runId && p.progress) setLiveProgress(p.progress)
    },
    { includeOwn: true, enabled: running }
  )

  const lines = log.data?.lines ?? []
  const progress = (running ? liveProgress : null) ?? parseProgress(log.data?.run.progress)
  const box = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a line arrives
  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines.length])

  return (
    <div data-job-run-log={runId} className='space-y-1.5'>
      {progress && (
        <p className='flex flex-wrap gap-x-3 text-[11.5px] text-slate-600 dark:text-muted-foreground'>
          {Object.entries(progress)
            .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
            .map(([k, v]) => (
              <span key={k}>
                <span className='text-slate-400'>{k}</span>{' '}
                <span className='tabular-nums'>{String(v)}</span>
              </span>
            ))}
        </p>
      )}
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className='max-h-[220px] overflow-y-auto rounded-md border border-slate-200 bg-white p-2 font-mono text-[11px] leading-relaxed dark:border-border dark:bg-card'
      >
        {lines.length === 0 ? (
          <p className='text-slate-400'>
            {log.isLoading
              ? 'Loading…'
              : 'No log lines kept for this run (logs are kept for a day).'}
          </p>
        ) : (
          lines.map((l) => (
            <p key={l.seq} className={cn('break-words', LEVEL_CLASS[l.level])}>
              <span className='mr-2 text-slate-400'>{new Date(l.at).toLocaleTimeString()}</span>
              {l.line}
            </p>
          ))
        )}
      </div>
    </div>
  )
}
