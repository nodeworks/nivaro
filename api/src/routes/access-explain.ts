import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { applyRowFilter, can, getRowFilter } from '../services/permissions.js'
import {
  applyScopeHops,
  getUserScopes,
  listScopeDimensions,
  resolveRecordDimensionIds,
  scopeHopsFor
} from '../services/user-scopes.js'

// ─── Access explain ──────────────────────────────────────────────────────────
// "Why can't I see this record?" — a scoped user hitting a record outside
// their User Scopes (or an RLS row filter) gets a bare 404 from /items, which
// reads as a broken app. This route re-runs each access gate SEPARATELY for
// one (collection, id) and names the one(s) that hid the record, so the
// record form can explain instead of shrugging.
//
// Deliberate trade-off: telling a user "this record exists but your Region
// filter excludes it" confirms the record's existence — acceptable for an
// internal operator console where the alternative is a support ticket.
// The route only ever returns REASONS, never record data.

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

interface AccessReason {
  type: 'permission' | 'not_found' | 'row_filter' | 'scope' | 'scope_strict'
  message: string
  /** scope reasons: which dimension and what the user IS limited to. */
  dimension?: string
  dimension_label?: string
  allowed_values?: string[]
}

export async function accessExplainRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/access-explain/:collection/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params as { collection: string; id: string }
      if (
        !IDENT_RE.test(collection) ||
        /^nivaro_/i.test(collection) ||
        /^directus_/i.test(collection)
      ) {
        return reply.code(400).send({ error: 'Invalid collection' })
      }
      // Admin access explain (#120): ?user_id= evaluates AS another user —
      // "why can't Beth see this record" without masquerading. Admin-only;
      // the impersonated evaluation is read-only by construction.
      const asUserId = (req.query as { user_id?: string } | undefined)?.user_id
      let user = req.user!
      let actingAdmin = req.isAdmin
      if (asUserId && String(asUserId) !== String(req.user!.id)) {
        if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
        const target = await db('nivaro_users').where({ id: asUserId }).first()
        if (!target) return reply.code(404).send({ error: 'User not found' })
        user = target as typeof user
        const targetRole = target.role
          ? await db('nivaro_roles').where({ id: target.role }).first('admin_access')
          : null
        actingAdmin = !!(targetRole as { admin_access?: boolean } | null)?.admin_access
      }
      const reasons: AccessReason[] = []

      // 1. Role permission — checked first; without read access nothing else
      //    about the record should be disclosed (not even existence).
      const permitted = actingAdmin || (await can(user, 'read', collection))
      if (!permitted) {
        reasons.push({
          type: 'permission',
          message: `Your role does not have permission to view ${collection.replace(/_/g, ' ')} records.`
        })
        return reply.send({ data: { access: false, reasons } })
      }

      // 2. Existence (raw, gate-free).
      let exists = false
      try {
        exists = !!(await db(collection).where({ id }).first('id'))
      } catch {
        return reply.code(400).send({ error: 'Unknown collection' })
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
            )) as
            | { trash_id: number; deleted_at: Date; deleted_by_name: string | null }
            | undefined
          if (trashed) {
            reasons.push({
              type: 'not_found',
              message: `This record was deleted ${new Date(trashed.deleted_at).toLocaleDateString()}${
                trashed.deleted_by_name?.trim() ? ` by ${trashed.deleted_by_name.trim()}` : ''
              }. It sits in the trash for 30 days and can be restored.`,
              ...(actingAdmin ? { trash_id: trashed.trash_id } : {})
            } as never)
            return reply.send({ data: { access: false, reasons } })
          }
        } catch {
          /* trash lookup is best-effort */
        }
        reasons.push({
          type: 'not_found',
          message: 'This record does not exist — it may have been deleted.'
        })
        return reply.send({ data: { access: false, reasons } })
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
            try {
              const recIds =
                (await resolveRecordDimensionIds(collection, [id], hops)).get(String(id)) ?? []
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
              message: `Your ${dim.label} access filter excludes this record — ${recordSide}, and you are limited to: ${allowed.join(', ') || '(none)'}.`
            })
          }
        }
      }

      return reply.send({ data: { access: reasons.length === 0, reasons } })
    }
  )
}
