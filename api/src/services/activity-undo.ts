import { valueUnchanged } from './value-unchanged.js'

/**
 * Undo from the audit log (#22). An activity entry is reversible when it is
 *   - a field edit (`update`) with a revision snapshot: the changed fields go
 *     back to what the record held before (the record's previous snapshot), but
 *     only while the record still holds the values this edit wrote — a field
 *     someone changed since is "changed since" and reverts only when the
 *     person picks it explicitly (per-field revert);
 *   - a bulk update: every entry of the same request (chain) by the same
 *     person on the same collection that changed the same fields — each record
 *     judged the same way, skipped ones reported;
 *   - a delete whose trash copy still exists: restored from trash.
 * Everything else (permission changes, sends, pushes, transitions, deletes
 * past trash, system tables, an undo itself) never offers Undo.
 *
 * The planner here is pure over `UndoDeps` (tests drive it with fakes); the
 * real deps (activity-undo-deps.ts) read as the caller and write through the
 * items service as the caller, so permissions, field lists, User Scopes, edit
 * locks, hooks and rollups all apply. The undo writes its own `undo` activity
 * entry whose comment JSON names the original (`undo_of`) and every entry it
 * reverted (`entries`) — that is what makes a second undo refuse.
 */

export type UndoKind = 'update' | 'bulk_update' | 'delete'

export interface UndoActivityRow {
  id: number
  action: string
  user: string | null
  collection: string | null
  item: string | null
  comment?: string | null
  timestamp: Date | string
  chain_id?: string | null
}

export type UndoFieldStatus =
  /** Still holds what this edit wrote — goes back to the previous value. */
  | 'revert'
  /** Someone changed it since — reverts only when picked explicitly. */
  | 'changed_since'
  /** Already holds the previous value again — nothing to do. */
  | 'already'
  /** The caller may not set this field. */
  | 'not_allowed'
  /** The caller may not read this field (values withheld). */
  | 'unreadable'
  /** Set by the system (rollup, state mirror, read-only) — follows the other fields. */
  | 'derived'
  /** No earlier snapshot says what it held before. */
  | 'no_previous'

export interface UndoFieldPlan {
  field: string
  status: UndoFieldStatus
  /** What the record held before this edit (the value an undo writes back). */
  previous?: unknown
  /** What this edit wrote. */
  written?: unknown
  /** What the record holds now. */
  current?: unknown
}

export type UndoRecordStatus =
  | 'revertible'
  /** Some fields still hold this edit's values, others changed since. */
  | 'partial'
  | 'changed_since'
  | 'nothing'
  | 'refused'
  | 'gone'
  | 'undone'
  | 'restorable'

export interface UndoRecordPlan {
  activity_id: number
  collection: string
  item: string
  status: UndoRecordStatus
  reason?: string
  fields: UndoFieldPlan[]
  /** A delete: the trash copy a restore brings back. */
  trash_id?: number
}

export interface UndoPreview {
  activity_id: number
  kind: UndoKind | null
  reversible: boolean
  reason?: string
  already_undone?: UndoneMark | null
  /** Records in the bulk group (1 for a single edit or a delete). */
  group_size: number
  /** The group was larger than one undo handles: only the first UNDO_GROUP_MAX records are judged. */
  truncated?: boolean
  records: UndoRecordPlan[]
  /** Records an apply (with the same `fields`) would change. */
  will_change: number
  skipped: number
}

export interface UndoResult extends UndoPreview {
  applied: boolean
  undo_activity_id: number | null
  changed: number
  failed: Array<{ item: string; reason: string }>
}

export interface UndoneMark {
  activity_id: number
  at: string
  by: string | null
}

export interface UndoRevision {
  /** Values this edit wrote (the revision's delta). */
  delta: Record<string, unknown> | null
  /** The record's previous snapshot, or null when none was kept. */
  before: Record<string, unknown> | null
}

export interface UndoFieldMeta {
  /** Audit stamps (creator, changed-on…) — never part of an undo. */
  audit: Set<string>
  /** Read-only / derived fields — follow the others, never written back. */
  readonly: Set<string>
}

export interface UndoDeps {
  isAdmin: boolean
  userId: string
  loadActivity(id: number): Promise<UndoActivityRow | null>
  /** Same chain + action + collection + user (the bulk request), the row itself included. */
  groupSiblings(row: UndoActivityRow, max: number): Promise<UndoActivityRow[]>
  revision(row: UndoActivityRow): Promise<UndoRevision | null>
  fieldMeta(collection: string): Promise<UndoFieldMeta>
  /** The record as the CALLER reads it; null = gone or not visible to them. */
  readCurrent(collection: string, item: string): Promise<Record<string, unknown> | null>
  canUpdate(collection: string, item: string): Promise<boolean>
  /** A person-held edit lock refusal message, or null. */
  lockedBy(collection: string, item: string): Promise<string | null>
  /** Of `fields`, the ones the caller's write would drop (field list, read-only). */
  notAllowed(collection: string, fields: string[]): Promise<Set<string>>
  /** Undo entries already written for any of `ids` (activity id → mark). */
  undoneIn(collection: string, since: Date, ids: number[]): Promise<Map<number, UndoneMark>>
  trashFor(row: UndoActivityRow): Promise<{ id: number } | null>
  recordExists(collection: string, item: string): Promise<boolean>
  canCreate(collection: string): Promise<boolean>
  /** Write through the items service as the caller. Throws a refusal. */
  update(
    collection: string,
    item: string,
    data: Record<string, unknown>,
    reason: string
  ): Promise<void>
  restore(trashId: number): Promise<void>
  logUndo(entry: {
    collection: string
    item: string | null
    comment: string
  }): Promise<number | null>
  /** Exclusive per-entry claim for the apply; false = another undo is running. */
  claim(id: number): Promise<boolean>
  release(id: number): Promise<void>
}

export interface UndoOptions {
  /** 'group' (default) undoes the whole bulk change; 'entry' only this record. */
  scope?: 'group' | 'entry'
  /** Per-field revert: only these fields, and these even when changed since. */
  fields?: string[]
}

/** Most records of one bulk change an undo handles (the first ones, by activity id). */
export const UNDO_GROUP_MAX = 500

const STAMP_FIELDS = new Set(['id', 'updated_at', 'date_updated', 'user_updated', 'changed'])

export class UndoError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code?: string
  ) {
    super(message)
    this.name = 'UndoError'
  }
}

function isSystemCollection(collection: string | null): boolean {
  return !collection || /^(nivaro_|directus_)/i.test(collection)
}

/** The cheap verdict: may this row ever offer Undo (no record reads)? */
export function reversibleAction(row: Pick<UndoActivityRow, 'action' | 'collection' | 'item'>): {
  ok: boolean
  reason?: string
} {
  if (!row.collection || !row.item) return { ok: false, reason: 'This entry names no record' }
  if (isSystemCollection(row.collection))
    return { ok: false, reason: 'Changes to system settings and permissions cannot be undone here' }
  if (row.action === 'update' || row.action === 'delete') return { ok: true }
  return { ok: false, reason: `A ${row.action} cannot be undone` }
}

function sameUser(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase()
}

function changedKeys(delta: Record<string, unknown> | null, meta?: UndoFieldMeta): string[] {
  if (!delta) return []
  return Object.keys(delta)
    .filter((k) => !STAMP_FIELDS.has(k) && !k.startsWith('_') && !meta?.audit.has(k))
    .sort()
}

/** The comment JSON of an `undo` entry. */
export function undoComment(payload: {
  undo_of: number
  kind: UndoKind
  entries: number[]
  changed: number
  skipped: number
  fields?: string[]
}): string {
  return JSON.stringify(payload)
}

/** The ids an `undo` entry's comment says it reverted (empty for anything else). */
export function parseUndoComment(comment: unknown): { undo_of: number; entries: number[] } | null {
  if (typeof comment !== 'string' || !comment.startsWith('{')) return null
  try {
    const j = JSON.parse(comment) as { undo_of?: unknown; entries?: unknown }
    const of = Number(j.undo_of)
    if (!Number.isFinite(of)) return null
    const entries = Array.isArray(j.entries)
      ? j.entries.map(Number).filter((n) => Number.isFinite(n))
      : []
    return { undo_of: of, entries: entries.length ? entries : [of] }
  } catch {
    return null
  }
}

async function planUpdateRecord(
  deps: UndoDeps,
  member: UndoActivityRow,
  meta: UndoFieldMeta,
  pick: Set<string> | null
): Promise<UndoRecordPlan> {
  const collection = String(member.collection)
  const item = String(member.item)
  const base = { activity_id: member.id, collection, item, fields: [] as UndoFieldPlan[] }
  const rev = await deps.revision(member)
  const keys = changedKeys(rev?.delta ?? null, meta)
  if (!rev?.delta || keys.length === 0)
    return { ...base, status: 'nothing', reason: 'No snapshot of this change was kept' }
  const current = await deps.readCurrent(collection, item)
  if (!current)
    return { ...base, status: 'gone', reason: 'The record no longer exists or you cannot see it' }
  if (!(await deps.canUpdate(collection, item)))
    return { ...base, status: 'refused', reason: 'You may not change this record' }
  const locked = await deps.lockedBy(collection, item)
  if (locked) return { ...base, status: 'refused', reason: locked }
  const blocked = await deps.notAllowed(collection, keys)
  const fields: UndoFieldPlan[] = keys.map((field) => {
    if (!(field in current)) return { field, status: 'unreadable' }
    const written = rev.delta?.[field]
    const now = current[field]
    if (meta.readonly.has(field)) return { field, status: 'derived', written, current: now }
    if (blocked.has(field)) return { field, status: 'not_allowed', written, current: now }
    if (!rev.before || !(field in rev.before))
      return { field, status: 'no_previous', written, current: now }
    const previous = rev.before[field]
    if (valueUnchanged(now, previous))
      return { field, status: 'already', previous, written, current: now }
    const status: UndoFieldStatus = valueUnchanged(now, written) ? 'revert' : 'changed_since'
    return { field, status, previous, written, current: now }
  })
  const scoped = pick ? fields.filter((f) => pick.has(f.field)) : fields
  const reverts = scoped.filter((f) => f.status === 'revert').length
  const changed = scoped.filter((f) => f.status === 'changed_since').length
  let status: UndoRecordStatus
  let reason: string | undefined
  if (reverts > 0 && changed === 0) status = 'revertible'
  else if (reverts > 0) {
    status = 'partial'
    reason = 'Some fields were changed since — pick the fields to revert'
  } else if (changed > 0) {
    status = 'changed_since'
    reason = 'Changed since — pick the fields to revert'
  } else {
    status = 'nothing'
    reason = scoped.some((f) => f.status === 'already')
      ? 'Already holds the previous values'
      : 'Nothing here can be reverted by you'
  }
  return { ...base, status, reason, fields }
}

/** The payload an apply writes for one record, or null (skipped). */
export function revertPayload(
  plan: UndoRecordPlan,
  pick: Set<string> | null
): Record<string, unknown> | null {
  if (plan.status !== 'revertible' && plan.status !== 'partial' && plan.status !== 'changed_since')
    return null
  // Without a pick, a record someone changed since is never half-reverted.
  if (!pick && plan.status !== 'revertible') return null
  const out: Record<string, unknown> = {}
  for (const f of plan.fields) {
    const take = pick
      ? pick.has(f.field) && (f.status === 'revert' || f.status === 'changed_since')
      : f.status === 'revert'
    if (take) out[f.field] = f.previous ?? null
  }
  return Object.keys(out).length ? out : null
}

function summarize(records: UndoRecordPlan[], pick: Set<string> | null) {
  let will = 0
  for (const r of records) {
    if (r.status === 'restorable' || revertPayload(r, pick)) will++
  }
  return { will_change: will, skipped: records.length - will }
}

function assertMayUndo(deps: UndoDeps, row: UndoActivityRow): void {
  if (deps.isAdmin) return
  if (sameUser(row.user, deps.userId)) return
  throw new UndoError('Only an administrator or the person who made this change can undo it', 403)
}

export async function previewUndo(
  deps: UndoDeps,
  activityId: number,
  opts: UndoOptions = {}
): Promise<UndoPreview> {
  const row = await deps.loadActivity(activityId)
  if (!row) throw new UndoError('Not found', 404)
  assertMayUndo(deps, row)
  const pick = opts.fields?.length ? new Set(opts.fields.map(String)) : null
  const none = (reason: string, extra: Partial<UndoPreview> = {}): UndoPreview => ({
    activity_id: row.id,
    kind: null,
    reversible: false,
    reason,
    group_size: 1,
    records: [],
    will_change: 0,
    skipped: 0,
    ...extra
  })
  const verdict = reversibleAction(row)
  if (!verdict.ok) return none(verdict.reason ?? 'This entry cannot be undone')
  const collection = String(row.collection)
  const since = new Date(row.timestamp)

  if (row.action === 'delete') {
    const undone = (await deps.undoneIn(collection, since, [row.id])).get(row.id)
    if (undone) return none('Already undone', { kind: 'delete', already_undone: undone })
    const trash = await deps.trashFor(row)
    if (!trash)
      return none(
        'The trash copy is gone (purged or restored already) — this delete cannot be undone',
        {
          kind: 'delete'
        }
      )
    const item = String(row.item)
    const base = { activity_id: row.id, collection, item, fields: [] }
    let rec: UndoRecordPlan
    if (!(await deps.canCreate(collection)))
      rec = { ...base, status: 'refused', reason: `You may not create ${collection} records` }
    else if (await deps.recordExists(collection, item))
      rec = { ...base, status: 'refused', reason: 'A record with this id exists again' }
    else rec = { ...base, status: 'restorable', trash_id: trash.id }
    return {
      activity_id: row.id,
      kind: 'delete',
      reversible: rec.status === 'restorable',
      ...(rec.reason ? { reason: rec.reason } : {}),
      group_size: 1,
      records: [rec],
      ...summarize([rec], null)
    }
  }

  // update — the bulk group (same request, person, collection and changed fields)
  const meta = await deps.fieldMeta(collection)
  let members: UndoActivityRow[] = [row]
  let truncated = false
  if (opts.scope !== 'entry' && row.chain_id) {
    const siblings = await deps.groupSiblings(row, UNDO_GROUP_MAX + 1)
    if (siblings.length > 1) {
      const ownRev = await deps.revision(row)
      const shape = changedKeys(ownRev?.delta ?? null, meta).join(',')
      const same: UndoActivityRow[] = []
      for (const s of siblings) {
        if (s.id === row.id) {
          same.push(s)
          continue
        }
        const r = await deps.revision(s)
        if (changedKeys(r?.delta ?? null, meta).join(',') === shape) same.push(s)
      }
      truncated = same.length > UNDO_GROUP_MAX
      members = same.sort((a, b) => a.id - b.id).slice(0, UNDO_GROUP_MAX)
      if (!members.some((m) => m.id === row.id)) members = [row, ...members.slice(0, -1)]
    }
  }
  const kind: UndoKind = members.length > 1 ? 'bulk_update' : 'update'
  const undone = await deps.undoneIn(
    collection,
    since,
    members.map((m) => m.id)
  )
  if (members.every((m) => undone.has(m.id))) {
    return none('Already undone', {
      kind,
      group_size: members.length,
      already_undone: undone.get(row.id) ?? [...undone.values()][0] ?? null
    })
  }
  const records: UndoRecordPlan[] = []
  for (const m of members) {
    if (undone.has(m.id)) {
      records.push({
        activity_id: m.id,
        collection,
        item: String(m.item),
        status: 'undone',
        reason: 'Already undone',
        fields: []
      })
      continue
    }
    records.push(await planUpdateRecord(deps, m, meta, pick))
  }
  const sum = summarize(records, pick)
  const first = records.find((r) => r.reason)?.reason
  return {
    activity_id: row.id,
    kind,
    reversible: sum.will_change > 0,
    ...(sum.will_change === 0 && first ? { reason: first } : {}),
    group_size: members.length,
    ...(truncated ? { truncated } : {}),
    records,
    ...sum
  }
}

export async function applyUndo(
  deps: UndoDeps,
  activityId: number,
  opts: UndoOptions = {}
): Promise<UndoResult> {
  if (!(await deps.claim(activityId)))
    throw new UndoError('An undo of this entry is already running', 409, 'UNDO_RUNNING')
  try {
    const plan = await previewUndo(deps, activityId, opts)
    const pick = opts.fields?.length ? new Set(opts.fields.map(String)) : null
    const result: UndoResult = {
      ...plan,
      applied: false,
      undo_activity_id: null,
      changed: 0,
      failed: []
    }
    if (!plan.reversible || !plan.kind) {
      if (plan.already_undone) throw new UndoError('Already undone', 409, 'ALREADY_UNDONE')
      return result
    }
    const done: number[] = []
    const reason = `Undo of activity #${activityId}`
    for (const rec of plan.records) {
      try {
        if (rec.status === 'restorable') {
          if (rec.trash_id == null) throw new Error('The trash copy is gone')
          await deps.restore(rec.trash_id)
          done.push(rec.activity_id)
          continue
        }
        const payload = revertPayload(rec, pick)
        if (!payload) continue
        await deps.update(rec.collection, rec.item, payload, reason)
        done.push(rec.activity_id)
      } catch (err) {
        result.failed.push({
          item: rec.item,
          reason: err instanceof Error ? err.message : 'Not changed'
        })
      }
    }
    result.changed = done.length
    result.skipped = plan.records.length - done.length
    if (done.length === 0) return result
    const row = plan.records[0]
    result.applied = true
    result.undo_activity_id = await deps.logUndo({
      collection: row.collection,
      item: plan.kind === 'bulk_update' ? null : row.item,
      comment: undoComment({
        undo_of: activityId,
        kind: plan.kind,
        entries: done,
        changed: done.length,
        skipped: result.skipped,
        ...(pick ? { fields: [...pick] } : {})
      })
    })
    return result
  } finally {
    await deps.release(activityId).catch(() => {})
  }
}
