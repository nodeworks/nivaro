import {
  handoffDbScope,
  handoffPrefix,
  type ImportDrainMode,
  importDrainMode
} from './import-handoff.js'

/**
 * Export hand-off (2026-11-18): a background export runs on the process that drains staged
 * imports (NIVARO_ROLE=importer; IMPORT_WORKER=on; the cron worker while no importer beats; a
 * single process), not on the web process that answered the click — shaped like the import
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
 *   claimed  <prefix>nvr:export-handoff:<db>:claimed       hash run id → {by, at, job}
 *   lease    <prefix>nvr:export-handoff:<db>:lease:<run>   the runner, EXPORT_LEASE_TTL_S, renewed
 *   beat     <prefix>nvr:export-worker:<db>                an importer draining exports, 90 s TTL
 *   fallback <prefix>nvr:export-worker:<db>:fallback       any other drainer, 90 s TTL
 *
 * A job is claimed by LPOP (atomic: two drainers never run one job). The run ROW
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
export const EXPORT_LEASE_TTL_S = 90
export const EXPORT_LEASE_RENEW_MS = 30_000
/** A job that waited longer than this is not run any more (it fails with a sentence). */
export const EXPORT_QUEUE_MAX_WAIT_MS = 6 * 3_600_000
/** How often a starter checks that someone is still there to run its waiting job. */
export const EXPORT_TAKE_BACK_MS = 15_000

const base = () => `${handoffPrefix()}nvr:export-handoff:${handoffDbScope()}`
export const exportQueueKey = () => base()
export const exportKickChannel = () => `${base()}:kick`
export const exportClaimedKey = () => `${base()}:claimed`
export const exportLeaseKey = (runId: number | string) => `${base()}:lease:${runId}`
export const exportWorkerKey = () => `${handoffPrefix()}nvr:export-worker:${handoffDbScope()}`
export const exportFallbackKey = () => `${exportWorkerKey()}:fallback`

/** Hand-offs are possible at all: self-hosted, and not switched off. */
export function exportHandoffEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLOUD_META_DB_URL) return false
  return (env.EXPORT_HANDOFF ?? '').trim().toLowerCase() !== 'off'
}

/** Does this process drain export jobs, and on what terms? The same processes as imports. */
export function exportDrainMode(env: NodeJS.ProcessEnv = process.env): ImportDrainMode {
  if (!exportHandoffEnabled(env)) return 'off'
  return importDrainMode(env)
}

/** Most export jobs one drainer runs at once (EXPORT_WORKER_PARALLEL, 1–8, default 2). */
export function exportWorkerParallel(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EXPORT_WORKER_PARALLEL)
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 2
}

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
  hgetall(key: string): Promise<Record<string, string>>
  hdel(key: string, field: string): Promise<unknown>
}

export function asExportRedis(r: unknown): ExportRedis | null {
  const x = r as Partial<ExportRedis> | null | undefined
  return x &&
    typeof x.rpush === 'function' &&
    typeof x.lpop === 'function' &&
    typeof x.lrem === 'function' &&
    typeof x.hgetall === 'function'
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
      !j.kind ||
      !j.user_id ||
      typeof j.params !== 'object' ||
      j.params == null
    )
      return null
    return j as ExportJob
  } catch {
    return null
  }
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

/** Claim the next waiting job (LPOP: only one drainer gets it); skips unreadable entries. */
export async function popExport(r: ExportRedis): Promise<ExportJob | null> {
  for (let i = 0; i < 20; i++) {
    const raw = await r.lpop(exportQueueKey())
    if (raw == null) return null
    const job = parseExportJob(raw)
    if (job) return job
  }
  return null
}

/** Record that `by` runs the job and take its lease. */
export async function claimExport(r: ExportRedis, job: ExportJob, by: string): Promise<void> {
  await r.hset(exportClaimedKey(), String(job.run_id), JSON.stringify({ by, at: Date.now(), job }))
  await r.set(exportLeaseKey(job.run_id), by, 'EX', EXPORT_LEASE_TTL_S)
}

export async function renewExportLease(r: ExportRedis, runId: number, by: string): Promise<void> {
  await r.set(exportLeaseKey(runId), by, 'EX', EXPORT_LEASE_TTL_S).catch(() => null)
}

/** The run is over (any outcome): drop its claim and lease. */
export async function releaseExportClaim(r: ExportRedis, runId: number): Promise<void> {
  await r.del(exportLeaseKey(runId)).catch(() => 0)
  await r.hdel(exportClaimedKey(), String(runId)).catch(() => 0)
}

/** Claimed jobs whose runner stopped renewing its lease (and that this process is not running). */
export async function lostExportClaims(
  r: ExportRedis,
  runningHere: ReadonlySet<number>
): Promise<ExportJob[]> {
  const all = await r.hgetall(exportClaimedKey()).catch(() => ({}) as Record<string, string>)
  const lost: ExportJob[] = []
  for (const [field, raw] of Object.entries(all ?? {})) {
    const runId = Number(field)
    if (!Number.isInteger(runId) || runningHere.has(runId)) continue
    if ((await r.get(exportLeaseKey(runId)).catch(() => 'unknown')) != null) continue
    let job: ExportJob | null = null
    try {
      job = parseExportJob(JSON.stringify((JSON.parse(raw) as { job?: unknown }).job))
    } catch {
      job = null
    }
    if (job) lost.push(job)
    else await r.hdel(exportClaimedKey(), field).catch(() => 0)
  }
  return lost
}

export const LOST_EXPORT_NOTE =
  'The process running this export stopped before it finished. Start the export again.'
export const STALE_EXPORT_NOTE =
  'This export waited too long for the export worker and was not run. Start it again.'

// ── Heartbeats ───────────────────────────────────────────────────────────────

export interface ExportWorkerBeat {
  role: 'importer' | 'fallback'
  instance: string
  name: string | null
  version: string
  at: string
}

export async function beatExportWorker(r: ExportRedis, beat: ExportWorkerBeat): Promise<void> {
  const key = beat.role === 'importer' ? exportWorkerKey() : exportFallbackKey()
  await r.set(key, JSON.stringify(beat), 'EX', EXPORT_WORKER_TTL_S).catch(() => null)
}

export async function readExportBeat(
  r: ExportRedis | null,
  which: 'importer' | 'fallback'
): Promise<(ExportWorkerBeat & { age_ms: number }) | null> {
  if (!r) return null
  const raw = await r
    .get(which === 'importer' ? exportWorkerKey() : exportFallbackKey())
    .catch(() => null)
  if (!raw) return null
  try {
    const b = JSON.parse(raw) as ExportWorkerBeat
    return { ...b, age_ms: Math.max(0, Date.now() - new Date(b.at).getTime()) }
  } catch {
    return null
  }
}

/** Is any export drainer alive (an importer or a fallback drainer beat lately)? */
export async function exportDrainerAlive(r: ExportRedis | null): Promise<boolean> {
  if (!r) return false
  return !!(await readExportBeat(r, 'importer')) || !!(await readExportBeat(r, 'fallback'))
}

/** Should this process drain exports right now? A fallback drains only while no importer beats. */
export async function shouldDrainExportsNow(
  mode: ImportDrainMode,
  r: ExportRedis | null
): Promise<boolean> {
  if (mode === 'off') return false
  if (mode !== 'fallback') return true
  return !(await readExportBeat(r, 'importer'))
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
