import { db } from '../db/index.js'
import { logActivity } from '../services/activity.js'
import { deferEffect } from '../services/unit-of-work.js'
import { originForWrite } from '../services/note-authorship.js'
import { computeDelta, writeRevision } from '../services/revisions.js'
import { fireWebhooks } from '../services/webhook-dispatch.js'
import { hooks } from './registry.js'

// ─── Per-collection audit level ──────────────────────────────────────────────
//
// `nivaro_collections.accountability` has always existed (default 'all') but
// nothing enforced it, so EVERY business write logged an activity row AND a
// full revision snapshot — including high-frequency ephemeral collections.
// Chat presence alone was writing ~3k activity rows/day plus a revision each,
// burying real audit history and bloating nivaro_revisions.
//
//   'all'       → activity row + revision snapshot (default; unchanged)
//   'activity'  → activity row only, no revision (chatty but audit-relevant)
//   null | ''   → neither (ephemeral: presence, read markers, heartbeats)
//
// Webhooks fire regardless — they're a delivery contract, not an audit one.

type AuditLevel = 'all' | 'activity' | 'none'

const CACHE_TTL_MS = 60_000
const levelCache = new Map<string, { level: AuditLevel; at: number }>()

/** Drop cached audit levels — call after a collection's accountability changes. */
export function clearAccountabilityCache(collection?: string): void {
  if (collection) levelCache.delete(collection)
  else levelCache.clear()
}

/** How much history a collection keeps: all (activity + revision), activity, none. */
export async function auditLevelOf(collection: string): Promise<AuditLevel> {
  return auditLevel(collection)
}

async function auditLevel(collection: string): Promise<AuditLevel> {
  const hit = levelCache.get(collection)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.level
  let level: AuditLevel = 'all'
  try {
    const row = (await db('nivaro_collections').where({ collection }).first('accountability')) as
      | { accountability?: string | null }
      | undefined
    // An unregistered collection keeps the historic default rather than going
    // silent — never lose audit coverage through a lookup miss.
    if (row) {
      const raw = String(row.accountability ?? '')
        .trim()
        .toLowerCase()
      level = raw === 'activity' ? 'activity' : raw === 'all' ? 'all' : 'none'
    }
  } catch {
    level = 'all'
  }
  levelCache.set(collection, { level, at: Date.now() })
  return level
}

/** Audit stamps move on every write; they are not what a receiver means by
 *  "this field changed". */
const STAMP_FIELDS = new Set(['updated_at', 'date_updated', 'user_updated', 'changed'])

function changedFieldNames(delta: Record<string, unknown> | null): string[] {
  if (!delta) return []
  return Object.keys(delta)
    .filter((k) => !STAMP_FIELDS.has(k))
    .slice(0, 100)
}

export function registerActivityHooks() {
  hooks.after('*', 'create', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const level = await auditLevel(ctx.collection)
    const origin = originForWrite(ctx.user, ctx.changeReason)
    const meta = { origin, changed_fields: [] as string[] }
    if (level === 'none') {
      await deferEffect('webhooks:create', () => fireWebhooks(ctx.collection, 'create', ctx.result, meta))
      return
    }
    const activityId = await logActivity({
      action: 'create',
      user: ctx.user?.id,
      collection: ctx.collection,
      item: ctx.keys?.[0] != null ? String(ctx.keys[0]) : undefined,
      // A create's provenance note ("import:<template>:<file>") rides the same
      // slot an update's change reason does.
      comment: ctx.changeReason,
      origin,
      req: ctx.req
    })
    if (level === 'all' && activityId && ctx.result && ctx.keys?.[0] != null) {
      await writeRevision({
        activity: activityId,
        collection: ctx.collection,
        item: String(ctx.keys[0]),
        data: ctx.result as Record<string, unknown>,
        delta: null
      })
    }
    await deferEffect('webhooks:create', () => fireWebhooks(ctx.collection, 'create', ctx.result, meta))
  })

  hooks.after('*', 'update', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const level = await auditLevel(ctx.collection)
    const origin = originForWrite(ctx.user, ctx.changeReason)
    // What the write changed — names for the webhook, the delta for history.
    const delta = ctx.previousData
      ? computeDelta(ctx.previousData, ctx.result as Record<string, unknown>)
      : null
    const meta = { origin, changed_fields: changedFieldNames(delta) }
    if (level === 'none') {
      await deferEffect('webhooks:update', () => fireWebhooks(ctx.collection, 'update', ctx.result, meta))
      return
    }
    const activityId = await logActivity({
      action: 'update',
      user: ctx.user?.id,
      collection: ctx.collection,
      item: ctx.keys?.[0] != null ? String(ctx.keys[0]) : undefined,
      comment: ctx.changeReason,
      origin,
      req: ctx.req
    })
    if (level === 'all' && activityId && ctx.result && ctx.keys?.[0] != null) {
      await writeRevision({
        activity: activityId,
        collection: ctx.collection,
        item: String(ctx.keys[0]),
        data: ctx.result as Record<string, unknown>,
        delta
      })
    }
    await deferEffect('webhooks:update', () => fireWebhooks(ctx.collection, 'update', ctx.result, meta))
  })

  hooks.after('*', 'delete', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const level = await auditLevel(ctx.collection)
    const meta = { origin: originForWrite(ctx.user, null), changed_fields: [] as string[] }
    if (level === 'none') {
      await deferEffect('webhooks:delete', () => fireWebhooks(ctx.collection, 'delete', ctx.previousData, meta))
      return
    }
    const activityId = await logActivity({
      action: 'delete',
      user: ctx.user?.id,
      collection: ctx.collection,
      item: ctx.keys?.[0] != null ? String(ctx.keys[0]) : undefined,
      origin: meta.origin,
      req: ctx.req
    })
    if (level === 'all' && activityId && ctx.previousData && ctx.keys?.[0] != null) {
      await writeRevision({
        activity: activityId,
        collection: ctx.collection,
        item: String(ctx.keys[0]),
        data: ctx.previousData,
        delta: null
      })
    }
    await deferEffect('webhooks:delete', () => fireWebhooks(ctx.collection, 'delete', ctx.previousData, meta))
  })
}
