import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { newChainId, startChain } from './chain.js'
import { getFile, readFileBuffer } from './files.js'
import { notifyUser } from './notification-channels.js'
import type { ImportDefinition } from './staged-imports.js'
import {
  describeSqlError,
  getImportDefinition,
  listImportDefinitions,
  lockGroupOf,
  parsePostRunFlows,
  runStagedImport,
  scrubSecrets
} from './staged-imports.js'

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

export function registerStagedImportWorker(app: FastifyInstance): void {
  app.cron.schedule('staged-imports', '*/10 * * * * *', async () => {
    // Guards overlapping ticks in this process; the status check below covers
    // other replicas.
    if (ticking) return
    ticking = true
    try {
      await drainOnce(app)
    } catch (err) {
      app.log.error({ err }, 'staged-import worker tick failed')
    } finally {
      ticking = false
    }
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
    void runOne(app, row, buffer).finally(() => driving.delete(id))
  }
}

async function runOne(
  app: FastifyInstance,
  next: QueueRow,
  preloaded: Buffer | null
): Promise<void> {
  let buffer = preloaded
  const began = Date.now()
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

    // One integration event chain per run: the load, and the post-run flows
    // it fans out to (PO completion sweep, partner pushes), share it.
    const fileBuffer = buffer
    const chainId = newChainId()
    const chainRoot = `import_run:${next.id}`
    const { rowCount, durationSeconds, summary, affected, matched } = await startChain(
      chainRoot,
      () =>
        runStagedImport({
          definition,
          buffer: fileBuffer,
          createdBy: next.created_by ? String(next.created_by) : null,
          runId: Number(next.id),
          onProgress: async (stage, data) => {
            if (stage === 'row_count') {
              await db('nivaro_import_queue')
                .where('id', next.id)
                .update({ row_count: Number(data?.row_count ?? 0) })
            }
            app.io?.emit('import:progress', { id: next.id, stage, ...data })
          }
        }),
      chainId
    )

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
    await notifyCreator(
      app,
      next,
      `${label(next)} import completed`,
      summary ? summary.split('\n')[0] : `Imported ${rowCount} rows.`
    )
    app.io?.emit('import:progress', { id: next.id, stage: 'completed', row_count: rowCount })
    startChain(
      chainRoot,
      () =>
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
        }),
      chainId
    )
  } catch (err) {
    // Defence in depth: the share loader sanitises its own failures, but ANY
    // thrower here reaches a persisted log and a user-facing notification.
    const message = scrubSecrets(describeSqlError(err))
    await db('nivaro_import_queue')
      .where('id', next.id)
      .update({
        status: 'error',
        duration: Math.round((Date.now() - began) / 1000),
        finished_at: new Date(),
        updated_at: new Date(),
        logs: message.slice(0, 4000)
      })
    // The failure belongs in front of whoever queued it — a silent 'error' row
    // is how imports get re-run blindly.
    await notifyCreator(app, next, `${label(next)} import failed`, message.slice(0, 500))
    app.io?.emit('import:progress', { id: next.id, stage: 'error', error: message })
    // Log the scrubbed message, not `err`: a serialised exec rejection carries
    // argv and stderr into the log stream.
    app.log.error({ queueId: next.id, error: message }, 'staged import failed')
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
