import { db } from '../db/index.js'
import { applyRowFilter, can, getRowFilter } from './permissions.js'
import type { User } from '../types.js'
import {
  applyScopeHops,
  getUserScopes,
  listScopeDimensions,
  resolveRecordDimensionIds,
  scopeHopsFor
} from './user-scopes.js'

// ─── Access explain ──────────────────────────────────────────────────────────
// "Why can't I see this record?" — re-runs each access gate SEPARATELY for
// one (collection, id) as a given user and names the one(s) that hid the
// record. Used by the record form's denied panel, the admin "explain as
// user" view, and the access-request queue (which stores the reasons so the
// grant can be the fitting one — a scope widening, not a blanket read policy).
//
// Deliberate trade-off: naming a scope confirms the record exists —
// acceptable for an internal operator console. Only REASONS are returned,
// never record data.

export interface AccessReason {
  type: 'permission' | 'not_found' | 'row_filter' | 'scope' | 'scope_strict'
  message: string
  /** scope reasons: which dimension and what the user IS limited to. */
  dimension?: string
  dimension_label?: string
  allowed_values?: string[]
  /** scope reasons: the record's own values on that dimension (ids + labels). */
  record_ids?: string[]
  record_values?: string[]
  /** not_found: the trash row, admins only. */
  trash_id?: number
}

export class UnknownCollectionError extends Error {
  constructor() {
    super('Unknown collection')
  }
}

export async function explainAccess(
  user: User,
  actingAdmin: boolean,
  collection: string,
  id: string
): Promise<{ access: boolean; reasons: AccessReason[] }> {
  const reasons: AccessReason[] = []

  // 1. Role permission — checked first; without read access nothing else
  //    about the record should be disclosed (not even existence).
  const permitted = actingAdmin || (await can(user, 'read', collection))
  if (!permitted) {
    reasons.push({
      type: 'permission',
      message: `Your role does not have permission to view ${collection.replace(/_/g, ' ')} records.`
    })
    return { access: false, reasons }
  }

  // 2. Existence (raw, gate-free).
  let exists = false
  try {
    exists = !!(await db(collection).where({ id }).first('id'))
  } catch {
    throw new UnknownCollectionError()
  }
  if (!exists) {
    // Smart 404 (#219): the trash knows WHO deleted it and WHEN — say so,
    // and tell the client whether a restore is on the table.
    try {
      const trashed = (await db('nivaro_trash as t')
        .leftJoin('nivaro_users as u', 'u.id', 't.deleted_by')
        .where({ 't.collection': collection, 't.item_id': String(id) })
        .orderBy('t.id', 'desc')
        .first(
          't.id as trash_id',
          't.deleted_at',
          db.raw("CONCAT(u.first_name, ' ', u.last_name) as deleted_by_name")
        )) as { trash_id: number; deleted_at: Date; deleted_by_name: string | null } | undefined
      if (trashed) {
        reasons.push({
          type: 'not_found',
          message: `This record was deleted ${new Date(trashed.deleted_at).toLocaleDateString()}${
            trashed.deleted_by_name?.trim() ? ` by ${trashed.deleted_by_name.trim()}` : ''
          }. It sits in the trash for 30 days and can be restored.`,
          ...(actingAdmin ? { trash_id: trashed.trash_id } : {})
        } as never)
        return { access: false, reasons }
      }
    } catch {
      /* trash lookup is best-effort */
    }
    reasons.push({
      type: 'not_found',
      message: 'This record does not exist — it may have been deleted.'
    })
    return { access: false, reasons }
  }

  // 3. Row-level security (nivaro_policies.row_filter on the user's role).
  if (!actingAdmin) {
    const rowFilter = await getRowFilter(user, 'read', collection)
    if (rowFilter) {
      const q = db(collection).where(`${collection}.id`, id)
      applyRowFilter(q, rowFilter, user)
      if (!(await q.first(`${collection}.id`))) {
        reasons.push({
          type: 'row_filter',
          message:
            'A row-level security rule on your role hides this record (it does not match the conditions your role is limited to).'
        })
      }
    }
  }

  // 4. User Scopes — evaluate each restrict dimension SEPARATELY so the
  //    response can name the one that excludes the record. Mirrors
  //    getUserScopeEnforcement's rules (reference-table skip, strict deny).
  if (!actingAdmin) {
    const scopes = (await getUserScopes(user.id)).filter(
      (s) => s.mode === 'restrict' && s.values.length > 0
    )
    if (scopes.length > 0) {
      const dims = await listScopeDimensions()
      const targets = new Set(dims.map((d) => d.target_collection))
      const isReferenceTable = targets.has(collection)
      for (const s of scopes) {
        const dim = dims.find((d) => d.name === s.dimension)
        if (!dim) continue
        if (isReferenceTable && dim.target_collection !== collection) continue
        const hops = await scopeHopsFor(dim, collection)
        if (!hops) {
          if (dim.strict) {
            reasons.push({
              type: 'scope_strict',
              dimension: dim.name,
              dimension_label: dim.label,
              message: `Your ${dim.label} access filter is strict and this collection has no ${dim.label} link — all its records are hidden from you.`
            })
          }
          continue
        }
        const q = db(collection).where(`${collection}.id`, id)
        if (hops.length === 0) {
          void q.whereIn(`${collection}.id`, s.values as never)
        } else {
          applyScopeHops(q, collection, hops, s.values)
        }
        if (await q.first(`${collection}.id`)) continue
        // This dimension excludes the record — resolve the user's allowed
        // values AND the record's own values to labels, so the message
        // shows both halves ("record's Zone: West — you are limited to…").
        const labelField = dim.display_field || 'name'
        let allowed: string[] = []
        let recordVals: string[] = []
        let recordIds: string[] = []
        try {
          const recIds =
            (await resolveRecordDimensionIds(collection, [id], hops)).get(String(id)) ?? []
          recordIds = recIds
          const lookupIds = [...new Set([...s.values.map(String), ...recIds])]
          const rows = (await db(dim.target_collection)
            .whereIn('id', lookupIds as never)
            .limit(40)
            .select('id', db.raw('?? as label', [labelField]))) as Array<{
            id: unknown
            label: unknown
          }>
          const labels = new Map(rows.map((r) => [String(r.id), String(r.label ?? r.id)]))
          allowed = s.values.slice(0, 20).map((v) => labels.get(String(v)) ?? String(v))
          recordVals = recIds.slice(0, 10).map((v) => labels.get(v) ?? v)
        } catch {
          allowed = s.values.slice(0, 20).map(String)
        }
        const recordSide =
          recordVals.length > 0
            ? `this record's ${dim.label} is ${recordVals.join(', ')}`
            : `this record has no ${dim.label} link`
        reasons.push({
          type: 'scope',
          dimension: dim.name,
          dimension_label: dim.label,
          allowed_values: allowed,
          record_ids: recordIds,
          record_values: recordVals,
          message: `Your ${dim.label} access filter excludes this record — ${recordSide}, and you are limited to: ${allowed.join(', ') || '(none)'}.`
        })
      }
    }
  }

  return { access: reasons.length === 0, reasons }
}
