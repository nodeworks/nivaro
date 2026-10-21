import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import {
  type BulkAction,
  type FormPlan,
  type LabelOf,
  type MacroStep,
  parseMacroSteps,
  planForm
} from './layout-bulk-plan.js'
import { loadLayoutBundle, runLayoutOps } from './layout-ops.js'
import { layoutStateHash, restoreLayoutVersion, snapshotLayoutVersion } from './layout-versions.js'
import { withReadGate } from './read-gate.js'

export * from './layout-bulk-plan.js'

/**
 * Many layouts at once (#2639 / #2662 / #2663): preview, apply, undo. Every
 * form is changed through runLayoutOps — the layout editor's own save path —
 * with a version captured first, so each form's History holds a "before"
 * entry named after the action and the whole change can be put back.
 */

export interface FormPreview extends Omit<FormPlan, 'ops'> {
  layout_id: number
  name: string
  layout_type: string
  rev: string
  ops_count: number
}

export interface ValueCount {
  /** Records that still hold a value; null when the field has no column of its own. */
  populated: number | null
  total: number | null
  note: string | null
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Labels for sentences: what the admin sees, else the field name. */
export function labelsFrom(raw: unknown): LabelOf {
  const map = new Map<string, string>()
  if (raw && typeof raw === 'object' && !Array.isArray(raw))
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      if (typeof v === 'string' && v.trim()) map.set(k, v.trim().slice(0, 120))
  return (field) => map.get(field) ?? field
}

/** Layout ids of a collection, in the overview's order; `only` narrows them. */
export async function collectionLayoutIds(collection: string, only?: number[]): Promise<number[]> {
  const q = db('nivaro_collection_layouts')
    .where({ collection })
    .orderBy([{ column: 'sort' }, { column: 'id' }])
    .select('id')
  const rows = (await q) as Array<{ id: number }>
  const ids = rows.map((r) => Number(r.id))
  return only ? ids.filter((id) => only.includes(id)) : ids
}

/** Fields placed on the collection's forms (page cards and positions left out). */
export async function placedFields(
  collection: string
): Promise<Array<{ field: string; forms: number }>> {
  const rows = (await db('nivaro_layout_field_assignments as a')
    .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
    .where('l.collection', collection)
    .groupBy('a.field')
    .select('a.field', db.raw('COUNT(DISTINCT a.layout_id) as forms'))) as Array<{
    field: string
    forms: number | string
  }>
  return rows
    .filter((r) => !String(r.field).startsWith('__'))
    .map((r) => ({ field: String(r.field), forms: Number(r.forms) }))
    .sort((a, b) => a.field.localeCompare(b.field))
}

/** What the action would do on each layout. Read-only. */
export async function previewBulk(
  collection: string,
  action: BulkAction,
  L: LabelOf,
  only?: number[]
): Promise<FormPreview[]> {
  const out: FormPreview[] = []
  for (const id of await collectionLayoutIds(collection, only)) {
    const bundle = await loadLayoutBundle(db, id)
    if (!bundle) continue
    const { ops, ...plan } = planForm(bundle, action, L)
    out.push({
      layout_id: id,
      name: String(bundle.layout.name ?? `Layout ${id}`),
      layout_type: String(bundle.layout.layout_type ?? 'grouped'),
      rev: bundle.rev,
      ops_count: ops.length,
      ...plan
    })
  }
  return out
}

/** Records of the collection that still hold a value in `field` (#2639). */
export async function countFieldValues(
  collection: string,
  field: string,
  who: string | null | undefined
): Promise<ValueCount> {
  if (!IDENT.test(collection) || /^(nivaro|directus)_/i.test(collection) || !IDENT.test(field))
    return { populated: null, total: null, note: null }
  const cols = (await db.raw(
    'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME = ?',
    [collection, field]
  )) as Array<{ COLUMN_NAME: string }>
  if (cols.length === 0)
    return {
      populated: null,
      total: null,
      note: 'This field has no column of its own (links live in another table); nothing is deleted.'
    }
  try {
    const rows = (await withReadGate(
      who,
      () => db.raw(`SELECT COUNT(*) AS total, COUNT([${field}]) AS populated FROM [${collection}]`),
      { label: 'layout-bulk:retire-count' }
    )) as Array<{ total: number; populated: number }>
    return {
      populated: Number(rows[0]?.populated ?? 0),
      total: Number(rows[0]?.total ?? 0),
      note: null
    }
  } catch {
    return { populated: null, total: null, note: 'The records could not be counted just now.' }
  }
}

export interface AppliedForm {
  layout_id: number
  name: string
  status: 'applied' | 'same' | 'skipped' | 'failed'
  reason: string | null
  /** The version holding this form as it was before — Undo restores it. */
  version_id: number | null
  /** The form's rev after the change: Undo only restores a form nobody changed since. */
  rev: string | null
}

/**
 * Apply to every layout of the collection (or `only`). Each form is planned
 * again on its current state; a form whose rev moved since the preview the
 * admin saw is skipped, never applied blind.
 */
export async function applyBulk(opts: {
  collection: string
  action: BulkAction
  L: LabelOf
  note: string
  userId: string | null | undefined
  only?: number[]
  revs?: Record<string, string>
}): Promise<AppliedForm[]> {
  const out: AppliedForm[] = []
  const note = opts.note.slice(0, 200)
  for (const id of await collectionLayoutIds(opts.collection, opts.only)) {
    const bundle = await loadLayoutBundle(db, id)
    if (!bundle) continue
    const name = String(bundle.layout.name ?? `Layout ${id}`)
    const row = (status: AppliedForm['status'], reason: string | null): AppliedForm => ({
      layout_id: id,
      name,
      status,
      reason,
      version_id: null,
      rev: null
    })
    const seen = opts.revs?.[String(id)]
    if (seen !== undefined && seen !== bundle.rev) {
      out.push(row('skipped', 'Changed since the preview: preview again'))
      continue
    }
    const plan = planForm(bundle, opts.action, opts.L)
    if (plan.status !== 'change') {
      out.push(row(plan.status === 'same' ? 'same' : 'skipped', plan.reason))
      continue
    }
    // The state before, as a version of its own (deduped when History already ends on it).
    await snapshotLayoutVersion(id, `Before ${note}`, opts.userId ?? null)
    const before = (await db('nivaro_layout_versions')
      .where({ layout_id: id })
      .orderBy('version', 'desc')
      .first('id')) as { id: number } | undefined
    const result = await runLayoutOps(
      id,
      { ops: plan.ops, base_rev: bundle.rev, note: `Before ${note}` },
      opts.userId
    )
    if (result.status === 200)
      out.push({
        ...row(result.changed ? 'applied' : 'same', null),
        version_id: before ? Number(before.id) : null,
        rev: result.bundle.rev
      })
    else if (result.status === 409) out.push(row('skipped', 'Someone saved this form just now'))
    else if (result.status === 400) out.push(row('failed', result.error))
    else out.push(row('skipped', 'This form no longer exists'))
  }
  return out
}

export interface UndoItem {
  layout_id: number
  version_id: number
  rev: string
}

/** Put each form back to its version from before the bulk change — unless it changed since. */
export async function undoBulk(
  collection: string,
  items: UndoItem[],
  userId: string | null | undefined
): Promise<Array<{ layout_id: number; status: 'restored' | 'skipped'; reason: string | null }>> {
  const ids = new Set(await collectionLayoutIds(collection))
  const out: Array<{ layout_id: number; status: 'restored' | 'skipped'; reason: string | null }> =
    []
  for (const it of items) {
    if (!ids.has(it.layout_id)) {
      out.push({
        layout_id: it.layout_id,
        status: 'skipped',
        reason: 'Not a form of this collection'
      })
      continue
    }
    const rev = await layoutStateHash(it.layout_id)
    if (rev !== it.rev) {
      out.push({
        layout_id: it.layout_id,
        status: 'skipped',
        reason: 'Changed since the bulk change: restore it from History'
      })
      continue
    }
    const r = await restoreLayoutVersion(it.layout_id, it.version_id, userId)
    if (!r) out.push({ layout_id: it.layout_id, status: 'skipped', reason: 'Version not found' })
    else if ('error' in r) out.push({ layout_id: it.layout_id, status: 'skipped', reason: r.error })
    else out.push({ layout_id: it.layout_id, status: 'restored', reason: null })
  }
  return out
}

// ─── Macros (#2663): a person's own, in nivaro_users.preferences.layout_macros ─

export interface LayoutMacro {
  id: string
  name: string
  collection: string
  steps: MacroStep[]
  created_at: string
  source_layout_id: number | null
}

export const MACROS_MAX = 30
const MACRO_MAX_BYTES = 48_000

async function readPrefs(userId: string): Promise<Record<string, unknown>> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: unknown }
    | undefined
  try {
    const p = typeof row?.preferences === 'string' ? JSON.parse(row.preferences) : row?.preferences
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Stored macros, tolerant of junk: a malformed entry is dropped, never thrown on. */
export function macrosFromPreferences(prefs: Record<string, unknown>): LayoutMacro[] {
  const raw = prefs.layout_macros
  if (!Array.isArray(raw)) return []
  const out: LayoutMacro[] = []
  for (const m of raw.slice(0, MACROS_MAX)) {
    if (!m || typeof m !== 'object') continue
    const x = m as Record<string, unknown>
    const steps = parseMacroSteps(x.steps)
    if (typeof x.id !== 'string' || typeof x.name !== 'string' || 'error' in steps) continue
    out.push({
      id: x.id,
      name: x.name,
      collection: typeof x.collection === 'string' ? x.collection : '',
      steps: steps.steps,
      created_at: typeof x.created_at === 'string' ? x.created_at : '',
      source_layout_id: typeof x.source_layout_id === 'number' ? x.source_layout_id : null
    })
  }
  return out
}

export async function listMacros(userId: string): Promise<LayoutMacro[]> {
  return macrosFromPreferences(await readPrefs(userId))
}

async function writeMacros(
  userId: string,
  prefs: Record<string, unknown>,
  list: LayoutMacro[]
): Promise<void> {
  const { layout_macros: _old, ...rest } = prefs
  await db('nivaro_users')
    .where({ id: userId })
    .update({
      preferences: JSON.stringify(list.length ? { ...rest, layout_macros: list } : rest)
    })
}

/** Save a new macro (id absent) or rename / re-record one of the caller's own. */
export async function saveMacro(
  userId: string,
  body: Record<string, unknown>
): Promise<{ macro: LayoutMacro } | { status: number; error: string }> {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
  if (!name) return { status: 400, error: 'Give the macro a name' }
  const collection = typeof body.collection === 'string' ? body.collection : ''
  if (!IDENT.test(collection)) return { status: 400, error: 'collection required' }
  const steps = parseMacroSteps(body.steps)
  if ('error' in steps) return { status: 400, error: steps.error }
  const prefs = await readPrefs(userId)
  const list = macrosFromPreferences(prefs)
  const id = typeof body.id === 'string' && body.id ? body.id : null
  const prior = id ? list.find((m) => m.id === id) : undefined
  if (id && !prior) return { status: 404, error: 'Macro not found' }
  if (!prior && list.length >= MACROS_MAX)
    return { status: 400, error: `You can keep at most ${MACROS_MAX} macros: delete one first` }
  const macro: LayoutMacro = {
    id: prior?.id ?? randomUUID(),
    name,
    collection,
    steps: steps.steps,
    created_at: prior?.created_at ?? new Date().toISOString(),
    source_layout_id:
      typeof body.source_layout_id === 'number'
        ? body.source_layout_id
        : (prior?.source_layout_id ?? null)
  }
  if (JSON.stringify(macro).length > MACRO_MAX_BYTES)
    return { status: 400, error: 'This macro is too long to keep: record fewer steps' }
  const next = prior ? list.map((m) => (m.id === macro.id ? macro : m)) : [...list, macro]
  await writeMacros(userId, prefs, next)
  return { macro }
}

export async function deleteMacro(userId: string, id: string): Promise<boolean> {
  const prefs = await readPrefs(userId)
  const list = macrosFromPreferences(prefs)
  if (!list.some((m) => m.id === id)) return false
  await writeMacros(
    userId,
    prefs,
    list.filter((m) => m.id !== id)
  )
  return true
}
