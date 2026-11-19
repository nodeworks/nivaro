import { db } from '../db/index.js'
import { getRelations } from './collections.js'
import type { Revision } from './revisions.js'

/**
 * To-many fields in a record's history (2026-11-19, Rob: "why was this change by Tim counted
 * as a change? no fields were changed?"). A save that only links or unlinks rows (Divisions on
 * a project type) writes the LINK ROWS — each with its own create/delete revision — and then a
 * parent revision whose snapshot holds no to-many field at all and whose delta is `{}`. The
 * history table had nothing to show for that save, so it read as a change of nothing.
 *
 * This folds the link rows back in at read time — no stored revision is rewritten, so history
 * written before this change reads right too:
 *
 *   - the link-row writes made by the same person in the moments just before a parent save
 *     (the same request: links are written first, then the parent — WINDOW_MS) belong to it;
 *   - walking back from the links the record has now, each snapshot without the field gets the
 *     link-row ids as that save left them, and a save whose links moved names the field in its
 *     delta, so it reads as changed;
 *   - a snapshot that stored the field itself is trusted and restarts the walk.
 *
 * Link writes made away from a parent save (a link table edited on its own) attach to no save;
 * the walk then shows them on the nearest older save. Bounded: one link read per field and one
 * activity read for at most MAX_SAVES saves.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
/** How long before its parent save a link write may be and still belong to it. */
export const WINDOW_MS = 15_000
/** A link write a hair after the parent stamp (clock rounding) still belongs to it. */
const AFTER_MS = 1_500
const MAX_SAVES = 100
const MAX_LINKS = 600

export interface LinkOp {
  at: number
  user: string | null
  op: 'add' | 'remove'
  id: string
}

export interface FoldSave {
  /** Index into the history list. */
  index: number
  at: number
  user: string | null
  /** The field's ids as the snapshot stored them, or null when it did not store the field. */
  stored: string[] | null
}

const time = (v: unknown) => (v ? new Date(v as string).getTime() : 0)

function idsOf(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const raw of v) {
    const id =
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>).id : (raw as unknown)
    if (typeof id === 'string' || typeof id === 'number') out.push(String(id))
  }
  return out
}

/** Which save a link write belongs to: the nearest save by the same person at or after it,
 *  within the window. Exported for tests. */
export function ownerSave(op: LinkOp, saves: FoldSave[]): FoldSave | null {
  let best: FoldSave | null = null
  for (const s of saves) {
    if ((s.user ?? null) !== (op.user ?? null)) continue
    const lead = s.at - op.at
    if (lead < -AFTER_MS || lead > WINDOW_MS) continue
    if (!best || Math.abs(s.at - op.at) < Math.abs(best.at - op.at)) best = s
  }
  return best
}

/**
 * The pure walk. `saves` newest first; `current` = the link ids the record has now. Returns, per
 * save index, the ids that save left (only for saves that did not store the field) and whether
 * that save moved the links. Exported for tests.
 */
export function foldLinkHistory(
  saves: FoldSave[],
  ops: LinkOp[],
  current: string[]
): Map<number, { ids: string[]; changed: boolean; added: string[]; removed: string[] }> {
  const out = new Map<
    number,
    { ids: string[]; changed: boolean; added: string[]; removed: string[] }
  >()
  const bySave = new Map<number, LinkOp[]>()
  for (const op of ops) {
    const s = ownerSave(op, saves)
    if (!s) continue
    const list = bySave.get(s.index) ?? []
    list.push(op)
    bySave.set(s.index, list)
  }
  let set = new Set(current)
  for (const s of saves) {
    if (s.stored) set = new Set(s.stored)
    const mine = (bySave.get(s.index) ?? []).sort((a, b) => a.at - b.at)
    // Net effect of this save's writes: a link added then removed in one save is no change.
    const net = new Map<string, 'add' | 'remove'>()
    for (const op of mine) {
      const prev = net.get(op.id)
      if (prev && prev !== op.op) net.delete(op.id)
      else net.set(op.id, op.op)
    }
    const added = [...net].filter(([, o]) => o === 'add').map(([id]) => id)
    const removed = [...net].filter(([, o]) => o === 'remove').map(([id]) => id)
    if (!s.stored) {
      out.set(s.index, {
        ids: [...set].sort(),
        changed: added.length + removed.length > 0,
        added,
        removed
      })
    }
    // Back to the set before this save.
    for (const id of added) set.delete(id)
    for (const id of removed) set.add(id)
  }
  return out
}

interface ToManyField {
  field: string
  junction: string
  parentFk: string
}

async function toManyFields(collection: string): Promise<ToManyField[]> {
  const rels = await getRelations(collection)
  return rels
    .filter(
      (r) =>
        r.one_collection === collection &&
        r.one_field &&
        IDENT.test(r.one_field) &&
        IDENT.test(r.many_collection) &&
        r.many_field &&
        IDENT.test(r.many_field) &&
        // Many-to-many only: one-to-many child rows have their own columns in the history.
        !!r.junction_field &&
        !String(r.many_collection).startsWith('nivaro_')
    )
    .map((r) => ({
      field: r.one_field as string,
      junction: r.many_collection,
      parentFk: r.many_field as string
    }))
}

const isSnapshot = (r: Revision) =>
  r.id != null && (r.action === 'update' || r.action === 'create' || r.action === 'restore')

function parseData(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v !== 'string') return null
  try {
    const p = JSON.parse(v) as unknown
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Link-row writes near these saves, by the same people, on these link tables. */
async function linkOpsNear(
  junctions: string[],
  saves: Array<Pick<FoldSave, 'at' | 'user'>>
): Promise<Array<LinkOp & { junction: string; data: Record<string, unknown> | null }>> {
  if (saves.length === 0 || junctions.length === 0) return []
  const rows = (await db('nivaro_activity as a')
    .leftJoin('nivaro_revisions as r', 'r.activity', 'a.id')
    .whereIn('a.collection', junctions)
    .whereIn('a.action', ['create', 'delete'])
    .where((outer) => {
      for (const s of saves) {
        outer.orWhere((b) => {
          if (s.user) b.where('a.user', s.user)
          else b.whereNull('a.user')
          b.whereBetween('a.timestamp', [new Date(s.at - WINDOW_MS), new Date(s.at + AFTER_MS)])
        })
      }
    })
    .orderBy('a.id', 'asc')
    .limit(5000)
    .select('a.collection', 'a.item', 'a.action', 'a.timestamp', 'a.user', 'r.data')) as Array<
    Record<string, unknown>
  >
  return rows.map((r) => ({
    junction: String(r.collection),
    id: String(r.item),
    op: r.action === 'delete' ? 'remove' : 'add',
    at: time(r.timestamp),
    user: (r.user as string | null) ? String(r.user).toUpperCase() : null,
    data: parseData(r.data)
  }))
}

/**
 * The history with every to-many field folded in (see above). Pure on failure: any read that
 * fails leaves the history as it was.
 */
export async function withLinkHistory(
  collection: string,
  item: string,
  revisions: Revision[]
): Promise<Revision[]> {
  try {
    const fields = await toManyFields(collection)
    if (fields.length === 0) return revisions
    const snapIdx = revisions
      .map((r, index) => ({ r, index }))
      .filter(({ r }) => isSnapshot(r))
      .sort((a, b) => time(b.r.timestamp) - time(a.r.timestamp))
      .slice(0, MAX_SAVES)
    if (snapIdx.length === 0) return revisions
    // Only fields some snapshot did not store need the fold.
    const needed = fields.filter((f) => snapIdx.some(({ r }) => idsOf(r.data?.[f.field]) == null))
    if (needed.length === 0) return revisions
    const userOf = (r: Revision) => (r.user_id ? String(r.user_id).toUpperCase() : null)
    const baseSaves = snapIdx.map(({ r, index }) => ({
      index,
      at: time(r.timestamp),
      user: userOf(r)
    }))
    const [opsAll, currents] = await Promise.all([
      linkOpsNear([...new Set(needed.map((f) => f.junction))], baseSaves),
      Promise.all(
        needed.map((f) =>
          db(f.junction)
            .where(f.parentFk, item)
            .limit(MAX_LINKS)
            .select('id')
            .then((rows) => (rows as Array<{ id: unknown }>).map((x) => String(x.id)))
            .catch(() => null)
        )
      )
    ])
    const out = revisions.map((r) => r)
    needed.forEach((f, i) => {
      const current = currents[i]
      if (current == null) return
      // A link row is this record's when its own snapshot names the record.
      const ops = opsAll.filter(
        (o) => o.junction === f.junction && String(o.data?.[f.parentFk] ?? '') === String(item)
      )
      const saves: FoldSave[] = baseSaves.map((s) => ({
        ...s,
        stored: idsOf(revisions[s.index].data?.[f.field])
      }))
      const folded = foldLinkHistory(saves, ops, current)
      for (const [index, v] of folded) {
        const r = out[index]
        out[index] = {
          ...r,
          data: { ...(r.data ?? {}), [f.field]: v.ids },
          delta: v.changed ? { ...(r.delta ?? {}), [f.field]: v.ids } : r.delta,
          ...(v.changed
            ? {
                link_changes: {
                  ...((r as { link_changes?: Record<string, unknown> }).link_changes ?? {}),
                  [f.field]: { added: v.added, removed: v.removed }
                }
              }
            : {})
        }
      }
    })
    return out
  } catch {
    return revisions
  }
}

/** Every link-row id the folded history names per to-many field (for the label read). */
export function foldedLinkIds(revisions: Revision[], fields: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const r of revisions) {
    for (const f of fields) {
      const ids = idsOf(r.data?.[f])
      if (!ids) continue
      const set = out.get(f) ?? new Set<string>()
      for (const id of ids) if (set.size < MAX_LINKS) set.add(id)
      out.set(f, set)
    }
    const lc = (r as { link_changes?: Record<string, { added: string[]; removed: string[] }> })
      .link_changes
    for (const [f, v] of Object.entries(lc ?? {})) {
      const set = out.get(f) ?? new Set<string>()
      for (const id of [...v.added, ...v.removed]) if (set.size < MAX_LINKS) set.add(id)
      out.set(f, set)
    }
  }
  return out
}
