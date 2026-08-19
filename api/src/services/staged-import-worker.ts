import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { getFile, readFileBuffer } from './files.js'
import { notifyUser } from './notification-channels.js'
import {
  describeSqlError,
  getImportDefinition,
  runStagedImport,
  scrubSecrets
} from './staged-imports.js'

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

async function drainOnce(app: FastifyInstance): Promise<void> {
  const inFlight = await db('nivaro_import_queue')
    .where('status', 'running')
    .count({ c: '*' })
    .first()
  if (Number(inFlight?.c ?? 0) > 0) return

  const queued = await db('nivaro_import_queue')
    .where('status', 'queued')
    .orderBy('sort')
    .orderBy('id')
    .limit(20)
  if (queued.length === 0) return

  let next: (typeof queued)[number] | null = null
  let buffer: Buffer | null = null
  for (const row of queued) {
    if (!row.file) {
      next = row
      break // claimed; the no-file error path below reports it
    }
    try {
      const stored = await getFile(String(row.file))
      if (!stored) {
        next = row
        break // file row deleted — claim and report, no host will do better
      }
      buffer = await readFileBuffer(stored)
      next = row
      break
    } catch {
      // Can't read the bytes from THIS host — leave it for the worker that
      // can, unless it has been unreadable for so long that no one can.
      const age = Date.now() - new Date(row.created_at ?? Date.now()).getTime()
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
      }
      // Keep scanning: a later row uploaded to THIS host must not starve
      // behind one this host cannot read.
    }
  }
  if (!next) return

  await db('nivaro_import_queue')
    .where('id', next.id)
    .update({ status: 'running', started_at: new Date(), updated_at: new Date() })

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

    const { rowCount, durationSeconds } = await runStagedImport({
      definition,
      buffer,
      onProgress: async (stage, data) => {
        if (stage === 'row_count') {
          await db('nivaro_import_queue')
            .where('id', next.id)
            .update({ row_count: Number(data?.row_count ?? 0) })
        }
        app.io?.emit('import:progress', { id: next.id, stage, ...data })
      }
    })

    await db('nivaro_import_queue').where('id', next.id).update({
      status: 'completed',
      row_count: rowCount,
      duration: durationSeconds,
      finished_at: new Date(),
      updated_at: new Date()
    })
    await notifyCreator(app, next, `${label(next)} import completed`, `Imported ${rowCount} rows.`)
    app.io?.emit('import:progress', { id: next.id, stage: 'completed', row_count: rowCount })
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
  row: { created_by?: unknown },
  subject: string,
  message: string
): Promise<void> {
  const recipient = row.created_by ? String(row.created_by) : null
  if (!recipient) return
  try {
    await notifyUser(app, recipient, {
      subject,
      message,
      // Clients resolve nivaro_import_queue into the imports console.
      collection: 'nivaro_import_queue',
      item: null
    })
  } catch {
    // Never let a notification failure mark a finished import as broken.
  }
}
