import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { itemActionRegistry } from '../extensions/item-actions.js'
import { logActivity } from './activity.js'
import type { BulkRunResult } from './bulk-actions.js'

/**
 * #620 / #622 — integration pushes over a selection (collection browser,
 * queue bar) or one row (the row Actions menu). Two operations, both
 * built-in bulk actions ('push', 'retry-push') so a collection can switch
 * them off or restrict who runs them:
 *
 *  - runItemActionOver: a registered item action (ctx.itemActions — "Push to
 *    <partner>") run over each record with the SAME gates the record form's
 *    button passes: the action must be registered for the collection, the
 *    addendum-create gate when the action declares it, and the action's own
 *    per-record `applicable()` check (a broken check counts as applicable,
 *    as it does on the form).
 *  - retryFailedPushes: each record's latest submission PER PARTNER is
 *    re-sent when it failed (or was rejected) — the same stored payload the
 *    record's own Retry button re-sends (routes/erp-submissions
 *    `retrySubmissionRow`). A partner whose latest push landed is left alone.
 *
 * Records run ONE AT A TIME: parallel sends against the same partner invite
 * rate limiting. Every record passes the single path's gates first (read as
 * the caller, update rights on the record, the approval edit lock) — a record
 * the caller cannot open or change is a failure, never a push. The dry run
 * judges the same gates, so its preview matches the run.
 * `dryRun` classifies without sending anything.
 */

export const BULK_PUSH_MAX = 200

type Outcome = BulkRunResult['outcomes'][number]

function emptyResult(): BulkRunResult {
  return { succeeded: 0, failed: 0, skipped: 0, errors: [], skipped_items: [], outcomes: [] }
}

function recorder(result: BulkRunResult) {
  return {
    change(item: string, reason?: string) {
      result.succeeded++
      result.outcomes.push({ item, outcome: 'change', reason })
    },
    skip(item: string, reason: string) {
      result.skipped++
      result.skipped_items.push(item)
      result.outcomes.push({ item, outcome: 'skip', reason })
    },
    fail(item: string, reason: string) {
      const r = reason.slice(0, 300)
      result.failed++
      result.errors.push({ item, error: r })
      result.outcomes.push({ item, outcome: 'fail', reason: r } satisfies Outcome)
    }
  }
}

/**
 * Why this person may not push this record, or null: the single-record
 * path's gates (routes/item-actions.ts) — readable as the caller, theirs to
 * change (update row filter, tree permission) and not refused by the
 * approval edit lock. A push is a write in the partner's books.
 */
async function pushRefusal(req: FastifyRequest, collection: string, item: string) {
  const { recordWriteRefusal } = await import('./edit-lock.js')
  try {
    const refused = await recordWriteRefusal(req, collection, item, { heldLock: false })
    if (!refused) return null
    return refused.status === 404 ? 'Record not found or not readable' : refused.body.error
  } catch {
    return 'Could not confirm you may change this record'
  }
}

/** Item actions registered for the collection (what the Push buttons offer). */
export function pushActionsFor(collection: string) {
  return itemActionRegistry.list(collection)
}

export async function runItemActionOver(opts: {
  actionId: string
  collection: string
  ids: Array<string | number>
  payload?: Record<string, unknown> | null
  req: FastifyRequest
  dryRun?: boolean
}): Promise<BulkRunResult> {
  const { actionId, collection, ids, req } = opts
  const action = itemActionRegistry.get(actionId)
  if (!action) throw Object.assign(new Error('Item action not found'), { statusCode: 404 })
  if (action.collections && !action.collections.includes(collection))
    throw Object.assign(new Error(`"${action.label}" does not apply to ${collection}`), {
      statusCode: 400
    })
  if (action.bulk === false && ids.length > 1)
    throw Object.assign(new Error(`"${action.label}" runs on one record at a time`), {
      statusCode: 400
    })
  const result = emptyResult()
  const rec = recorder(result)

  for (const rawId of ids) {
    const item = String(rawId)
    try {
      const refused = await pushRefusal(req, collection, item)
      if (refused) {
        rec.fail(item, refused)
        continue
      }
      if (action.requires_addendum_create) {
        try {
          const { canCreateAddendum } = await import('./addendum-approve.js')
          const gate = await canCreateAddendum(collection, item, {
            roleId: (req.user?.role as string | null) ?? null,
            isAdmin: !!req.isAdmin
          })
          if (!gate.ok) {
            rec.skip(item, gate.reason ?? 'addendums unavailable here')
            continue
          }
        } catch {
          /* a gate error must not block a working action (the form's rule) */
        }
      }
      if (action.applicable) {
        const ok = await action.applicable({ collection, itemId: item }).catch(() => true) // a broken check must not hide a working action
        if (!ok) {
          rec.skip(item, 'not applicable to this record')
          continue
        }
      }
      if (opts.dryRun) {
        rec.change(item, `would run ${action.label}`)
        continue
      }
      const out = await action.execute({
        collection,
        itemId: item,
        payload: opts.payload ?? undefined,
        userId: req.user?.id
      })
      await logActivity({
        action: 'item-action-execute',
        user: req.user?.id,
        collection,
        item,
        comment: `${actionId} (bulk)`,
        req
      })
      rec.change(item, out?.message ? String(out.message).slice(0, 300) : action.label)
    } catch (err) {
      rec.fail(item, err instanceof Error ? err.message : String(err))
    }
  }
  return result
}

interface SubmissionRow {
  id: number
  item: string
  external_api: number
  external_ref: string | null
  status: string
  attempts: number
  last_error: string | null
  payload: string | null
  obligation_id: number | null
}

const FAILED = new Set(['failed', 'rejected'])

/**
 * Per record: the newest submission for each partner (created_at, then id).
 * Pure — exported for the unit tests.
 */
export function latestPerPartner(rows: SubmissionRow[]): Map<string, SubmissionRow[]> {
  const out = new Map<string, SubmissionRow[]>()
  const seen = new Set<string>()
  // Callers hand rows newest first; the first row per (item, partner) wins.
  for (const r of rows) {
    const key = `${r.item}\u0000${r.external_api}`
    if (seen.has(key)) continue
    seen.add(key)
    const list = out.get(String(r.item)) ?? []
    list.push(r)
    out.set(String(r.item), list)
  }
  return out
}

export async function retryFailedPushes(opts: {
  collection: string
  ids: Array<string | number>
  req: FastifyRequest
  dryRun?: boolean
}): Promise<BulkRunResult> {
  const { collection, ids, req } = opts
  const result = emptyResult()
  const rec = recorder(result)
  const items = [...new Set(ids.map(String))]
  if (items.length === 0) return result

  const rows = (await db('nivaro_erp_submissions')
    .where({ collection })
    .whereIn('item', items)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .select(
      'id',
      'item',
      'external_api',
      'external_ref',
      'status',
      'attempts',
      'last_error',
      'payload',
      'obligation_id'
    )) as SubmissionRow[]
  const latest = latestPerPartner(rows)
  const apiIds = [...new Set(rows.map((r) => r.external_api).filter((v) => v != null))]
  const names = new Map<number, string>(
    apiIds.length
      ? (
          (await db('nivaro_external_apis').whereIn('id', apiIds).select('id', 'name')) as Array<{
            id: number
            name: string
          }>
        ).map((a) => [Number(a.id), String(a.name)])
      : []
  )
  const nameOf = (api: number) => names.get(Number(api)) ?? `API ${api}`

  const { retrySubmissionRow } = await import('../routes/erp-submissions.js')

  for (const item of items) {
    try {
      const refused = await pushRefusal(req, collection, item)
      if (refused) {
        rec.fail(item, refused)
        continue
      }
      const partners = latest.get(item) ?? []
      if (partners.length === 0) {
        rec.skip(item, 'never pushed')
        continue
      }
      const failed = partners.filter((p) => FAILED.has(String(p.status)))
      if (failed.length === 0) {
        rec.skip(item, 'no failed push')
        continue
      }
      if (opts.dryRun) {
        rec.change(item, `would retry ${failed.map((p) => nameOf(p.external_api)).join(', ')}`)
        continue
      }
      const verdicts: string[] = []
      let anyFailed = false
      for (const p of failed) {
        try {
          const outcome = await retrySubmissionRow(p, req.user?.id ?? null)
          const landed = outcome.status === 'pending' || outcome.status === 'accepted'
          if (!landed) anyFailed = true
          verdicts.push(
            `${nameOf(p.external_api)}: ${outcome.status}${outcome.error ? ` (${outcome.error.slice(0, 160)})` : ''}`
          )
          await logActivity({
            action: 'update',
            collection: 'nivaro_erp_submissions',
            item: String(p.id),
            user: req.user?.id,
            req,
            comment: `retry #${Number(p.attempts ?? 0) + 1} (${outcome.status}) — bulk`
          })
        } catch (err) {
          anyFailed = true
          verdicts.push(
            `${nameOf(p.external_api)}: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
      if (anyFailed) rec.fail(item, verdicts.join('; '))
      else rec.change(item, verdicts.join('; '))
    } catch (err) {
      rec.fail(item, err instanceof Error ? err.message : String(err))
    }
  }
  return result
}
