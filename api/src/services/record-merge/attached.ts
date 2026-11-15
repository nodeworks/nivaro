/**
 * Merge records — the record-attached system rows (comments, tasks, related-record links)
 * on the discarded records, and which of them THIS person may move. Read the same way by
 * the plan (counts) and by the merge itself (the rows it moves), so a row the plan showed
 * as movable is judged again when the merge runs; nothing trusts the plan.
 *
 *   comments      — a field comment moves only for someone who may read that field
 *                   (fieldCommentGate, the thread's own rule); a record comment moves
 *                   for anyone who reads the record (the caller already does).
 *   tasks         — only tasks the person may work (admin who sees every record, assignee
 *                   or requester — routes/tasks.ts canWorkTask); others stay put (the
 *                   delete cancels them like any delete, a restore reopens them).
 *   record_links  — only where the record at the other end is readable to the person.
 *
 * A row that may not be moved stays with the discarded record and is counted as hidden.
 */
import type { FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import type { MergeAttachedKind } from './rules.js'

export interface AttachedRow {
  id: string
  /** The merged-collection record it hangs off. */
  item: string
  /** record_links: which end of the link is the merged record. */
  side?: 'from' | 'to'
  /** record_links: the record at the other end. */
  other?: { collection: string; item: string }
  movable: boolean
}

const sameId = (a: unknown, b: unknown) =>
  String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()

const pickId = (ids: string[], raw: unknown) => ids.find((x) => sameId(x, raw)) ?? String(raw)

export interface AttachedGates {
  /** Field comment readable by the person (null field = a record comment). */
  commentField(field: string | null): boolean
  /** The person may work this task (move it, close it). */
  task(t: { assignee: string | null; created_by: string | null }): boolean
  /** The record at the other end of a link is readable to the person. */
  readable(collection: string, item: string): Promise<boolean>
}

async function gatesFor(req: FastifyRequest, collection: string): Promise<AttachedGates> {
  const user = req.user as User
  const { hasFieldCommentColumns, fieldCommentGate } = await import('../field-comments.js')
  const fieldCols = await hasFieldCommentColumns().catch(() => false)
  const mayReadField = fieldCols
    ? await fieldCommentGate(user, req.isAdmin === true, collection)
    : () => true
  const { seesAllRecords } = await import('../user-scopes.js')
  const all = await seesAllRecords(req.isAdmin, user).catch(() => false)
  const { isTaskParty, canReadTaskRecord } = await import('../tasks.js')
  const seen = new Map<string, Promise<boolean>>()
  return {
    commentField: (field) => mayReadField(field),
    task: (t) =>
      all || isTaskParty({ assignee: t.assignee, created_by: t.created_by ?? '' }, String(user.id)),
    readable(c, item) {
      const key = `${c}\u0001${item.toLowerCase()}`
      let p = seen.get(key)
      if (!p) {
        p = canReadTaskRecord(user, c, item, req.workspaceId ?? undefined).catch(() => false)
        seen.set(key, p)
      }
      return p
    }
  }
}

/** A raw attached row as stored (before it is judged). */
export interface RawAttachedRow {
  id: string | number
  item: string
  field?: string | null
  assignee?: string | null
  created_by?: string | null
  side?: 'from' | 'to'
  other_collection?: string
  other_item?: string
}

/** Read the kind's stored rows on `ids` (comments not deleted; links from both ends). */
async function fetchRaw(
  kind: MergeAttachedKind,
  collection: string,
  ids: string[]
): Promise<RawAttachedRow[]> {
  if (kind === 'comments') {
    const { hasFieldCommentColumns } = await import('../field-comments.js')
    const fieldCols = await hasFieldCommentColumns().catch(() => false)
    return (await db('nivaro_comments')
      .where({ collection })
      .whereIn('item', ids)
      .whereNull('deleted_at')
      .select('id', 'item', ...(fieldCols ? ['field'] : []))) as RawAttachedRow[]
  }
  if (kind === 'tasks')
    return (await db('nivaro_tasks')
      .where({ collection })
      .whereIn('item', ids)
      .select('id', 'item', 'assignee', 'created_by')) as RawAttachedRow[]
  const out: RawAttachedRow[] = []
  for (const side of ['from', 'to'] as const) {
    const other = side === 'from' ? 'to' : 'from'
    const rows = (await db('nivaro_record_links')
      .where(`${side}_collection`, collection)
      .whereIn(`${side}_item`, ids)
      .select(
        'id',
        `${side}_item as item`,
        `${other}_collection as other_collection`,
        `${other}_item as other_item`
      )) as RawAttachedRow[]
    for (const r of rows) out.push({ ...r, side })
  }
  return out
}

/** Judge stored rows for this person (pure but for the readable() lookups). */
export async function judgeAttached(
  kind: MergeAttachedKind,
  raw: RawAttachedRow[],
  ids: string[],
  g: AttachedGates
): Promise<AttachedRow[]> {
  const out: AttachedRow[] = []
  for (const r of raw) {
    const base = { id: String(r.id), item: pickId(ids, r.item) }
    if (kind === 'comments') out.push({ ...base, movable: g.commentField(r.field ?? null) })
    else if (kind === 'tasks')
      out.push({
        ...base,
        movable: g.task({ assignee: r.assignee ?? null, created_by: r.created_by ?? null })
      })
    else {
      const other = {
        collection: String(r.other_collection ?? ''),
        item: String(r.other_item ?? '')
      }
      out.push({
        ...base,
        side: r.side ?? 'from',
        other,
        movable: !!other.collection && (await g.readable(other.collection, other.item))
      })
    }
  }
  return out
}

/** The kind's rows on `ids`, each judged for this person. */
export async function attachedRows(
  req: FastifyRequest,
  kind: MergeAttachedKind,
  collection: string,
  ids: string[],
  opts: {
    gates?: AttachedGates
    fetch?: (
      kind: MergeAttachedKind,
      collection: string,
      ids: string[]
    ) => Promise<RawAttachedRow[]>
  } = {}
): Promise<AttachedRow[]> {
  if (ids.length === 0) return []
  const raw = await (opts.fetch ?? fetchRaw)(kind, collection, ids)
  if (raw.length === 0) return []
  const g = opts.gates ?? (await gatesFor(req, collection))
  return judgeAttached(kind, raw, ids, g)
}
