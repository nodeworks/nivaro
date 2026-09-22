import { db } from '../db/index.js'
import type { User } from '../types.js'
import { resolveStateOwnersBatch } from './pipeline-engine.js'
import { compileAccessGates, explainIds, visibleIds } from './record-access.js'

// ─── Access audit runner ─────────────────────────────────────────────────────
// "Can every stakeholder still see their record?" Data edits (a region
// change, a scope tightening, a role swap) silently strip a record's creator
// or resolved owners of read access — the record just 404s for them. An audit
// definition names a collection and its SUBJECTS (user-FK fields like
// `creator`, plus the pipeline's resolved current-state owners); a run checks
// every (record, stakeholder) pair through the same gates the items API
// enforces (role permission, RLS row filter, User Scopes) and stores a
// finding per pair that fails, with the gate(s) that failed named.
//
// The check is SET-BASED per user, never per pair: one visibility query per
// user per 2k-id chunk, and reason attribution runs only over the violating
// ids (one query per gate). ~88k workflows × hundreds of stakeholders stays
// in whole-table-scan territory, not N+1.

export interface AuditSubject {
  type: 'field' | 'pipeline_owners'
  field?: string
  label?: string
}

const CHUNK = 1500
const FINDINGS_CAP = 5000
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

interface Finding {
  item_id: string
  user: string
  subject: string
  reasons: Array<{
    type: string
    dimension?: string
    dimension_label?: string
    record_values?: string[]
    message: string
  }>
}

function parseSubjects(raw: unknown): AuditSubject[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? (parsed as AuditSubject[]) : []
  } catch {
    return []
  }
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Human label map for the audited records. Resolution chain: the collection's
 * display_template (plain tokens only) → the entity-room registry's
 * match_field (nivaro_chat_room_types — the same "friendly id" source
 * resolveFriendlyId uses: each collection's business id column) → a
 * name/title-style column.
 */
async function buildLabelMap(collection: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (ids.length === 0) return map
  try {
    const meta = (await db('nivaro_collections').where({ collection }).first('display_template')) as
      | { display_template?: string | null }
      | undefined
    const tmpl = meta?.display_template ?? null
    let plain: string[] = []
    if (tmpl) {
      const tokens = [...tmpl.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1])
      plain = tokens.filter((t) => !t.includes('.') && IDENT_RE.test(t))
    }
    if (tmpl && plain.length > 0) {
      for (const chunk of chunks(ids, CHUNK)) {
        const rows = (await db(collection)
          .whereIn('id', chunk)
          .select('id', ...plain)) as Array<Record<string, unknown>>
        for (const r of rows) {
          const label = tmpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, t: string) =>
            String((r as Record<string, unknown>)[t] ?? '')
          )
          if (label.trim()) map.set(String(r.id), label.trim().slice(0, 490))
        }
      }
      return map
    }
    // No usable template — friendly-id registry, then common label columns.
    let labelCol: string | null = null
    try {
      const rt = (await db('nivaro_chat_room_types').where({ collection }).first('match_field')) as
        | { match_field?: string | null }
        | undefined
      if (rt?.match_field && rt.match_field !== 'id' && IDENT_RE.test(rt.match_field)) {
        labelCol = rt.match_field
      }
    } catch {
      /* registry table may not exist on fresh installs */
    }
    if (!labelCol) {
      const cols = await db(collection).columnInfo()
      labelCol = ['name', 'title', 'label', 'subject'].find((c) => c in cols) ?? null
    }
    if (!labelCol) return map
    for (const chunk of chunks(ids, CHUNK)) {
      const rows = (await db(collection)
        .whereIn('id', chunk)
        .select('id', db.raw('?? as label', [labelCol]))) as Array<{
        id: unknown
        label: unknown
      }>
      for (const r of rows) {
        if (r.label != null && String(r.label).trim()) {
          map.set(String(r.id), String(r.label).trim().slice(0, 490))
        }
      }
    }
  } catch {
    /* labels are cosmetic */
  }
  return map
}

export async function runAccessAudit(auditId: number, runId: number): Promise<void> {
  const patchRun = (patch: Record<string, unknown>) =>
    db('nivaro_access_audit_runs').where({ id: runId }).update(patch)
  try {
    const audit = (await db('nivaro_access_audits').where({ id: auditId }).first()) as
      | { id: number; collection: string; subjects: string }
      | undefined
    if (!audit) throw new Error('Audit definition not found')
    const collection = audit.collection
    if (!IDENT_RE.test(collection) || /^nivaro_/i.test(collection)) {
      throw new Error('Invalid collection')
    }
    const subjects = parseSubjects(audit.subjects)
    if (subjects.length === 0) throw new Error('Audit has no subjects configured')

    // ── 1. Gather (user → record → subject labels) ────────────────────────
    const pairs = new Map<string, Map<string, Set<string>>>()
    const addPair = (userId: string, itemId: string, label: string) => {
      let byItem = pairs.get(userId)
      if (!byItem) {
        byItem = new Map()
        pairs.set(userId, byItem)
      }
      let labels = byItem.get(itemId)
      if (!labels) {
        labels = new Set()
        byItem.set(itemId, labels)
      }
      labels.add(label)
    }

    for (const s of subjects) {
      if (s.type === 'field' && s.field && IDENT_RE.test(s.field)) {
        const rows = (await db(collection).whereNotNull(s.field).select('id', s.field)) as Array<
          Record<string, unknown>
        >
        const label = s.label || s.field
        for (const r of rows) addPair(String(r[s.field as string]), String(r.id), label)
      } else if (s.type === 'pipeline_owners') {
        // Open instances only — a completed record's owners no longer work it.
        const instances = (await db('nivaro_workflow_instances as wi')
          .leftJoin('nivaro_workflow_states as st', 'wi.current_state', 'st.id')
          .where('wi.collection', collection)
          .whereNotNull('wi.current_state')
          .whereNull('wi.completed_at')
          .where((qb) => qb.where('st.is_terminal', false).orWhereNull('st.is_terminal'))
          .select('wi.id as instance_id', 'wi.item', 'wi.current_state')) as Array<{
          instance_id: string
          item: string
          current_state: string
        }>
        const label = s.label || 'Owner'
        const owners = await resolveStateOwnersBatch(
          instances.map((inst) => ({
            key: `${collection}:${inst.item}`,
            stateId: inst.current_state,
            instanceId: inst.instance_id,
            collection,
            itemId: inst.item
          }))
        )
        for (const inst of instances) {
          for (const o of owners.get(`${collection}:${inst.item}`) ?? []) {
            addPair(o.id, String(inst.item), label)
          }
        }
      }
    }

    // ── 2. Users in play — active, not redacted; admins always pass ───────
    const userIds = [...pairs.keys()]
    const userRows: Array<{ id: string; email: string; role: string | null; status: string }> = []
    for (const chunk of chunks(userIds, CHUNK)) {
      userRows.push(
        ...((await db('nivaro_users')
          .whereIn('id', chunk)
          .where('is_redacted', 0)
          .where('status', 'active')
          .select('id', 'email', 'role', 'status')) as typeof userRows)
      )
    }
    const adminRoles = new Set(
      (
        (await db('nivaro_roles').where('admin_access', 1).select('id')) as Array<{ id: string }>
      ).map((r) => String(r.id).toUpperCase())
    )
    const checkUsers = userRows.filter(
      (u) => !u.role || !adminRoles.has(String(u.role).toUpperCase())
    )

    const allItemIds = new Set<string>()
    for (const byItem of pairs.values()) for (const id of byItem.keys()) allItemIds.add(id)
    let checkedPairs = 0
    for (const u of checkUsers) checkedPairs += pairs.get(u.id)?.size ?? 0
    await patchRun({ checked_records: allItemIds.size, checked_pairs: checkedPairs })

    // ── 3. Per-user set-based visibility check + reason attribution ───────
    // The gates come from services/record-access.ts — the same compiler the
    // record's denied panel (access-explain) uses, so an audit finding and
    // the panel a stakeholder sees can never disagree (#519).
    const findings: Finding[] = []
    let truncated = false
    for (const u of checkUsers) {
      if (truncated) break
      const byItem = pairs.get(u.id)
      if (!byItem || byItem.size === 0) continue
      const ids = [...byItem.keys()]
      const gates = await compileAccessGates({ id: u.id, role: u.role } as User, collection)
      for (const chunk of chunks(ids, CHUNK)) {
        if (truncated) break
        const visible = await visibleIds(gates, chunk)
        const violating = chunk.filter((id) => !visible.has(id))
        if (violating.length === 0) continue
        const reasonMap = await explainIds(gates, violating)
        for (const id of violating) {
          const reasons = reasonMap.get(id) ?? []
          if (reasons.length === 0) {
            reasons.push({
              type: 'unknown',
              message:
                'Record not visible (gate could not be attributed — it may have been deleted mid-run)'
            })
          }
          findings.push({
            item_id: id,
            user: u.id,
            subject: [...(byItem.get(id) ?? [])].join(', '),
            reasons
          })
          if (findings.length >= FINDINGS_CAP) {
            truncated = true
            break
          }
        }
      }
    }

    // ── 4. Persist ────────────────────────────────────────────────────────
    const labelMap = await buildLabelMap(collection, [...new Set(findings.map((f) => f.item_id))])
    // 7 bound params per row against MSSQL's ~2100-parameter statement cap:
    // 250 rows = 1750 params. 400 was over the cap and failed on big runs.
    for (const chunk of chunks(findings, 250)) {
      await db('nivaro_access_audit_findings').insert(
        chunk.map((f) => ({
          run: runId,
          collection,
          item_id: f.item_id,
          item_label: labelMap.get(f.item_id) ?? null,
          user: f.user,
          subject: f.subject.slice(0, 100),
          reasons: JSON.stringify(f.reasons)
        }))
      )
    }
    await patchRun({
      status: 'completed',
      violation_count: findings.length,
      truncated: truncated ? 1 : 0,
      finished_at: new Date()
    })
  } catch (err) {
    await patchRun({
      status: 'error',
      error: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
      finished_at: new Date()
    }).catch(() => {})
  }
}
