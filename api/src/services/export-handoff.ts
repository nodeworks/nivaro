import { cronTicksEnabled } from './cron-ticks.js'
import { handoffDbScope, handoffPrefix } from './import-handoff.js'
import { processRole } from './process-role.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Export hand-off (2026-11-18): a background export runs on an export drainer — the exporter
 * (NIVARO_ROLE=exporter), else the importer, else the cron worker, else a single process (see
 * exportDrainMode) — not on the web process that answered the click; shaped like the import
 * hand-off (services/import-handoff.ts).
 *
 * A background export is a SERIALIZABLE job (`ExportJob`): kind, subject, the person's id, the
 * query / filters / fields / format / preset id captured when it started, the workspace — never
 * a closure. The process that runs it rebuilds the builder from it (services/export-kinds.ts),
 * re-reading the person and judging access exactly as the starter would; nothing here decides
 * access.
 *
 *   list     <prefix>nvr:export-handoff:<db>               JSON ExportJob, one per waiting run
 *   kick     <prefix>nvr:export-handoff:<db>:kick          a run id
 *   claimed  <prefix>nvr:export-handoff:<db>:claimed       hash run id → the job's JSON
 *   leases   <prefix>nvr:export-handoff:<db>:leases        hash run id → `<runner>|<expires ms>`
 *   cancel   <prefix>nvr:export-cancel:<db>:<tenant|->:<run>   set by Cancel, read by the runner
 *   beat     <prefix>nvr:export-worker:<db>                the exporter (role=exporter), 90 s TTL
 *   importer <prefix>nvr:export-worker:<db>:importer       an importer draining exports, 90 s TTL
 *   fallback <prefix>nvr:export-worker:<db>:fallback       any other drainer, 90 s TTL
 *
 * Every script names all its keys in KEYS (Redis Cluster / Dragonfly refuse undeclared keys):
 * leases are fields of one hash with their expiry in the value, not keys with a TTL.
 *
 * A job is claimed by one script that pops it, takes its lease and records the claim (atomic:
 * two drainers never run one job, and a drainer that dies in between loses nothing). The run ROW
 * (nivaro_job_runs) stays the truth for status; the list only carries the job. A claimed job
 * whose lease runs out lost its process: a drainer marks the run failed with a sentence (an
 * export is cheap to start again; replaying it later over newer data is not what was asked).
 *
 * The starting process hands a job off only while an export drainer beats; otherwise it runs it
 * itself, as before. While the job waits, the starter checks every EXPORT_TAKE_BACK_MS: once no
 * drainer beats any more it takes the job back (LREM — atomic against the drainer's LPOP) and
 * runs it itself.
 *
 * Never in cloud mode (a cloud export runs where it started). EXPORT_HANDOFF=off runs every
 * export where it started.
 */

export type ExportRunKind = 'preset' | 'items' | 'audit'

export interface ExportJob {
  v: 1
  run_id: number
  kind: ExportRunKind
  /** Preset id, collection, 'audit'. */
  subject: string
  /** Tray label ("Exporting Workflows"). */
  label: string
  user_id: string
  workspace_id: string | null
  /** What the builder needs, captured at start (query, filters, fields, format, preset id…). */
  params: Record<string, unknown>
  total: number | null
  /** The per-person run slot the starter claimed (services/background-runs.ts). */
  slot: number
  slot_owner: string
  /** When the run started (ms) — its duration counts from here. */
  started_at: number
  /** When it was handed off (ms). */
  queued_at?: number
}

export const EXPORT_WORKER_TTL_S = 90
export const EXPORT_BEAT_MS = 30_000
/** A claimed job's lease: long enough that a stalled event loop does not lose a live run. */
export const EXPORT_LEASE_TTL_S = 300
export const EXPORT_LEASE_RENEW_MS = 30_000
/** A job that waited longer than this is not run any more (it fails with a sentence). */
export const EXPORT_QUEUE_MAX_WAIT_MS = 6 * 3_600_000
/** How often a starter checks that someone is still there to run its waiting job. */
export const EXPORT_TAKE_BACK_MS = 15_000
/** Readiness warns when an export has waited this long with nothing draining. */
export const EXPORT_STUCK_MS = 2 * 60_000

const base = () => `${handoffPrefix()}nvr:export-handoff:${handoffDbScope()}`
export const exportQueueKey = () => base()
export const exportKickChannel = () => `${base()}:kick`
export const exportClaimedKey = () => `${base()}:claimed`
export const exportLeasesKey = () => `${base()}:leases`
export const exportWorkerKey = () => `${handoffPrefix()}nvr:export-worker:${handoffDbScope()}`
export const exportImporterBeatKey = () => `${exportWorkerKey()}:importer`
export const exportFallbackKey = () => `${exportWorkerKey()}:fallback`

/** Hand-offs are possible at all: self-hosted, and not switched off. */
export function exportHandoffEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLOUD_META_DB_URL) return false
  return (env.EXPORT_HANDOFF ?? '').trim().toLowerCase() !== 'off'
}

/**
 * Who drains export jobs (fix round 2: the exporter process):
 *   exporter  NIVARO_ROLE=exporter — always (it drains only exports)
 *   enabled   EXPORT_WORKER=on
 *   importer  NIVARO_ROLE=importer — only while no exporter beats
 *   fallback  the cron worker of a split stack — only while neither an exporter nor an importer
 *             draining exports beats
 *   inline    a single process (no NIVARO_ROLE) that ticks crons
 *   off       EXPORT_WORKER=off, EXPORT_HANDOFF=off, cloud, web / realtime / canary, a process
 *             whose crons do not tick
 */
export type ExportDrainMode = 'exporter' | 'enabled' | 'importer' | 'fallback' | 'inline' | 'off'

export function exportDrainMode(env: NodeJS.ProcessEnv = process.env): ExportDrainMode {
  if (!exportHandoffEnabled(env)) return 'off'
  const flag = (env.EXPORT_WORKER ?? '').trim().toLowerCase()
  if (flag === 'off') return 'off'
  const role = processRole(env)
  if (role === 'exporter') return 'exporter'
  if (flag === 'on') return 'enabled'
  if (role === 'importer') return 'importer'
  if (role === 'web' || role === 'realtime' || role === 'canary') return 'off'
  if (!cronTicksEnabled()) return 'off'
  return role ? 'fallback' : 'inline'
}

/** Most export jobs one drainer runs at once (EXPORT_WORKER_CONCURRENCY, 1–8, default 2;
 *  EXPORT_WORKER_PARALLEL is read as an older name). */
export function exportWorkerConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  for (const raw of [env.EXPORT_WORKER_CONCURRENCY, env.EXPORT_WORKER_PARALLEL]) {
    const n = Number(raw)
    if (raw != null && raw !== '' && Number.isInteger(n) && n >= 1 && n <= 8) return n
  }
  return 2
}
/** @deprecated name kept for callers: exportWorkerConcurrency. */
export const exportWorkerParallel = exportWorkerConcurrency

// ── Redis ────────────────────────────────────────────────────────────────────

export interface ExportRedis {
  rpush(key: string, value: string): Promise<unknown>
  lpop(key: string): Promise<string | null>
  lrange(key: string, start: number, stop: number): Promise<string[]>
  lrem(key: string, count: number, value: string): Promise<number>
  publish(channel: string, message: string): Promise<unknown>
  set(key: string, value: string, ex: 'EX', seconds: number): Promise<unknown>
  get(key: string): Promise<string | null>
  del(key: string): Promise<unknown>
  hset(key: string, field: string, value: string): Promise<unknown>
  hget(key: string, field: string): Promise<string | null>
  hgetall(key: string): Promise<Record<string, string>>
  hdel(key: string, field: string): Promise<unknown>
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>
}

export function asExportRedis(r: unknown): ExportRedis | null {
  const x = r as Partial<ExportRedis> | null | undefined
  return x &&
    typeof x.rpush === 'function' &&
    typeof x.lpop === 'function' &&
    typeof x.lrem === 'function' &&
    typeof x.hgetall === 'function' &&
    typeof x.eval === 'function'
    ? (x as ExportRedis)
    : null
}

/** Parse one list entry; null when it is not a job. */
export function parseExportJob(raw: string | null | undefined): ExportJob | null {
  if (!raw) return null
  try {
    const j = JSON.parse(raw) as Partial<ExportJob>
    if (
      j?.v !== 1 ||
      !Number.isInteger(j.run_id) ||
      typeof j.kind !== 'string' ||
      typeof j.user_id !== 'string' ||
      !j.user_id ||
      typeof j.params !== 'object' ||
      j.params == null ||
      Array.isArray(j.params)
    )
      return null
    return j as ExportJob
  } catch {
    return null
  }
}

/** The run id an entry names, even when the entry is not a job this version can run. */
export function runIdOf(raw: string | null | undefined): number | null {
  const m = /"run_id":(\d+)/.exec(raw ?? '')
  const n = m ? Number(m[1]) : Number.NaN
  return Number.isSafeInteger(n) ? n : null
}

/** Put a job on the list and kick the drainers. Returns the list entry (LREM needs it verbatim). */
export async function enqueueExport(r: ExportRedis, job: ExportJob): Promise<string> {
  const raw = JSON.stringify({ ...job, queued_at: job.queued_at ?? Date.now() })
  await r.rpush(exportQueueKey(), raw)
  await r.publish(exportKickChannel(), String(job.run_id)).catch(() => 0)
  return raw
}

/** Take a waiting job back off the list: true when this caller removed it (nobody claimed it). */
export async function takeBackExport(r: ExportRedis, raw: string): Promise<boolean> {
  try {
    return Number(await r.lrem(exportQueueKey(), 1, raw)) === 1
  } catch {
    return false
  }
}

/** The waiting entry of one run, when it is still on the list. */
export async function queuedExportEntry(
  r: ExportRedis,
  runId: number
): Promise<{ raw: string; job: ExportJob } | null> {
  const raws = await r.lrange(exportQueueKey(), 0, 999).catch(() => [] as string[])
  for (const raw of raws) {
    const job = parseExportJob(raw)
    if (job && job.run_id === runId) return { raw, job }
  }
  return null
}

/** Waiting entries older than `maxWaitMs` (their starter's watcher may be gone). */
export async function staleQueuedExports(
  r: ExportRedis,
  now = Date.now(),
  maxWaitMs = EXPORT_QUEUE_MAX_WAIT_MS
): Promise<Array<{ raw: string; job: ExportJob }>> {
  const raws = await r.lrange(exportQueueKey(), 0, 999).catch(() => [] as string[])
  const out: Array<{ raw: string; job: ExportJob }> = []
  for (const raw of raws) {
    const job = parseExportJob(raw)
    if (job && now - (job.queued_at ?? job.started_at) > maxWaitMs) out.push({ raw, job })
  }
  return out
}

/** Ages (ms) of the waiting entries — the readiness check reads them. */
export async function queuedExportAges(r: ExportRedis, now = Date.now()): Promise<number[]> {
  const raws = await r.lrange(exportQueueKey(), 0, 999).catch(() => [] as string[])
  const ages: number[] = []
  for (const raw of raws) {
    const job = parseExportJob(raw)
    if (job) ages.push(Math.max(0, now - (job.queued_at ?? job.started_at)))
  }
  return ages
}

/** A lease value: `<runner>|<expires at, ms>`. */
export function leaseValue(by: string, now = Date.now()): string {
  return `${by}|${now + EXPORT_LEASE_TTL_S * 1000}`
}
export function parseLease(v: string | null | undefined): { by: string; until: number } | null {
  if (!v) return null
  const i = v.lastIndexOf('|')
  if (i < 0) return null
  const until = Number(v.slice(i + 1))
  return Number.isFinite(until) ? { by: v.slice(0, i), until } : null
}

/**
 * Pop + validate + lease + claim in ONE script (fix rounds 1 and 2): a drainer that dies between
 * taking a job off the list and recording that it runs it can no longer lose the job. The entry
 * is decoded (cjson) and only a job of THIS shape is claimed; any other entry (another version's
 * job, garbage) comes back as {raw, 'invalid'} unclaimed, and the caller fails its run by id.
 * KEYS: list, claimed hash, leases hash. ARGV: the lease value.
 */
export const CLAIM_EXPORT_SCRIPT = `-- nvr:export-claim
local raw = redis.call('lpop', KEYS[1])
if not raw then return false end
local ok, job = pcall(cjson.decode, raw)
local id = string.match(raw, '"run_id":(%d+)')
if not ok or type(job) ~= 'table' or job.v ~= 1 or not id or type(job.kind) ~= 'string'
  or type(job.user_id) ~= 'string' or type(job.params) ~= 'table' then
  return {raw, 'invalid'}
end
redis.call('hset', KEYS[3], id, ARGV[1])
redis.call('hset', KEYS[2], id, raw)
return {raw, 'claimed'}`

/** Renew the lease only while `by` still holds it. KEYS: leases. ARGV: id, by, new value. */
export const RENEW_EXPORT_SCRIPT = `-- nvr:export-renew
local v = redis.call('hget', KEYS[1], ARGV[1])
if v and string.sub(v, 1, string.len(ARGV[2]) + 1) == ARGV[2] .. '|' then
  redis.call('hset', KEYS[1], ARGV[1], ARGV[3])
  return 1
end
return 0`

/**
 * Release a claim only while it is ours (fix round 2: a late release never removes the claim of
 * a drainer that took the job since). KEYS: claimed, leases. ARGV: id, match, mode — `owner`
 * (the lease is `<match>|…`) or `exact` (the lease value is exactly `<match>`; `` = no lease).
 */
export const RELEASE_EXPORT_SCRIPT = `-- nvr:export-release
local v = redis.call('hget', KEYS[2], ARGV[1])
local mine
if ARGV[3] == 'exact' then
  mine = (v == false and ARGV[2] == '') or v == ARGV[2]
else
  mine = v and string.sub(v, 1, string.len(ARGV[2]) + 1) == ARGV[2] .. '|'
end
if not mine then return 0 end
redis.call('hdel', KEYS[2], ARGV[1])
redis.call('hdel', KEYS[1], ARGV[1])
return 1`

export type ClaimResult = { job: ExportJob } | { invalidRunId: number | null; raw: string }

/** Claim the next waiting job for `by` (atomic, see CLAIM_EXPORT_SCRIPT). Null = nothing waits. */
export async function claimNextExport(r: ExportRedis, by: string): Promise<ClaimResult | null> {
  const out = (await r.eval(
    CLAIM_EXPORT_SCRIPT,
    3,
    exportQueueKey(),
    exportClaimedKey(),
    exportLeasesKey(),
    leaseValue(by)
  )) as [string, string] | null
  if (!out || !Array.isArray(out)) return null
  const [raw, state] = out
  const job = state === 'claimed' ? parseExportJob(raw) : null
  if (job) return { job }
  // Claimed by the script but unreadable here (should not happen): let go of it.
  if (state === 'claimed') await releaseExportClaim(r, runIdOf(raw) ?? -1, by)
  return { invalidRunId: runIdOf(raw), raw }
}

/** Record that `by` runs the job (lease first, then the claim). */
export async function claimExport(r: ExportRedis, job: ExportJob, by: string): Promise<void> {
  await r.hset(exportLeasesKey(), String(job.run_id), leaseValue(by))
  await r.hset(exportClaimedKey(), String(job.run_id), JSON.stringify(job))
}

/** Renew `by`'s lease; false when the lease is no longer ours (stop the run). */
export async function renewExportLease(
  r: ExportRedis,
  runId: number,
  by: string
): Promise<boolean> {
  try {
    const n = await r.eval(
      RENEW_EXPORT_SCRIPT,
      1,
      exportLeasesKey(),
      String(runId),
      by,
      leaseValue(by)
    )
    return Number(n) === 1
  } catch {
    // Redis trouble: keep going (a lost lease is judged by the sweep, not by a failed renewal).
    return true
  }
}

/** The run is over (any outcome): drop its claim and lease — only while they are `by`'s. */
export async function releaseExportClaim(
  r: ExportRedis,
  runId: number,
  by: string
): Promise<boolean> {
  try {
    const n = await r.eval(
      RELEASE_EXPORT_SCRIPT,
      2,
      exportClaimedKey(),
      exportLeasesKey(),
      String(runId),
      by,
      'owner'
    )
    return Number(n) === 1
  } catch {
    return false
  }
}

/** Release a lost claim exactly as it was found (`lease` = the value read, null = none). */
export async function releaseLostExportClaim(
  r: ExportRedis,
  runId: number,
  lease: string | null
): Promise<boolean> {
  try {
    const n = await r.eval(
      RELEASE_EXPORT_SCRIPT,
      2,
      exportClaimedKey(),
      exportLeasesKey(),
      String(runId),
      lease ?? '',
      'exact'
    )
    return Number(n) === 1
  } catch {
    return false
  }
}

/** Claimed jobs whose runner stopped renewing its lease (and that this process is not running). */
export async function lostExportClaims(
  r: ExportRedis,
  runningHere: ReadonlySet<number>,
  now = Date.now()
): Promise<Array<{ job: ExportJob | null; runId: number; lease: string | null }>> {
  const all = await r.hgetall(exportClaimedKey()).catch(() => ({}) as Record<string, string>)
  const leases = await r.hgetall(exportLeasesKey()).catch(() => ({}) as Record<string, string>)
  const lost: Array<{ job: ExportJob | null; runId: number; lease: string | null }> = []
  for (const [field, raw] of Object.entries(all ?? {})) {
    const runId = Number(field)
    if (!Number.isInteger(runId) || runningHere.has(runId)) continue
    const lease = leases?.[field] ?? null
    const parsed = parseLease(lease)
    if (parsed && parsed.until > now) continue
    lost.push({ job: parseExportJob(raw), runId, lease })
  }
  return lost
}

/** The cancel flag of one run: prefixed and scoped like every hand-off key. */
export function exportCancelKey(runId: number): string {
  return `${handoffPrefix()}nvr:export-cancel:${handoffDbScope()}:${currentTenantKey() || '-'}:${runId}`
}

export const LOST_EXPORT_NOTE =
  'The process running this export stopped before it finished. Start the export again.'
export const STALE_EXPORT_NOTE =
  'This export waited too long for the export worker and was not run. Start it again.'
export const INVALID_EXPORT_NOTE =
  'This export was queued by a different version of the app and could not be run. Start it again.'

// ── Heartbeats ───────────────────────────────────────────────────────────────

export type ExportBeatRole = 'exporter' | 'importer' | 'fallback'

export interface ExportWorkerBeat {
  role: ExportBeatRole
  instance: string
  name: string | null
  version: string
  at: string
}

const beatKey = (role: ExportBeatRole) =>
  role === 'exporter'
    ? exportWorkerKey()
    : role === 'importer'
      ? exportImporterBeatKey()
      : exportFallbackKey()

/** The beat role of a drain mode. */
export function beatRoleOf(mode: ExportDrainMode): ExportBeatRole {
  return mode === 'exporter' || mode === 'enabled'
    ? 'exporter'
    : mode === 'importer'
      ? 'importer'
      : 'fallback'
}

export async function beatExportWorker(r: ExportRedis, beat: ExportWorkerBeat): Promise<void> {
  await r.set(beatKey(beat.role), JSON.stringify(beat), 'EX', EXPORT_WORKER_TTL_S).catch(() => null)
}

export async function readExportBeat(
  r: ExportRedis | null,
  which: ExportBeatRole
): Promise<(ExportWorkerBeat & { age_ms: number }) | null> {
  if (!r) return null
  const raw = await r.get(beatKey(which)).catch(() => null)
  if (!raw) return null
  try {
    const b = JSON.parse(raw) as ExportWorkerBeat
    return { ...b, age_ms: Math.max(0, Date.now() - new Date(b.at).getTime()) }
  } catch {
    return null
  }
}

/** Is any export drainer alive (other than `exceptInstance`, when given)? */
export async function exportDrainerAlive(
  r: ExportRedis | null,
  exceptInstance?: string
): Promise<boolean> {
  if (!r) return false
  for (const role of ['exporter', 'importer', 'fallback'] as const) {
    const b = await readExportBeat(r, role)
    if (b && b.instance !== exceptInstance) return true
  }
  return false
}

/** Should this process drain exports right now (see ExportDrainMode)? */
export async function shouldDrainExportsNow(
  mode: ExportDrainMode,
  r: ExportRedis | null
): Promise<boolean> {
  if (mode === 'off') return false
  if (mode === 'importer') return !(await readExportBeat(r, 'exporter'))
  if (mode === 'fallback')
    return !(await readExportBeat(r, 'exporter')) && !(await readExportBeat(r, 'importer'))
  return true
}

/**
 * Where should a background export this process just started run?
 *   'here'    hand-off off / cloud / no Redis / this process is an active drainer itself /
 *             nobody drains
 *   'handoff' an export drainer beats elsewhere
 */
export async function exportPlacement(r: ExportRedis | null): Promise<'here' | 'handoff'> {
  if (!exportHandoffEnabled() || !r) return 'here'
  if (await shouldDrainExportsNow(exportDrainMode(), r)) return 'here'
  return (await exportDrainerAlive(r)) ? 'handoff' : 'here'
}

// ── Judging (readiness + preflight share it) ───────────────────────────────

export interface ExportJudgement {
  status: 'ok' | 'warn'
  summary: string
}

/** Is something draining the export hand-off? Warns when exports waited > EXPORT_STUCK_MS
 *  with no drainer beating. */
export function judgeExportWorker(ctx: {
  cloud: boolean
  handoff: boolean
  redis: boolean
  exporter: (ExportWorkerBeat & { age_ms: number }) | null
  importer: (ExportWorkerBeat & { age_ms: number }) | null
  fallback: (ExportWorkerBeat & { age_ms: number }) | null
  self: ExportDrainMode
  queued: number
  stuck: number
}): ExportJudgement {
  if (ctx.cloud) return { status: 'ok', summary: 'Cloud mode: exports run where they start.' }
  if (!ctx.handoff)
    return { status: 'ok', summary: 'EXPORT_HANDOFF=off: every export runs where it started.' }
  const waiting = ctx.queued > 0 ? `${ctx.queued} export(s) waiting` : 'nothing waiting'
  const name = (b: ExportWorkerBeat) => b.name ?? b.instance
  if (ctx.exporter)
    return {
      status: 'ok',
      summary: `Background exports run on the exporter ${name(ctx.exporter)} (${ctx.exporter.version}); ${waiting}.`
    }
  if (ctx.importer)
    return {
      status: 'ok',
      summary: `No exporter (NIVARO_ROLE=exporter) has checked in: the importer ${name(ctx.importer)} runs background exports in its place; ${waiting}.`
    }
  if (ctx.fallback)
    return {
      status: 'ok',
      summary: `No exporter or importer has checked in: the worker ${name(ctx.fallback)} runs background exports; ${waiting}.`
    }
  if (ctx.stuck > 0)
    return {
      status: 'warn',
      summary: `${ctx.stuck} background export(s) have waited over ${EXPORT_STUCK_MS / 60_000} minutes and nothing is running them: no exporter, importer or worker has checked in for ${EXPORT_WORKER_TTL_S} s${ctx.redis ? '' : ' (and there is no Redis to hear from one)'}. Start the exporter service (NIVARO_ROLE=exporter).`
    }
  if (ctx.self !== 'off') return { status: 'ok', summary: `This process runs exports; ${waiting}.` }
  return {
    status: 'ok',
    summary: `No export worker has checked in: exports run where they start; ${waiting}.`
  }
}
