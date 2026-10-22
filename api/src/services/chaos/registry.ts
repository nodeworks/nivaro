import { createHash, randomUUID } from 'node:crypto'
import { instanceKey } from '../instance-key.js'
import { INSTANCE_ID } from '../instance-roster.js'
import {
  type ArmedFault,
  clampSeconds,
  type FaultDefinition,
  type FaultParams,
  type FaultTarget,
  getFault,
  type Release,
  validateParams,
  validateTarget
} from './catalog.js'
import { assertChaosAllowed, ChaosError, chaosRefusal } from './gate.js'

/**
 * The fault-point registry (#2827). Code that can fail asks `chaosPoint('mail.send')` on its
 * hot path; the answer is the armed fault acting there (or null) from a module-level index —
 * O(1), no I/O, no await, nothing allocated when nothing is armed.
 *
 * Every armed fault is time-boxed (the catalog caps it) and self-heals twice over: a timer
 * disarms it, and every `chaosPoint` call checks `ends_at` in case the timer is late. Arm,
 * disarm and Stop all reach the other replicas over a Redis channel (prefixed like the other
 * channels) and the `nvr:chaos:armed` hash, which a replica booting mid-drill reads. Stop all
 * clears THIS process first and only then tells Redis, so it works with Redis down.
 */

export const CHAOS_NODE = `${instanceKey()}·${INSTANCE_ID}`

const PREFIX = process.env.REDIS_CHANNEL_PREFIX ?? ''
export const CHAOS_CHANNEL = `${PREFIX}nvr:chaos`
export const ARMED_KEY = 'nvr:chaos:armed'
/** The hash outlives the longest fault by this much, so a late reader still sees it expire. */
const ARMED_KEY_GRACE_S = 600

export interface ChaosPointContext {
  /** The request path (no query string) for route targets. */
  route?: string
  table?: string
  userId?: string | null
  /** A stable key (request id, socket id, record key) for share targets. */
  key?: string
  node?: string
}

export interface ArmSpec {
  id?: string
  fault_key: string
  target?: unknown
  params?: unknown
  seconds?: unknown
  started_by?: string | null
  started_by_name?: string | null
  run_id?: string | null
}

export type RegistryEvent =
  | { type: 'armed'; fault: ArmedFault; remote: boolean }
  | { type: 'disarmed'; fault: ArmedFault; reason: string; remote: boolean }
  | { type: 'expired'; fault: ArmedFault; remote: boolean }
  | { type: 'stop-all'; faults: ArmedFault[]; reason: string; remote: boolean }

/** The slice of ioredis the registry uses (tests pass a fake; null = this process alone). */
export interface ChaosBus {
  publish(channel: string, message: string): Promise<unknown>
  hset(key: string, field: string, value: string): Promise<unknown>
  hdel(key: string, ...fields: string[]): Promise<unknown>
  hgetall(key: string): Promise<Record<string, string>>
  del(key: string): Promise<unknown>
  expire(key: string, seconds: number): Promise<unknown>
  duplicate(): {
    subscribe(channel: string): Promise<unknown>
    on(event: 'message', fn: (channel: string, message: string) => void): unknown
  }
}

interface Entry {
  fault: ArmedFault
  timer: ReturnType<typeof setTimeout> | null
  releases: Release[]
}

const armed = new Map<string, Entry>()
/** point name → the faults acting there (rebuilt on every change; read on every hot path). */
let byPoint: Map<string, ArmedFault[]> = new Map()
const listeners = new Set<(ev: RegistryEvent) => void>()
const stopAllHooks = new Set<(reason: string) => void | Promise<void>>()
let bus: ChaosBus | null = null
let subscribed = false
let appRef: unknown = null

/** The Fastify app for faults whose `apply` needs it (set once at boot). */
export function setChaosApp(app: unknown): void {
  appRef = app
}

// ─── Hot path ─────────────────────────────────────────────────────────────────

/** Stable 0–99.99 bucket of a key within one fault (pure). */
export function shareBucket(key: string, faultId: string): number {
  const h = createHash('sha1').update(`${faultId}|${key}`).digest()
  return (h.readUInt32BE(0) % 10_000) / 100
}

const ROUTE_SUBJECT_MAX = 2048

/**
 * Linear-time glob match: `*` spans anything, segments are found with indexOf in order (no
 * RegExp — a crafted URL against a pattern with several stars must not backtrack on the hot
 * path). A pattern without `*` matches the path itself or anything under it.
 */
export function routeMatches(pattern: string, rawRoute: string): boolean {
  const route =
    rawRoute.length > ROUTE_SUBJECT_MAX ? rawRoute.slice(0, ROUTE_SUBJECT_MAX) : rawRoute
  if (!pattern.includes('*')) return route === pattern || route.startsWith(`${pattern}/`)
  const parts = pattern.split('*')
  let pos = 0
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]
    if (seg === '') continue
    if (i === 0) {
      if (!route.startsWith(seg)) return false
      pos = seg.length
      continue
    }
    if (i === parts.length - 1) return route.length - pos >= seg.length && route.endsWith(seg)
    const at = route.indexOf(seg, pos)
    if (at < 0) return false
    pos = at + seg.length
  }
  return true
}

/** Does this fault reach what the caller describes (pure)? */
export function targetMatches(fault: ArmedFault, ctx: ChaosPointContext | undefined): boolean {
  const t = fault.target
  switch (t.kind) {
    case 'all':
      return true
    case 'route':
      return !!ctx?.route && routeMatches(t.pattern, ctx.route.split('?')[0])
    case 'table':
      return !!ctx?.table && ctx.table.toLowerCase() === t.table.toLowerCase()
    case 'user':
      return !!ctx?.userId && ctx.userId.toLowerCase() === t.user_id
    case 'share':
      return ctx?.key
        ? shareBucket(ctx.key, fault.id) < t.share_pct
        : Math.random() * 100 < t.share_pct
    case 'node':
      return (ctx?.node ?? CHAOS_NODE) === t.node
    case 'room':
      return false
  }
}

/**
 * The fault acting at `name` for this call, or null. Expired faults answer null at once and
 * are cleared on the next tick (never inside the caller's hot path).
 */
export function chaosPoint(name: string, ctx?: ChaosPointContext): ArmedFault | null {
  if (byPoint.size === 0) return null
  const list = byPoint.get(name)
  if (!list) return null
  const now = Date.now()
  for (const f of list) {
    if (now >= f.ends_at) {
      setTimeout(() => expire(f.id), 0).unref?.()
      continue
    }
    if (targetMatches(f, ctx)) return f
  }
  return null
}

/** A number parameter of the fault at `name` (0 when nothing is armed) — the common one-liner. */
export function chaosNumber(name: string, param: string, ctx?: ChaosPointContext): number {
  const f = chaosPoint(name, ctx)
  if (!f) return 0
  const v = f.params[param]
  return typeof v === 'number' ? v : Number(v) || 0
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export function armedFaults(now = Date.now()): ArmedFault[] {
  const out: ArmedFault[] = []
  for (const e of armed.values()) if (now < e.fault.ends_at) out.push(e.fault)
  return out.sort((a, b) => a.started_at - b.started_at)
}

export function armedFault(id: string): ArmedFault | null {
  const e = armed.get(id)
  return e && Date.now() < e.fault.ends_at ? e.fault : null
}

export function onRegistryChange(fn: (ev: RegistryEvent) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Run on Stop all, for drills that live outside the registry (socket drills from /realtime). */
export function onStopAll(fn: (reason: string) => void | Promise<void>): () => void {
  stopAllHooks.add(fn)
  return () => {
    stopAllHooks.delete(fn)
  }
}

// ─── Local state ──────────────────────────────────────────────────────────────

function rebuildIndex(): void {
  const next = new Map<string, ArmedFault[]>()
  for (const e of armed.values()) {
    const def = getFault(e.fault.fault_key)
    for (const p of def?.points ?? []) {
      const list = next.get(p) ?? []
      list.push(e.fault)
      next.set(p, list)
    }
  }
  byPoint = next
}

function notify(ev: RegistryEvent): void {
  for (const fn of listeners) {
    try {
      fn(ev)
    } catch {
      /* a listener never affects the drill */
    }
  }
}

async function runApply(def: FaultDefinition, entry: Entry, origin: boolean): Promise<void> {
  if (!def.apply) return
  if ((def.apply_scope ?? 'every') === 'origin' && !origin) return
  try {
    const release = await def.apply(entry.fault, { app: appRef, origin })
    if (typeof release === 'function') {
      // The fault may have ended while apply ran.
      if (armed.get(entry.fault.id) === entry) entry.releases.push(release)
      else await release()
    }
  } catch (err) {
    // The fault points still act; the side effect is reported through the run events.
    notify({
      type: 'disarmed',
      fault: entry.fault,
      reason: `apply failed: ${(err as Error)?.message ?? err}`,
      remote: false
    })
  }
}

/** Arm in this process only (the bus calls it for remote arms). */
async function armLocal(fault: ArmedFault, origin: boolean): Promise<Entry | null> {
  if (armed.has(fault.id)) return armed.get(fault.id) ?? null
  const def = getFault(fault.fault_key)
  if (!def) return null
  const now = Date.now()
  if (now >= fault.ends_at) return null
  const entry: Entry = { fault, timer: null, releases: [] }
  entry.timer = setTimeout(() => expire(fault.id), fault.ends_at - now)
  entry.timer.unref?.()
  armed.set(fault.id, entry)
  rebuildIndex()
  await runApply(def, entry, origin)
  notify({ type: 'armed', fault, remote: !origin })
  return entry
}

async function clearLocal(id: string): Promise<ArmedFault | null> {
  const entry = armed.get(id)
  if (!entry) return null
  armed.delete(id)
  rebuildIndex()
  if (entry.timer) clearTimeout(entry.timer)
  for (const release of entry.releases.splice(0)) {
    try {
      await release()
    } catch {
      /* the undo is best effort; the fault points are already clear */
    }
  }
  return entry.fault
}

async function expire(id: string): Promise<void> {
  const fault = await clearLocal(id)
  if (!fault) return
  notify({ type: 'expired', fault, remote: fault.node !== CHAOS_NODE })
  if (fault.node === CHAOS_NODE) await busCall((b) => b.hdel(ARMED_KEY, id))
}

// ─── Cluster bus ──────────────────────────────────────────────────────────────

type BusMessage =
  | { node: string; action: 'arm'; fault: ArmedFault }
  | { node: string; action: 'disarm'; id: string; reason: string }
  | { node: string; action: 'stop-all'; reason: string }

async function busCall(fn: (b: ChaosBus) => Promise<unknown>): Promise<void> {
  if (!bus) return
  try {
    await fn(bus)
  } catch {
    /* Redis down: this process already did its part */
  }
}

function publish(msg: BusMessage): Promise<void> {
  return busCall((b) => b.publish(CHAOS_CHANNEL, JSON.stringify(msg)))
}

async function onBusMessage(raw: string): Promise<void> {
  let msg: BusMessage
  try {
    msg = JSON.parse(raw) as BusMessage
  } catch {
    return
  }
  if (!msg || msg.node === CHAOS_NODE) return
  if (chaosRefusal()) return
  if (msg.action === 'arm' && msg.fault) await armLocal(msg.fault, false)
  else if (msg.action === 'disarm' && msg.id) {
    const fault = await clearLocal(msg.id)
    if (fault) notify({ type: 'disarmed', fault, reason: msg.reason, remote: true })
  } else if (msg.action === 'stop-all') {
    const faults = armedFaults()
    for (const f of faults) await clearLocal(f.id)
    notify({ type: 'stop-all', faults, reason: msg.reason, remote: true })
    for (const fn of stopAllHooks) {
      try {
        await fn(msg.reason)
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Join the cluster: hear other replicas' arms and stops, and pick up faults armed before this
 * process started (a boot mid-drill must not be the one replica without the fault). Idempotent.
 */
export async function startChaosCluster(redis: ChaosBus | null): Promise<void> {
  bus = redis
  if (!bus || subscribed) return
  subscribed = true
  try {
    const sub = bus.duplicate()
    sub.on('message', (channel, message) => {
      if (channel === CHAOS_CHANNEL) void onBusMessage(message)
    })
    await sub.subscribe(CHAOS_CHANNEL)
  } catch {
    subscribed = false
  }
  await loadArmedFromBus()
}

/** Arm whatever the `nvr:chaos:armed` hash still holds (unexpired). */
export async function loadArmedFromBus(): Promise<number> {
  if (!bus || chaosRefusal()) return 0
  let rows: Record<string, string> = {}
  try {
    rows = (await bus.hgetall(ARMED_KEY)) ?? {}
  } catch {
    return 0
  }
  let n = 0
  const now = Date.now()
  for (const [id, raw] of Object.entries(rows)) {
    try {
      const fault = JSON.parse(raw) as ArmedFault
      if (fault.ends_at <= now) {
        await busCall((b) => b.hdel(ARMED_KEY, id))
        continue
      }
      if (armed.has(id)) continue
      if (await armLocal(fault, false)) n++
    } catch {
      /* skip a bad row */
    }
  }
  return n
}

// ─── Public writes ────────────────────────────────────────────────────────────

/** Arm a fault here and on every replica. Validates against the catalog (throws ChaosError). */
export async function armFault(spec: ArmSpec): Promise<ArmedFault> {
  assertChaosAllowed()
  const def = getFault(spec.fault_key)
  if (!def) throw new ChaosError(`unknown fault ${spec.fault_key}`, 400, 'CHAOS_UNKNOWN_FAULT')
  const target: FaultTarget = validateTarget(def, spec.target)
  const params: FaultParams = validateParams(def, spec.params)
  const seconds = clampSeconds(def, spec.seconds)
  const now = Date.now()
  const fault: ArmedFault = {
    id: spec.id ?? randomUUID(),
    fault_key: def.key,
    label: def.label,
    target,
    params,
    started_at: now,
    ends_at: now + seconds * 1000,
    started_by: spec.started_by ?? null,
    started_by_name: spec.started_by_name ?? null,
    run_id: spec.run_id ?? null,
    node: CHAOS_NODE
  }
  const entry = await armLocal(fault, true)
  if (!entry) throw new ChaosError('the fault could not be armed', 500, 'CHAOS_ARM_FAILED')
  await busCall(async (b) => {
    await b.hset(ARMED_KEY, fault.id, JSON.stringify(fault))
    await b.expire(ARMED_KEY, seconds + ARMED_KEY_GRACE_S)
  })
  await publish({ node: CHAOS_NODE, action: 'arm', fault })
  return fault
}

/** Disarm one fault everywhere (this process first). False when it was not armed here. */
export async function disarm(id: string, reason = 'stopped'): Promise<boolean> {
  const fault = await clearLocal(id)
  if (fault) notify({ type: 'disarmed', fault, reason, remote: false })
  await busCall((b) => b.hdel(ARMED_KEY, id))
  await publish({ node: CHAOS_NODE, action: 'disarm', id, reason })
  return !!fault
}

/**
 * Stop every fault on every replica, socket drills included. Local clear first, then the
 * hooks (socket drills), then Redis — so it works when Redis is the thing that failed.
 */
export async function stopAll(reason = 'stop all'): Promise<ArmedFault[]> {
  const faults = armedFaults()
  for (const f of [...armed.keys()]) await clearLocal(f)
  notify({ type: 'stop-all', faults, reason, remote: false })
  for (const fn of stopAllHooks) {
    try {
      await fn(reason)
    } catch {
      /* best effort */
    }
  }
  await busCall((b) => b.del(ARMED_KEY))
  await publish({ node: CHAOS_NODE, action: 'stop-all', reason })
  return faults
}

/** Tests only: drop every fault and listener without telling anyone. */
export async function _resetRegistryForTests(): Promise<void> {
  for (const id of [...armed.keys()]) await clearLocal(id)
  listeners.clear()
  stopAllHooks.clear()
  bus = null
  subscribed = false
  appRef = null
}
