import { db } from '../db/index.js'
import type { User } from '../types.js'
import type { LabelsRequest } from './activity-readable.js'
import { type ActivityLabels, o2mSentence, valueText } from './activity-sentence.js'
import { can } from './permissions.js'
import { pickFields, readableFieldSet, revisionsForReader } from './revision-fields.js'

/**
 * "Before you move it: this changed since you opened it" (rt3 #14).
 *
 * What OTHER people (and automated writers) changed on one record after `since` — the time the
 * mover's page read the record — as the mover may read it: field changes with their before and
 * after values (field read policy applied, link values named as the reader may see them), line
 * (child row) changes as the History already words them, and files added or removed through a
 * file link table (counted, never named). The client drops what its page already showed (a live
 * refresh after the change) and lists the rest in the move's confirm step.
 *
 * Read-only; one call per move press, never per event.
 */

/** What the client matches its "already on screen" log against. */
export type UnseenScope = 'field' | `lines:${string}` | `files:${string}`

export interface UnseenChange {
  kind: 'field' | 'lines' | 'files'
  scope: UnseenScope
  /** ISO time of the newest change this entry folds in. */
  at: string
  /** Who made it ("Beth Smith", "Beth Smith and 1 other", "An automated process"). */
  by: string
  /** Field name (field changes) — the client never shows it. */
  field?: string
  /** Field label, child collection label or "Files". */
  label: string
  /** Field changes: the value before the first unseen change and the value now. */
  from?: string | null
  to?: string | null
  /** Lines / files: the History's own words ("changed Materials · 110140: Quantity 4 → 5"). */
  text?: string
}

export interface UnseenAnswer {
  since: string
  changes: UnseenChange[]
  /** Entries left out past the cap. */
  more: number
}

/** The furthest back an unseen-changes read looks (a page left open for days). */
export const UNSEEN_LOOKBACK_MS = 7 * 24 * 3600 * 1000

/** The `since` a request may ask for: a valid time, not in the future, at most a week back. */
export function clampSince(raw: unknown, now = Date.now()): Date | null {
  if (typeof raw !== 'string' || !raw) return null
  const t = new Date(raw).getTime()
  if (!Number.isFinite(t)) return null
  return new Date(Math.min(now, Math.max(now - UNSEEN_LOOKBACK_MS, t)))
}

export const UNSEEN_MAX = 12
const SCAN_MAX = 200
const AUTOMATED = 'An automated process'

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase()

function parseJson(v: unknown): Record<string, unknown> | null {
  if (v == null) return null
  if (typeof v === 'object') return v as Record<string, unknown>
  try {
    const p = JSON.parse(String(v))
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a == null || a === '') return b == null || b === ''
  if (b == null || b === '') return false
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  const na = Number(a)
  const nb = Number(b)
  if (typeof a !== 'boolean' && Number.isFinite(na) && Number.isFinite(nb) && String(a).trim())
    return na === nb
  return String(a) === String(b)
}

export interface FieldRevision {
  id: number
  at: Date | string
  user: string | null
  data: Record<string, unknown> | null
  delta: Record<string, unknown> | null
}

export interface FoldedField {
  field: string
  from: unknown
  to: unknown
  at: string
  by: Array<string | null>
}

/**
 * Per field: the value before the FIRST change someone else made after `since` and the value
 * now, with who and when. `before` = the record as it stood at `since` (the newest snapshot at
 * or before it); revisions come oldest first. A field someone changed and changed back is left
 * out — it reads the same as when the page opened. The caller's own changes are never news,
 * but they do move the "now" value.
 */
export function foldFieldChanges(
  before: Record<string, unknown> | null,
  revisions: FieldRevision[],
  callerId: string
): FoldedField[] {
  const state: Record<string, unknown> = { ...(before ?? {}) }
  const out = new Map<string, FoldedField & { first: unknown }>()
  for (const rev of revisions) {
    const delta = rev.delta ?? {}
    const mine = sameId(rev.user, callerId)
    for (const field of Object.keys(delta)) {
      const prev = field in state ? state[field] : (before?.[field] ?? null)
      const next = rev.data && field in rev.data ? rev.data[field] : delta[field]
      if (!mine) {
        const hit = out.get(field)
        const at = new Date(rev.at).toISOString()
        if (hit) {
          hit.at = at
          if (!hit.by.some((b) => (b == null && rev.user == null) || sameId(b, rev.user)))
            hit.by.push(rev.user)
        } else out.set(field, { field, first: prev, from: prev, to: next, at, by: [rev.user] })
      }
      state[field] = next
    }
  }
  const result: FoldedField[] = []
  for (const f of out.values()) {
    const now = state[f.field]
    if (sameValue(f.first, now)) continue
    result.push({ field: f.field, from: f.first, to: now, at: f.at, by: f.by })
  }
  return result.sort((a, z) => (a.at < z.at ? 1 : a.at > z.at ? -1 : 0))
}

/** "Beth Smith", "Beth Smith and Kim Lee", "Beth Smith and 2 others", "An automated process". */
export function byText(ids: Array<string | null>, names: Map<string, string>): string {
  const list = ids.map((id) => (id ? (names.get(id.toLowerCase()) ?? 'Someone') : AUTOMATED))
  const uniq = [...new Set(list)]
  if (uniq.length <= 1) return uniq[0] ?? 'Someone'
  if (uniq.length === 2) return `${uniq[0]} and ${uniq[1]}`
  return `${uniq[0]} and ${uniq.length - 1} others`
}

/** A changed value as the reader sees it; null = empty. Links name the record as the reader may
 *  see it ("a record you can't see" when they cannot), numbers read with grouping. */
export function unseenValueText(
  collection: string,
  field: string,
  value: unknown,
  labels: ActivityLabels
): string | null {
  if (value == null || value === '') return null
  const target = labels.links?.[`${collection}.${field}`]
  if (target) {
    const label = labels.records?.[`${target}:${String(value)}`]
    return label ?? "a record you can't see"
  }
  if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value))) {
    const n = Number(value)
    if (Number.isFinite(n) && !labels.choices?.[`${collection}.${field}`]?.[String(value)])
      return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  return valueText(collection, field, value, labels)
}

interface FileLink {
  junction: string
  parentField: string
  fileField: string
  /** The parent's alias field the link table hangs off (its read policy covers the files). */
  alias: string | null
}

const FILE_TABLES = new Set(['nivaro_files', 'directus_files'])

/** The link tables that attach files to records of `collection`. */
async function fileLinksOf(collection: string): Promise<FileLink[]> {
  const { getRelations } = await import('./collections.js')
  const rels = (await getRelations(collection).catch(() => [])) as Array<{
    many_collection: string
    many_field: string
    one_collection: string | null
    one_field?: string | null
    junction_field?: string | null
  }>
  const out: FileLink[] = []
  for (const r of rels) {
    if (r.one_collection !== collection || !r.junction_field) continue
    const other = rels.find(
      (x) => x.many_collection === r.many_collection && x.many_field === r.junction_field
    )
    let target = other?.one_collection ?? null
    if (!target) {
      const theirs = (await getRelations(r.many_collection).catch(() => [])) as typeof rels
      target =
        theirs.find(
          (x) => x.many_collection === r.many_collection && x.many_field === r.junction_field
        )?.one_collection ?? null
    }
    if (target && FILE_TABLES.has(target))
      out.push({
        junction: r.many_collection,
        parentField: r.many_field,
        fileField: r.junction_field,
        alias: r.one_field ?? null
      })
  }
  return out
}

export interface UnseenDeps {
  labels(user: User, req: LabelsRequest, isAdmin: boolean): Promise<ActivityLabels>
}

const defaultDeps: UnseenDeps = {
  async labels(user, req, isAdmin) {
    const { activityLabelsFor } = await import('./activity-readable.js')
    return activityLabelsFor(user, req, { isAdmin })
  }
}

/**
 * The unseen-change answer for one record. The ROUTE has already judged the record as the
 * caller (recordVisibleTo); everything here is cut to what they may read.
 */
export async function recordChangesSince(
  user: User,
  isAdmin: boolean,
  collection: string,
  item: string,
  since: Date,
  /** `fieldsSince`: when the page last re-read the record's own fields (a live refresh) — the
   *  fields on screen are as of then, so field changes count from there (lines and files keep
   *  `since`, the page's first read: their grids refresh on their own). */
  opts: { fieldsSince?: Date | null } = {},
  deps: UnseenDeps = defaultDeps
): Promise<UnseenAnswer> {
  const callerId = String(user.id)
  const fieldSince =
    opts.fieldsSince && opts.fieldsSince.getTime() > since.getTime() ? opts.fieldsSince : since
  const [revRows, beforeRow, o2mRows, links] = await Promise.all([
    db('nivaro_revisions as r')
      .join('nivaro_activity as a', 'r.activity', 'a.id')
      .where('r.collection', collection)
      .where('r.item', item)
      .whereIn('a.action', ['create', 'update'])
      .where('a.timestamp', '>', fieldSince)
      .orderBy('r.id', 'asc')
      .limit(SCAN_MAX)
      .select('r.id', 'r.data', 'r.delta', 'a.timestamp', 'a.user') as Promise<
      Array<Record<string, unknown>>
    >,
    db('nivaro_revisions as r')
      .join('nivaro_activity as a', 'r.activity', 'a.id')
      .where('r.collection', collection)
      .where('r.item', item)
      .where('a.timestamp', '<=', fieldSince)
      .orderBy('r.id', 'desc')
      .first('r.data') as Promise<{ data?: unknown } | undefined>,
    db('nivaro_activity')
      .where({ collection, item })
      .whereIn('action', ['o2m-create', 'o2m-update', 'o2m-delete'])
      .where('timestamp', '>', since)
      .where((b) => b.whereNull('user').orWhereNot('user', callerId))
      .orderBy('id', 'desc')
      .limit(50)
      .select('id', 'action', 'comment', 'timestamp', 'user') as Promise<
      Array<Record<string, unknown>>
    >,
    fileLinksOf(collection)
  ])

  // ── Fields, cut to the reader's field list ──────────────────────────────
  const readable = await readableFieldSet(user, collection)
  const revisions: FieldRevision[] = revRows.map((r) => ({
    id: Number(r.id),
    at: r.timestamp as Date,
    user: r.user == null ? null : String(r.user),
    data: pickFields(parseJson(r.data), readable),
    delta: pickFields(parseJson(r.delta), readable)
  }))
  const folded = foldFieldChanges(
    pickFields(parseJson(beforeRow?.data), readable),
    revisions,
    callerId
  ).filter((f) => f.field !== 'id' && !/^(date|user)_(created|updated)$/.test(f.field))

  // ── Lines: the History's own reader-cut summaries ───────────────────────
  const o2m = await revisionsForReader(
    user,
    collection,
    o2mRows.map((r) => ({ action: r.action as string, comment: r.comment as string | null }))
  ).catch(() => [])

  // ── Files added / removed through a link table ──────────────────────────
  const fileEvents: Array<{
    junction: string
    added: number
    removed: number
    at: string
    by: Array<string | null>
  }> = []
  for (const link of links) {
    if (readable && link.alias && !readable.has(link.alias)) continue
    if (!isAdmin && !(await can(user, 'read', link.junction).catch(() => false))) continue
    const rows = (await db('nivaro_activity as a')
      .leftJoin('nivaro_revisions as r', 'r.activity', 'a.id')
      .where('a.collection', link.junction)
      .whereIn('a.action', ['create', 'delete'])
      .where('a.timestamp', '>', since)
      .where((b) => b.whereNull('a.user').orWhereNot('a.user', callerId))
      .orderBy('a.id', 'desc')
      .limit(SCAN_MAX)
      .select('a.action', 'a.timestamp', 'a.user', 'r.data')
      .catch(() => [])) as Array<Record<string, unknown>>
    const mine = rows.filter((r) => sameId(parseJson(r.data)?.[link.parentField], item))
    if (mine.length === 0) continue
    const ev = {
      junction: link.junction,
      added: 0,
      removed: 0,
      at: '',
      by: [] as Array<string | null>
    }
    for (const r of mine) {
      if (r.action === 'create') ev.added++
      else ev.removed++
      const at = new Date(r.timestamp as string).toISOString()
      if (at > ev.at) ev.at = at
      const u = r.user == null ? null : String(r.user)
      if (!ev.by.some((b) => (b == null && u == null) || sameId(b, u))) ev.by.push(u)
    }
    fileEvents.push(ev)
  }

  // ── Words, as the reader ────────────────────────────────────────────────
  const people = new Set<string>()
  for (const f of folded) for (const b of f.by) if (b) people.add(b)
  for (const r of o2mRows) if (r.user) people.add(String(r.user))
  for (const e of fileEvents) for (const b of e.by) if (b) people.add(b)
  const refs: Array<{ collection: string; id: string }> = []
  const labels = await deps
    .labels(
      user,
      {
        refs,
        users: [...people],
        fields: folded.map((f) => ({ collection, field: f.field })),
        collections: [collection]
      },
      isAdmin
    )
    .catch(() => ({}) as ActivityLabels)
  // Link values: a second pass names the linked records (only now are the targets known).
  const linkRefs: Array<{ collection: string; id: string }> = []
  for (const f of folded) {
    const target = labels.links?.[`${collection}.${f.field}`]
    if (!target) continue
    for (const v of [f.from, f.to])
      if (v != null && v !== '' && typeof v !== 'object')
        linkRefs.push({ collection: target, id: String(v) })
  }
  if (linkRefs.length > 0) {
    const more = await deps
      .labels(user, { refs: linkRefs, users: [], fields: [], collections: [] }, isAdmin)
      .catch(() => ({}) as ActivityLabels)
    labels.records = { ...(labels.records ?? {}), ...(more.records ?? {}) }
  }
  const names = new Map<string, string>()
  for (const [id, name] of Object.entries(labels.users ?? {})) names.set(id.toLowerCase(), name)

  const changes: UnseenChange[] = []
  for (const f of folded) {
    changes.push({
      kind: 'field',
      scope: 'field',
      field: f.field,
      at: f.at,
      by: byText(f.by, names),
      label:
        labels.fields?.[`${collection}.${f.field}`] ||
        f.field.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
      from: unseenValueText(collection, f.field, f.from, labels),
      to: unseenValueText(collection, f.field, f.to, labels)
    })
  }
  o2m.forEach((rev, i) => {
    const summary = rev.o2m
    const row = o2mRows[i]
    if (!summary) return
    const child = summary.collection || 'rows'
    changes.push({
      kind: 'lines',
      scope: `lines:${child}`,
      at: new Date(row.timestamp as string).toISOString(),
      by: byText([row.user == null ? null : String(row.user)], names),
      label: summary.collection_label,
      text: o2mSentence(summary)
    })
  })
  for (const e of fileEvents) {
    const parts: string[] = []
    if (e.added) parts.push(`added ${e.added === 1 ? 'a file' : `${e.added} files`}`)
    if (e.removed) parts.push(`removed ${e.removed === 1 ? 'a file' : `${e.removed} files`}`)
    changes.push({
      kind: 'files',
      scope: `files:${e.junction}`,
      at: e.at,
      by: byText(e.by, names),
      label: 'Files',
      text: parts.join(' and ')
    })
  }
  changes.sort((a, z) => (a.at < z.at ? 1 : a.at > z.at ? -1 : 0))
  return {
    since: since.toISOString(),
    changes: changes.slice(0, UNSEEN_MAX),
    more: Math.max(0, changes.length - UNSEEN_MAX)
  }
}
