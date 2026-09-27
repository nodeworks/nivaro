/**
 * How long this process took to start, phase by phase.
 *
 * A boot that went from 5 seconds to 40 used to be noticed by whoever was
 * waiting on it. Each phase is timed here, the newest boots are kept per
 * instance in Redis, and a phase that took far longer than it usually does is
 * flagged.
 *
 * Leaf module: imports nothing of the app.
 */

export interface BootPhase {
  name: string
  ms: number
  /** Milliseconds after the process started that the phase began. */
  at: number
  /** Ran beside the boot, not in its way (cache warms, a schema build). */
  background: boolean
  failed?: boolean
}

export interface BootReport {
  started_at: string
  ready_at: string | null
  /** Process start to accepting requests. */
  total_ms: number | null
  phases: BootPhase[]
}

const processStart = Date.now() - Math.round(process.uptime() * 1000)
const phases: BootPhase[] = []
let readyAt: number | null = null

function push(p: BootPhase): void {
  phases.push(p)
  if (phases.length > 60) phases.shift()
}

/** Time a phase. The phase's own failure is recorded and rethrown. */
export async function bootPhase<T>(
  name: string,
  fn: () => Promise<T> | T,
  opts: { background?: boolean } = {}
): Promise<T> {
  const began = Date.now()
  try {
    const out = await fn()
    push({ name, ms: Date.now() - began, at: began - processStart, background: !!opts.background })
    return out
  } catch (err) {
    push({
      name,
      ms: Date.now() - began,
      at: began - processStart,
      background: !!opts.background,
      failed: true
    })
    throw err
  }
}

/** Record a phase that was timed elsewhere. */
export function markBootPhase(name: string, ms: number, opts: { background?: boolean } = {}): void {
  push({
    name,
    ms: Math.max(0, Math.round(ms)),
    at: Date.now() - processStart - ms,
    background: !!opts.background
  })
}

/** The process accepts requests from now. */
export function markBootReady(): void {
  if (readyAt == null) readyAt = Date.now()
}

export function bootReport(): BootReport {
  return {
    started_at: new Date(processStart).toISOString(),
    ready_at: readyAt ? new Date(readyAt).toISOString() : null,
    total_ms: readyAt ? readyAt - processStart : null,
    phases: [...phases].sort((a, b) => a.at - b.at)
  }
}

// ── what is usual ────────────────────────────────────────────────────────────

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

export interface PhaseVerdict extends BootPhase {
  usual_ms: number | null
  /** Took at least twice its usual time and at least a second longer. */
  slow: boolean
}

/** Judge each phase of `current` against the same phase in earlier boots. */
export function judgePhases(current: BootPhase[], earlier: BootPhase[][]): PhaseVerdict[] {
  return current.map((p) => {
    const before = earlier
      .map((b) => b.find((x) => x.name === p.name && !x.failed)?.ms)
      .filter((v): v is number => typeof v === 'number')
    const usual = before.length >= 3 ? median(before) : null
    return {
      ...p,
      usual_ms: usual,
      slow: usual != null && p.ms >= usual * 2 && p.ms - usual >= 1000
    }
  })
}

// ── kept per instance ────────────────────────────────────────────────────────

interface RedisLike {
  lpush(key: string, value: string): Promise<unknown>
  ltrim(key: string, start: number, stop: number): Promise<unknown>
  lrange(key: string, start: number, stop: number): Promise<string[]>
  expire(key: string, seconds: number): Promise<unknown>
}

const KEEP = 20
const keyOf = (instance: string) => `nvr:boots:${instance}`
let stored = false

/** Store this boot once. Background phases that finish later are included by
 *  calling it again (the entry is replaced). */
export async function storeBoot(redis: RedisLike, instance: string): Promise<void> {
  try {
    const body = JSON.stringify({ ...bootReport(), pid: process.pid })
    const key = keyOf(instance)
    if (stored) {
      const list = await redis.lrange(key, 0, 0)
      const head = list[0] ? (JSON.parse(list[0]) as { pid?: number; started_at?: string }) : null
      if (head?.pid === process.pid && head.started_at === bootReport().started_at) {
        await (
          redis as unknown as { lset(k: string, i: number, v: string): Promise<unknown> }
        ).lset(key, 0, body)
        return
      }
    }
    await redis.lpush(key, body)
    await redis.ltrim(key, 0, KEEP - 1)
    await redis.expire(key, 90 * 86_400)
    stored = true
  } catch {
    /* Redis unavailable — this boot is reported from memory only */
  }
}

export async function earlierBoots(redis: RedisLike, instance: string): Promise<BootReport[]> {
  try {
    const rows = await redis.lrange(keyOf(instance), 0, KEEP - 1)
    const mine = bootReport().started_at
    return rows
      .map((r) => {
        try {
          return JSON.parse(r) as BootReport
        } catch {
          return null
        }
      })
      .filter((r): r is BootReport => !!r && r.started_at !== mine)
  } catch {
    return []
  }
}
