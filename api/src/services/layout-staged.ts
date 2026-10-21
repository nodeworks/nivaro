import { db } from '../db/index.js'

/**
 * Staged layout edits (#2589): the editor's unsaved steps, kept on the server
 * per person and layout. A draft follows its author to another browser and
 * outlives a closed tab, and nobody else sees it until they Save — the Save
 * is still one atomic ops apply against the layout's rev.
 *
 * Rows live in `nivaro_drafts` (migration 316, the record form's server
 * drafts) under the pseudo collection STAGED_COLLECTION, keyed by layout id,
 * so no table is added. That table is skipped by the staging config copy, so
 * a draft outlives the nightly layout replacement: the editor folds it onto
 * the layout as it is then and lists what no longer fits.
 */

export const STAGED_COLLECTION = 'layout-editor'
const PAYLOAD_CAP = 256 * 1024
const MAX_OPS = 5000
const MAX_STEPS = 2000
const LABEL_MAX = 200

export interface StagedStep {
  label: string
  ops: unknown[]
}

export interface StagedDraft {
  steps: StagedStep[]
  base_rev: string
  /** When it was last written (ISO). */
  saved_at: string
}

/** Someone else's draft on the same layout: who and how much, never the changes. */
export interface StagedOther {
  user_id: string
  name: string
  step_count: number
  op_count: number
  saved_at: string
}

export class StagedError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

// nivaro_drafts arrived in migration 316; a database behind it simply has no staged
// drafts (the editor keeps them in the browser alone). Re-checked each minute until found.
let table: { has: boolean; at: number } | null = null
export async function stagedAvailable(): Promise<boolean> {
  if (table && (table.has || Date.now() - table.at < 60_000)) return table.has
  let has = false
  try {
    has = await db.schema.hasTable('nivaro_drafts')
  } catch {
    has = false
  }
  table = { has, at: Date.now() }
  return has
}
/** Tests: forget what the table check found. */
export function resetStagedTableCheck(): void {
  table = null
}

const isStep = (s: unknown): s is StagedStep => {
  const x = s as { label?: unknown; ops?: unknown } | null
  return (
    !!x &&
    typeof x === 'object' &&
    typeof x.label === 'string' &&
    x.label.length <= LABEL_MAX &&
    Array.isArray(x.ops) &&
    x.ops.every((op) => !!op && typeof op === 'object' && !Array.isArray(op))
  )
}

/** The editor's body: { steps: [{label, ops}], base_rev }. Throws StagedError 400 / 413. */
export function parseStagedBody(body: unknown): { steps: StagedStep[]; base_rev: string } {
  const b = (body ?? {}) as { steps?: unknown; base_rev?: unknown }
  if (typeof b.base_rev !== 'string' || !b.base_rev || b.base_rev.length > 128)
    throw new StagedError(400, 'base_rev required')
  if (!Array.isArray(b.steps) || b.steps.length === 0)
    throw new StagedError(400, 'steps must be a non-empty array')
  if (b.steps.length > MAX_STEPS) throw new StagedError(413, `At most ${MAX_STEPS} steps`)
  if (!b.steps.every(isStep)) throw new StagedError(400, 'Each step needs a label and ops')
  const steps = b.steps as StagedStep[]
  const ops = steps.reduce((n, s) => n + s.ops.length, 0)
  if (ops === 0) throw new StagedError(400, 'steps carry no ops')
  if (ops > MAX_OPS) throw new StagedError(413, `At most ${MAX_OPS} ops`)
  if (JSON.stringify(steps).length > PAYLOAD_CAP) throw new StagedError(413, 'Draft too large')
  return { steps, base_rev: b.base_rev }
}

const keyOf = (layoutId: number, userId: string) => ({
  user: userId,
  collection: STAGED_COLLECTION,
  item_key: String(layoutId)
})

const iso = (v: unknown) =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : new Date().toISOString()

export async function readStaged(layoutId: number, userId: string): Promise<StagedDraft | null> {
  const row = (await db('nivaro_drafts')
    .where(keyOf(layoutId, userId))
    .first('payload', 'saved_at')) as { payload: string; saved_at: Date | string } | undefined
  if (!row) return null
  let payload: { steps?: unknown; base_rev?: unknown } | null = null
  try {
    payload = JSON.parse(row.payload)
  } catch {
    return null
  }
  if (
    !payload ||
    typeof payload.base_rev !== 'string' ||
    !Array.isArray(payload.steps) ||
    !payload.steps.every(isStep)
  )
    return null
  return {
    steps: payload.steps as StagedStep[],
    base_rev: payload.base_rev,
    saved_at: iso(row.saved_at)
  }
}

export async function writeStaged(
  layoutId: number,
  userId: string,
  draft: { steps: StagedStep[]; base_rev: string }
): Promise<{ saved_at: string }> {
  const savedAt = new Date()
  const where = keyOf(layoutId, userId)
  const text = JSON.stringify({ v: 1, base_rev: draft.base_rev, steps: draft.steps })
  const existing = (await db('nivaro_drafts').where(where).first('id')) as
    | { id: number }
    | undefined
  if (existing) await db('nivaro_drafts').where(where).update({ payload: text, saved_at: savedAt })
  else await db('nivaro_drafts').insert({ ...where, payload: text, saved_at: savedAt })
  return { saved_at: savedAt.toISOString() }
}

export async function clearStaged(layoutId: number, userId: string): Promise<void> {
  await db('nivaro_drafts').where(keyOf(layoutId, userId)).delete()
}

/** Other people's drafts on this layout: names and counts only. */
export async function stagedByOthers(layoutId: number, userId: string): Promise<StagedOther[]> {
  const rows = (await db('nivaro_drafts as d')
    .leftJoin('nivaro_users as u', 'd.user', 'u.id')
    .where({ 'd.collection': STAGED_COLLECTION, 'd.item_key': String(layoutId) })
    .whereNot('d.user', userId)
    .orderBy('d.saved_at', 'desc')
    .select(
      'd.user as user_id',
      'd.payload',
      'd.saved_at',
      'u.first_name',
      'u.last_name'
    )) as Array<{
    user_id: string
    payload: string
    saved_at: Date | string
    first_name: string | null
    last_name: string | null
  }>
  const out: StagedOther[] = []
  for (const r of rows) {
    let steps: StagedStep[] = []
    try {
      const p = JSON.parse(r.payload) as { steps?: unknown }
      if (Array.isArray(p.steps) && p.steps.every(isStep)) steps = p.steps as StagedStep[]
    } catch {
      continue
    }
    if (steps.length === 0) continue
    const name = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'An administrator'
    out.push({
      user_id: r.user_id,
      name,
      step_count: steps.length,
      op_count: steps.reduce((n, s) => n + s.ops.length, 0),
      saved_at: iso(r.saved_at)
    })
  }
  return out
}
