import type { FastifyBaseLogger } from 'fastify'
import { db } from '../db/index.js'
import { purgeExpiredRecordings } from '../routes/session-recordings.js'
import { pruneAiCalls } from './ai-log.js'
import { noteRetentionPassResult, noteRetentionPassStarted } from './retention-schedule.js'
import { purgeExpiredTrash } from './trash.js'

/**
 * The daily retention pass (#16/#17 and the logs that ride it). Everything it deletes lives in
 * one app's database except the help-video import sweep (purgeStaleImports: this process's
 * import sessions in memory and its work dir on disk).
 *
 *  - Self-hosted: server.ts runs runSelfHostedRetentionPass at boot and every 24 h after (the one
 *    chain, the sweep in its old place).
 *  - Hub shared deployment: the `retention-pass` job (RETENTION_PASS_CRON) fans out per app and
 *    runs runAppRetentionPass inside each; the sweep gets its own daily timer per process
 *    (startStaleImportSweep), outside any app.
 *  - Nivaro Cloud: never runs.
 */

export const RETENTION_PASS_CRON = '30 3 * * *'

export interface RetentionPassResult {
  activity_deleted: number
  activity_bridged: number
  error?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/** The pass for the current app (its database, its settings). Never the process import sweep. */
export function runAppRetentionPass(log: FastifyBaseLogger): Promise<RetentionPassResult> {
  return runPass(log, false)
}

/** Self-hosted: the app pass with the import sweep where it always ran (after old renders). */
export function runSelfHostedRetentionPass(log: FastifyBaseLogger): Promise<RetentionPassResult> {
  return runPass(log, true)
}

/** Shared deployment: the import sweep once now and every 24 h, outside any app. The handle is
 *  unref'd (never holds the process open). */
export function startStaleImportSweep(log: FastifyBaseLogger): NodeJS.Timeout {
  const sweep = () =>
    void import('./help-video-package.js')
      .then((m) => m.purgeStaleImports())
      .catch((err) => log.warn({ err }, '[retention] help-video import sweep failed'))
  sweep()
  const timer = setInterval(sweep, DAY_MS)
  timer.unref()
  return timer
}

async function runPass(
  log: FastifyBaseLogger,
  withImportSweep: boolean
): Promise<RetentionPassResult> {
  noteRetentionPassStarted()
  let result: RetentionPassResult = { activity_deleted: 0, activity_bridged: 0 }
  try {
    {
      const { pruneJobRuns } = await import('./job-runs.js')
      await pruneJobRuns().catch(() => {})
    }

    const row = await db('nivaro_settings')
      .first('activity_retention_days', 'revision_retention_count')
      .catch(() => null)

    // #16/#17 — activity rows go only through purgeActivityRows: records under legal
    // hold, rows a revision points at, imported history (legacy_id) and the trail head
    // stay; deleted sealed rows leave a bridge so the trail still verifies.
    const { purgeActivityRows } = await import('./activity-trail/purge.js')
    let activityDeleted = 0
    let activityBridged = 0
    // Per-collection retention overrides (#257): a collection with its own
    // activity_retention_days purges on ITS schedule; the global setting
    // covers the rest. Overridden collections are excluded from the
    // global pass so a longer override actually keeps rows longer.
    const overrides = (await db('nivaro_collections')
      .whereNotNull('activity_retention_days')
      .select('collection', 'activity_retention_days')
      .catch(() => [])) as Array<{ collection: string; activity_retention_days: number }>
    for (const o of overrides) {
      const cutoff = new Date(Date.now() - o.activity_retention_days * 86_400_000)
      const r = await purgeActivityRows((q) => {
        void q
          .where('collection', o.collection)
          .where('timestamp', '<', cutoff)
          .whereNull('legacy_id')
      }).catch((err) => {
        log.warn({ err, collection: o.collection }, '[retention] activity purge failed')
        return null
      })
      activityDeleted += r?.deleted ?? 0
      activityBridged += r?.bridged ?? 0
    }
    if (row?.activity_retention_days) {
      const cutoff = new Date(Date.now() - row.activity_retention_days * 86_400_000)
      // Imported legacy history (legacy_id NOT NULL) is permanent — retention applies to organic rows only.
      const r = await purgeActivityRows((q) => {
        void q.where('timestamp', '<', cutoff).whereNull('legacy_id')
        // Null-safe: NOT IN alone would keep every row with no collection forever.
        if (overrides.length > 0)
          void q.where((w) => {
            void w.whereNull('collection').orWhereNotIn(
              'collection',
              overrides.map((o) => o.collection)
            )
          })
      }).catch((err) => {
        // The rest of the pass (revisions, trash, AI log …) still runs.
        log.warn({ err }, '[retention] activity purge failed')
        return null
      })
      activityDeleted += r?.deleted ?? 0
      activityBridged += r?.bridged ?? 0
    }
    result = { activity_deleted: activityDeleted, activity_bridged: activityBridged }
    noteRetentionPassResult(result)

    if (row?.revision_retention_count) {
      // Imported legacy history is permanent; records under legal hold keep every
      // revision (#17).
      const { pruneRevisionsByCount } = await import('./revision-retention.js')
      await pruneRevisionsByCount(Number(row.revision_retention_count))
    }
    await purgeExpiredTrash()
    await purgeExpiredRecordings().catch(() => {})
    await import('./help-video-uploads.js').then((m) => m.purgeStaleUploads()).catch(() => 0)
    await import('./help-video-render.js').then((m) => m.pruneOldRenders()).catch(() => 0)
    if (withImportSweep)
      await import('./help-video-package.js').then((m) => m.purgeStaleImports()).catch(() => 0)
    // #528 — ERP push payloads/responses past the configured window lose their bytes, never their history.
    await import('./erp-retention.js')
      .then((m) => m.pruneErpSubmissionPayloads())
      .then((r) => {
        if (r.blanked)
          log.info(
            { blanked: r.blanked, days: r.days, more: r.more },
            '[retention] erp submission payloads blanked'
          )
      })
      .catch((err) => log.warn({ err }, '[retention] erp payload prune failed'))
    // Landed integration obligations (sent/superseded) are history after
    // 180 days; failed/missing/overdue/pending never expire.
    await import('./integration-obligations.js')
      .then((m) => m.pruneObligations())
      .then((n) => {
        if (n) log.info({ pruned: n }, '[retention] integration obligations pruned')
      })
      .catch((err) => log.warn({ err }, '[retention] integration obligations prune failed'))
    await pruneAiCalls().catch(() => 0)
    // #1833 — Ask AI conversations past ai_conversation_retention_days (pinned kept).
    await import('./ai-conversations.js').then((m) => m.pruneConversations()).catch(() => 0)
    // Edited/deleted chat message history past chat_history_retention_days.
    await import('./chat-send.js').then((m) => m.pruneChatMessageHistory()).catch(() => 0)
    await db('nivaro_admin_journeys')
      .where('entered_at', '<', new Date(Date.now() - 30 * 86_400_000))
      .del()
      .catch(() => 0)
  } catch (err) {
    log.warn({ err }, '[retention] purge failed')
    result = {
      activity_deleted: 0,
      activity_bridged: 0,
      error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)
    }
    noteRetentionPassResult(result)
  }
  return result
}
