import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigation, useOptionalNivaroClient } from './../context'
import { get, post } from '../lib/commands'
import { useLiveAvailable, useLiveEvent } from '../lib/live'

/**
 * Admin-authored announcement banners ("maintenance Friday 6pm") — a new or ended
 * banner arrives over the socket (`announcements:changed`, #1744), the poll (every
 * minute; every 5 while the socket is live) is the net under it; role/window-filtered server-side, dismiss = acknowledge
 * (stays gone for that user, admins see ack counts). Mount once per app
 * shell; renders nothing when there is nothing to say.
 */
/** The banner's video card, when the server attached one for this viewer. */
function videoOf(a: unknown): { path: string; title: string } | null {
  const v = (a as { help_video?: { path?: unknown; title?: unknown } }).help_video
  return v && typeof v.path === 'string' ? { path: v.path, title: String(v.title ?? '') } : null
}

/** The maintenance row's block when it is STRICT (a Nivaro Hub move): nobody is exempt from the
 *  freeze, administrators included, so everyone gets the full page instead of the strip. */
type StrictMaintenance = { headline?: string; explainer?: string; until?: string | null }
function strictMaintenanceOf(a: unknown): StrictMaintenance | null {
  const m = (a as { maintenance?: StrictMaintenance & { strict?: unknown } }).maintenance
  return m && m.strict === true ? m : null
}

/** "Expected back around 3:40 PM", or null when nobody said or the time is unreadable. */
function backAround(until: string | null | undefined): string | null {
  if (!until) return null
  const d = new Date(until)
  if (Number.isNaN(d.getTime())) return null
  return `Expected back around ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`
}

function StrictMaintenancePage({ row, fallback }: { row: StrictMaintenance; fallback: string }) {
  const back = backAround(row.until)
  return (
    <div
      role='alertdialog'
      aria-modal='true'
      aria-labelledby='nvr-strict-maintenance-title'
      data-strict-maintenance
      className='fixed inset-0 z-[150] flex items-center justify-center bg-slate-50 p-6 dark:bg-background'
    >
      <div className='w-full max-w-[520px] rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-border dark:bg-card'>
        <p className='text-[11px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400'>
          Maintenance
        </p>
        <h1
          id='nvr-strict-maintenance-title'
          className='mt-2 text-[16px] font-semibold text-slate-900 dark:text-foreground'
        >
          {row.headline?.trim() || fallback}
        </h1>
        {row.explainer && (
          <p className='mt-2 text-[13px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
            {row.explainer}
          </p>
        )}
        {back && (
          <p className='mt-2 text-[12.5px] text-slate-500 dark:text-muted-foreground'>{back}</p>
        )}
        <p className='mt-4 text-[12px] text-slate-400 dark:text-muted-foreground'>
          This page goes away by itself when the app is back.
        </p>
      </div>
    </div>
  )
}

export function AnnouncementBanner() {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  // The host's videos page, for a banner's "Watch the video" link.
  const helpVideosPath = useNavigation().helpVideosPath ?? '/help-videos'
  const live = useLiveAvailable()
  // Dismissed in this tab, waiting for the server: hidden at once (a React state update, so
  // it never waits on the query cache's notify tick).
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(() => new Set())
  const { data: fetched = [] } = useQuery<Array<{ id: number; message: string; severity: string }>>(
    {
      queryKey: ['announcements-active'],
      queryFn: () =>
        client!
          .request<{ data: Array<{ id: number; message: string; severity: string }> }>(
            get('/announcements/active')
          )
          .then((r) => r.data ?? [])
          .catch(() => []),
      enabled: !!client,
      // The socket says when something changed; the poll still catches a window that simply
      // elapsed (ends_at passing sends nothing) and a socket that is down.
      refetchInterval: live ? 300_000 : 60_000
    }
  )
  // The notice is payload-free: the viewer's audience rules apply when they re-read.
  useLiveEvent(
    'announcements:changed',
    () => void qc.invalidateQueries({ queryKey: ['announcements-active'] }),
    { debounceMs: 300, includeOwn: true, enabled: !!client }
  )
  const items = dismissed.size > 0 ? fetched.filter((a) => !dismissed.has(a.id)) : fetched
  if (items.length === 0) return null
  // Must-acknowledge rows (#90) render a BLOCKING overlay — the app is usable
  // again only after every one of them is explicitly acknowledged.
  const mustAck = items.filter((a) => (a as { require_ack?: boolean }).require_ack)
  // Strict maintenance (a Hub move) replaces the app for everyone, administrators included: the
  // strip it would give an exempt admin leaves them in an app whose every save is refused.
  const strictRow = items.find((a) => strictMaintenanceOf(a))
  const strict = strictRow ? strictMaintenanceOf(strictRow) : null
  const strip = items.filter(
    (a) => !(a as { require_ack?: boolean }).require_ack && a !== strictRow
  )
  // The banner leaves THIS tab at once; the server then tells the person's other tabs and
  // devices (`announcements:changed`), which drop it through the same re-read. A failed ack
  // re-reads, so the banner comes back rather than silently staying "dismissed".
  const ack = (id: number) => {
    setDismissed((cur) => new Set(cur).add(id))
    const drop = () =>
      qc.setQueryData<Array<{ id: number }> | undefined>(['announcements-active'], (cur) =>
        cur?.filter((a) => a.id !== id)
      )
    drop()
    // A read already in flight would put the banner back: stop it, then drop again.
    void qc.cancelQueries({ queryKey: ['announcements-active'] }).then(drop)
    void client
      ?.request(post(`/announcements/${id}/ack`, {}))
      .then(() => qc.invalidateQueries({ queryKey: ['announcements-active'] }))
      .catch(() => {
        setDismissed((cur) => {
          const next = new Set(cur)
          next.delete(id)
          return next
        })
        return qc.invalidateQueries({ queryKey: ['announcements-active'] })
      })
  }
  return (
    <div data-announcements data-nvr-recording-hide className='shrink-0'>
      {strict && strictRow && <StrictMaintenancePage row={strict} fallback={strictRow.message} />}
      {mustAck.length > 0 && (
        <div className='fixed inset-0 z-[140] flex items-center justify-center bg-black/50 p-6'>
          <div className='w-full max-w-[520px] rounded-xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-border dark:bg-card'>
            <p className='text-[11px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400'>
              Acknowledgement required
            </p>
            <p className='mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-slate-800 dark:text-foreground'>
              {mustAck[0].message}
            </p>
            {mustAck.length > 1 && (
              <p className='mt-2 text-[11.5px] text-slate-400'>
                {mustAck.length - 1} more notice{mustAck.length > 2 ? 's' : ''} after this one.
              </p>
            )}
            <button
              type='button'
              onClick={() => ack(mustAck[0].id)}
              className='mt-4 h-9 w-full rounded-md bg-nvr-cyan text-[13px] font-semibold text-white'
            >
              I acknowledge
            </button>
          </div>
        </div>
      )}
      {strip.map((a) => (
        <div
          key={a.id}
          className={
            a.severity === 'critical'
              ? 'flex items-center gap-3 border-b border-red-200 bg-red-50 px-4 py-2 dark:border-red-500/30 dark:bg-red-500/10'
              : a.severity === 'warn'
                ? 'flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-500/30 dark:bg-amber-400/10'
                : 'flex items-center gap-3 border-b border-sky-200 bg-sky-50 px-4 py-2 dark:border-sky-500/30 dark:bg-sky-500/10'
          }
        >
          <span
            className={
              a.severity === 'critical'
                ? 'min-w-0 flex-1 text-[12.5px] text-red-800 dark:text-red-300'
                : a.severity === 'warn'
                  ? 'min-w-0 flex-1 text-[12.5px] text-amber-800 dark:text-amber-300'
                  : 'min-w-0 flex-1 text-[12.5px] text-sky-800 dark:text-sky-300'
            }
          >
            {a.message}
          </span>
          {/* A video moment (#1528a), present only when this viewer may watch it. */}
          {videoOf(a) && (
            <a
              href={`${helpVideosPath}${videoOf(a)!.path.replace(/^\/help-videos/, '')}`}
              className='shrink-0 text-[11.5px] font-medium text-slate-700 underline decoration-dotted underline-offset-2 hover:text-slate-900 dark:text-foreground'
              data-announcement-video={videoOf(a)!.path}
            >
              Watch the video
            </a>
          )}
          {(a as { dismissable?: boolean }).dismissable !== false && (
            <button
              type='button'
              onClick={() => ack(a.id)}
              className='shrink-0 text-[11.5px] font-medium text-slate-500 underline decoration-dotted underline-offset-2 hover:text-slate-700 dark:text-muted-foreground'
            >
              Dismiss
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
