import { setArmedVisibility } from './armed-visibility.js'
import type { ArmedFault } from './catalog.js'
import { onRegistryChange } from './registry.js'

/**
 * Blind mode (#2854). The lead starts a drill or game day without telling the responders: while
 * its window is open, the faults the lead arms are hidden from the drill banner for everyone
 * but the lead and chaos operators (armed-visibility.ts), and drill-tagged alert routing
 * (#2847) asks `isBlindRun` before telling responders a page is only a drill. The lead can
 * reveal at any time; Stop all always works (the registry does not care about visibility).
 *
 * A window is matched to faults synchronously — the banner paths cannot wait on I/O — by the
 * runs bound to it and, until a run is bound, by "armed by the lead after the window opened".
 * Windows reach the other replicas through the `nvr:chaos:blind` hash and a pub/sub channel
 * (prefixed like the other channels); the window is published BEFORE its first fault is armed.
 */

export interface BlindWindow {
  /** The game day id, or the run id of a single blind drill. */
  id: string
  kind: 'gameday' | 'run'
  lead: string
  insiders: string[]
  /** Runs armed inside this window (bound once their id is known). */
  run_ids: string[]
  opened_at: number
  /** The window closes by itself at this time (ms). */
  until: number
  revealed_at: number | null
}

const PREFIX = process.env.REDIS_CHANNEL_PREFIX ?? ''
export const BLIND_CHANNEL = `${PREFIX}nvr:chaos:blind`
export const BLIND_KEY = 'nvr:chaos:blind'
/** A fault armed this long before the window opened still counts (clock spread). */
const OPEN_SLACK_MS = 2000

interface BlindBus {
  publish(channel: string, message: string): Promise<unknown>
  hset(key: string, field: string, value: string): Promise<unknown>
  hdel(key: string, ...fields: string[]): Promise<unknown>
  hgetall(key: string): Promise<Record<string, string>>
  expire(key: string, seconds: number): Promise<unknown>
  duplicate(): {
    subscribe(channel: string): Promise<unknown>
    on(event: 'message', fn: (channel: string, message: string) => void): unknown
    quit?(): Promise<unknown>
  }
}

const windows = new Map<string, BlindWindow>()
let bus: BlindBus | null = null
let sub: ReturnType<BlindBus['duplicate']> | null = null
let stopAllWired: (() => void) | null = null

const lc = (s: string | null | undefined) => (s ? s.toLowerCase() : '')

function live(w: BlindWindow, now = Date.now()): boolean {
  return w.revealed_at == null && now < w.until
}

function prune(now = Date.now()): void {
  for (const [id, w] of windows) if (now >= w.until) windows.delete(id)
}

/** The open (unrevealed) window a fault belongs to, if any. */
export function blindWindowOf(f: ArmedFault, now = Date.now()): BlindWindow | null {
  for (const w of windows.values()) {
    if (!live(w, now)) continue
    if (f.run_id && w.run_ids.includes(lc(f.run_id))) return w
    if (
      lc(f.started_by) === lc(w.lead) &&
      f.started_at >= w.opened_at - OPEN_SLACK_MS &&
      f.started_at <= w.until
    )
      return w
  }
  return null
}

export function isBlindFault(f: ArmedFault): boolean {
  return blindWindowOf(f) != null
}

/** For #2847 alert routing: is this run (or game day) inside an unrevealed blind window? */
export function isBlindRun(runId: string | null | undefined): boolean {
  if (!runId) return false
  const id = lc(runId)
  for (const w of windows.values())
    if (live(w) && (w.id === id || w.run_ids.includes(id))) return true
  return false
}

export function blindWindows(): BlindWindow[] {
  prune()
  return [...windows.values()]
}

export function blindWindow(id: string): BlindWindow | null {
  return windows.get(lc(id)) ?? null
}

/** The window a run is bound to (a single blind drill, or a game day's child). */
export function windowOfRun(runId: string): BlindWindow | null {
  const id = lc(runId)
  for (const w of windows.values()) if (w.id === id || w.run_ids.includes(id)) return w
  return null
}

// ─── Writes (this process first, then Redis) ─────────────────────────────────

async function share(w: BlindWindow | null, id: string): Promise<void> {
  if (!bus) return
  try {
    if (w) {
      await bus.hset(BLIND_KEY, w.id, JSON.stringify(w))
      await bus.expire(BLIND_KEY, Math.max(60, Math.ceil((w.until - Date.now()) / 1000) + 600))
    } else await bus.hdel(BLIND_KEY, id)
    await bus.publish(BLIND_CHANNEL, JSON.stringify({ id, w }))
  } catch {
    /* this process still knows; other replicas fail open to "public" — the lead can reveal */
  }
}

function changed(): void {
  void import('./drill.js').then((m) => m.emitArmedChanged()).catch(() => {})
}

export async function openBlindWindow(input: {
  id: string
  kind: BlindWindow['kind']
  lead: string
  /** More people who see the window's faults (a game day's named lead, besides its planner). */
  insiders?: string[]
  until: number
  run_ids?: string[]
}): Promise<BlindWindow> {
  const w: BlindWindow = {
    id: lc(input.id),
    kind: input.kind,
    lead: lc(input.lead),
    insiders: [...new Set([input.lead, ...(input.insiders ?? [])].map(lc))],
    run_ids: (input.run_ids ?? []).map(lc),
    opened_at: Date.now(),
    until: input.until,
    revealed_at: null
  }
  windows.set(w.id, w)
  await share(w, w.id)
  return w
}

export async function bindBlindRun(windowId: string, runId: string): Promise<void> {
  const w = windows.get(lc(windowId))
  if (!w || w.run_ids.includes(lc(runId))) return
  w.run_ids = [...w.run_ids, lc(runId)].slice(-200)
  await share(w, w.id)
}

/** The lead (or an operator) reveals: every fault of the window shows on the banner. */
export async function revealBlindWindow(id: string): Promise<BlindWindow | null> {
  const w = windows.get(lc(id))
  if (!w || w.revealed_at != null) return w ?? null
  w.revealed_at = Date.now()
  await share(w, w.id)
  changed()
  return w
}

export async function closeBlindWindow(id: string): Promise<void> {
  const had = windows.delete(lc(id))
  await share(null, lc(id))
  if (had) changed()
}

// ─── Cluster ─────────────────────────────────────────────────────────────────

function applyRemote(message: string): void {
  try {
    const m = JSON.parse(message) as { id: string; w: BlindWindow | null }
    if (!m?.id) return
    if (m.w) windows.set(lc(m.id), m.w)
    else windows.delete(lc(m.id))
  } catch {
    /* a bad message changes nothing */
  }
}

export async function startBlindCluster(redis: BlindBus | null): Promise<void> {
  setArmedVisibility({
    insidersOf: (f) => {
      const w = blindWindowOf(f)
      return w ? w.insiders : null
    }
  })
  // Stop all ends every blind window with the faults (on every replica: each hears stop-all).
  stopAllWired ??= onRegistryChange((ev) => {
    if (ev.type === 'stop-all') windows.clear()
  })
  if (!redis || bus) return
  bus = redis
  try {
    sub = redis.duplicate()
    sub.on('message', (channel, message) => {
      if (channel === BLIND_CHANNEL) applyRemote(message)
    })
    await sub.subscribe(BLIND_CHANNEL)
    const rows = (await redis.hgetall(BLIND_KEY)) ?? {}
    const now = Date.now()
    for (const [id, raw] of Object.entries(rows)) {
      try {
        const w = JSON.parse(raw) as BlindWindow
        if (w.until > now) windows.set(lc(id), w)
      } catch {
        /* skip */
      }
    }
  } catch {
    /* windows stay process-local */
  }
}

export async function stopBlindCluster(): Promise<void> {
  try {
    await sub?.quit?.()
  } catch {
    /* closing */
  }
  sub = null
  bus = null
}

/** Tests only. */
export function _resetBlindForTests(): void {
  windows.clear()
  bus = null
  sub = null
  stopAllWired?.()
  stopAllWired = null
  setArmedVisibility(null)
}
