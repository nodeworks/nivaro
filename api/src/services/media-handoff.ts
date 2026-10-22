import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { cronTicksEnabled } from './cron-ticks.js'
import { hasFfmpeg } from './ffmpeg.js'
import { getApp } from './io-holder.js'
import { canaryLenient, imageVariant } from './render-peer.js'

/**
 * Media hand-off (slim parity). A process with no ffmpeg or Chromium of its
 * own (the slim image, NIVARO_IMAGE_VARIANT=slim) never runs a media job
 * that ends in a stored artefact — a clip, generated captions, an upload's
 * thumbnails and waveform, a session-replay video. It records the job as an
 * id on a Redis list and kicks the media worker: a full-image process that
 * reads the same storage and database, pops one job of each kind at a time
 * and runs it exactly as it would have run for a request of its own. The
 * job's own state (the clip row, the caption job, the upload row, the job run
 * and notification) is what the author sees, so nothing waits on the
 * request that started it.
 *
 * Work a request waits on goes to the render peer instead (render-peer.ts:
 * PDFs, probes, remuxes, conversions, the encoder report).
 *
 *   list    <prefix>nvr:media-handoff:<db>:<kind>          JSON {kind, payload, at}
 *   records <prefix>nvr:media-handoff:<db>:<kind>:records  kinds with a requester (replay-webm)
 *   kick    <prefix>nvr:media-handoff:<db>:kick            the kind (or 'render')
 *   beat    <prefix>nvr:media-worker:<db>                  who drains, 90 s TTL
 *
 * <prefix> is REDIS_CHANNEL_PREFIX, <db> the database name: two instances on
 * one Redis never take each other's jobs. A process only hands off while a
 * worker heartbeat is there; otherwise the work is refused with the readable
 * 503 at once. A kind with a requester (replay-webm) keeps a record of each
 * queued job until it has run, so a job dropped on the way (stale, unreadable,
 * lost in a crash) still ends as a failed run and a notification. The enqueue
 * (the backlog cap, the per-person cap, the record and the push) is one Lua
 * script, so concurrent requests cannot pass a cap together.
 *
 * Who drains: MEDIA_WORKER=on|off, else a full-image process that ticks crons
 * and is not NIVARO_ROLE=web (the worker of a web + worker stack). Never in
 * cloud mode: a job carries no tenant, so cloud runs the full image.
 * Payloads are ids only; the worker re-reads everything it needs.
 */

export type HandoffKind = 'clip' | 'captions' | 'extras' | 'replay-webm'
export const HANDOFF_KINDS: readonly HandoffKind[] = ['clip', 'captions', 'extras', 'replay-webm']

/** What a kind needs on the process that runs it. */
const NEEDS_CHROMIUM: Record<HandoffKind, boolean> = {
  clip: false,
  captions: false,
  extras: false,
  'replay-webm': true
}

/** Jobs of one kind waiting before a new one is refused (503). */
const MAX_WAITING = 500
/** Kinds whose jobs have a requester: queued per person at most this many
 *  (429 past it), each kept as a record until it has run. */
const PER_USER_MAX: Partial<Record<HandoffKind, number>> = { 'replay-webm': 5 }
/** A job older than this is dropped unrun (its own state has gone stale). */
const ITEM_MAX_AGE_MS = 24 * 3_600_000
const HEARTBEAT_MS = 30_000
export const MEDIA_WORKER_TTL_S = 90
/** The worker also looks every this often (a kick can be missed). */
const POLL_MS = 30_000

const prefix = () => process.env.REDIS_CHANNEL_PREFIX ?? ''
/** The database this instance serves, as a key part (two instances on one
 *  Redis without a REDIS_CHANNEL_PREFIX still never share a queue). */
const dbScope = () =>
  (config.DB_DATABASE || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '_')
    .slice(0, 64)
export const handoffKey = (kind: HandoffKind) => `${prefix()}nvr:media-handoff:${dbScope()}:${kind}`
export const handoffRecordsKey = (kind: HandoffKind) => `${handoffKey(kind)}:records`
export const handoffKickChannel = () => `${prefix()}nvr:media-handoff:${dbScope()}:kick`
export const mediaWorkerKey = () => `${prefix()}nvr:media-worker:${dbScope()}`

function cloudMode(): boolean {
  return !!process.env.CLOUD_META_DB_URL
}

export interface HandoffRedis {
  rpush(key: string, value: string): Promise<unknown>
  lpop(key: string): Promise<string | null>
  llen(key: string): Promise<number>
  publish(channel: string, message: string): Promise<unknown>
  set(key: string, value: string, ex: 'EX', seconds: number): Promise<unknown>
  get(key: string): Promise<string | null>
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
  hgetall(key: string): Promise<Record<string, string>>
  hget(key: string, field: string): Promise<string | null>
  hdel(key: string, field: string): Promise<unknown>
}

function redis(): HandoffRedis | null {
  const r = getApp()?.redis
  return r && typeof r.rpush === 'function' && typeof r.lpop === 'function' ? r : null
}

type HandoffError = Error & { statusCode: number; code: string }
function handoffError(statusCode: number, code: string, message: string): HandoffError {
  return Object.assign(new Error(message), { statusCode, code })
}

/** Can this process run `kind` itself (the binaries are here)? */
export async function canRunHere(kind: HandoffKind): Promise<boolean> {
  if (!(await hasFfmpeg())) return false
  if (!NEEDS_CHROMIUM[kind]) return true
  const { hasLocalChromium } = await import('./pdf-layout.js')
  return hasLocalChromium()
}

/** Can this process hand a job to the media worker (Redis, not cloud mode)? */
export function handoffAvailable(): boolean {
  return !cloudMode() && !!redis()
}

/** Where a job of `kind` started on this process runs: here, or on the
 *  media worker. Throws the readable 503 when neither is possible: no
 *  Redis, cloud mode, or no media worker (able to run the kind) has checked
 *  in — work nobody would run is refused, never accepted. */
export async function mediaPlacement(kind: HandoffKind): Promise<'here' | 'worker'> {
  if (await canRunHere(kind)) return 'here'
  if (!handoffAvailable()) throw unavailableError(kind)
  const beat = await readMediaWorker()
  if (!beat) throw unavailableError(kind, 'no media worker has checked in')
  if (NEEDS_CHROMIUM[kind] && !beat.chromium)
    throw unavailableError(kind, 'the media worker has no Chromium')
  return 'worker'
}

export function unavailableError(kind: HandoffKind, reason?: string): HandoffError {
  const missing = NEEDS_CHROMIUM[kind] ? 'ffmpeg and Chromium' : 'ffmpeg'
  const why =
    reason ??
    (cloudMode()
      ? 'cloud mode cannot hand media work to another server'
      : 'there is no Redis to hand it to the media worker')
  return handoffError(
    503,
    'RENDER_UNAVAILABLE',
    `This server has no ${missing}${imageVariant() === 'slim' ? ' (slim image)' : ''}, and ${why}.`
  )
}

/**
 * The enqueue, atomic: KEYS = list, records. ARGV = backlog cap, item,
 * record id ('' = none), record, requester, per-person cap. -1 = backlog
 * full, -2 = this person already has as many queued as allowed.
 */
export const ENQUEUE_LUA = `
if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[1]) then return -1 end
if ARGV[3] ~= '' then
  local n = 0
  for _, v in ipairs(redis.call('HVALS', KEYS[2])) do
    local ok, rec = pcall(cjson.decode, v)
    if ok and type(rec) == 'table' and rec.user == ARGV[5] then n = n + 1 end
  end
  if n >= tonumber(ARGV[6]) then return -2 end
  redis.call('HSET', KEYS[2], ARGV[3], ARGV[4])
end
return redis.call('RPUSH', KEYS[1], ARGV[2])
`

/** Queue one job for the media worker and kick it. A kind with a requester
 *  (PER_USER_MAX) needs `user` and gets a record (`record_id` in the payload). */
export async function handOff(
  kind: HandoffKind,
  payload: Record<string, unknown>,
  opts: { user?: string } = {}
): Promise<void> {
  const r = redis()
  if (cloudMode() || !r) throw unavailableError(kind)
  const perUser = PER_USER_MAX[kind]
  if (perUser && !opts.user) throw new Error(`a ${kind} hand-off needs its requester`)
  const at = Date.now()
  const recordId = perUser ? randomUUID() : ''
  const body = recordId ? { ...payload, record_id: recordId } : payload
  const record = recordId ? JSON.stringify({ user: opts.user, payload: body, at }) : ''
  const n = Number(
    await r.eval(
      ENQUEUE_LUA,
      2,
      handoffKey(kind),
      handoffRecordsKey(kind),
      MAX_WAITING,
      JSON.stringify({ kind, payload: body, at }),
      recordId,
      record,
      opts.user ?? '',
      perUser ?? 0
    )
  )
  if (n === -1)
    throw handoffError(
      503,
      'RENDER_BUSY',
      'Too much media work is waiting for the media worker. Try again in a few minutes.'
    )
  if (n === -2)
    throw handoffError(
      429,
      'MEDIA_HANDOFF_USER_LIMIT',
      `You already have ${perUser} of these waiting. Try again when one is done.`
    )
  await r.publish(handoffKickChannel(), kind).catch(() => 0)
}

/** Tell the media worker something is waiting ('render': a help-video render
 *  was queued on a process that cannot render). Best effort. */
export function kickMediaWorker(what: HandoffKind | 'render'): void {
  if (cloudMode()) return
  void redis()
    ?.publish(handoffKickChannel(), what)
    .catch(() => 0)
}

/** Does this process drain the hand-off lists? (The binaries are checked
 *  when it starts.) */
export function mediaWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MEDIA_WORKER ?? '').trim().toLowerCase()
  if (raw === 'off' || cloudMode()) return false
  if (imageVariant() === 'slim') return false
  if (raw === 'on') return true
  if ((env.NIVARO_ROLE ?? '').trim().toLowerCase() === 'web') return false
  return cronTicksEnabled()
}

export interface MediaWorkerBeat {
  instance: string
  name: string | null
  version: string
  ffmpeg: boolean
  chromium: boolean
  at: string
}

/** The newest media worker heartbeat, or null when none checked in lately. */
export async function readMediaWorker(
  r: HandoffRedis | null = redis()
): Promise<(MediaWorkerBeat & { age_ms: number }) | null> {
  if (!r) return null
  const raw = await r.get(mediaWorkerKey()).catch(() => null)
  if (!raw) return null
  try {
    const beat = JSON.parse(raw) as MediaWorkerBeat
    return { ...beat, age_ms: Math.max(0, Date.now() - new Date(beat.at).getTime()) }
  } catch {
    return null
  }
}

/** Jobs waiting per kind (for the readiness check and the docs). */
export async function handoffBacklog(
  r: HandoffRedis | null = redis()
): Promise<Record<HandoffKind, number> | null> {
  if (!r) return null
  const out = {} as Record<HandoffKind, number>
  for (const k of HANDOFF_KINDS) out[k] = Number(await r.llen(handoffKey(k)).catch(() => 0))
  return out
}

// ── The worker ──────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isId = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)
const optMs = (v: unknown) => v === null || (Number.isFinite(v) && (v as number) >= 0)

/** Runs one job here. Each runner goes through its module's own queue (the
 *  heavy slot, the conversion slot), so a hand-off is made exactly like a
 *  job of this process. A payload that is not what its kind sends is
 *  dropped. Imported lazily: the feature modules import this one. */
const RUN: Record<HandoffKind, (p: Record<string, unknown>) => Promise<void>> = {
  clip: async (p) => {
    if (!isId(p.id)) throw new Error('bad clip id')
    await (await import('./help-video-clips.js')).runClipHere(p.id)
  },
  captions: async (p) => {
    if (!isId(p.version_id)) throw new Error('bad version id')
    await (await import('./help-video-captions.js')).runCaptionJobHere(p.version_id)
  },
  extras: async (p) => {
    const i = p.input as Record<string, unknown> | undefined
    if (!isId(p.user_id) || !i || !isId(i.uploadId) || !isId(i.fileId))
      throw new Error('bad extras job')
    await (await import('./help-video-extras.js')).runMediaExtrasHere(String(p.user_id), {
      uploadId: String(i.uploadId),
      fileId: String(i.fileId),
      mime: String(i.mime ?? ''),
      durationMs: i.durationMs == null ? null : Number(i.durationMs),
      width: i.width == null ? null : Number(i.width),
      height: i.height == null ? null : Number(i.height),
      hasAudio: i.hasAudio === true
    })
  },
  'replay-webm': async (p) => {
    if (!isId(p.recordingId) || !isId(p.userId) || !optMs(p.fromMs) || !optMs(p.toMs))
      throw new Error('bad replay export job')
    await (await import('./session-replay-export.js')).runWebmExportHere({
      recordingId: p.recordingId,
      userId: p.userId,
      fromMs: p.fromMs as number | null,
      toMs: p.toMs as number | null
    })
  }
}

/** What a kind with a requester does when its job is dropped unrun (stale,
 *  unreadable, failed before it started, lost): the requester hears why and
 *  a failed run is recorded. The record is what we wrote at enqueue. */
const DROP: Partial<
  Record<HandoffKind, (record: { user?: unknown; payload?: unknown }, why: string) => Promise<void>>
> = {
  'replay-webm': async (rec, why) => {
    const p = (rec.payload ?? {}) as Record<string, unknown>
    if (!isId(rec.user)) return
    await (await import('./session-replay-export.js')).failQueuedWebmExport(
      String(rec.user),
      isId(p.recordingId) ? p.recordingId : null,
      why
    )
  }
}

interface WorkerDeps {
  redis: HandoffRedis & { duplicate?: () => unknown }
  log?: { warn: (o: unknown, m?: string) => void; info?: (o: unknown, m?: string) => void }
  instance: string
  name: string | null
  version: string
  /** Test seam: the runners and the drop handlers. */
  run?: Partial<typeof RUN>
  drop?: Partial<typeof DROP>
}

let worker: {
  stop: () => Promise<void>
  drain: (k: HandoffKind) => Promise<void>
  sweep: () => Promise<void>
} | null = null

interface Subscriber {
  subscribe: (c: string) => Promise<unknown>
  on: (e: string, fn: (...a: unknown[]) => void) => unknown
  quit?: () => Promise<unknown>
  disconnect?: () => void
}

/** Kicks on a duplicated connection; null without one (the poll still drains). */
async function subscribeKicks(
  r: { duplicate?: () => unknown },
  onKick: (what: string) => void
): Promise<Subscriber | null> {
  try {
    const conn = (r.duplicate?.() as Subscriber | undefined) ?? null
    if (!conn) return null
    conn.on('error', () => {})
    await conn.subscribe(handoffKickChannel())
    conn.on('message', (_channel, msg) => onKick(String(msg)))
    return conn
  } catch {
    return null
  }
}

/** Starts draining the hand-off lists on this process when it is the media
 *  worker and has ffmpeg. Returns false when it does not drain. */
export async function startMediaWorker(deps: WorkerDeps): Promise<boolean> {
  if (worker || !mediaWorkerEnabled()) return false
  const r = deps.redis
  if (!(await hasFfmpeg())) {
    deps.log?.warn({}, '[media-worker] this process has no ffmpeg: it does not take hand-offs')
    return false
  }
  const { hasLocalChromium } = await import('./pdf-layout.js')
  const chromium = await hasLocalChromium()
  const run = { ...RUN, ...deps.run }
  const drop = { ...DROP, ...deps.drop }
  let stopped = false
  const inflight = new Map<HandoffKind, Promise<void>>()

  const beat = () =>
    r
      .set(
        mediaWorkerKey(),
        JSON.stringify({
          instance: deps.instance,
          name: deps.name,
          version: deps.version,
          ffmpeg: true,
          chromium,
          at: new Date().toISOString()
        } satisfies MediaWorkerBeat),
        'EX',
        MEDIA_WORKER_TTL_S
      )
      .catch(() => null)

  /** Drops a kind's record (if it has one) and tells its requester why. */
  const dropRecord = async (kind: HandoffKind, recordId: unknown, why: string) => {
    if (!PER_USER_MAX[kind] || !isId(recordId)) return
    const raw = await r.hget(handoffRecordsKey(kind), recordId).catch(() => null)
    await r.hdel(handoffRecordsKey(kind), recordId).catch(() => 0)
    if (!raw) return
    try {
      await drop[kind]?.(JSON.parse(raw), why)
    } catch (err) {
      deps.log?.warn({ err, kind }, '[media-worker] could not report a dropped job')
    }
  }

  /** One job of a kind at a time, popped only when the last one is done, so
   *  a crash loses at most the one in hand (each kind's own state says so:
   *  stale clips and caption jobs fail, job runs are marked interrupted, and
   *  a requester's record is swept below). Background pool: none of this is
   *  a request. */
  const drain = (kind: HandoffKind): Promise<void> => {
    const running = inflight.get(kind)
    if (running) return running
    if (stopped || (NEEDS_CHROMIUM[kind] && !chromium)) return Promise.resolve()
    const p = runInBackgroundPool(async () => {
      for (;;) {
        if (stopped) return
        const raw = await r.lpop(handoffKey(kind)).catch(() => null)
        if (!raw) return
        let item: { kind?: unknown; payload?: unknown; at?: unknown }
        try {
          item = JSON.parse(raw)
        } catch {
          continue // unreadable: no record id to report (the sweep ends its record)
        }
        const payload = (item.payload ?? {}) as Record<string, unknown>
        const at = Number(item.at)
        if (!Number.isFinite(at) || Date.now() - at > ITEM_MAX_AGE_MS) {
          await dropRecord(kind, payload.record_id, 'it waited too long for the media worker')
          continue
        }
        try {
          await run[kind](payload)
          // The runner reported its own outcome (job run + notification).
          if (isId(payload.record_id))
            await r.hdel(handoffRecordsKey(kind), payload.record_id).catch(() => 0)
        } catch (err) {
          deps.log?.warn({ err, kind }, '[media-worker] a handed-off job failed')
          await dropRecord(kind, payload.record_id, 'the media worker could not start it')
        }
      }
    }).finally(() => inflight.delete(kind))
    inflight.set(kind, p)
    return p
  }
  /** Records whose job never ran (an item lost in a crash or unreadable):
   *  past the age limit and an hour of slack, the requester hears it failed. */
  const sweep = () =>
    runInBackgroundPool(async () => {
      for (const kind of HANDOFF_KINDS) {
        if (!PER_USER_MAX[kind]) continue
        const all = await r.hgetall(handoffRecordsKey(kind)).catch(() => ({}))
        for (const [id, raw] of Object.entries(all ?? {})) {
          let at = 0
          try {
            at = Number((JSON.parse(raw) as { at?: unknown }).at)
          } catch {
            at = 0
          }
          if (Number.isFinite(at) && at > 0 && Date.now() - at < ITEM_MAX_AGE_MS + 3_600_000)
            continue
          await dropRecord(kind, id, 'it was lost on the way to the media worker')
        }
      }
    })
  const drainAll = () => {
    for (const k of HANDOFF_KINDS) void drain(k)
  }

  await beat()
  // A kick on its own connection (a subscribed connection can do nothing else).
  const sub = await subscribeKicks(r, (what) =>
    runInBackgroundPool(() => {
      if (what === 'render') {
        void import('./help-video-render.js').then((m) => m.kickRenderer()).catch(() => null)
      } else if ((HANDOFF_KINDS as readonly string[]).includes(what)) {
        void drain(what as HandoffKind)
      }
    })
  )
  const timer = setInterval(
    () => {
      void beat()
      drainAll()
      void sweep().catch(() => null)
    },
    Math.min(HEARTBEAT_MS, POLL_MS)
  )
  timer.unref?.()
  drainAll()
  deps.log?.info?.({ chromium }, '[media-worker] draining media hand-offs')

  worker = {
    drain,
    sweep,
    stop: async () => {
      stopped = true
      clearInterval(timer)
      const conn = sub
      if (conn) await (conn.quit?.() ?? Promise.resolve()).catch(() => conn.disconnect?.())
      worker = null
    }
  }
  return true
}

/** Stops the worker (shutdown, tests). Jobs already running finish. */
export async function stopMediaWorker(): Promise<void> {
  await worker?.stop()
}

/** Tests: drain one kind now and wait for it. */
export async function drainForTests(kind: HandoffKind): Promise<void> {
  await worker?.drain(kind)
}

/** Tests: run the lost-record sweep now. */
export async function sweepForTests(): Promise<void> {
  await worker?.sweep()
}

// ── Judging (readiness + preflight share it) ───────────────────────────────

export interface MediaJudgement {
  status: 'ok' | 'warn' | 'fail'
  summary: string
}

/**
 * Is there somewhere for this process's media jobs to run? Passes when it
 * has ffmpeg and Chromium itself. Otherwise it needs the media worker's
 * heartbeat; on the slim image anything less FAILS (a deploy gate must stop
 * it before people's clips and exports wait forever), elsewhere it warns.
 */
export function judgeMediaWorker(
  local: { ffmpeg: boolean; chromium: boolean },
  ctx: {
    variant: 'slim' | 'full' | null
    cloud: boolean
    redis: boolean
    worker: (MediaWorkerBeat & { age_ms: number }) | null
    backlog?: Record<HandoffKind, number> | null
    /** NIVARO_ROLE: a deploy canary only warns (canaryLenient). */
    role?: string
  }
): MediaJudgement {
  return canaryLenient(judgeMediaWorkerFor(local, ctx), ctx.role ?? process.env.NIVARO_ROLE)
}

function judgeMediaWorkerFor(
  local: { ffmpeg: boolean; chromium: boolean },
  ctx: Parameters<typeof judgeMediaWorker>[1]
): MediaJudgement {
  if (local.ffmpeg && local.chromium)
    return {
      status: 'ok',
      summary:
        'This process makes clips, captions, thumbnails and replay videos itself (ffmpeg and Chromium are here).'
    }
  const bad: MediaJudgement['status'] = ctx.variant === 'slim' ? 'fail' : 'warn'
  if (ctx.cloud)
    return {
      status: bad,
      summary:
        'No ffmpeg or Chromium here, and cloud mode cannot hand media work to a worker: run the full image.'
    }
  if (!ctx.redis)
    return {
      status: bad,
      summary:
        'No ffmpeg or Chromium here and no Redis: clips, captions, thumbnails and replay videos cannot be handed to the media worker.'
    }
  if (!ctx.worker)
    return {
      status: bad,
      summary: `No media worker has checked in for ${MEDIA_WORKER_TTL_S} s: clips, captions, thumbnails and replay videos started here wait until one does (a full-image process with CRON_TICKS on, or MEDIA_WORKER=on).`
    }
  if (!local.chromium && !ctx.worker.chromium)
    return {
      status: bad,
      summary: `The media worker (${ctx.worker.name ?? ctx.worker.instance}) has no Chromium: session-replay videos cannot be made.`
    }
  const waiting = ctx.backlog
    ? Object.entries(ctx.backlog)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ')
    : ''
  return {
    status: 'ok',
    summary: `Media work goes to the media worker ${ctx.worker.name ?? ctx.worker.instance} (${ctx.worker.version}), last seen ${Math.round(ctx.worker.age_ms / 1000)} s ago${waiting ? `; waiting: ${waiting}` : ''}.`
  }
}
