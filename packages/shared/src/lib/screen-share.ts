import { useSyncExternalStore } from 'react'
import { replayRecorderMode, tapReplayEvents } from './replay-capture'
import {
  buildReplayMaskingOptions,
  DEFAULT_REPLAY_MASKING,
  normalizeReplayMasking,
  type ReplayMaskingRules
} from './replay-masking'

/**
 * Share my screen with support (realtime idea 24) — the browser half.
 *
 * The person who asked for help starts a view-only live share of THIS APP (the page's own DOM,
 * never their desktop or other tabs) with whoever works their ticket. It is the session-replay
 * recorder's rrweb stream with exactly its masking (lib/replay-masking.ts: every input masked,
 * record field values / rich text / file names masked unless an admin allowed the field,
 * `.nvr-no-record` / `[data-replay-block]` blocked):
 *
 *  - a recorder already running (full recording or the error-clip buffer) is TAPPED — rrweb
 *    records one stream per page — and asked for a fresh full snapshot;
 *  - otherwise the share runs its own `record()` with `buildReplayMaskingOptions(rules)`, the
 *    instance's rules handed back by the start call (the strict defaults when absent).
 *
 * Only the screen travels: rrweb Meta / FullSnapshot / IncrementalSnapshot events. The recorders'
 * custom events (console lines, requests, socket events) and plugin events are dropped.
 *
 * Nothing is sent while nobody watches: the server asks for a snapshot when someone opens the
 * share (and when a viewer missed a frame), and says who is watching. Batches go out as JSON
 * text split into parts of ≤ PART_CHARS characters, paced so one big snapshot never floods the
 * viewer's socket. The share stops on Stop, after its time limit, when the page closes, or when
 * the server ends it (request moved or closed).
 *
 * The page holds at most one share. Hosts register the rrweb loaders once
 * (`registerScreenShareRuntime`, usually through the ScreenShareHost component) — shared code
 * never imports rrweb itself.
 */

export const PART_CHARS = 60_000
export const FLUSH_MS = 200
export const BEAT_MS = 10_000
/** A batch waiting to go out is dropped past this (the viewer resyncs from a fresh snapshot). */
export const QUEUE_MAX_CHARS = 24_000_000

/** rrweb event types that make up the screen. */
export const SCREEN_EVENT_TYPES: ReadonlySet<number> = new Set([2, 3, 4])
const FULL_SNAPSHOT = 2
const META = 4

export interface ScreenShareInfo {
  id: string
  ticket: number
  sharer_name: string
  to: { kind: 'user' | 'team'; name: string }
  started_at: number
  expires_at: number
  max_ms: number
}

type RrwebRecord = ((opts: Record<string, unknown>) => (() => void) | undefined) & {
  takeFullSnapshot?: (isCheckout?: boolean) => void
}

/** The rrweb Replayer the viewer builds (the parts used here). */
export interface ScreenReplayer {
  play(timeOffset?: number): void
  addEvent(e: unknown): void
  destroy?(): void
  pause?(): void
  on?(event: string, cb: (payload: unknown) => void): unknown
  wrapper?: HTMLElement
  iframe?: HTMLIFrameElement
}
export type ScreenReplayerCtor = new (
  events: unknown[],
  config: Record<string, unknown>
) => ScreenReplayer

export interface ScreenShareRuntime {
  loadRecord(): Promise<RrwebRecord | null>
  loadReplayer(): Promise<ScreenReplayerCtor | null>
}

let runtime: ScreenShareRuntime | null = null

/** Hosts register the rrweb loaders once. Returns the undo. */
export function registerScreenShareRuntime(r: ScreenShareRuntime): () => void {
  runtime = r
  emitChange()
  return () => {
    if (runtime === r) {
      runtime = null
      emitChange()
    }
  }
}
export function screenShareRuntime(): ScreenShareRuntime | null {
  return runtime
}

// ── Packing (sharer) and assembling (viewer) ────────────────────────────────

export interface FramePart {
  seq: number
  part: number
  parts: number
  data: string
}

/** Keep only the events that draw the screen. */
export function screenEvents(events: unknown[]): unknown[] {
  return events.filter((e) => SCREEN_EVENT_TYPES.has(Number((e as { type?: unknown })?.type)))
}

/** One batch → parts of ≤ max characters each. */
export function packBatch(seq: number, events: unknown[], max = PART_CHARS): FramePart[] {
  const text = JSON.stringify(events)
  const parts = Math.max(1, Math.ceil(text.length / max))
  const out: FramePart[] = []
  for (let i = 0; i < parts; i++)
    out.push({ seq, part: i, parts, data: text.slice(i * max, (i + 1) * max) })
  return out
}

/**
 * The viewer's side: parts → whole batches, in order. A batch whose seq skips one says a frame
 * was lost (`gap`): the viewer asks for a fresh snapshot and drops incremental events until a
 * full snapshot arrives.
 */
export function createFrameAssembler() {
  const pending = new Map<number, { parts: number; got: Map<number, string> }>()
  let last = -1
  let waitingForSnapshot = true
  return {
    /** Feed one part; returns the events to play now (maybe none) and whether a gap was seen. */
    push(p: FramePart): { events: unknown[]; gap: boolean; snapshot: boolean } {
      const none = { events: [] as unknown[], gap: false, snapshot: false }
      if (!Number.isSafeInteger(p.seq) || p.seq <= last - 1000) return none
      let b = pending.get(p.seq)
      if (!b) {
        b = { parts: p.parts, got: new Map() }
        pending.set(p.seq, b)
      }
      b.got.set(p.part, p.data)
      if (b.got.size < b.parts) {
        // Old incomplete batches are gone for good.
        for (const s of [...pending.keys()]) if (s < p.seq - 50) pending.delete(s)
        return none
      }
      pending.delete(p.seq)
      let events: unknown[]
      try {
        const text = Array.from({ length: b.parts }, (_, i) => b?.got.get(i) ?? '').join('')
        const parsed = JSON.parse(text)
        events = Array.isArray(parsed) ? parsed : []
      } catch {
        events = []
      }
      const gap = last >= 0 && p.seq !== last + 1
      if (p.seq > last) last = p.seq
      events = screenEvents(events)
      const at = events.findIndex((e) => Number((e as { type?: unknown }).type) === FULL_SNAPSHOT)
      if (gap) waitingForSnapshot = true
      if (waitingForSnapshot) {
        if (at < 0) return { events: [], gap, snapshot: false }
        waitingForSnapshot = false
        // From the Meta event just before the snapshot (it carries the page size).
        let meta = -1
        for (let i = at - 1; i >= 0; i--)
          if (Number((events[i] as { type?: unknown }).type) === META) {
            meta = i
            break
          }
        return { events: events.slice(meta >= 0 ? meta : at), gap, snapshot: true }
      }
      return { events, gap, snapshot: at >= 0 }
    },
    reset() {
      pending.clear()
      last = -1
      waitingForSnapshot = true
    }
  }
}

// ── The running share (sharer) ───────────────────────────────────────────────

export interface ScreenShareTransport {
  emit(event: string, payload: unknown): void
  on(event: string, cb: (payload: any) => void): () => void
  /** DELETE the share (the Stop button, or `page` as the page closes — keepalive). */
  stop(ticket: number, share: string, reason?: 'page' | 'expired'): Promise<void> | void
}

export interface ScreenShareStatus {
  share: ScreenShareInfo
  /** Names of the people looking right now. */
  watching: string[]
  /** Why it ended (shown briefly), or null while running. */
  ended: string | null
}

let status: ScreenShareStatus | null = null
const listeners = new Set<() => void>()
function emitChange() {
  for (const l of listeners) l()
}
function setStatus(s: ScreenShareStatus | null) {
  status = s
  emitChange()
}
export function screenShareStatus(): ScreenShareStatus | null {
  return status
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
/** The running share on this page (null when none). */
export function useScreenShareStatus(): ScreenShareStatus | null {
  return useSyncExternalStore(subscribe, screenShareStatus, () => null)
}
/** Whether a host registered the rrweb loaders (the feature is offered only then). */
export function useScreenShareAvailable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => runtime != null,
    () => false
  )
}

type StopWhy = 'stopped' | 'page' | 'expired' | 'ended'
let running: { stop: (why: StopWhy, reason?: string) => void } | null = null

export function screenShareRunning(): boolean {
  return running != null
}

/** Stop this page's share (the bar's Stop button). */
export function stopScreenShare(): void {
  running?.stop('stopped')
}

export const ENDED_TEXT: Record<string, string> = {
  stopped: 'You stopped sharing',
  expired: 'Sharing stopped after 30 minutes',
  stale: 'Sharing stopped',
  page: 'Sharing stopped',
  moved: 'Sharing stopped: your request moved to someone else',
  closed: 'Sharing stopped: your request was closed',
  replaced: 'Sharing moved to another tab',
  gone: 'Sharing stopped'
}

export interface StartScreenShareOptions {
  share: ScreenShareInfo
  masking?: unknown
  transport: ScreenShareTransport
  /** Test seam. */
  runtime?: ScreenShareRuntime
  now?: () => number
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null
}

/**
 * Start sharing (after the server said yes). Returns false when the runtime is missing or a
 * share already runs on this page.
 */
export async function startScreenShare(opts: StartScreenShareOptions): Promise<boolean> {
  const rt = opts.runtime ?? runtime
  if (!rt || running) return false
  const record = await rt.loadRecord().catch(() => null)
  if (!record) return false
  const { share, transport } = opts
  const now = opts.now ?? Date.now
  const win = opts.win === undefined ? (typeof window !== 'undefined' ? window : null) : opts.win
  const rules: ReplayMaskingRules =
    opts.masking == null ? DEFAULT_REPLAY_MASKING : normalizeReplayMasking(opts.masking)

  let sending = false
  let buffer: unknown[] = []
  let seq = 0
  let queue: FramePart[] = []
  let queued = 0
  let pumping: ReturnType<typeof setTimeout> | null = null
  let stopRecord: (() => void) | null = null
  let stopped = false
  const offs: Array<() => void> = []

  const push = (e: unknown) => {
    if (!sending || stopped) return
    if (!SCREEN_EVENT_TYPES.has(Number((e as { type?: unknown })?.type))) return
    buffer.push(e)
  }

  const pump = () => {
    pumping = null
    if (stopped) return
    const next = queue.shift()
    if (!next) return
    queued -= next.data.length
    transport.emit('screenshare:frame', { ticket: share.ticket, share: share.id, ...next })
    // ≈1 M characters a second: a big snapshot reaches the viewer without flooding its socket.
    pumping = setTimeout(pump, Math.max(16, Math.round(next.data.length / 1000)))
  }

  const flush = () => {
    if (stopped || buffer.length === 0) return
    const events = buffer
    buffer = []
    const parts = packBatch(seq++, events)
    for (const p of parts) {
      queue.push(p)
      queued += p.data.length
    }
    if (queued > QUEUE_MAX_CHARS) {
      // The viewer could not keep up: drop what waits; its next frame shows a gap and it asks
      // for a fresh snapshot.
      queue = []
      queued = 0
    }
    if (!pumping) pump()
  }

  const snapshot = async () => {
    if (stopped) return
    sending = true
    try {
      const mode = replayRecorderMode()
      if (!stopRecord) {
        if (mode === 'full' || mode === 'clip') {
          stopRecord = tapReplayEvents(push)
          record.takeFullSnapshot?.(true)
        } else {
          // Exactly session replay's masking (#1361) — never looser.
          stopRecord = record({ emit: push, ...buildReplayMaskingOptions(() => rules) }) ?? null
        }
      } else {
        record.takeFullSnapshot?.(true)
      }
    } catch {
      /* the next request tries again */
    }
  }

  const teardown = (why: StopWhy, reason?: string) => {
    if (stopped) return
    stopped = true
    sending = false
    running = null
    clearInterval(flushTimer)
    clearInterval(beatTimer)
    clearTimeout(deadline)
    if (pumping) clearTimeout(pumping)
    queue = []
    buffer = []
    for (const off of offs) off()
    try {
      stopRecord?.()
    } catch {
      /* already stopped */
    }
    if (why !== 'ended') {
      try {
        void Promise.resolve(
          transport.stop(share.ticket, share.id, why === 'stopped' ? undefined : why)
        ).catch(() => {})
      } catch {
        /* the server ends it when the beats stop */
      }
    }
    const key = why === 'ended' ? (reason ?? 'gone') : why
    setStatus({ share, watching: [], ended: ENDED_TEXT[key] ?? ENDED_TEXT.gone })
    // The "stopped" note shows for a moment, then the bar goes away.
    setTimeout(() => {
      if (status?.share.id === share.id && status.ended) setStatus(null)
    }, 4_000)
  }

  const mine = (p: { ticket?: unknown; share?: unknown } | null) =>
    !!p && Number(p.ticket) === share.ticket && p.share === share.id

  offs.push(
    transport.on('screenshare:snapshot', (p) => {
      if (mine(p)) void snapshot()
    }),
    transport.on('screenshare:watching', (p) => {
      if (!mine(p)) return
      const names = Array.isArray(p.names)
        ? p.names.filter((n: unknown) => typeof n === 'string')
        : []
      // Nobody looking: nothing is sent (the next viewer asks for a snapshot).
      if (names.length === 0) sending = false
      if (status?.share.id === share.id && !status.ended) setStatus({ ...status, watching: names })
    }),
    transport.on('screenshare:ended', (p) => {
      if (mine(p)) teardown('ended', typeof p.reason === 'string' ? p.reason : undefined)
    })
  )
  if (win) {
    const onHide = (e: Event) => {
      // A page that only goes into the back/forward cache comes back; a real close does not.
      if ((e as PageTransitionEvent).persisted) return
      teardown('page')
    }
    win.addEventListener('pagehide', onHide)
    offs.push(() => win.removeEventListener('pagehide', onHide))
  }

  const beat = () => transport.emit('screenshare:beat', { ticket: share.ticket, share: share.id })
  const flushTimer = setInterval(flush, FLUSH_MS)
  const beatTimer = setInterval(beat, BEAT_MS)
  const deadline = setTimeout(() => teardown('expired'), Math.max(1_000, share.expires_at - now()))
  running = { stop: teardown }
  setStatus({ share, watching: [], ended: null })
  beat()
  return true
}

/** Tests only. */
export function __resetScreenShare(): void {
  running?.stop('ended')
  running = null
  status = null
  runtime = null
  emitChange()
}

// ── Ticket history: one line per share ───────────────────────────────────────

export interface ShareHistoryRow {
  id: number | string
  action?: string | null
  text: string
  /** Who wrote the row (user id), when known. */
  user?: string | null
  user_name: string | null
  at: string
}

function endedWord(text: string): string | null {
  if (/^Stopped sharing/i.test(text)) return null
  if (/page closed/i.test(text)) return 'ended when the page closed'
  if (/30 minutes/i.test(text)) return 'ended after 30 minutes'
  if (/moved/i.test(text)) return 'ended when the request moved'
  if (/request closed/i.test(text)) return 'ended when the request closed'
  if (/restarted/i.test(text)) return 'restarted'
  return 'ended'
}

/**
 * The support person's look at the requester's activity (`support-traffic-view`) is an access
 * audit row the requester sees too, so it is worded for whoever reads it and names the person
 * itself (the row then shows no separate author). Other rows: unchanged, author shown.
 */
export function historyLine(
  row: { action?: string | null; text: string; user_name: string | null },
  reader: { isRequester: boolean; requesterName: string | null }
): { text: string; showAuthor: boolean } {
  if (row.action !== 'support-traffic-view') return { text: row.text, showAuthor: true }
  const who = row.user_name ?? 'Someone'
  if (reader.isRequester)
    return { text: `${who} looked at your recent activity around this ticket`, showAuthor: false }
  const whose = reader.requesterName ? `${reader.requesterName}'s` : 'the requester’s'
  return { text: `${who} viewed ${whose} activity around the ticket`, showAuthor: false }
}

/**
 * Fold each screen share's start / first-look / stop rows (actions screen-share-start,
 * -watch, -stop) into ONE history line: "Shared their screen with Beth · 4 min · watched by
 * Beth · page closed". A support person's look at the requester's activity
 * (`support-traffic-view`, logged once per share) shows once per person, and never when the
 * requester looked at their own. Every other row passes through untouched, in order.
 */
export function foldShareHistory<T extends ShareHistoryRow>(
  rows: T[],
  opts: { requester?: string | null } = {}
): T[] {
  const out: T[] = []
  const requester = opts.requester ? String(opts.requester).toUpperCase() : null
  const looked = new Set<string>()
  let open: { at: number; row: T; to: string; watchers: string[] } | null = null
  const finish = (dur: string | null, why: string | null, running: boolean) => {
    if (!open) return
    const { to, watchers } = open
    const parts = [
      running ? `Sharing their screen with ${to} now` : `Shared their screen with ${to}`
    ]
    if (dur) parts.push(dur)
    // The bar's words for a running share; the shared-with person is not named twice.
    const onlyTarget = watchers.length > 0 && watchers.every((w) => w === to)
    if (running) parts.push(watchers.length ? 'watching now' : 'not opened yet')
    else if (watchers.length === 0) parts.push('not watched')
    else parts.push(onlyTarget ? 'watched' : `watched by ${watchers.join(', ')}`)
    if (why) parts.push(why)
    out[open.at] = { ...open.row, text: parts.join(' · ') }
    open = null
  }
  for (const r of rows) {
    if (r.action === 'screen-share-start') {
      finish(null, 'restarted', false)
      const to = /with (.+)$/.exec(r.text)?.[1] ?? 'support'
      open = { at: out.length, row: r, to, watchers: [] }
      out.push(r)
    } else if (r.action === 'screen-share-watch' && open) {
      const name = r.user_name ?? 'someone'
      if (!open.watchers.includes(name)) open.watchers.push(name)
    } else if (r.action === 'screen-share-stop' && open) {
      const dur = /\(([^)]+)\)\s*$/.exec(r.text)?.[1] ?? null
      finish(dur, endedWord(r.text), false)
    } else if (r.action === 'support-traffic-view') {
      const by = String(r.user ?? r.user_name ?? '').toUpperCase()
      if (requester && by === requester) continue
      if (by && looked.has(by)) continue
      if (by) looked.add(by)
      out.push(r)
    } else out.push(r)
  }
  finish(null, null, true)
  return out
}
