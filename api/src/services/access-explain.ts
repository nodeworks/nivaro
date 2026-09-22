import { db } from '../db/index.js'
import type { User } from '../types.js'
import { can } from './permissions.js'
import { type AccessReason, compileAccessGates, explainIds, visibleIds } from './record-access.js'

export type { AccessReason }

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

  // 3–4. Row-level security + User Scopes — the SAME gates access audits and
  //      coverage use (services/record-access.ts, #519); each re-run alone so
  //      the reason names the one that hid the record.
  const gates = await compileAccessGates(user, collection, { actingAdmin })
  if (!(await visibleIds(gates, [String(id)])).has(String(id))) {
    reasons.push(...((await explainIds(gates, [String(id)])).get(String(id)) ?? []))
  }

  return { access: reasons.length === 0, reasons }
}
