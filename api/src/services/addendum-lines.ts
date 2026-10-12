import { db } from '../db/index.js'
import type { User } from '../types.js'

/**
 * An addendum's proposed CHILD ROWS (an O2M alias in `data`, e.g. a
 * workflow's lines) — applied on approval, kept as a before/after picture.
 *
 * The create form pre-fills every current line, so `data[alias]` is the WHOLE
 * proposed set: rows with a known id are kept or changed, rows without one are
 * new, and a row that was there when the draft was made but is missing from
 * the proposal is removed. What the author changed is read against the lines
 * AS THEY WERE WHEN THE DRAFT WAS MADE (`base`, stored at create), never
 * against the lines at approval time — a PO import that moved an amount in
 * between must not be overwritten by the stale pre-filled figure.
 *
 * Everything lives in nivaro_addendums.revert_snapshot (server-only, never
 * serialized by the addendum API):
 *   { base: { [alias]: LineSet } }                   — written on create
 *   { o2m: { [alias]: AppliedLines }, ...others }   — written on approval
 *   { o2m: …, import: true }                          — a converted legacy row
 *                                                       (display only, no revert)
 */

type Row = Record<string, unknown>

export interface LineSet {
  collection: string
  fk: string
  rows: Row[]
}

export interface AppliedLines extends LineSet {
  /** Lines before approval (full rows). `rows` are the lines after it. */
  before: Row[]
  created?: Array<string | number>
  updated?: Array<{ id: string | number; prior: Row }>
  deleted?: Row[]
}

export interface LineOps {
  creates: Row[]
  updates: Array<{ id: string | number; patch: Row; prior: Row }>
  deletes: Row[]
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const NEVER_WRITTEN = new Set([
  'id',
  'created',
  'changed',
  'creator',
  'created_at',
  'updated_at',
  'user_created',
  'user_updated',
  'date_created',
  'date_updated',
  'sort'
])

/** The create form pre-fills at most this many lines (InlineTableField O2M_ROW_LIMIT). */
export const PREFILL_LIMIT = 1000

const isBlank = (v: unknown) => v === null || v === undefined || v === ''
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/

/**
 * Value equality across the two shapes a line arrives in: the API's JSON
 * (dates as strings, decimals possibly as strings) and a raw knex read (Date,
 * number, boolean). Anything this calls "different" becomes a WRITE, so it
 * errs on the side of equal.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (isBlank(a) && isBlank(b)) return true
  if (isBlank(a) || isBlank(b)) return false
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const t = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
    return t(a) === t(b)
  }
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : Date.parse(String(a))
    const tb = b instanceof Date ? b.getTime() : Date.parse(String(b))
    return Number.isFinite(ta) && ta === tb
  }
  if (typeof a === 'object' || typeof b === 'object') {
    const s = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))
    return s(a) === s(b)
  }
  const sa = String(a).trim()
  const sb = String(b).trim()
  if (sa !== '' && sb !== '' && Number.isFinite(Number(sa)) && Number.isFinite(Number(sb)))
    return Math.abs(Number(sa) - Number(sb)) < 0.005
  if (ISO_DATE.test(sa) && ISO_DATE.test(sb)) {
    const ta = Date.parse(sa)
    const tb = Date.parse(sb)
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta === tb
  }
  return sa === sb
}

/**
 * What approving the proposal does to the lines — pure.
 *  - a proposed row whose id is a current line: patch the columns the author
 *    changed against `base` (else against current), skipping no-ops;
 *  - a proposed row whose id was in `base` but is gone now: left gone;
 *  - a proposed row with no id / an unknown id: created;
 *  - a `base` line missing from the proposal and still present: deleted
 *    (never when the reference reaches the pre-fill cap).
 * `writable` is the set of real, writable columns of the child table.
 */
export function planLineOps(
  proposed: Row[],
  current: Row[],
  base: Row[] | null,
  fk: string,
  writable: Set<string>
): LineOps {
  const key = (v: unknown) => (isBlank(v) ? null : String(v))
  const currentById = new Map(current.map((r) => [key(r.id), r]))
  const reference = base ?? current
  const refById = new Map(reference.map((r) => [key(r.id), r]))
  const canWrite = (k: string) =>
    writable.has(k) &&
    k !== fk &&
    !NEVER_WRITTEN.has(k) &&
    IDENT_RE.test(k) &&
    !k.startsWith('_') &&
    !k.includes('.')

  const ops: LineOps = { creates: [], updates: [], deletes: [] }
  const proposedIds = new Set<string>()
  for (const row of proposed) {
    const id = key(row.id)
    if (id) proposedIds.add(id)
    const cur = id ? currentById.get(id) : undefined
    if (cur) {
      const ref = refById.get(id) ?? cur
      const patch: Row = {}
      const prior: Row = {}
      for (const [k, v] of Object.entries(row)) {
        if (!canWrite(k)) continue
        if (sameValue(v, ref[k])) continue // the author did not change it
        if (sameValue(v, cur[k])) continue // already so
        patch[k] = v
        prior[k] = cur[k] ?? null
      }
      if (Object.keys(patch).length > 0) ops.updates.push({ id: cur.id as string, patch, prior })
      continue
    }
    if (id && refById.has(id)) continue // removed since the draft — never resurrect
    const create: Row = {}
    for (const [k, v] of Object.entries(row)) if (canWrite(k)) create[k] = v
    ops.creates.push(create)
  }
  // A proposal pre-filled from a capped read may simply not carry the lines
  // past the cap — never read their absence as "remove".
  if (reference.length >= PREFILL_LIMIT) return ops
  for (const r of reference) {
    const id = key(r.id)
    if (!id || proposedIds.has(id)) continue
    const cur = currentById.get(id)
    if (cur) ops.deletes.push(cur)
  }
  return ops
}

/** The plain O2M children an addendum's data proposes — system tables never qualify. */
export async function addendumLineLinks(
  parentCollection: string,
  data: Row | null | undefined
): Promise<Array<{ alias: string; collection: string; fk: string }>> {
  const aliases = Object.entries(data ?? {})
    .filter(([k, v]) => Array.isArray(v) && IDENT_RE.test(k))
    .map(([k]) => k)
  if (aliases.length === 0) return []
  const rels = (await db('nivaro_relations')
    .where({ one_collection: parentCollection })
    .whereIn('one_field', aliases)
    .whereNull('junction_field')
    .select('one_field', 'many_collection', 'many_field')) as Array<{
    one_field: string
    many_collection: string | null
    many_field: string | null
  }>
  return rels
    .filter(
      (r) =>
        r.many_collection &&
        r.many_field &&
        IDENT_RE.test(r.many_collection) &&
        IDENT_RE.test(r.many_field) &&
        !/^(nivaro|directus)_/i.test(r.many_collection)
    )
    .map((r) => ({ alias: r.one_field, collection: r.many_collection!, fk: r.many_field! }))
}

async function readLines(collection: string, fk: string, parentId: string): Promise<Row[]> {
  const q = db(collection).where(fk, parentId)
  const cols = await db(collection)
    .columnInfo()
    .catch(() => ({}))
  if ('line_number' in cols) q.orderBy('line_number')
  else if ('sort' in cols) q.orderBy('sort')
  return (await q.orderBy('id').select('*')) as Row[]
}

/** The lines as they are now, per proposed alias — the `base` an approval diffs against. */
export async function snapshotAddendumBase(
  parentCollection: string,
  parentId: string,
  data: Row | null | undefined
): Promise<Record<string, LineSet>> {
  const out: Record<string, LineSet> = {}
  for (const l of await addendumLineLinks(parentCollection, data)) {
    out[l.alias] = {
      collection: l.collection,
      fk: l.fk,
      rows: await readLines(l.collection, l.fk, parentId)
    }
  }
  return out
}

async function isAdminUser(user: User): Promise<boolean> {
  if (!user.role) return false
  const r = (await db('nivaro_roles').where({ id: user.role }).first('admin_access')) as
    | { admin_access?: boolean | number | null }
    | undefined
  return !!r?.admin_access
}

/**
 * The line ids (of those given) this person can SEE (row filter + User
 * Scopes) and, for a write action, may also write under that action's row
 * filter — what the items service would let them do to that row.
 */
async function permittedIds(
  user: User,
  collection: string,
  ids: string[],
  action: 'update' | 'delete' | null
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const admin = await isAdminUser(user)
  const { compileAccessGates, visibleIds } = await import('./record-access.js')
  const gates = await compileAccessGates(user, collection, { actingAdmin: admin })
  let ok = await visibleIds(gates, ids)
  if (admin || !action || ok.size === 0) return ok
  const { applyRowFilter, getRowFilter } = await import('./permissions.js')
  const rf = await getRowFilter(user, action, collection)
  if (rf && rf.length > 0) {
    const pass = new Set<string>()
    const list = [...ok]
    for (let i = 0; i < list.length; i += 1000) {
      const q = db(collection).whereIn(`${collection}.id`, list.slice(i, i + 1000))
      applyRowFilter(q, rf, user)
      for (const r of (await q.select(`${collection}.id`)) as Array<{ id: unknown }>)
        pass.add(String(r.id))
    }
    ok = pass
  }
  // Tree permissions: an explicit deny on the line (or its nearest ancestor)
  // blocks it, exactly as items.ts does for the person's own write.
  const { getTreePermission } = await import('./tree-permissions.js')
  for (const id of [...ok]) {
    if ((await getTreePermission(user, action, collection, id)) === false) ok.delete(id)
  }
  return ok
}

/**
 * Apply the proposed lines AS THE APPROVER through the items service, so
 * revisions, hooks and stored rollups (the parent's requisition amount) fire.
 * Returns what to keep in the snapshot (before/after + the ops for revert).
 */
export async function applyAddendumLines(
  approver: User,
  parentCollection: string,
  parentId: string,
  data: Row,
  allowedKeys: Set<string>,
  base: Record<string, LineSet> | null,
  /** Who wrote the proposal. A change applies only when BOTH sides hold:
   *  the AUTHOR could have made it themselves (create / update / delete
   *  rights, that action's row filter, User Scopes, allowed columns — so
   *  approval never escalates a proposal), and the APPROVER can see it (a
   *  readable row, readable columns — approving never writes what the
   *  reviewer was not shown). Anything else is reported failed, not applied.
   *  Null author = nothing applies. */
  author: User | null
): Promise<{ o2m: Record<string, AppliedLines>; applied: number; failed: number }> {
  const { createOne, updateOne, deleteOne } = await import('./items.js')
  const { can, getAllowedFields } = await import('./permissions.js')
  const capTo = (cols: Set<string>, allowed: string[] | null) =>
    allowed === null ? cols : new Set([...cols].filter((c) => allowed.includes(c)))
  const o2m: Record<string, AppliedLines> = {}
  let applied = 0
  let failed = 0
  for (const l of await addendumLineLinks(parentCollection, data)) {
    if (!allowedKeys.has(l.alias)) continue
    const proposed = (data[l.alias] as unknown[]).filter(
      (r): r is Row => !!r && typeof r === 'object'
    )
    const before = await readLines(l.collection, l.fk, parentId)
    const baseRows = base?.[l.alias]?.collection === l.collection ? base[l.alias].rows : null
    const columns = new Set(Object.keys(await db(l.collection).columnInfo()))
    const authorMay = async (action: 'create' | 'update' | 'delete') =>
      !!author && (await can(author, action, l.collection))
    const [mayCreate, mayUpdate, mayDelete] = await Promise.all([
      authorMay('create'),
      authorMay('update'),
      authorMay('delete')
    ])
    const updatable = mayUpdate
      ? capTo(columns, await getAllowedFields(author!, 'update', l.collection))
      : new Set<string>()
    const creatable = mayCreate
      ? capTo(columns, await getAllowedFields(author!, 'create', l.collection))
      : new Set<string>()
    // Never through a proposal: ownership / tenancy / credential columns
    // (items.ts would force a non-admin's workspace; nothing runs as the
    // author here) and the fields the AUTHOR's role has section-locked.
    const { PARENT_WRITE_BLOCKED_COLUMNS } = await import('./addendum-approve.js')
    const locked =
      author && !(await isAdminUser(author))
        ? await (await import('./section-locks.js')).sectionLockedFields(
            l.collection,
            author.role as string | null
          )
        : new Set<string>()
    for (const set of [updatable, creatable])
      for (const c of [...set])
        if (PARENT_WRITE_BLOCKED_COLUMNS.has(c) || locked.has(c)) set.delete(c)
    // What the approver was shown: readable columns (ids always pair rows).
    const approverCols = capTo(columns, await getAllowedFields(approver, 'read', l.collection))
    // Plan against every real column, then cap each op (see `author` above).
    const ops = planLineOps(proposed, before, baseRows, l.fk, columns)
    const touched = [
      ...new Set([...ops.updates.map((u) => String(u.id)), ...ops.deletes.map((d) => String(d.id))])
    ]
    const [authorUpd, authorDel, approverSees] = await Promise.all([
      mayUpdate
        ? permittedIds(author!, l.collection, touched, 'update')
        : Promise.resolve(new Set<string>()),
      mayDelete
        ? permittedIds(author!, l.collection, touched, 'delete')
        : Promise.resolve(new Set<string>()),
      permittedIds(approver, l.collection, touched, null)
    ])
    const capped: LineOps['updates'] = []
    for (const u of ops.updates) {
      if (!authorUpd.has(String(u.id)) || !approverSees.has(String(u.id))) {
        failed++
        continue
      }
      const keys = Object.keys(u.patch).filter((k) => updatable.has(k) && approverCols.has(k))
      if (keys.length < Object.keys(u.patch).length) failed++
      if (keys.length === 0) continue
      capped.push({
        id: u.id,
        patch: Object.fromEntries(keys.map((k) => [k, u.patch[k]])),
        prior: Object.fromEntries(keys.map((k) => [k, u.prior[k]]))
      })
    }
    ops.updates = capped
    if (mayCreate) {
      ops.creates = ops.creates.map((c) => {
        const keep = Object.entries(c).filter(([k]) => creatable.has(k) && approverCols.has(k))
        if (keep.length < Object.keys(c).length) failed++
        return Object.fromEntries(keep)
      })
    } else {
      failed += ops.creates.length
      ops.creates = []
    }
    const allowedDeletes = ops.deletes.filter(
      (d) => authorDel.has(String(d.id)) && approverSees.has(String(d.id))
    )
    failed += ops.deletes.length - allowedDeletes.length
    ops.deletes = allowedDeletes
    const done: AppliedLines = {
      ...l,
      before,
      rows: [],
      created: [],
      updated: [],
      deleted: []
    }
    for (const u of ops.updates) {
      try {
        await updateOne(approver, l.collection, u.id, u.patch)
        done.updated!.push({ id: u.id, prior: u.prior })
        applied++
      } catch {
        failed++
      }
    }
    for (const c of ops.creates) {
      try {
        const created = (await createOne(approver, l.collection, {
          ...c,
          [l.fk]: parentId
        })) as unknown
        const id =
          created && typeof created === 'object' ? (created as Row).id : (created as unknown)
        if (id != null) done.created!.push(id as string | number)
        applied++
      } catch {
        failed++
      }
    }
    for (const d of ops.deletes) {
      try {
        await deleteOne(approver, l.collection, d.id as string | number)
        done.deleted!.push(d)
        applied++
      } catch {
        failed++
      }
    }
    done.rows = await readLines(l.collection, l.fk, parentId)
    o2m[l.alias] = done
  }
  return { o2m, applied, failed }
}

/** Undo an approval's line ops: created rows deleted, patched cells restored, deleted rows re-created. */
export async function revertAddendumLines(
  actor: User,
  parentId: string,
  o2m: Record<string, AppliedLines>
): Promise<{ applied: number; failed: number }> {
  const { createOne, updateOne, deleteOne } = await import('./items.js')
  let applied = 0
  let failed = 0
  for (const l of Object.values(o2m)) {
    if (!IDENT_RE.test(l.collection) || !IDENT_RE.test(l.fk)) continue
    if (/^(nivaro|directus)_/i.test(l.collection)) continue
    const writable = new Set(Object.keys(await db(l.collection).columnInfo()))
    const owns = async (id: string | number) => {
      const r = (await db(l.collection).where({ id }).first(l.fk)) as Row | undefined
      return !!r && String(r[l.fk]) === String(parentId)
    }
    for (const id of l.created ?? []) {
      try {
        if (!(await owns(id))) continue
        await deleteOne(actor, l.collection, id)
        applied++
      } catch {
        failed++
      }
    }
    for (const u of l.updated ?? []) {
      try {
        if (!(await owns(u.id))) continue
        const patch = Object.fromEntries(
          Object.entries(u.prior).filter(([k]) => writable.has(k) && k !== l.fk && k !== 'id')
        )
        if (Object.keys(patch).length > 0) await updateOne(actor, l.collection, u.id, patch)
        applied++
      } catch {
        failed++
      }
    }
    for (const d of l.deleted ?? []) {
      try {
        const row = Object.fromEntries(
          Object.entries(d).filter(([k]) => writable.has(k) && !NEVER_WRITTEN.has(k) && k !== l.fk)
        )
        await createOne(actor, l.collection, { ...row, [l.fk]: parentId })
        applied++
      } catch {
        failed++
      }
    }
  }
  return { applied, failed }
}

/** Keep only the columns a reader may read (null = all). Ids stay so rows pair up. */
export function projectRows(rows: Row[], allowed: string[] | null): Row[] {
  if (allowed === null) return rows
  const keep = new Set([...allowed, 'id'])
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k))))
}

/**
 * An addendum's `data` as one reader may see it: proposed parent fields
 * limited to the reader's readable columns of the parent; each proposed line
 * set limited to lines their row filter / User Scopes allow (an id-less row
 * is a new line — the author's own text) and to their readable columns of
 * the line collection; nothing at all for a line collection they cannot read.
 */
export async function redactAddendumData(
  user: User,
  isAdmin: boolean,
  parentCollection: string,
  data: Row | null
): Promise<Row | null> {
  if (!data || typeof data !== 'object' || isAdmin) return data
  const { can, getAllowedFields } = await import('./permissions.js')
  const { compileAccessGates, visibleIds } = await import('./record-access.js')
  const links = new Map((await addendumLineLinks(parentCollection, data)).map((l) => [l.alias, l]))
  const parentCols = await getAllowedFields(user, 'read', parentCollection)
  const out: Row = {}
  for (const [k, v] of Object.entries(data)) {
    const link = links.get(k)
    if (!link) {
      if (Array.isArray(v)) continue // a relation set we cannot place — never leak it
      if (parentCols === null || parentCols.includes(k)) out[k] = v
      continue
    }
    if (!(await can(user, 'read', link.collection))) {
      out[k] = []
      continue
    }
    const rows = (v as unknown[]).filter((r): r is Row => !!r && typeof r === 'object')
    const gates = await compileAccessGates(user, link.collection)
    const ids = rows
      .map((r) => r.id)
      .filter((x) => !isBlank(x))
      .map(String)
    const visible = await visibleIds(gates, [...new Set(ids)])
    const allowed = await getAllowedFields(user, 'read', link.collection)
    out[k] = projectRows(
      rows.filter((r) => isBlank(r.id) || visible.has(String(r.id))),
      allowed
    )
  }
  return out
}
