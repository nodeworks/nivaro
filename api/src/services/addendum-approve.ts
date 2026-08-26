import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'

/**
 * Addendum approval — the ONE apply-back implementation, shared by:
 *  - POST /addendums/:id/approve (the panel's Review → Approve button)
 *  - applyTransition (an addendum whose WORKFLOW reaches a terminal state —
 *    pipeline-driven approvals like the PO closeout action)
 *
 * What approval does:
 *  1. Applies the addendum's `data` back onto the parent record (allow-listed
 *     by the addendum layout, blocked columns stripped, sub-rows replaced).
 *  2. Applies `data.__line_changes` — child-row patches recorded at draft time
 *     ({collection, rows: [{id, ...patch}]}) — THROUGH updateOne as the
 *     approver, so revisions, hooks and stored rollups all fire (a raw write
 *     would leave requisition-amount rollups stale).
 *  3. Flips status → approved, stamps approver, writes the immutable
 *     change-order row (nivaro_addendum_approvals).
 *  4. Fires the parent layout's auto-PDF regeneration when its __pdf__ slot
 *     is configured that way (same behavior as a form save) — via the real
 *     generate-and-attach route in-process; caller headers when available,
 *     else an admin integration token; never blocks the approval.
 */

function parseJsonSafe(raw: unknown): unknown {
  if (raw == null) return null
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return null
  }
}

/** Columns blocked on the PARENT business table write path (apply-back). */
export const PARENT_WRITE_BLOCKED_COLUMNS = new Set([
  'id', 'created_at', 'updated_at', 'created_by',
  'password', 'password_hash', 'totp_secret', 'totp_enabled',
  'static_token', 'admin_access', 'app_access',
  'tenant_id', 'workspace_id', 'workspace', 'owner_id',
  'deleted_at', 'is_deleted', 'is_redacted', 'redacted_at',
  'external_id', 'role'
])

export async function getAllowedAddendumFields(
  collection: string,
  addendumLayoutId: number | null | undefined
): Promise<Set<string>> {
  let layoutId = addendumLayoutId

  if (layoutId) {
    const layout = (await db('nivaro_collection_layouts')
      .where({ id: layoutId })
      .select('id', 'collection', 'layout_type')
      .first()) as { id: number; collection: string; layout_type: string } | undefined
    if (!layout || layout.collection !== collection || layout.layout_type !== 'addendum') {
      return new Set()
    }
  } else {
    const defaultLayout = (await db('nivaro_collection_layouts')
      .where({ collection, layout_type: 'addendum' })
      .orderBy('sort', 'asc')
      .first()) as { id: number } | undefined
    if (!defaultLayout) return new Set()
    layoutId = defaultLayout.id
  }

  const assignments = (await db('nivaro_layout_field_assignments')
    .where({ layout_id: layoutId })
    .select('field')) as Array<{ field: string }>
  return new Set(
    assignments.map((a) => a.field).filter((f) => !f.startsWith('__') && !f.includes('.'))
  )
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Resolve the FK column linking a line collection to the parent record, or
 * null when no plain M2O relation exists. Security boundary: line changes may
 * only touch rows that BELONG to the addendum's parent — without this check a
 * forged sidecar could patch arbitrary rows in arbitrary collections as the
 * approver.
 */
async function lineParentFk(
  lineCollection: string,
  parentCollection: string
): Promise<string | null> {
  if (
    !IDENT_RE.test(lineCollection) ||
    /^(nivaro|directus)_/i.test(lineCollection) // system tables are never line children
  ) {
    return null
  }
  const rel = (await db('nivaro_relations')
    .where({ many_collection: lineCollection, one_collection: parentCollection })
    .whereNull('junction_field')
    .first('many_field')) as { many_field: string | null } | undefined
  return rel?.many_field && IDENT_RE.test(rel.many_field) ? rel.many_field : null
}

/** Apply row patches to a line collection with the full guard set: system
 *  collections refused,每 row verified to belong to the parent, blocked and
 *  underscore/dotted keys stripped. Returns applied/failed counts. */
async function applyGuardedLineChanges(
  actor: User,
  lc: { collection?: string; rows?: Array<Record<string, unknown>> },
  parentCollection: string,
  parentId: string
): Promise<{ applied: number; failed: number }> {
  let applied = 0
  let failed = 0
  if (!lc.collection || !Array.isArray(lc.rows)) return { applied, failed }
  const fk = await lineParentFk(lc.collection, parentCollection)
  if (!fk) return { applied, failed: lc.rows.length }
  const { updateOne } = await import('./items.js')
  for (const row of lc.rows) {
    const rowId = row.id
    if (rowId == null) continue
    const { id: _i, was: _w, line_number: _l, ...rest } = row as Record<string, unknown>
    const patch = Object.fromEntries(
      Object.entries(rest).filter(
        ([k]) =>
          !k.startsWith('_') &&
          !k.includes('.') &&
          IDENT_RE.test(k) &&
          !PARENT_WRITE_BLOCKED_COLUMNS.has(k) &&
          k !== fk // the parent linkage itself is never patchable
      )
    )
    if (Object.keys(patch).length === 0) continue
    try {
      // Ownership check: the row must point at THIS parent.
      const owner = (await db(lc.collection)
        .where({ id: rowId })
        .first(fk)) as Record<string, unknown> | undefined
      if (!owner || String(owner[fk]) !== String(parentId)) {
        failed++
        continue
      }
      await updateOne(actor, lc.collection, String(rowId), patch)
      applied++
    } catch {
      failed++
    }
  }
  return { applied, failed }
}

export interface ApproveAddendumResult {
  ok: boolean
  error?: string
  status?: number
  line_changes_applied?: number
  line_changes_failed?: number
}

export async function applyAddendumApproval(
  addendumId: string,
  approverUserId: string | null,
  opts: {
    /** Which current statuses may be approved from. The route allows only
     *  'review'; the pipeline path also accepts 'draft' (its review IS the
     *  workflow). */
    allowedFromStatuses?: string[]
    /** Auth headers to forward for the auto-PDF regeneration inject. */
    pdfAuthHeaders?: Record<string, string>
    app?: FastifyInstance | null
  } = {}
): Promise<ApproveAddendumResult> {
  const existing = (await db('nivaro_addendums').where({ id: addendumId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!existing) return { ok: false, status: 404, error: 'Not found' }

  const from = opts.allowedFromStatuses ?? ['review']
  if (!from.includes(String(existing.status))) {
    return {
      ok: false,
      status: 409,
      error: `Only ${from.join('/')}-status addendums can be approved`
    }
  }

  const now = new Date()
  const parentCollection = String(existing.parent_collection)
  const parentId = String(existing.parent_id)
  let revertLineChanges: { collection: string; rows: Array<Record<string, unknown>> } | null = null

  // ── 1. Apply `data` back onto the parent record ───────────────────────────
  let lineChangesApplied = 0
  let lineChangesFailed = 0
  if (existing.data) {
    const data = parseJsonSafe(existing.data) as Record<string, unknown> | null
    if (data && typeof data === 'object') {
      const allowedKeys = await getAllowedAddendumFields(
        parentCollection,
        existing.addendum_layout_id as number | null
      )
      const fieldMeta = (await db('nivaro_fields')
        .where({ collection: parentCollection })
        .select('field', 'interface', 'type')) as Array<{
        field: string
        interface: string | null
        type: string | null
      }>
      const subRowFields = new Set(
        fieldMeta.filter((f) => f.interface === 'sub-rows').map((f) => f.field)
      )
      const relationFields = (await db('nivaro_relations')
        .where({ one_collection: parentCollection })
        .select('one_field')) as Array<{ one_field: string | null }>
      const relationFieldSet = new Set(
        relationFields.map((r) => r.one_field).filter(Boolean) as string[]
      )
      const scalarPatch: Record<string, unknown> = {}
      const revertParent: Record<string, unknown> = {}
      const revertSubRows: Record<string, unknown[]> = {}
      for (const [key, value] of Object.entries(data)) {
        if (PARENT_WRITE_BLOCKED_COLUMNS.has(key)) continue
        if (key.startsWith('__')) continue // sidecars handled below, never columns
        if (!allowedKeys.has(key)) continue
        if (relationFieldSet.has(key)) continue
        if (subRowFields.has(key)) {
          const rows = Array.isArray(value) ? value : []
          // Revert snapshot: the sub-rows being replaced.
          const prior = (await db('nivaro_sub_rows')
            .where({
              parent_collection: parentCollection,
              parent_id: parentId,
              sub_row_field: key
            })
            .orderBy('sort')
            .select('data')) as Array<{ data: string | null }>
          revertSubRows[key] = prior.map((r) => parseJsonSafe(r.data)).filter((v) => v != null)
          await db('nivaro_sub_rows')
            .where({
              parent_collection: parentCollection,
              parent_id: parentId,
              sub_row_field: key
            })
            .delete()
          if (rows.length > 0) {
            await db('nivaro_sub_rows').insert(
              rows.map((row: unknown, idx: number) => ({
                parent_collection: parentCollection,
                parent_id: parentId,
                sub_row_field: key,
                sort: idx,
                data: JSON.stringify(row),
                created_at: now,
                updated_at: now
              }))
            )
          }
        } else {
          scalarPatch[key] = value
        }
      }
      if (Object.keys(scalarPatch).length > 0) {
        // Revert snapshot: the parent's values BEFORE this apply.
        try {
          const prior = (await db(parentCollection)
            .where({ id: parentId })
            .first(Object.keys(scalarPatch))) as Record<string, unknown> | undefined
          for (const k of Object.keys(scalarPatch)) revertParent[k] = prior?.[k] ?? null
        } catch {
          /* snapshot is best-effort — apply proceeds */
        }
        await db(parentCollection)
          .where({ id: parentId })
          .update({ ...scalarPatch, updated_at: now })
      }

      // ── 2. Child-row patches (`__line_changes`) through updateOne ─────────
      // Recorded at draft time by actions like PO closeout. Each row goes
      // through the items service AS THE APPROVER so revisions apply and the
      // parent's stored rollups (requisition_amount) recalc themselves.
      const lc = data.__line_changes as
        | { collection?: string; rows?: Array<Record<string, unknown>> }
        | undefined
      if (lc?.collection && Array.isArray(lc.rows)) {
        const approver = approverUserId
          ? ((await db('nivaro_users').where({ id: approverUserId }).first()) as User | undefined)
          : undefined
        const revertLines: Array<Record<string, unknown>> = []
        // SECURITY: the sidecar rides the client-writable data JSON, so it is
        // treated as UNTRUSTED even though only server-side actions write it —
        // system collections refused, the line collection must have a real M2O
        // to the parent, every row must BELONG to this parent, and blocked/
        // metadata keys are stripped before any write.
        const fk = approver ? await lineParentFk(lc.collection, parentCollection) : null
        if (approver && fk) {
          const { updateOne } = await import('./items.js')
          for (const row of lc.rows) {
            const rowId = row.id
            if (rowId == null) continue
            const { id: _i, was: _w, line_number: _l, ...rest } = row as Record<string, unknown>
            const patch = Object.fromEntries(
              Object.entries(rest).filter(
                ([k]) =>
                  !k.startsWith('_') &&
                  !k.includes('.') &&
                  IDENT_RE.test(k) &&
                  !PARENT_WRITE_BLOCKED_COLUMNS.has(k) &&
                  k !== fk
              )
            )
            if (Object.keys(patch).length === 0) continue
            try {
              // Ownership + revert snapshot in one read: the row's parent FK
              // and its prior values for exactly the keys this apply writes.
              const prior = (await db(lc.collection)
                .where({ id: rowId })
                .first([fk, ...Object.keys(patch)])
                .catch(() => null)) as Record<string, unknown> | null
              if (!prior || String(prior[fk]) !== String(parentId)) {
                lineChangesFailed++
                continue
              }
              await updateOne(approver, lc.collection, String(rowId), patch)
              const { [fk]: _fk, ...priorVals } = prior
              revertLines.push({ id: rowId, ...priorVals })
              lineChangesApplied++
            } catch {
              lineChangesFailed++
            }
          }
        } else {
          lineChangesFailed = lc.rows.length
        }
        if (revertLines.length > 0) {
          revertLineChanges = { collection: lc.collection, rows: revertLines }
        }
      }

      // Persist the revert snapshot as a data sidecar (admin revert, #undo).
      const revert: Record<string, unknown> = {}
      if (Object.keys(revertParent).length > 0) revert.parent = revertParent
      if (Object.keys(revertSubRows).length > 0) revert.sub_rows = revertSubRows
      if (revertLineChanges) revert.line_changes = revertLineChanges
      if (Object.keys(revert).length > 0) {
        try {
          // Server-only column (migration 281) — clients can neither read nor
          // forge it through the addendum API.
          await db('nivaro_addendums')
            .where({ id: addendumId })
            .update({ revert_snapshot: JSON.stringify(revert) })
        } catch {
          /* best-effort — approval itself already applied */
        }
      }
    }
  }

  // ── 3. Status + change order ──────────────────────────────────────────────
  await db('nivaro_addendums').where({ id: addendumId }).update({
    status: 'approved',
    approved_by: approverUserId,
    approved_at: now,
    updated_at: now
  })

  const existingOrder = await db('nivaro_addendum_approvals')
    .where({ addendum_id: addendumId })
    .first()
  if (!existingOrder) {
    const approvalCount = await db('nivaro_addendum_approvals')
      .where({ parent_collection: parentCollection, parent_id: parentId })
      .count('id as cnt')
      .then((r) => Number((r[0] as { cnt: number }).cnt))
    await db('nivaro_addendum_approvals').insert({
      addendum_id: addendumId,
      parent_collection: parentCollection,
      parent_id: parentId,
      order_number: approvalCount + 1,
      net_cost_impact: existing.cost_impact ?? null,
      net_timeline_impact_days: existing.timeline_impact_days ?? null,
      notes: existing.title ?? null,
      approved_by: approverUserId,
      approved_at: now,
      created_at: now
    })
  }

  // ── 4. Auto-PDF, exactly like a form save ─────────────────────────────────
  if (opts.app) {
    void regenerateParentPdf(opts.app, parentCollection, parentId, approverUserId, opts.pdfAuthHeaders)
  }

  return {
    ok: true,
    line_changes_applied: lineChangesApplied,
    line_changes_failed: lineChangesFailed
  }
}

/** Regenerate the parent record's layout PDF when its __pdf__ slot says
 *  auto_generate_on_save — through the real generate-and-attach route via
 *  in-process inject. Caller headers when provided; otherwise an admin
 *  integration static token (mwf-ingest precedent). Fire-and-forget. */
async function regenerateParentPdf(
  app: FastifyInstance,
  collection: string,
  itemId: string,
  approverUserId: string | null,
  authHeaders?: Record<string, string>
): Promise<void> {
  try {
    const activeLayout = (await db('nivaro_collection_layouts')
      .where({ collection, layout_type: 'grouped', is_active: true })
      .first('id')) as { id: number } | undefined
    if (!activeLayout) return
    const pdfSlot = (await db('nivaro_layout_field_assignments')
      .where({ layout_id: activeLayout.id, field: '__pdf__' })
      .first('overrides')) as { overrides: string | null } | undefined
    if (!pdfSlot) return
    const ov = (parseJsonSafe(pdfSlot.overrides) ?? {}) as Record<string, unknown>
    if (!ov.auto_generate_on_save || !ov.attach_to_field) return
    const renderLayoutId = (ov.source_layout_id as number | null) ?? activeLayout.id

    let headers: Record<string, string> | null =
      authHeaders && (authHeaders.authorization || authHeaders.cookie) ? { ...authHeaders } : null
    if (!headers) {
      // Pipeline-driven approvals carry no request: try the approver's own
      // static token, then any admin integration token.
      const tokenRow = approverUserId
        ? ((await db('nivaro_users')
            .where({ id: approverUserId })
            .whereNotNull('static_token')
            .first('static_token')) as { static_token: string } | undefined)
        : undefined
      const fallback =
        tokenRow ??
        ((await db('nivaro_users as u')
          .join('nivaro_roles as r', 'u.role', 'r.id')
          .where('r.admin_access', true)
          .whereNotNull('u.static_token')
          .first('u.static_token')) as { static_token: string } | undefined)
      if (!fallback?.static_token) return
      headers = { authorization: `Bearer ${fallback.static_token}` }
    }

    await app.inject({
      method: 'POST',
      url: `/api/collection-layouts/${renderLayoutId}/generate-and-attach`,
      headers: { 'content-type': 'application/json', ...headers },
      payload: {
        collection,
        item_id: itemId,
        attach_field: ov.attach_to_field,
        filename_template: (ov.filename_template as string | null) ?? null,
        replace_generated: ov.overwrite_generated !== false
      }
    })
  } catch (err) {
    console.warn('[addendum-approve] auto-PDF regeneration failed:', err)
  }
}

/**
 * Admin revert (#Rob 2026-08-26): roll an APPROVED addendum back so its
 * changes never landed — parent scalars and sub-rows restored from the
 * revert snapshot captured at approval, line changes re-applied in reverse
 * THROUGH updateOne (revisions + rollups fire again), the change-order row
 * removed, status → 'reverted'. The addendum row itself stays: history,
 * activity, and the revision trail all keep the whole story.
 */
export async function revertAddendumApproval(
  addendumId: string,
  adminUserId: string
): Promise<ApproveAddendumResult> {
  const existing = (await db('nivaro_addendums').where({ id: addendumId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!existing) return { ok: false, status: 404, error: 'Not found' }
  if (existing.status !== 'approved') {
    return { ok: false, status: 409, error: 'Only approved addendums can be reverted' }
  }
  const revert = parseJsonSafe(existing.revert_snapshot) as {
    parent?: Record<string, unknown>
    sub_rows?: Record<string, unknown[]>
    line_changes?: { collection?: string; rows?: Array<Record<string, unknown>> }
  } | null
  if (!revert) {
    return {
      ok: false,
      status: 409,
      error:
        'No revert snapshot on this addendum — it was approved before revert existed. Undo the values manually via the revision history.'
    }
  }

  const now = new Date()
  const parentCollection = String(existing.parent_collection)
  const parentId = String(existing.parent_id)

  // Parent scalars back to their pre-approval values.
  if (revert.parent && Object.keys(revert.parent).length > 0) {
    const patch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(revert.parent)) {
      if (PARENT_WRITE_BLOCKED_COLUMNS.has(k) || k.startsWith('__')) continue
      patch[k] = v
    }
    if (Object.keys(patch).length > 0) {
      await db(parentCollection)
        .where({ id: parentId })
        .update({ ...patch, updated_at: now })
    }
  }

  // Sub-rows back to the replaced set.
  if (revert.sub_rows) {
    for (const [field, rows] of Object.entries(revert.sub_rows)) {
      if (!IDENT_RE.test(field)) continue
      await db('nivaro_sub_rows')
        .where({ parent_collection: parentCollection, parent_id: parentId, sub_row_field: field })
        .delete()
      if (Array.isArray(rows) && rows.length > 0) {
        await db('nivaro_sub_rows').insert(
          rows.map((row, idx) => ({
            parent_collection: parentCollection,
            parent_id: parentId,
            sub_row_field: field,
            sort: idx,
            data: JSON.stringify(row),
            created_at: now,
            updated_at: now
          }))
        )
      }
    }
  }

  // Line rows back through updateOne — revisions and stored rollups fire.
  // Same guard set as approval even though the snapshot is server-written:
  // schema can drift between approval and revert, and defense-in-depth costs
  // one read per row.
  let lineChangesApplied = 0
  let lineChangesFailed = 0
  const lc = revert.line_changes
  if (lc?.collection && Array.isArray(lc.rows)) {
    const admin = (await db('nivaro_users').where({ id: adminUserId }).first()) as User | undefined
    if (admin) {
      const r = await applyGuardedLineChanges(admin, lc, parentCollection, parentId)
      lineChangesApplied = r.applied
      lineChangesFailed = r.failed
    } else {
      lineChangesFailed = lc.rows.length
    }
  }

  // "Never existed": the change-order row goes; the addendum row STAYS as the
  // reverted record of what happened.
  await db('nivaro_addendum_approvals').where({ addendum_id: addendumId }).delete()
  await db('nivaro_addendums').where({ id: addendumId }).update({
    status: 'reverted',
    updated_at: now
  })

  return { ok: true, line_changes_applied: lineChangesApplied, line_changes_failed: lineChangesFailed }
}
