import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { useCc } from '../state'
import { FAINT, FOCUS, MUTED, PANEL, PANEL_HEAD, TITLE } from '../theme'
import { usePortalVars } from '../time'
import type { SystemHealth } from '../types'

export interface SystemIssue {
  key: string
  severity: 'critical' | 'warning'
  text: string
}

/** Server errors in an hour that count as an issue: at least this many AND this share. */
export const ERRORS_MIN = 10
export const ERRORS_SHARE = 0.01
/** …or this many whatever the share. */
export const ERRORS_ALWAYS = 50
/** Event-loop lag (worst in the last minute) that reads as "the server is struggling". */
export const LAG_MS = 500

/** What is wrong with the system right now, worst first (pure — the pill's rules). */
export function systemIssues(h: SystemHealth): SystemIssue[] {
  const out: SystemIssue[] = []
  if (!h.db_ok) out.push({ key: 'db', severity: 'critical', text: 'The database is not answering' })
  if (!h.redis_ok) out.push({ key: 'redis', severity: 'critical', text: 'Redis is not answering' })
  const share = h.requests_1h > 0 ? h.errors_1h / h.requests_1h : h.errors_1h > 0 ? 1 : 0
  if (h.errors_1h >= ERRORS_ALWAYS || (h.errors_1h >= ERRORS_MIN && share >= ERRORS_SHARE))
    out.push({
      key: 'errors',
      severity: 'warning',
      text: `${h.errors_1h.toLocaleString()} server errors in the last hour (${(share * 100).toFixed(1)}% of requests)`
    })
  if (h.jobs_failed_1h > 0)
    out.push({
      key: 'jobs',
      severity: 'warning',
      text: `${h.jobs_failed_1h} background ${h.jobs_failed_1h === 1 ? 'job' : 'jobs'} failed in the last hour`
    })
  const lag = h.runtime?.event_loop_lag_ms?.max_1m ?? 0
  if (lag >= LAG_MS)
    out.push({
      key: 'lag',
      severity: 'warning',
      text: `The server is busy: work waited up to ${Math.round(lag)} ms in the last minute`
    })
  return out
}

/**
 * Header pill (CC-16): "All systems normal" or "N issues", with a popover listing them and the
 * hand-offs to the Traffic Map and Health. Administrators only (the server sends `health` to
 * nobody else). The detail lives on those pages; memory and loop lag appear only here.
 */
export function SystemPill() {
  const { snapshot, navigate, at } = useCc()
  const vars = usePortalVars()
  const [open, setOpen] = useState(false)
  const h = snapshot?.health
  if (!h) return null
  const issues = systemIssues(h)
  const critical = issues.some((i) => i.severity === 'critical')
  const label =
    issues.length === 0
      ? 'All systems normal'
      : `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`
  const tone =
    issues.length === 0
      ? 'bg-emerald-500/15 text-[var(--cc-good-text)]'
      : critical
        ? 'bg-red-500/15 text-[var(--cc-bad-text)]'
        : 'bg-amber-500/15 text-[var(--cc-warn-text)]'
  const go = (path: string) => {
    setOpen(false)
    navigate(path)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium ${tone} ${FOCUS}`}
          aria-label={`System: ${label}${at ? ' (now)' : ''}`}
          data-cc-system-pill={issues.length}
        >
          <span aria-hidden className='text-[10px]'>
            {issues.length === 0 ? '●' : critical ? '■' : '▲'}
          </span>
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[320px] border-[var(--cc-border)] bg-[var(--cc-panel)] p-3 text-[var(--cc-text)]'
        style={vars}
      >
        <p className='text-[12.5px] font-semibold text-[var(--cc-strong)]'>
          System {at ? '(now)' : ''}
        </p>
        {issues.length === 0 ? (
          <p className={`mt-1 text-[12px] ${MUTED}`}>Nothing needs attention.</p>
        ) : (
          <ul className='mt-1.5 space-y-1 text-[12px]'>
            {issues.map((i) => (
              <li key={i.key} className='flex gap-1.5'>
                <span
                  aria-hidden
                  className={
                    i.severity === 'critical'
                      ? 'text-[var(--cc-bad-text)]'
                      : 'text-[var(--cc-warn-text)]'
                  }
                >
                  {i.severity === 'critical' ? '■' : '▲'}
                </span>
                <span>
                  <span className='sr-only'>
                    {i.severity === 'critical' ? 'Critical: ' : 'Warning: '}
                  </span>
                  {i.text}
                </span>
              </li>
            ))}
          </ul>
        )}
        <dl className={`mt-2.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11.5px] ${MUTED}`}>
          <dt>Requests (1 h)</dt>
          <dd className='text-right tabular-nums'>{h.requests_1h.toLocaleString()}</dd>
          <dt>Jobs running</dt>
          <dd className='text-right tabular-nums'>{h.jobs_running}</dd>
          <dt>Servers</dt>
          <dd className='text-right tabular-nums'>{h.instances}</dd>
          <dt>Memory</dt>
          <dd className='text-right tabular-nums'>{Math.round(h.runtime.rss_mb)} MB</dd>
          <dt>Loop lag (1 min)</dt>
          <dd className='text-right tabular-nums'>
            {Math.round(h.runtime.event_loop_lag_ms.max_1m)} ms
          </dd>
        </dl>
        <div className='mt-3 flex gap-3 text-[12px] font-medium'>
          <button
            type='button'
            className={`rounded text-[var(--cc-strong)] underline-offset-2 hover:underline ${FOCUS}`}
            onClick={() => go('/traffic-map')}
          >
            Open Traffic Map
          </button>
          <button
            type='button'
            className={`rounded text-[var(--cc-strong)] underline-offset-2 hover:underline ${FOCUS}`}
            onClick={() => go('/health')}
          >
            Open Health
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Compact System card — administrators only. The pill carries the verdict; this keeps the four
 * figures for a board that shows the rail, and hands off to the Traffic Map for anything more.
 */
export function SystemPanel() {
  const { snapshot: snap, at, navigate } = useCc()
  const h = snap?.health
  if (!h) return null
  const dot = (ok: boolean) => (ok ? 'bg-emerald-500' : 'bg-red-500')
  return (
    <section className={PANEL} data-cc-panel='system' aria-label='System'>
      <div className={PANEL_HEAD}>
        <h2 className={TITLE}>System</h2>
        <button
          type='button'
          className={`rounded text-[11.5px] hover:underline ${FAINT} ${FOCUS}`}
          onClick={() => navigate('/traffic-map')}
        >
          Traffic Map{at ? ' · now' : ''}
        </button>
      </div>
      <div className='flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[12px] text-[var(--cc-text)]'>
        <span className='flex items-center gap-1.5'>
          <span className={`h-2 w-2 rounded-full ${dot(h.db_ok)}`} aria-hidden />
          Database {h.db_ok ? 'ok' : 'down'}
        </span>
        <span className='flex items-center gap-1.5'>
          <span className={`h-2 w-2 rounded-full ${dot(h.redis_ok)}`} aria-hidden />
          Redis {h.redis_ok ? 'ok' : 'down'}
        </span>
        <span>
          <b className='tabular-nums'>{h.errors_1h}</b> errors
          <span className={FAINT}> / 1 h</span>
        </span>
        <span>
          <b className='tabular-nums'>{h.jobs_running}</b> jobs running
          {h.jobs_failed_1h > 0 && (
            <b className='tabular-nums text-[var(--cc-warn-text)]'> · {h.jobs_failed_1h} failed</b>
          )}
        </span>
      </div>
    </section>
  )
}
