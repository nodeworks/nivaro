import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Loader2, Maximize2, Minimize2, Minus, MonitorUp, ShieldCheck } from 'lucide-react'
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApiFetchConfig, useNivaroClient } from '../../context'
import { del, get, post } from '../../lib/commands'
import { describeError } from '../../lib/error-message'
import { type RealtimeAdapter, useOptionalRealtime } from '../../lib/realtime'
import {
  createFrameAssembler,
  type FramePart,
  registerScreenShareRuntime,
  type ScreenReplayer,
  type ScreenShareInfo,
  type ScreenShareRuntime,
  type ScreenShareTransport,
  screenShareRuntime,
  startScreenShare,
  stopScreenShare,
  useScreenShareAvailable,
  useScreenShareStatus
} from '../../lib/screen-share'

/**
 * Share my screen with support (realtime idea 24) — the visible parts:
 *
 *  - `ScreenShareHost`: mounted ONCE by a host app (admin AppLayout, the portal's shell). It
 *    registers the rrweb loaders and shows the persistent "Sharing with Beth · Stop" bar on every
 *    screen while a share runs.
 *  - `ScreenSharePanel`: inside a support ticket. The requester gets the start card (what is
 *    shared, what is hidden, how it stops); the ticket's support person gets the live view;
 *    anyone else who can open the ticket sees one line saying a share is running.
 *
 * The rules are the server's (api services/screen-share.ts); this file only asks and shows.
 */

interface ShareAnswer {
  enabled: boolean
  active: boolean
  mine: boolean
  share: ScreenShareInfo | null
  can_start: boolean
  start_refusal: string | null
  can_watch: boolean
  to_name: string | null
}

const shareKey = (ticket: number) => ['support-screen-share', ticket] as const

function useShareTransport(): ScreenShareTransport | null {
  const rt = useOptionalRealtime()
  const client = useNivaroClient()
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  return useMemo(() => {
    if (!rt) return null
    return {
      emit: (event, payload) => rt.emit(event, payload),
      on: (event, cb) => rt.on(event, cb),
      stop: async (ticket, share, reason) => {
        const path = `/support/tickets/${ticket}/screen-share?share=${encodeURIComponent(share)}${reason ? `&reason=${reason}` : ''}`
        if (reason) {
          // The page may be going away: keepalive outlives it.
          try {
            void fetch(`${apiBase}${path}`, {
              method: 'DELETE',
              keepalive: true,
              credentials,
              headers: authHeaders
            }).catch(() => {})
          } catch {
            /* the server ends it when the heartbeat stops */
          }
          return
        }
        await client.request(del(path))
      }
    }
  }, [rt, client, apiBase, authHeaders, credentials])
}

// ── Host: runtime + persistent bar ───────────────────────────────────────────

export interface ScreenShareHostProps {
  /** The host's rrweb loaders (`() => import('rrweb')`). Omit when already registered. */
  runtime?: ScreenShareRuntime
}

export function ScreenShareHost({ runtime }: ScreenShareHostProps) {
  useEffect(() => (runtime ? registerScreenShareRuntime(runtime) : undefined), [runtime])
  return <ScreenShareBar />
}

function useCountdown(until: number | null): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until == null) return
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [until])
  if (until == null) return ''
  const s = Math.max(0, Math.round((until - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function shareTargetName(share: ScreenShareInfo): string {
  return share.to.kind === 'team' ? `the ${share.to.name} team` : share.to.name
}

/** Where the pill goes so it never covers an open sheet or dialog (its footer, its actions). */
export type PillPlacement =
  | { kind: 'free' }
  | { kind: 'beside'; left: number; width: number }
  | { kind: 'above'; bottom: number }
  | { kind: 'covered' }

/** Room the expanded pill needs beside a sheet before it moves above it instead. */
const PILL_ROOM = 340

/**
 * The open dialogs / sheets that reach the bottom of the screen decide: room to one side → the
 * pill centres there; a dialog that starts lower down → the pill sits just above it; a dialog
 * that fills the screen (a phone sheet) → `covered`, and the pill folds to its dot.
 */
export function pillPlacement(
  rects: Array<{ left: number; right: number; top: number; bottom: number }>,
  vw: number,
  vh: number
): PillPlacement {
  const low = rects.filter(
    (r) => r.right - r.left > 0 && r.bottom - r.top > 0 && r.bottom > vh - 120
  )
  if (low.length === 0) return { kind: 'free' }
  const left = Math.min(...low.map((r) => r.left))
  const right = Math.max(...low.map((r) => r.right))
  const top = Math.min(...low.map((r) => r.top))
  if (left >= PILL_ROOM) return { kind: 'beside', left: 0, width: left }
  if (vw - right >= PILL_ROOM) return { kind: 'beside', left: right, width: vw - right }
  if (top >= 96) return { kind: 'above', bottom: vh - top + 12 }
  return { kind: 'covered' }
}

/** Watches open dialogs (Radix portals them to body) only while the pill shows. */
function usePillPlacement(active: boolean): PillPlacement {
  const [placement, setPlacement] = useState<PillPlacement>({ kind: 'free' })
  useEffect(() => {
    if (!active || typeof document === 'undefined') return
    let frame = 0
    const sized = new ResizeObserver(() => measure())
    function measure() {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        sized.disconnect()
        const dialogs = [
          ...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')
        ].filter((d) => d.isConnected && getComputedStyle(d).visibility !== 'hidden')
        for (const d of dialogs) sized.observe(d)
        const next = pillPlacement(
          dialogs.map((d) => d.getBoundingClientRect()),
          window.innerWidth,
          window.innerHeight
        )
        setPlacement((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next))
      })
    }
    // A sheet slides in: measure as it mounts and again once it has settled.
    let settle: ReturnType<typeof setTimeout> | undefined
    const changed = () => {
      measure()
      clearTimeout(settle)
      settle = setTimeout(measure, 400)
    }
    const watcher = new MutationObserver(changed)
    watcher.observe(document.body, { childList: true })
    window.addEventListener('resize', changed)
    changed()
    return () => {
      watcher.disconnect()
      sized.disconnect()
      cancelAnimationFrame(frame)
      clearTimeout(settle)
      window.removeEventListener('resize', changed)
    }
  }, [active])
  return placement
}

/**
 * The pill the sharing person sees on every screen while sharing: always-dark so it reads as
 * "this is not the page" in light and dark mode; floats and reserves no layout space; never
 * recorded itself (`data-replay-block`). Minimise folds it to a small red-dot pill in the corner
 * (click to bring it back). It moves beside or above an open sheet or dialog so it never covers
 * that sheet's actions, and folds to its dot when a sheet fills the screen.
 */
export function ScreenShareBar() {
  const status = useScreenShareStatus()
  const live = !!status && !status.ended
  const left = useCountdown(live ? (status?.share.expires_at ?? null) : null)
  const placement = usePillPlacement(!!status)
  /** null = follow the screen (folded only while a sheet fills it); true/false = their choice. */
  const [chosenMin, setChosenMin] = useState<boolean | null>(null)
  const shareId = status?.share.id
  useEffect(() => {
    // A new share starts expanded.
    if (shareId) setChosenMin(null)
  }, [shareId])
  const showing = !!status
  const covered = showing && placement.kind === 'covered'
  useEffect(() => {
    if (!showing || typeof document === 'undefined') return
    // Phone: the pill is the bottom-edge control while sharing; floating help buttons step aside.
    document.documentElement.setAttribute('data-screen-sharing', '')
    return () => document.documentElement.removeAttribute('data-screen-sharing')
  }, [showing])
  useEffect(() => {
    if (!covered || typeof document === 'undefined') return
    // A sheet fills the screen: its scrolling body keeps room for the folded pill.
    document.documentElement.setAttribute('data-screen-share-covered', '')
    return () => document.documentElement.removeAttribute('data-screen-share-covered')
  }, [covered])
  if (!status || typeof document === 'undefined') return null
  const { share, watching, ended } = status
  const who = shareTargetName(share)
  const watchText =
    watching.length === 0
      ? 'not opened yet'
      : share.to.kind === 'user'
        ? 'watching now'
        : `${watching.length === 1 ? watching[0] : `${watching.length} people`} watching`
  const minimised = !ended && (chosenMin ?? placement.kind === 'covered')
  const timeTip = left ? `Sharing stops by itself in ${left}` : undefined

  if (minimised)
    return createPortal(
      <button
        type='button'
        data-replay-block
        data-screen-share-bar='minimised'
        onClick={() => setChosenMin(false)}
        aria-label={`Sharing this app with ${who}, ${watchText}. Show the sharing controls`}
        data-tip={timeTip}
        className={`nvr-no-record fixed bottom-[max(1rem,env(safe-area-inset-bottom))] z-[160] flex h-9 items-center gap-2 rounded-full border border-white/10 bg-[#111827] pl-2.5 pr-3 text-[12px] font-medium text-slate-100 shadow-[0_6px_18px_-6px_rgba(15,23,42,0.5)] transition-colors hover:bg-[#1f2937] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 ${placement.kind === 'covered' ? 'left-3' : 'right-3 sm:right-20'}`}
      >
        <PillRules />
        <LiveDot />
        Sharing
      </button>,
      document.body
    )

  const style: CSSProperties =
    placement.kind === 'beside'
      ? { left: placement.left, width: placement.width }
      : placement.kind === 'above'
        ? { bottom: placement.bottom }
        : {}
  return createPortal(
    <div
      role='status'
      aria-live='polite'
      data-replay-block
      data-screen-share-bar={ended ? 'ended' : 'live'}
      data-placement={placement.kind}
      style={style}
      className={`nvr-no-record pointer-events-none fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[160] flex justify-center px-3 sm:px-4 ${placement.kind === 'beside' ? '' : 'inset-x-0'}`}
    >
      <PillRules />
      <div className='pointer-events-auto flex w-full items-center gap-2.5 rounded-full border border-white/10 bg-[#111827] py-1 pl-3.5 pr-1 text-[12.5px] text-slate-100 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.45)] sm:w-auto sm:max-w-full sm:gap-3 sm:py-1.5 sm:pr-1.5'>
        {ended ? (
          <span className='px-1 py-1 text-slate-300'>{ended}</span>
        ) : (
          <>
            <span data-tip={timeTip} className='flex shrink-0'>
              <LiveDot />
            </span>
            {/* Narrow screens drop the name before the watching state: "Sharing · watching now". */}
            <span className='min-w-0 flex-1 truncate sm:flex-none'>
              <span className='sm:hidden'>Sharing</span>
              <span className='hidden sm:inline'>
                Sharing with <b className='font-semibold text-white'>{who}</b>
              </span>
              <span className='text-slate-400' data-screen-share-watching>
                {' · '}
                {watchText}
              </span>
            </span>
            <button
              type='button'
              data-screen-share-stop
              onClick={() => stopScreenShare()}
              className='h-7 shrink-0 rounded-full bg-red-600 px-3 text-[12px] font-semibold text-white transition-colors hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#111827] sm:px-3.5'
            >
              Stop sharing
            </button>
            <button
              type='button'
              data-screen-share-minimise
              onClick={() => setChosenMin(true)}
              aria-label='Minimise the sharing controls'
              data-tip='Minimise'
              className='flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400'
            >
              <Minus className='h-3.5 w-3.5' />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}

/**
 * Phone: floating help buttons (bug report, Report a problem) hide while sharing — the pill is
 * the bottom-edge control and they come back when sharing stops. A sheet that fills the screen
 * keeps room at the end of its scrolling body for the folded pill.
 */
function PillRules() {
  return (
    <style>
      {'@media (max-width: 639px){html[data-screen-sharing] [data-floating-help]{display:none!important}' +
        // A phone page ends above the pill, so its last row (a pager, a legend) scrolls clear of it.
        'html[data-screen-sharing] main{padding-bottom:calc(3.5rem + env(safe-area-inset-bottom))}}' +
        'html[data-screen-share-covered] [role="dialog"] [data-sheet-body]{padding-bottom:calc(2.25rem + 2rem + env(safe-area-inset-bottom))}'}
    </style>
  )
}

function LiveDot() {
  return (
    <span className='relative flex h-2.5 w-2.5 shrink-0' aria-hidden>
      <span className='absolute inset-0 rounded-full bg-red-500 motion-safe:animate-ping motion-safe:opacity-60' />
      <span className='relative h-2.5 w-2.5 rounded-full bg-red-500' />
    </span>
  )
}

// ── Inside a ticket ──────────────────────────────────────────────────────────

export function ScreenSharePanel({
  ticketId,
  onWideChange
}: {
  ticketId: number
  /** The live view asks its sheet to grow wide (and back). */
  onWideChange?: (wide: boolean) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const rt = useOptionalRealtime()
  const available = useScreenShareAvailable()
  const running = useScreenShareStatus()
  const [watched, setWatched] = useState<ScreenShareInfo | null>(null)
  const [endedWhy, setEndedWhy] = useState<string | null>(null)
  const { data } = useQuery({
    queryKey: shareKey(ticketId),
    queryFn: () =>
      client
        .request<{ data: ShareAnswer }>(get(`/support/tickets/${ticketId}/screen-share`))
        .then((r) => r.data),
    enabled: available,
    staleTime: 5_000
  })
  // A share starting or ending on this ticket (ids only) → read again.
  useEffect(() => {
    if (!rt) return
    const refetch = (p: { ticket?: unknown } | null) => {
      if (Number(p?.ticket) !== ticketId) return
      void qc.invalidateQueries({ queryKey: shareKey(ticketId) })
      // The ticket's history gains a "shared / stopped" line.
      void qc.invalidateQueries({ queryKey: ['support-ticket', ticketId] })
    }
    const onEnded = (p: { ticket?: unknown; reason?: unknown } | null) => {
      if (Number(p?.ticket) === ticketId && typeof p?.reason === 'string') setEndedWhy(p.reason)
      refetch(p)
    }
    const offs = [rt.on('screenshare:state', refetch), rt.on('screenshare:ended', onEnded)]
    return () => {
      for (const off of offs) off()
    }
  }, [rt, qc, ticketId])

  // A share this viewer was watching that has ended: say so instead of vanishing.
  const watchable = data?.active && data.can_watch && data.share ? data.share : null
  useEffect(() => {
    if (watchable) setWatched(watchable)
  }, [watchable])

  if (!available || !data?.enabled) return null
  const sharingHere = running && !running.ended && running.share.ticket === ticketId
  if (sharingHere || (data.mine && data.active))
    return (
      <SharingNow
        name={data.to_name}
        onStop={async () => {
          if (sharingHere) return stopScreenShare()
          // Running in another tab of theirs: stop it from here too.
          if (data.share)
            await client
              .request(
                del(
                  `/support/tickets/${ticketId}/screen-share?share=${encodeURIComponent(data.share.id)}`
                )
              )
              .catch(() => {})
          void qc.invalidateQueries({ queryKey: shareKey(ticketId) })
        }}
      />
    )
  if (data.can_start || data.start_refusal) return <StartCard ticketId={ticketId} answer={data} />
  if (data.active && data.can_watch && data.share && rt)
    return <LiveScreenViewer share={data.share} rt={rt} onWideChange={onWideChange} />
  if (!data.active && watched)
    return (
      <p
        data-screen-share-note='ended'
        className='flex items-center gap-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'
      >
        <MonitorUp className='h-3.5 w-3.5 shrink-0' />
        {endedSentence(watched.sharer_name, endedWhy)}
      </p>
    )
  if (data.active && data.share)
    return (
      <p
        data-screen-share-note
        className='flex items-center gap-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'
      >
        <MonitorUp className='h-3.5 w-3.5 shrink-0' />
        {data.share.sharer_name} is sharing their screen with {shareTargetName(data.share)}.
      </p>
    )
  return null
}

/** Why a share the support person watched ended, in plain words. */
export function endedSentence(name: string, reason: string | null | undefined): string {
  switch (reason) {
    case 'page':
    case 'stale':
      return `${name}'s page closed, so sharing ended.`
    case 'expired':
      return 'Sharing ended after 30 minutes.'
    case 'moved':
      return 'Sharing ended because the request moved to someone else.'
    case 'closed':
      return 'Sharing ended because the request was closed.'
    default:
      return `${name} stopped sharing their screen.`
  }
}

function SharingNow({ name, onStop }: { name: string | null; onStop: () => void }) {
  return (
    <div
      data-screen-share-card='sharing'
      className='flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3 dark:border-border dark:bg-white/[0.03]'
    >
      <span className='relative flex h-2.5 w-2.5 shrink-0' aria-hidden>
        <span className='absolute inset-0 rounded-full bg-red-500 motion-safe:animate-ping motion-safe:opacity-60' />
        <span className='relative h-2.5 w-2.5 rounded-full bg-red-500' />
      </span>
      <p className='mr-auto text-[12.5px] text-slate-700 dark:text-slate-200'>
        You are sharing this app with <b className='font-semibold'>{name ?? 'support'}</b>.
      </p>
      <button
        type='button'
        data-screen-share-stop-card
        onClick={onStop}
        className='h-7 shrink-0 rounded-md border border-red-300 bg-white px-3 text-[12px] font-medium text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 dark:border-red-500/40 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-500/10'
      >
        Stop sharing
      </button>
    </div>
  )
}

function StartCard({ ticketId, answer }: { ticketId: number; answer: ShareAnswer }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const transport = useShareTransport()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const name = answer.to_name ?? 'support'
  const canStart = answer.can_start && !!transport

  const start = async () => {
    if (!transport) return
    setBusy(true)
    setErr(null)
    try {
      const r = await client.request<{ data: { share: ScreenShareInfo; masking: unknown } }>(
        post(`/support/tickets/${ticketId}/screen-share`)
      )
      const ok = await startScreenShare({
        share: r.data.share,
        masking: r.data.masking,
        transport
      })
      if (!ok) {
        await Promise.resolve(transport.stop(ticketId, r.data.share.id)).catch(() => {})
        setErr('Sharing could not start on this page. Reload the page and try again.')
      }
    } catch (e) {
      setErr(describeError(e, 'Sharing could not start').title)
    } finally {
      setBusy(false)
      void qc.invalidateQueries({ queryKey: shareKey(ticketId) })
      void qc.invalidateQueries({ queryKey: ['support-ticket', ticketId] })
    }
  }

  return (
    <section
      data-screen-share-card='start'
      className='rounded-lg border border-slate-200 px-4 py-3.5 dark:border-border'
    >
      <div className='flex items-start gap-3'>
        <MonitorUp className='mt-0.5 h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400' />
        <div className='min-w-0 flex-1'>
          <h3 className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
            Show {canStart ? name : 'support'} your screen
          </h3>
          <p className='mt-1 text-[12px] leading-relaxed text-slate-600 dark:text-slate-300'>
            {canStart ? name : 'Whoever picks this up'} sees this app as you use it — not your other
            tabs or anything else on your computer. They can only watch.
          </p>
          <p className='mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
            <ShieldCheck className='mt-px h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400' />
            What you type and the values on records are hidden from them. Stops when you press Stop,
            close the page, or after 30 minutes.
          </p>
          {canStart ? (
            <button
              type='button'
              data-screen-share-start
              disabled={busy}
              onClick={() => void start()}
              className='mt-3 inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50'
            >
              {busy && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
              Share my screen with {name}
            </button>
          ) : (
            <p
              data-screen-share-refusal
              className='mt-2.5 text-[12px] text-slate-500 dark:text-muted-foreground'
            >
              {answer.start_refusal ??
                'Sharing needs a live connection. Reload the page and try again.'}
            </p>
          )}
          {err && (
            <p role='alert' className='mt-2 text-[12px] text-red-600 dark:text-red-400'>
              {err}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

// ── The support person's live view ───────────────────────────────────────────

const REPLAYER_STYLE = `
[data-screen-view] .replayer-wrapper { position: absolute; top: 0; left: 0; transform-origin: top left; }
[data-screen-view] .replayer-wrapper > iframe { border: 0; pointer-events: none; background: #fff; }
[data-screen-view] .replayer-mouse { position: absolute; width: 18px; height: 18px; margin: -2px 0 0 -2px;
  border-radius: 9999px; background: rgba(0, 206, 255, 0.35); border: 2px solid #00ceff;
  transition: left .05s linear, top .05s linear; pointer-events: none; z-index: 2; }
[data-screen-view] .replayer-mouse.active { background: rgba(0, 206, 255, 0.7); }
[data-screen-view] .replayer-mouse-tail { display: none; }
[data-screen-view] .replayer-mouse:not([style*="left"]) { display: none; }
`

/** Rules the replay frame gets (admin replay-player/live.ts: paused frames keep animations still). */
const FRAME_STYLE_RULES = [
  'html.rrweb-paused *, html.rrweb-paused *::before, html.rrweb-paused *::after { animation-duration: 0s !important; animation-delay: 0s !important; }'
]

export function LiveScreenViewer({
  share,
  rt,
  onWideChange
}: {
  share: ScreenShareInfo
  rt: RealtimeAdapter
  onWideChange?: (wide: boolean) => void
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const replayerRef = useRef<ScreenReplayer | null>(null)
  const sizeRef = useRef<{ width: number; height: number } | null>(null)
  const [phase, setPhase] = useState<
    'joining' | 'waiting' | 'live' | 'denied' | 'ended' | 'unavailable'
  >('joining')
  const [wide, setWide] = useState(false)
  const wideRef = useRef(false)
  wideRef.current = wide
  const [endedReason, setEndedReason] = useState<string | null>(null)
  const ticket = share.ticket

  const fitToBox = useCallback(() => {
    const box = boxRef.current
    const wrapper = replayerRef.current?.wrapper
    // The page as the replay actually laid it out (rrweb sizes its iframe to each snapshot's
    // viewport); the Meta event's size only until the iframe has one.
    const iframe = replayerRef.current?.iframe
    const iw = Number(iframe?.getAttribute('width')) || iframe?.offsetWidth || 0
    const ih = Number(iframe?.getAttribute('height')) || iframe?.offsetHeight || 0
    if (iw > 0 && ih > 0) sizeRef.current = { width: iw, height: ih }
    const size = sizeRef.current
    if (!box || !size || !wrapper) return
    // Fill the frame's width at the recording's aspect ratio (up or down), the frame's height
    // follows, and the page is centred should it ever come out narrower than the frame.
    const width = box.clientWidth
    // Larger: the whole shared screen fits the window too (width and height), centred.
    const maxH = wideRef.current
      ? Math.max(240, window.innerHeight - 140)
      : Number.POSITIVE_INFINITY
    const scale = Math.min(width / Math.max(1, size.width), maxH / Math.max(1, size.height))
    wrapper.style.transform = `scale(${scale})`
    wrapper.style.left = `${Math.max(0, Math.round((width - size.width * scale) / 2))}px`
    box.style.height = `${Math.round(size.height * scale)}px`
  }, [])

  useEffect(() => {
    let alive = true
    const assembler = createFrameAssembler()
    let lastResync = 0
    let Replayer: Awaited<ReturnType<ScreenShareRuntime['loadReplayer']>> = null
    const loading =
      screenShareRuntime()
        ?.loadReplayer()
        .catch(() => null) ?? Promise.resolve(null)

    const resync = () => {
      const t = Date.now()
      if (t - lastResync < 3_000) return
      lastResync = t
      rt.emit('screenshare:resync', { ticket })
    }

    const build = (events: unknown[]) => {
      const stage = stageRef.current
      if (!stage || !Replayer) return
      try {
        replayerRef.current?.destroy?.()
      } catch {
        /* gone */
      }
      stage.replaceChildren()
      const meta = events.find((e) => (e as { type?: number }).type === 4) as
        | { data?: { width?: number; height?: number } }
        | undefined
      if (meta?.data?.width && meta.data.height)
        sizeRef.current = { width: meta.data.width, height: meta.data.height }
      const rep = new Replayer(events, {
        root: stage,
        liveMode: true,
        mouseTail: false,
        triggerFocus: false,
        showWarning: false,
        UNSAFE_replayCanvas: false,
        insertStyleRules: FRAME_STYLE_RULES
      })
      rep.on?.('resize', (p) => {
        const d = p as { width?: number; height?: number }
        if (d?.width && d.height) sizeRef.current = { width: d.width, height: d.height }
        fitToBox()
      })
      const ts = events
        .map((e) => (e as { timestamp?: number }).timestamp)
        .filter((n): n is number => typeof n === 'number')
      // The page as it is now: everything up to the newest event, then live.
      rep.play(ts.length ? Math.max(0, ts[ts.length - 1] - ts[0]) : 0)
      replayerRef.current = rep
      // Refit once the snapshot is built and again after it painted: the first frame is never
      // cut off by a size read too early.
      rep.on?.('fullsnapshot-rebuilded', () => {
        fitToBox()
        requestAnimationFrame(() => fitToBox())
      })
      fitToBox()
      requestAnimationFrame(() => requestAnimationFrame(() => fitToBox()))
      setPhase('live')
    }

    const onFrame = (p: (FramePart & { ticket?: unknown; share?: unknown }) | null) => {
      if (!alive || !p || Number(p.ticket) !== ticket || p.share !== share.id) return
      const r = assembler.push(p)
      if (r.gap) resync()
      if (!r.events.length) return
      if (r.snapshot || !replayerRef.current) build(r.events)
      else for (const e of r.events) replayerRef.current.addEvent(e)
    }
    const offs = [
      rt.on('screenshare:frame', onFrame),
      rt.on('screenshare:joined', (p) => {
        if (alive && Number(p?.ticket) === ticket) setPhase((s) => (s === 'live' ? s : 'waiting'))
      }),
      rt.on('screenshare:denied', (p) => {
        if (alive && Number(p?.ticket) === ticket) setPhase('denied')
      }),
      rt.on('screenshare:ended', (p) => {
        if (!alive || Number(p?.ticket) !== ticket) return
        setEndedReason(typeof p?.reason === 'string' ? p.reason : null)
        setPhase('ended')
      })
    ]
    void loading.then((R) => {
      if (!alive) return
      if (!R) {
        setPhase('unavailable')
        return
      }
      Replayer = R
      rt.emit('screenshare:watch', { ticket })
    })
    // Still on the list every 15 s; no picture 6 s after joining = ask for a fresh snapshot.
    const keep = setInterval(() => rt.emit('screenshare:watch', { ticket }), 15_000)
    const nudge = setInterval(() => {
      if (!replayerRef.current) resync()
    }, 6_000)
    // Back from a dropped connection: say "watching" again at once (the server forgot this socket).
    const offStatus = rt.onStatus?.((st) => {
      if (st.state === 'live' && Replayer) rt.emit('screenshare:watch', { ticket })
    })
    if (offStatus) offs.push(offStatus)
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fitToBox()) : null
    if (boxRef.current) observer?.observe(boxRef.current)
    offs.push(() => observer?.disconnect())
    const onResize = () => fitToBox()
    window.addEventListener('resize', onResize)
    return () => {
      alive = false
      clearInterval(keep)
      clearInterval(nudge)
      window.removeEventListener('resize', onResize)
      for (const off of offs) off()
      rt.emit('screenshare:unwatch', { ticket })
      try {
        replayerRef.current?.destroy?.()
      } catch {
        /* gone */
      }
      replayerRef.current = null
    }
  }, [rt, ticket, share.id, fitToBox])

  // Live: the box takes the page's scaled height; otherwise its fixed placeholder height.
  useEffect(() => {
    if (phase === 'live') fitToBox()
    else if (boxRef.current) boxRef.current.style.height = ''
  }, [phase, fitToBox])

  useEffect(() => {
    onWideChange?.(wide)
    const t = setTimeout(() => {
      fitToBox()
      // Bring the enlarged frame to the top of the sheet so all of it is in view.
      if (wide) boxRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }, 320)
    return () => clearTimeout(t)
  }, [wide, onWideChange, fitToBox])
  useEffect(() => () => onWideChange?.(false), [onWideChange])

  return (
    <section data-screen-share-view={phase} className='space-y-2'>
      <style>{REPLAYER_STYLE}</style>
      <div className='flex items-center gap-2'>
        <span className='relative flex h-2 w-2 shrink-0' aria-hidden>
          {phase === 'live' && (
            <span className='absolute inset-0 rounded-full bg-red-500 motion-safe:animate-ping motion-safe:opacity-60' />
          )}
          <span
            className={`relative h-2 w-2 rounded-full ${phase === 'live' ? 'bg-red-500' : 'bg-slate-300 dark:bg-slate-600'}`}
          />
        </span>
        <h3 className='mr-auto text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
          {share.sharer_name}'s screen
          <span className='ml-1.5 font-normal text-slate-500 dark:text-muted-foreground'>
            {phase === 'live'
              ? '· live, view only'
              : phase === 'ended'
                ? '· sharing stopped'
                : phase === 'denied' || phase === 'unavailable'
                  ? '· not available here'
                  : '· connecting…'}
          </span>
        </h3>
        {phase === 'live' && (
          <button
            type='button'
            data-screen-share-wide
            onClick={() => setWide((w) => !w)}
            className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10'
          >
            {wide ? <Minimize2 className='h-3.5 w-3.5' /> : <Maximize2 className='h-3.5 w-3.5' />}
            {wide ? 'Smaller' : 'Larger'}
          </button>
        )}
      </div>
      <div
        ref={boxRef}
        data-screen-view
        className={`relative w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-border dark:bg-white/[0.04] ${phase === 'live' ? '' : 'h-[180px]'}`}
      >
        <div ref={stageRef} className={phase === 'live' ? '' : 'hidden'} />
        {phase !== 'live' && (
          <div className='absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
            {phase === 'ended' ? (
              <span>{endedSentence(share.sharer_name, endedReason)}</span>
            ) : phase === 'denied' ? (
              <span>This screen share is only for the person working this request.</span>
            ) : phase === 'unavailable' ? (
              <span>This app cannot show a live screen. Open the request in the admin app.</span>
            ) : (
              <>
                <Loader2 className='h-4 w-4 animate-spin' />
                <span>Waiting for {share.sharer_name}'s screen…</span>
              </>
            )}
          </div>
        )}
      </div>
      <p className='flex items-center gap-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        <Eye className='h-3.5 w-3.5 shrink-0' />
        Typed text and record values are hidden. You are named in the request's history.
      </p>
    </section>
  )
}
