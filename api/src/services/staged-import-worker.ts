import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { NIVARO_VERSION } from '../version.js'
import { activityGroupKey, withActivityScope } from './activity-scope.js'
import { withBackgroundWork } from './background-inflight.js'
import { newChainId, startChain } from './chain.js'
import { isMultiTenant } from './deployment-mode.js'
import { getFile, readFileBuffer } from './files.js'
import { announceCollectionImportRun } from './import-collection-runs.js'
import {
  asImportRedis,
  beatImportWorker,
  enqueueImportRun,
  forgetRun,
  type ImportDrainMode,
  type ImportJudgement,
  type ImportRedis,
  type ImportWorkerBeat,
  importAttemptsKey,
  importDrainMode,
  importKickChannel,
  importLeaseMs,
  judgeImportWorker,
  judgeLeases,
  LEASE_FAIL_NOTE,
  LEASE_RENEW_MS,
  LEASE_RETRY_NOTE,
  pruneFinishedEntries,
  type RunningRow,
  readImportBeat,
  STUCK_QUEUED_MS,
  shouldDrainNow
} from './import-handoff.js'
import { loadQueueStanding, publishQueueStanding } from './import-queue-standing.js'
import { rememberRunRows } from './import-run-rows.js'
import { INSTANCE_ID } from './instance-roster.js'
import { emitImportProgress, emitJobProgress } from './live-progress.js'
import { notifyUser } from './notification-channels.js'
import { validateStagedRows } from './staged-import-validation.js'
import type { ImportDefinition } from './staged-imports.js'
import {
  describeSqlError,
  getImportDefinition,
  listImportDefinitions,
  lockGroupOf,
  parseImportFileAsync,
  parsePostRunFlows,
  runStagedImport,
  scrubSecrets
} from './staged-imports.js'
import { runAsTrafficSource, type TrafficSource, withTrafficSource } from './traffic-source.js'
import { noteImportRun } from './traffic-taps/sources.js'

/**
 * Post-completion fan-out. A staged import writes through raw SQL (BULK INSERT
 * + a procedure), so none of the items-service hooks fire for the rows it
 * changed. Two ways downstream work hangs off a run:
 *   1. the definition's `post_run_flows` — explicit flow ids, run IN ORDER,
 *      each awaited (a flow that re-evaluates auto transitions must finish
 *      before the next one reads the result);
 *   2. the generic 'staged-import-completed' flow trigger — every active flow
 *      on that trigger, minus the ones already run in step 1.
 * Fire-and-forget as a whole: a failure here must never mark a finished run
 * as failed — it lands in nivaro_flow_runs like any other flow error.
 */
function afterImportCompleted(
  app: FastifyInstance,
  definition: ImportDefinition,
  payload: {
    run_id: string
    import_key: string
    definition_label: string | null
    staging_table: string | null
    procedure: string | null
    row_count: number
    duration_seconds: number
    created_by: string | null
    /** Processor runs only: the records the run changed, per collection. */
    affected?: Record<string, Array<string | number>>
    /** Every stored record the file named, changed or not, per collection. */
    matched?: Record<string, Array<string | number>>
  }
): void {
  void (async () => {
    const explicit = parsePostRunFlows(definition.post_run_flows)
    if (explicit.length > 0) {
      const { executeFlow } = await import('./flow-executor.js')
      const rows = (await db('nivaro_flows')
        .whereIn('id', explicit)
        .select('id', 'name', 'status')) as Array<{ id: string; name: string; status: string }>
      const byId = new Map(rows.map((r) => [String(r.id).toUpperCase(), r]))
      for (const id of explicit) {
        const flow = byId.get(id)
        if (!flow) {
          app.log.warn({ import_key: payload.import_key, flow: id }, 'post-run flow missing')
          continue
        }
        if (flow.status !== 'active') {
          app.log.info(
            { import_key: payload.import_key, flow: flow.name },
            'post-run flow inactive, skipped'
          )
          continue
        }
        try {
          await executeFlow({
            flowId: flow.id,
            flowName: flow.name,
            trigger: 'staged-import-completed',
            payload,
            log: app.log,
            userId: payload.created_by ?? undefined
          })
        } catch (err) {
          app.log.error(
            { err, import_key: payload.import_key, flow: flow.name },
            'post-run flow failed'
          )
        }
      }
    }
    const { emitTrigger } = await import('../flows/registry.js')
    emitTrigger('staged-import-completed', payload, app.log, payload.created_by ?? undefined, {
      excludeFlowIds: explicit
    })
  })().catch((err) => {
    app.log.error({ err, import_key: payload.import_key }, 'post-import fan-out failed')
  })
}

/**
 * Drains `nivaro_import_queue`, one run at a time.
 *
 * Serialised deliberately: a definition's procedure truncates and refills a
 * SHARED staging table, so two concurrent runs of the same import would read
 * each other's rows.
 */

let ticking = false

const importRedis = (app: FastifyInstance): ImportRedis | null =>
  asImportRedis((app as unknown as { redis?: unknown }).redis)

/**
 * One drain pass, single-flight per process: only where importDrainMode() allows it (an
 * importer; IMPORT_WORKER=on; the worker while no importer beats; a single process), never
 * on a web process. Beats, recovers runs whose process died, drops finished hand-off entries,
 * then claims queued rows (services/import-handoff.ts).
 */
export async function drainImportsTick(app: FastifyInstance): Promise<void> {
  // Guards overlapping ticks in this process; the row's own claim covers other replicas.
  if (ticking) return
  ticking = true
  try {
    const mode = importDrainMode()
    const r = importRedis(app)
    if (!(await shouldDrainNow(mode, r))) return
    if (r) await beatImportWorker(r, beatOf(mode))
    await recoverLostRuns(app, r).catch((err) =>
      app.log.warn({ err }, 'staged-import worker: lease recovery failed')
    )
    if (r) await pruneFinishedEntries(r, statusesOf).catch(() => 0)
    await drainOnce(app)
    await publishStanding().catch(() => {})
    // Collection imports (POST /api/imports) ride the same drainers (collection-import-worker.ts).
    await drainCollectionJobsTick(app, r)
  } catch (err) {
    app.log.error({ err }, 'staged-import worker tick failed')
  } finally {
    ticking = false
  }
}

async function drainCollectionJobsTick(app: FastifyInstance, r: ImportRedis | null) {
  const w = await import('./collection-import-worker.js')
  await w
    .recoverLostCollectionJobs(app, r)
    .catch((err) => app.log.warn({ err }, 'collection-import worker: lease recovery failed'))
  await w.pruneCollectionJobEntries(r).catch(() => 0)
  await w
    .drainCollectionImportJobs(app)
    .catch((err) => app.log.error({ err }, 'collection-import worker: drain failed'))
}

function beatOf(mode: ImportDrainMode): ImportWorkerBeat {
  return {
    role: mode === 'importer' ? 'importer' : 'fallback',
    instance: INSTANCE_ID,
    name: process.env.NIVARO_INSTANCE?.trim() || null,
    version: NIVARO_VERSION,
    at: new Date().toISOString()
  }
}

async function statusesOf(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  for (let i = 0; i < ids.length; i += 500) {
    const rows = (await db('nivaro_import_queue')
      .whereIn('id', ids.slice(i, i + 500))
      .select('id', 'status')) as Array<{ id: number; status: string }>
    for (const row of rows) out.set(Number(row.id), String(row.status))
  }
  return out
}

/**
 * Runs left `running` by a process that died: their lease (`updated_at`, renewed every
 * LEASE_RENEW_MS while a run is driven) ran out. Back in the queue once (a recent run), then
 * failed with a sentence. The update matches the lease it read, so two drainers never both act.
 */
export async function recoverLostRuns(
  app: FastifyInstance,
  r: ImportRedis | null = importRedis(app),
  now = Date.now()
): Promise<Array<{ id: number; action: 'retry' | 'fail' }>> {
  const rows = (await db('nivaro_import_queue')
    .where('status', 'running')
    .select('id', 'started_at', 'updated_at', 'import_key', 'created_by')) as Array<
    RunningRow & { import_key?: string; created_by?: string | null }
  >
  const candidates = rows.filter((row) => !driving.has(String(row.id)))
  if (candidates.length === 0) return []
  const attempts = new Map<number, number>()
  if (r) {
    for (const row of candidates) {
      const n = Number(
        await (r as unknown as { hget?: (k: string, f: string) => Promise<string | null> })
          .hget?.(importAttemptsKey(), String(row.id))
          .catch(() => null)
      )
      if (Number.isFinite(n) && n > 0) attempts.set(Number(row.id), n)
    }
  }
  const acted: Array<{ id: number; action: 'retry' | 'fail' }> = []
  for (const verdict of judgeLeases(candidates, attempts, now, importLeaseMs())) {
    const row = candidates.find((c) => Number(c.id) === verdict.id)
    if (!row) continue
    const lease = row.updated_at ?? row.started_at ?? null
    const q = db('nivaro_import_queue').where({ id: verdict.id, status: 'running' })
    if (lease) q.where('updated_at', lease as Date)
    else q.whereNull('updated_at')
    const n = Number(
      verdict.action === 'retry'
        ? await q.update({
            status: 'queued',
            started_at: null,
            updated_at: new Date(),
            logs: LEASE_RETRY_NOTE
          })
        : await q.update({
            status: 'error',
            finished_at: new Date(),
            updated_at: new Date(),
            logs: LEASE_FAIL_NOTE
          })
    )
    if (n !== 1) continue
    acted.push(verdict)
    noteImportRun('error', { run_id: verdict.id, key: String(row.import_key ?? '') })
    if (verdict.action === 'retry') {
      if (r) await r.hincrby(importAttemptsKey(), String(verdict.id), 1).catch(() => 0)
      await enqueueImportRun(r, verdict.id)
    } else {
      await forgetRun(r, verdict.id)
      await notifyCreator(app, row, `${label(row)} import failed`, LEASE_FAIL_NOTE)
      emitJobProgress(row.created_by ? String(row.created_by) : null, {
        key: `import:${verdict.id}`,
        kind: 'import',
        label: `${label(row)} import`,
        status: 'error',
        error: LEASE_FAIL_NOTE,
        href: `/imports?run=${verdict.id}`
      })
    }
    app.log.warn({ queueId: verdict.id, action: verdict.action }, 'staged import lost its worker')
  }
  return acted
}

interface KickSubscriber {
  subscribe: (c: string) => Promise<unknown>
  on: (e: string, fn: (...a: unknown[]) => void) => unknown
  quit?: () => Promise<unknown>
  disconnect?: () => void
}

/** The upload's kick, heard on a duplicated connection; null without one (the loop drains). */
async function subscribeImportKicks(
  app: FastifyInstance,
  onKick: () => void
): Promise<KickSubscriber | null> {
  try {
    const dup = (app as unknown as { redis?: { duplicate?: () => unknown } }).redis?.duplicate?.()
    if (!dup) return null
    const conn = dup as KickSubscriber
    conn.on('error', () => {})
    await conn.subscribe(importKickChannel())
    conn.on('message', () => onKick())
    return conn
  } catch {
    return null
  }
}

let drainer: { stop: () => Promise<void> } | null = null

/**
 * Start draining on this process when it may: an importer or IMPORT_WORKER=on process runs its
 * own 10 s loop (it may tick no crons); every drainer also hears the upload's kick, so a run
 * starts at once instead of at the next tick. Returns the mode it runs in.
 */
export async function startImportDrainer(app: FastifyInstance): Promise<ImportDrainMode> {
  const mode = importDrainMode()
  if (mode === 'off' || drainer) return mode
  const r = importRedis(app)
  const tick = () => void runInBackgroundPool(() => drainImportsTick(app))
  const sub = await subscribeImportKicks(app, tick)
  const own = mode === 'importer' || mode === 'enabled'
  const timer = own ? setInterval(tick, 10_000) : null
  timer?.unref?.()
  if (own) tick()
  if (r && mode === 'importer') await beatImportWorker(r, beatOf(mode))
  app.log.info({ mode }, '[import-worker] draining staged imports')
  drainer = {
    stop: async () => {
      if (timer) clearInterval(timer)
      const conn = sub
      if (conn) await (conn.quit?.() ?? Promise.resolve()).catch(() => conn.disconnect?.())
      drainer = null
    }
  }
  app.addHook('onClose', async () => drainer?.stop())
  return mode
}

export function registerStagedImportWorker(app: FastifyInstance): void {
  // Registered everywhere (the roster, run-now); a tick drains only where importDrainMode()
  // allows it, and an importer, which ticks no crons, runs the same pass on its own loop.
  app.cron.schedule('staged-imports', '*/10 * * * * *', async () => {
    const mode = importDrainMode()
    if (mode === 'importer' || mode === 'enabled') return // its own loop drains
    await drainImportsTick(app)
  })
  // #846 — empty staging tables a set number of days after their last run.
  app.cron.schedule(
    'staged-import-staging-purge',
    '20 4 * * *',
    async () => {
      const { runStagingPurge } = await import('./staged-import-purge.js')
      const { purged } = await runStagingPurge()
      if (purged.length > 0) {
        app.log.info({ purged }, 'staging tables purged')
      }
    },
    {
      dryRun: async () => {
        const { runStagingPurge } = await import('./staged-import-purge.js')
        return runStagingPurge({ dryRun: true })
      }
    }
  )
}

/** A queued row is only claimable by a worker that can actually READ its
 *  file. The queue table lives in a database SHARED across environments
 *  (local dev + staging both poll it), but the uploaded bytes live on
 *  whichever host received the upload — a worker on the wrong host claiming
 *  the row fails with ENOENT on a file that exists perfectly well elsewhere.
 *  Capability, not identity: no hostname bookkeeping to go stale. A row no
 *  worker can read (file genuinely gone) errors after a grace period instead
 *  of sitting queued forever. */
const UNREADABLE_GRACE_MS = 60 * 60 * 1000

/** How many runs one process drives at once (#802). Runs in the same lock
 *  group never overlap whatever this says. */
const MAX_PARALLEL = Math.max(1, Number(process.env.IMPORT_MAX_PARALLEL ?? 3) || 3)

/** Queued + running runs with where each queued one stands (#1753). */
export async function currentStanding() {
  const defs = new Map(
    (await listImportDefinitions(false)).map((d) => [String(d.key).toLowerCase(), d])
  )
  const groupOf = (key: string): string => {
    const d = defs.get(String(key ?? '').toLowerCase())
    return d ? lockGroupOf(d) : `key:${String(key ?? '').toLowerCase()}`
  }
  const loaded = await loadQueueStanding(groupOf)
  const labelOf = (key: string): string => {
    const d = defs.get(String(key).toLowerCase())
    return d?.label ? String(d.label) : label({ import_key: key })
  }
  return { ...loaded, labelOf }
}

/** #1753 — tell each queued run's creator "3rd in line, about 4 minutes" as it moves up. */
export async function publishStanding(): Promise<void> {
  const { entries, standing, labelOf } = await currentStanding()
  publishQueueStanding(entries, standing, labelOf)
}

/** Run ids this process is driving right now. */
const driving = new Set<string>()

type QueueRow = Record<string, any>

async function drainOnce(app: FastifyInstance): Promise<void> {
  if (driving.size >= MAX_PARALLEL) return

  // #802 — runs serialise per LOCK GROUP (default: the staging table), not
  // globally: procedures truncate a shared staging table, so two runs of one
  // table must not overlap, but runs on different tables may.
  const defs = new Map(
    (await listImportDefinitions(false)).map((d) => [String(d.key).toLowerCase(), d])
  )
  const groupOf = (key: unknown): string => {
    const d = defs.get(String(key ?? '').toLowerCase())
    return d ? lockGroupOf(d) : `key:${String(key ?? '').toLowerCase()}`
  }
  const running = (await db('nivaro_import_queue')
    .where('status', 'running')
    .select('id', 'import_key')) as QueueRow[]
  const busy = new Set(running.map((r) => groupOf(r.import_key)))

  const queued = (await db('nivaro_import_queue')
    .where('status', 'queued')
    .orderBy('sort')
    .orderBy('id')
    .limit(50)) as QueueRow[]
  if (queued.length === 0) return

  // Per group, only the FIRST queued row may start — a later run of the same
  // table must never overtake an earlier one that is waiting on its file.
  const blocked = new Set<string>()
  for (const row of queued) {
    if (driving.size >= MAX_PARALLEL) return
    const group = groupOf(row.import_key)
    if (busy.has(group) || blocked.has(group)) continue

    let buffer: Buffer | null = null
    if (row.file) {
      try {
        const stored = await getFile(String(row.file))
        // A deleted file row: claim and report — no host will do better.
        if (stored) buffer = await readFileBuffer(stored)
      } catch {
        // Can't read the bytes from THIS host — leave it for the worker that
        // can, unless it has been unreadable for so long that no one can.
        const age = Date.now() - new Date((row.created_at as string) ?? Date.now()).getTime()
        if (age > UNREADABLE_GRACE_MS) {
          await db('nivaro_import_queue').where('id', row.id).update({
            status: 'error',
            finished_at: new Date(),
            updated_at: new Date(),
            logs: 'No import worker could read the uploaded file within an hour — it was likely uploaded to a host whose worker is not running, or its storage was lost. Re-upload the file.'
          })
          await notifyCreator(
            app,
            row,
            `${label(row)} import failed`,
            'No import worker could read the uploaded file. Re-upload it from the Import Console.'
          )
        } else {
          blocked.add(group)
        }
        // Keep scanning: a row of another group must not starve behind it.
        continue
      }
    }

    // Claim atomically: another worker process may be scanning the same queue.
    const claimed = await db('nivaro_import_queue')
      .where({ id: row.id, status: 'queued' })
      .update({ status: 'running', started_at: new Date(), updated_at: new Date() })
    if (Number(claimed) !== 1) continue
    busy.add(group)
    const id = String(row.id)
    driving.add(id)
    void withBackgroundWork('import', `${row.import_key ?? 'staged'} #${id}`, () =>
      runOne(app, row, buffer)
    ).finally(() => driving.delete(id))
  }
}

/** The Traffic Map source an import run's writes and partner calls are attributed to (#1143). */
const IMPORT_SOURCE: TrafficSource = { id: 'import:worker', label: 'Import worker', kind: 'import' }

async function runOne(
  app: FastifyInstance,
  next: QueueRow,
  preloaded: Buffer | null
): Promise<void> {
  let buffer = preloaded
  const began = Date.now()
  // #1826 — a procedure-mode run is announced on its collections' pages (start + end).
  let announced: ImportDefinition | null = null
  // The run's lease: while this process drives it, updated_at keeps moving. A run whose
  // updated_at stops moving lost its process and is recovered by a drainer (recoverLostRuns).
  const lease = setInterval(() => {
    void db('nivaro_import_queue')
      .where({ id: next.id, status: 'running' })
      .update({ updated_at: new Date() })
      .catch(() => 0)
  }, LEASE_RENEW_MS)
  lease.unref?.()
  try {
    const definition = await getImportDefinition(String(next.import_key))
    if (!definition) throw new Error(`No import definition for "${next.import_key}"`)
    if (!definition.is_active) throw new Error(`Import "${next.import_key}" is inactive`)
    if (!next.file) throw new Error('Queue row has no file attached')

    if (!buffer) {
      const stored = await getFile(String(next.file))
      if (!stored) throw new Error(`Attached file ${next.file} not found`)
      buffer = await readFileBuffer(stored)
    }

    emitJobProgress(next.created_by ? String(next.created_by) : null, {
      key: `import:${next.id}`,
      kind: 'import',
      label: `${definition.label ?? label(next)} import`,
      status: 'running',
      href: `/imports?run=${next.id}`
    })
    announced = definition
    void announceCollectionImportRun(definition, String(next.id), 'running')
    // One integration event chain per run: the load, and the post-run flows
    // it fans out to (PO completion sweep, partner pushes), share it.
    const fileBuffer = buffer
    // The upload answers at once (202), so the file is checked here: read off the event loop
    // once, validated (the same file-derived hard errors the upload used to answer 422 with),
    // and the same rows handed to the run. A validator that itself fails never blocks a run.
    const fileRows = await parseImportFileAsync(fileBuffer)
    const validation = await validateStagedRows(definition, fileRows).catch(() => null)
    if (validation && validation.errors.length > 0) {
      throw new Error(
        `That file fails validation: ${validation.errors.map((e) => e.message).join(' · ')}`
      )
    }
    const chainId = newChainId()
    const chainRoot = `import_run:${next.id}`
    // #1143: the run is the Traffic Map's import-worker source (its writes, partner calls).
    noteImportRun('start', {
      run_id: Number(next.id),
      key: String(next.import_key),
      label: definition.label ?? null,
      bytes: fileBuffer.length
    })
    // Migration 516: the run's activity rows are one burst, written by this import.
    const importScope = {
      group_key: activityGroupKey('import_run', next.id),
      actor: {
        kind: 'import' as const,
        id: String(next.import_key),
        name: definition.label ?? String(next.import_key),
        on_behalf_of: next.created_by ? String(next.created_by) : null
      }
    }
    const { rowCount, durationSeconds, summary, affected, matched, rows } = await startChain(
      chainRoot,
      () =>
        withActivityScope(importScope, () =>
          runAsTrafficSource(IMPORT_SOURCE, () =>
            runStagedImport({
              definition,
              buffer: fileBuffer,
              rows: fileRows,
              createdBy: next.created_by ? String(next.created_by) : null,
              runId: Number(next.id),
              onProgress: async (stage, data) => {
                if (stage === 'row_count') {
                  noteImportRun('rows', {
                    run_id: Number(next.id),
                    key: String(next.import_key),
                    rows: Number(data?.row_count ?? 0)
                  })
                  await db('nivaro_import_queue')
                    .where('id', next.id)
                    .update({ row_count: Number(data?.row_count ?? 0) })
                }
                emitImportProgress(next.created_by ? String(next.created_by) : null, {
                  id: next.id,
                  stage,
                  ...data
                })
                emitJobProgress(next.created_by ? String(next.created_by) : null, {
                  key: `import:${next.id}`,
                  kind: 'import',
                  label: `${definition.label ?? label(next)} import`,
                  status: 'running',
                  progress: {
                    phase: String(stage),
                    ...(data?.row_count != null ? { total: Number(data.row_count) } : {})
                  },
                  href: `/imports?run=${next.id}`
                })
              }
            })
          )
        ),
      chainId
    )
    noteImportRun('done', { run_id: Number(next.id), key: String(next.import_key), rows: rowCount })

    await db('nivaro_import_queue')
      .where('id', next.id)
      .update({
        status: 'completed',
        row_count: rowCount,
        duration: durationSeconds,
        finished_at: new Date(),
        updated_at: new Date(),
        // Service-mode runs report what actually changed; proc runs keep null.
        ...(summary ? { logs: summary.slice(0, 4000) } : {})
      })
    void announceCollectionImportRun(definition, String(next.id), 'completed')
    // rt6 #19 — a catalog / price / stock import: owners of open records whose lines it changed
    // hear it once (services/catalog-impact.ts; nothing for any other collection).
    void import('./catalog-impact.js')
      .then(async ({ noteCatalogChange }) => {
        const { parseRecalcRollups } = await import('./import-rollups.js')
        for (const c of parseRecalcRollups(definition.recalc_rollups)) noteCatalogChange(c, null)
        for (const [c, ids] of Object.entries(affected ?? {})) noteCatalogChange(c, ids)
      })
      .catch(() => {})
    await notifyCreator(
      app,
      next,
      `${label(next)} import completed`,
      summary ? summary.split('\n')[0] : `Imported ${rowCount} rows.`
    )
    emitImportProgress(next.created_by ? String(next.created_by) : null, {
      id: next.id,
      stage: 'completed',
      row_count: rowCount
    })
    emitJobProgress(next.created_by ? String(next.created_by) : null, {
      key: `import:${next.id}`,
      kind: 'import',
      label: `${definition.label ?? label(next)} import`,
      status: 'completed',
      outcome: summary ? summary.split('\n')[0].slice(0, 300) : `Imported ${rowCount} rows.`,
      href: `/imports?run=${next.id}`
    })
    // Post-run flow ops read this run's file values by run id (import-run-rows.ts) instead
    // of a shared staging table. Only kept when the definition names flows to read them.
    if (rows && parsePostRunFlows(definition.post_run_flows).length > 0) {
      rememberRunRows(String(next.id), rows)
    }
    startChain(
      chainRoot,
      () =>
        withActivityScope(importScope, () =>
          withTrafficSource(IMPORT_SOURCE, () =>
            afterImportCompleted(app, definition, {
              run_id: String(next.id),
              import_key: String(next.import_key),
              definition_label: definition.label ?? null,
              staging_table: definition.staging_table ?? null,
              procedure: definition.procedure ?? null,
              row_count: rowCount,
              duration_seconds: durationSeconds,
              created_by: next.created_by ? String(next.created_by) : null,
              ...(affected ? { affected } : {}),
              ...(matched ? { matched } : {})
            })
          )
        ),
      chainId
    )
  } catch (err) {
    // Defence in depth: the share loader sanitises its own failures, but ANY
    // thrower here reaches a persisted log and a user-facing notification.
    const message = scrubSecrets(describeSqlError(err))
    noteImportRun('error', { run_id: Number(next.id), key: String(next.import_key) })
    await db('nivaro_import_queue')
      .where('id', next.id)
      .update({
        status: 'error',
        duration: Math.round((Date.now() - began) / 1000),
        finished_at: new Date(),
        updated_at: new Date(),
        logs: message.slice(0, 4000)
      })
    if (announced) void announceCollectionImportRun(announced, String(next.id), 'error')
    // The failure belongs in front of whoever queued it — a silent 'error' row
    // is how imports get re-run blindly.
    await notifyCreator(app, next, `${label(next)} import failed`, message.slice(0, 500))
    emitImportProgress(next.created_by ? String(next.created_by) : null, {
      id: next.id,
      stage: 'error',
      error: message
    })
    emitJobProgress(next.created_by ? String(next.created_by) : null, {
      key: `import:${next.id}`,
      kind: 'import',
      label: `${label(next)} import`,
      status: 'error',
      error: message.slice(0, 300),
      href: `/imports?run=${next.id}`
    })
    // Log the scrubbed message, not `err`: a serialised exec rejection carries
    // argv and stderr into the log stream.
    app.log.error({ queueId: next.id, error: message }, 'staged import failed')
  } finally {
    clearInterval(lease)
    // The row is final either way now: its hand-off entry goes (services/import-handoff.ts).
    await forgetRun(importRedis(app), String(next.id)).catch(() => {})
  }
}

function label(row: { import_key?: unknown }): string {
  return String(row.import_key ?? '')
    .split('_')
    .map((v) => v.charAt(0).toUpperCase() + v.slice(1))
    .join(' ')
}

async function notifyCreator(
  app: FastifyInstance,
  row: { id?: unknown; created_by?: unknown },
  subject: string,
  message: string
): Promise<void> {
  const recipient = row.created_by ? String(row.created_by) : null
  if (!recipient) return
  try {
    const { buildImportRunMail } = await import('./mail-builders.js')
    const built =
      row.id != null ? await buildImportRunMail(String(row.id), recipient).catch(() => null) : null
    await notifyUser(app, recipient, {
      subject,
      message,
      ...(built ? { template: built.template, template_data: built.data } : {}),
      // Clients resolve nivaro_import_queue into the imports console.
      collection: 'nivaro_import_queue',
      item: null
    })
  } catch {
    // Never let a notification failure mark a finished import as broken.
  }
}

/**
 * Readiness / preflight: is something draining the import queue? Reads the queued rows (count,
 * oldest, how many waited past STUCK_QUEUED_MS) and both heartbeats (judgeImportWorker).
 */
export async function importWorkerJudgement(redis: unknown): Promise<ImportJudgement> {
  const r = asImportRedis(redis)
  const rows = (await db('nivaro_import_queue')
    .where('status', 'queued')
    .select('created_at')
    .limit(500)
    .catch(() => [])) as Array<{ created_at: Date | string | null }>
  // Pending collection imports (POST /api/imports) wait on the same drainers.
  const { pendingJobTimes } = await import('./collection-import-worker.js')
  const jobs = await pendingJobTimes().catch(() => [] as Array<Date | string | null>)
  const now = Date.now()
  const ages = [...rows.map((row) => row.created_at), ...jobs]
    .map((at) => now - new Date(at ?? now).getTime())
    .filter((n) => Number.isFinite(n))
  return judgeImportWorker({
    cloud: isMultiTenant(),
    redis: !!r,
    importer: await readImportBeat(r, 'importer'),
    fallback: await readImportBeat(r, 'fallback'),
    self: importDrainMode(),
    queued: rows.length + jobs.length,
    stuck: ages.filter((a) => a > STUCK_QUEUED_MS).length,
    oldestQueuedMs: ages.length ? Math.max(...ages) : null
  })
}
