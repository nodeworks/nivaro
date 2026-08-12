import { db } from '../db/index.js'

// ─── Workflow template versioning ────────────────────────────────────────────
//
// Snapshots a template's full config (template row + states + transitions +
// bindings, WITH their ids) into nivaro_workflow_template_versions. Captured
// best-effort BEFORE every config mutation, deduped against the latest
// version, so the pre-edit state is always one restore away — transitions are
// not revisioned by the items service (raw-knex admin routes), and a wiped
// `actions` blob was previously unrecoverable.
//
// Restore is ID-PRESERVING: states/transitions/bindings upsert by id (live
// instances FK current_state by state uuid — recreating states under new ids
// would orphan them). States are never deleted; transitions absent from the
// snapshot are deleted only when no nivaro_workflow_history row references
// them; extra bindings are left in place. Everything skipped is reported.

interface Logger {
  warn: (obj: unknown, msg?: string) => void
}
const consoleLogger: Logger = {
  warn: (obj, msg) => console.warn(msg ?? '', obj)
}

export interface TemplateSnapshot {
  template: Record<string, unknown>
  states: Array<Record<string, unknown>>
  transitions: Array<Record<string, unknown>>
  bindings: Array<Record<string, unknown>>
}

async function readSnapshot(templateId: string): Promise<TemplateSnapshot | null> {
  const template = await db('nivaro_workflow_templates').where({ id: templateId }).first()
  if (!template) return null
  const [states, transitions, bindings] = await Promise.all([
    db('nivaro_workflow_states').where({ template: templateId }).orderBy('sort').orderBy('label'),
    db('nivaro_workflow_transitions')
      .where({ template: templateId })
      .orderBy('sort')
      .orderBy('label'),
    db('nivaro_workflow_bindings').where({ template: templateId }).orderBy('id')
  ])
  return {
    template: template as Record<string, unknown>,
    states: states as Array<Record<string, unknown>>,
    transitions: transitions as Array<Record<string, unknown>>,
    bindings: bindings as Array<Record<string, unknown>>
  }
}

// Dates serialize differently between a fresh read and a stored snapshot —
// normalize through JSON so the dedupe compare is stable.
function stableJson(snapshot: TemplateSnapshot): string {
  return JSON.stringify(snapshot)
}

/**
 * Capture the template's CURRENT config as the next version. Skips (returns
 * null) when the latest stored version is byte-identical. Never throws.
 */
export async function snapshotTemplateVersion(
  templateId: string,
  userId?: string | null,
  note?: string,
  logger: Logger = consoleLogger
): Promise<number | null> {
  try {
    const snapshot = await readSnapshot(templateId)
    if (!snapshot) return null
    const json = stableJson(snapshot)
    const latest = (await db('nivaro_workflow_template_versions')
      .where({ template: templateId })
      .orderBy('version', 'desc')
      .first('version', 'snapshot')) as { version: number; snapshot: string } | undefined
    if (latest && latest.snapshot === json) return null // unchanged — no new version
    const nextVersion = (latest?.version ?? 0) + 1
    await db('nivaro_workflow_template_versions').insert({
      template: templateId,
      version: nextVersion,
      snapshot: json,
      note: note?.slice(0, 255) ?? null,
      created_by: userId ?? null,
      created_at: new Date()
    })
    return nextVersion
  } catch (err) {
    logger.warn({ err, templateId }, 'Failed to snapshot workflow template version')
    return null
  }
}

export interface RestoreResult {
  states: { updated: number; inserted: number; extra_kept: number }
  transitions: { updated: number; inserted: number; deleted: number; kept_in_history: number }
  bindings: { updated: number; inserted: number; extra_kept: number }
}

const TEMPLATE_RESTORE_COLS = ['name', 'description'] as const

/**
 * Restore a stored version onto the live template. Id-preserving upserts —
 * see the header comment for exactly what is (and is not) deleted.
 */
export async function restoreTemplateVersion(
  templateId: string,
  versionId: number
): Promise<RestoreResult> {
  const row = (await db('nivaro_workflow_template_versions')
    .where({ template: templateId, id: versionId })
    .first('snapshot')) as { snapshot: string } | undefined
  if (!row) throw new Error('Version not found')
  const snapshot = JSON.parse(row.snapshot) as TemplateSnapshot

  const result: RestoreResult = {
    states: { updated: 0, inserted: 0, extra_kept: 0 },
    transitions: { updated: 0, inserted: 0, deleted: 0, kept_in_history: 0 },
    bindings: { updated: 0, inserted: 0, extra_kept: 0 }
  }

  // Template row — only safe display columns.
  const tplPatch: Record<string, unknown> = {}
  for (const col of TEMPLATE_RESTORE_COLS) {
    if (col in snapshot.template) tplPatch[col] = snapshot.template[col]
  }
  if (Object.keys(tplPatch).length > 0) {
    await db('nivaro_workflow_templates').where({ id: templateId }).update(tplPatch)
  }

  const upsert = async (
    table: string,
    rows: Array<Record<string, unknown>>,
    counters: { updated: number; inserted: number }
  ) => {
    for (const raw of rows) {
      const { id, ...rest } = raw
      if (id == null) continue
      const patch = { ...rest, template: templateId }
      const existing = await db(table).where({ id }).first('id')
      if (existing) {
        await db(table).where({ id }).update(patch)
        counters.updated++
      } else {
        await db(table).insert({ id, ...patch })
        counters.inserted++
      }
    }
  }

  // States: upsert only — never delete (instances/history FK state ids).
  await upsert('nivaro_workflow_states', snapshot.states, result.states)
  const snapStateIds = new Set(snapshot.states.map((s) => String(s.id)))
  const liveStates = (await db('nivaro_workflow_states')
    .where({ template: templateId })
    .select('id')) as Array<{ id: string }>
  result.states.extra_kept = liveStates.filter((s) => !snapStateIds.has(String(s.id))).length

  // Transitions: upsert + delete extras not referenced by history.
  await upsert('nivaro_workflow_transitions', snapshot.transitions, result.transitions)
  const snapTxIds = new Set(snapshot.transitions.map((t) => String(t.id)))
  const liveTx = (await db('nivaro_workflow_transitions')
    .where({ template: templateId })
    .select('id')) as Array<{ id: string }>
  for (const tx of liveTx) {
    if (snapTxIds.has(String(tx.id))) continue
    const used = await db('nivaro_workflow_history').where({ transition: tx.id }).first('id')
    if (used) {
      result.transitions.kept_in_history++
      continue
    }
    await db('nivaro_workflow_transitions').where({ id: tx.id }).delete()
    result.transitions.deleted++
  }

  // Bindings: upsert only — deleting a binding would silently detach a live
  // collection from the template.
  await upsert('nivaro_workflow_bindings', snapshot.bindings, result.bindings)
  const snapBindingIds = new Set(snapshot.bindings.map((b) => String(b.id)))
  const liveBindings = (await db('nivaro_workflow_bindings')
    .where({ template: templateId })
    .select('id')) as Array<{ id: string }>
  result.bindings.extra_kept = liveBindings.filter((b) => !snapBindingIds.has(String(b.id))).length

  return result
}
