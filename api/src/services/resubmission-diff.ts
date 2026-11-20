import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { jsonValue } from '../db/sql-dialect.js'
import type { User } from '../types.js'
import { linkLabelKey, linkLabelsAsUser } from './ai-link-labels.js'
import { isDerivedField } from './approval-brief.js'
import { selectInChunks } from './db-batch.js'
import { readableFileIdList } from './file-access.js'
import { getAllowedFields } from './permissions.js'
import { compileAccessGates, visibleIds } from './record-access.js'

/**
 * "What changed since you sent it back" (realtime round 8, item 12).
 *
 * A record an approver sent back comes back to the same step: the approver should not have to
 * dig through History to see what the requester did about it. This answers, for the step the
 * record is in NOW, what changed between the latest send back FROM that step and now:
 *
 *   - fields  — old → new per field, who changed it last and when;
 *   - lines   — child rows (one-to-many) added, changed (which fields) or removed;
 *   - files   — a file field's file swapped, or a file linked to / taken off the record.
 *
 * Everything is judged AS THE VIEWER: the route checks the record itself (recordReadGate); here
 * a field counts only when the viewer may read it (getAllowedFields), a line only when the
 * viewer may read its collection and that row (compileAccessGates + visibleIds — a removed line
 * is named only when no row rule applies, otherwise it is just counted), a linked record's label
 * comes from linkLabelsAsUser and a file's name only for files the viewer may open
 * (file-access.ts readableFileIdList). Values are short display strings, never raw blobs.
 *
 * Cost: one read of the instance + its history (capped), the record's in-window revisions, the
 * pre-window snapshot, and per child collection (≤ MAX_CHILD_RELS) one id read + one activity
 * read + one delete read. Only on demand (the strip / the approve dialog), never per event.
 */

const MAX_HISTORY = 400
const MAX_CHILD_RELS = 6
const MAX_CHILD_IDS = 500
const MAX_CHILD_ROWS = 400
const MAX_FIELDS = 25
const MAX_LINES_PER_REL = 12
const FILES = 'nivaro_files'
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const IGNORED = new Set([
  'date_updated',
  'user_updated',
  'date_created',
  'user_created',
  'changed',
  'last_state_change',
  'sort'
])
const SECRET = /pass(word)?|secret|token|api_?key|totp|hash|salt/i

// ── Types ────────────────────────────────────────────────────────────────────

export interface HistRow {
  id: string | number
  from_state: string | null
  to_state: string
  user: string | null
  comment: string | null
  timestamp: Date | string
}

export interface StateRow {
  id: string
  sort: number | null
  label: string | null
  is_terminal?: unknown
}

export interface ResubWindow {
  sentBack: HistRow
  returned: HistRow
}

export interface ResubFieldChange {
  field: string
  label: string
  old: string
  new: string
  by: string | null
  at: string
  auto?: boolean
  /** How the client formats old/new (rt8 review r2): dates and date-times arrive as their
   *  stored ISO text and numbers as plain figures, so the viewer's own formatters (time zone,
   *  the field's currency + precision) render them like the form does. Absent = plain text. */
  kind?: 'date' | 'datetime' | 'number'
  format?: string | null
  precision?: number | null
}

export interface ResubLineItem {
  id: string
  label: string
  kind: 'added' | 'changed' | 'removed'
  /** Labels of the readable fields that changed on a changed line. */
  fields: string[]
  by: string | null
  at: string
}

export interface ResubLineGroup {
  collection: string
  /** The record's field holding these lines ("Lines", "Forecasts"). */
  field: string
  label: string
  added: number
  changed: number
  removed: number
  items: ResubLineItem[]
}

export interface ResubFileChange {
  /** The field / link the file sits in. */
  field: string
  field_label: string
  kind: 'added' | 'removed' | 'replaced'
  /** Readable file names; "a file" when the viewer may not open it. */
  name: string
  old_name?: string | null
  by: string | null
  at: string
}

export interface ResubmissionDiff {
  sent_back: {
    by: string | null
    by_you: boolean
    at: string
    from_label: string | null
    to_label: string | null
    reason: string | null
  }
  returned: { by: string | null; at: string }
  fields: ResubFieldChange[]
  lines: ResubLineGroup[]
  files: ResubFileChange[]
  /** fields + line items + files the viewer may see. */
  total: number
}

// ── Pure parts ───────────────────────────────────────────────────────────────

const up = (v: unknown) => String(v ?? '').toUpperCase()
const ms = (t: Date | string) => new Date(t).getTime()
const bit = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

/**
 * The window to describe, or null when the record is not back after a send back.
 *
 * The record sits in `currentStateId`. Its latest entry into that step must come AFTER a send
 * back FROM that step (a move to a step that sorts before it, never a finished one). The latest
 * such send back opens the window; the current entry is the return.
 */
export function resubmissionWindow(
  history: HistRow[],
  states: StateRow[],
  currentStateId: string | null | undefined
): ResubWindow | null {
  if (!currentStateId) return null
  const cur = up(currentStateId)
  const byId = new Map(states.map((s) => [up(s.id), s]))
  const curSort = byId.get(cur)?.sort
  if (curSort == null) return null
  const rows = [...history].sort((a, b) => ms(a.timestamp) - ms(b.timestamp) || 0)
  let entry = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (up(rows[i].to_state) === cur) {
      entry = i
      break
    }
  }
  if (entry < 0) return null
  for (let j = entry - 1; j >= 0; j--) {
    const h = rows[j]
    if (up(h.from_state) !== cur) continue
    const to = byId.get(up(h.to_state))
    if (!to || to.sort == null || bit(to.is_terminal)) continue
    if (Number(to.sort) < Number(curSort)) return { sentBack: h, returned: rows[entry] }
  }
  return null
}

export function parseObj(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === 'object') return Array.isArray(raw) ? null : (raw as Record<string, unknown>)
  try {
    const v = JSON.parse(String(raw))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** A short display string for one stored value. */
export function shortValue(v: unknown): string {
  if (v == null || v === '') return '(empty)'
  if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80)
  return String(v)
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

const titleCase = (s: string) => s.replace(/_+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export interface Rev {
  delta: unknown
  user: string | null
  timestamp: Date | string
}

/**
 * Field keys changed in the window → last value, last editor and time. `allowed` = the
 * viewer's readable fields (null = all). Exported for tests.
 */
export function changedFields(
  revs: Rev[],
  allowed: string[] | null
): Map<string, { value: unknown; by: string | null; at: string }> {
  const out = new Map<string, { value: unknown; by: string | null; at: string }>()
  const canRead = (f: string) => allowed == null || allowed.includes(f)
  for (const r of [...revs].sort((a, b) => ms(a.timestamp) - ms(b.timestamp))) {
    const d = parseObj(r.delta)
    if (!d) continue
    for (const [k, v] of Object.entries(d)) {
      if (IGNORED.has(k) || k.startsWith('_') || k.startsWith('$') || SECRET.test(k)) continue
      if (!canRead(k)) continue
      out.set(k, { value: v, by: r.user, at: new Date(r.timestamp).toISOString() })
    }
  }
  return out
}

export interface ChildEvent {
  item: string
  action: 'create' | 'update' | 'delete'
  delta: unknown
  data: unknown
  user: string | null
  timestamp: Date | string
}

/**
 * One child collection's in-window events → added / changed / removed rows (a row added and
 * removed inside the window says nothing). `allowed` = the viewer's readable child fields.
 * Exported for tests.
 */
export function lineChanges(
  events: ChildEvent[],
  allowed: string[] | null,
  fkField: string
): Array<{
  id: string
  kind: 'added' | 'changed' | 'removed'
  fields: string[]
  by: string | null
  at: string
  snapshot: Record<string, unknown> | null
}> {
  const byId = new Map<
    string,
    {
      created: boolean
      deleted: boolean
      fields: Set<string>
      by: string | null
      at: string
      snapshot: Record<string, unknown> | null
    }
  >()
  const canRead = (f: string) => allowed == null || allowed.includes(f)
  for (const e of [...events].sort((a, b) => ms(a.timestamp) - ms(b.timestamp))) {
    const cur = byId.get(e.item) ?? {
      created: false,
      deleted: false,
      fields: new Set<string>(),
      by: null,
      at: '',
      snapshot: null
    }
    if (e.action === 'create') cur.created = true
    if (e.action === 'delete') {
      cur.deleted = true
      cur.snapshot = parseObj(e.data)
    }
    if (e.action === 'update') {
      for (const k of Object.keys(parseObj(e.delta) ?? {})) {
        if (IGNORED.has(k) || k === fkField || k.startsWith('_') || SECRET.test(k)) continue
        if (canRead(k)) cur.fields.add(k)
      }
    }
    cur.by = e.user
    cur.at = new Date(e.timestamp).toISOString()
    byId.set(e.item, cur)
  }
  const out: ReturnType<typeof lineChanges> = []
  for (const [id, c] of byId) {
    if (c.created && c.deleted) continue
    if (c.deleted)
      out.push({ id, kind: 'removed', fields: [], by: c.by, at: c.at, snapshot: c.snapshot })
    else if (c.created)
      out.push({ id, kind: 'added', fields: [], by: c.by, at: c.at, snapshot: null })
    else if (c.fields.size > 0)
      out.push({ id, kind: 'changed', fields: [...c.fields], by: c.by, at: c.at, snapshot: null })
  }
  return out.sort((a, b) => ms(b.at) - ms(a.at))
}

/** A removed row's label from its snapshot: the display template's readable plain fields. */
export function snapshotLabel(
  snapshot: Record<string, unknown> | null,
  template: string | null,
  allowed: string[] | null
): string | null {
  if (!snapshot) return null
  const canRead = (f: string) => allowed == null || allowed.includes(f)
  if (template) {
    let used = false
    const text = template
      .replace(/\{\{\s*([\w]+)\s*\}\}/g, (_m, f: string) => {
        if (!canRead(f) || snapshot[f] == null || snapshot[f] === '') return ''
        used = true
        return String(snapshot[f])
      })
      .replace(/\{\{[^}]*\}\}/g, '')
      .replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—·|,:/]+|[\s\-–—·|,:/]+$/g, '')
      .trim()
    if (used && text) return text.slice(0, 80)
  }
  for (const f of ['title', 'name', 'label', 'description']) {
    if (canRead(f) && snapshot[f] != null && snapshot[f] !== '')
      return String(snapshot[f]).slice(0, 80)
  }
  return null
}

// ── I/O ──────────────────────────────────────────────────────────────────────

type Caller = Pick<FastifyRequest, 'user' | 'isAdmin' | 'workspaceId'>

interface Rel {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

async function allowedFor(caller: Caller, collection: string): Promise<string[] | null> {
  if (caller.isAdmin) return null
  const list = await getAllowedFields(caller.user as User, 'read', collection)
  return list == null || list.includes('*') ? null : list
}

async function peopleNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x).map(up))]
  if (want.length === 0) return new Map()
  const rows = (await db('nivaro_users')
    .whereIn('id', want)
    .select('id', 'first_name', 'last_name', 'email', 'is_redacted')
    .catch(() => [])) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    is_redacted?: unknown
  }>
  const out = new Map<string, string>()
  for (const u of rows) {
    const name = bit(u.is_redacted)
      ? 'Former user'
      : [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || 'Someone'
    out.set(up(u.id), name)
  }
  return out
}

async function fileNames(caller: Caller, ids: string[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter(Boolean))]
  if (want.length === 0) return new Map()
  const readable = await readableFileIdList(want, caller).catch(() => new Set<string>())
  const ok = want.filter((id) => readable.has(id.toLowerCase()))
  if (ok.length === 0) return new Map()
  const rows = (await db(FILES)
    .whereIn('id', ok)
    .select('id', 'filename_download', 'title')
    .catch(() => [])) as Array<{
    id: string
    filename_download: string | null
    title: string | null
  }>
  return new Map(
    rows.map((r) => [String(r.id).toLowerCase(), r.filename_download || r.title || 'a file'])
  )
}

async function childEvents(
  childCollection: string,
  fkField: string,
  parentId: string,
  since: Date
): Promise<ChildEvent[]> {
  // Rows that hang off the record now: their creates and updates in the window.
  const current = (await db(childCollection)
    .where(fkField, parentId)
    .limit(MAX_CHILD_IDS)
    .select('id')
    .catch(() => [])) as Array<{ id: unknown }>
  const ids = current.map((r) => String(r.id))
  const live = ids.length
    ? ((await selectInChunks(ids, 1000, (chunk) =>
        db('nivaro_activity as a')
          .leftJoin('nivaro_revisions as r', 'r.activity', 'a.id')
          .where('a.collection', childCollection)
          .whereIn('a.item', chunk)
          .whereIn('a.action', ['create', 'update'])
          .where('a.timestamp', '>', since)
          .orderBy('a.timestamp', 'desc')
          .limit(MAX_CHILD_ROWS)
          .select('a.item', 'a.action', 'r.delta', 'a.user', 'a.timestamp')
      ).catch(() => [])) as Array<Record<string, unknown>>)
    : []
  // Rows removed in the window: the delete's snapshot still names the parent.
  const delQ = db('nivaro_activity as a')
    .join('nivaro_revisions as r', 'r.activity', 'a.id')
    .where('a.collection', childCollection)
    .where('a.action', 'delete')
    .where('a.timestamp', '>', since)
    .orderBy('a.timestamp', 'desc')
    .limit(MAX_CHILD_ROWS)
    .select('a.item', 'a.action', 'r.data', 'a.user', 'a.timestamp')
  if (IDENT.test(fkField))
    delQ.whereRaw(`${jsonValue(db, 'r.data', `$.${fkField}`)} = ?`, [parentId])
  const dels = ((await delQ.catch(() => [])) as Array<Record<string, unknown>>).filter((row) => {
    const snap = parseObj(row.data)
    return snap != null && String(snap[fkField] ?? '') === parentId
  })
  return [...live, ...dels].map((r) => ({
    item: String(r.item),
    action: r.action as ChildEvent['action'],
    delta: r.delta ?? null,
    data: r.data ?? null,
    user: (r.user as string | null) ?? null,
    timestamp: r.timestamp as Date
  }))
}

/** What changed on one record since it was last sent back from the step it is in, as `caller` sees it. */
export async function buildResubmissionDiff(
  caller: Caller,
  collection: string,
  item: string
): Promise<ResubmissionDiff | null> {
  const user = caller.user as User | undefined
  if (!user) return null
  const instance = (await db('nivaro_workflow_instances')
    .where({ collection, item: String(item) })
    .orderBy('started_at', 'desc')
    .first('id', 'template', 'current_state')) as
    | { id: string; template: string; current_state: string | null }
    | undefined
  if (!instance?.current_state) return null
  const [history, states] = await Promise.all([
    db('nivaro_workflow_history')
      .where({ instance: instance.id })
      .orderBy('timestamp', 'desc')
      .limit(MAX_HISTORY)
      .select('id', 'from_state', 'to_state', 'user', 'comment', 'timestamp') as Promise<HistRow[]>,
    db('nivaro_workflow_states')
      .where({ template: instance.template })
      .select('id', 'sort', 'label', 'is_terminal') as Promise<StateRow[]>
  ])
  const win = resubmissionWindow(history, states, instance.current_state)
  if (!win) return null
  const since = new Date(win.sentBack.timestamp)
  const labelOfState = new Map(states.map((s) => [up(s.id), s.label]))

  const [allowed, relsRaw] = await Promise.all([
    allowedFor(caller, collection),
    db('nivaro_relations')
      .where((q) =>
        q
          .where('many_collection', collection)
          .orWhere('one_collection', collection)
          // A junction's other leg (workflows_files.file → nivaro_files) names neither side as
          // this collection; without it a files junction is never recognised as file links.
          .orWhereIn(
            'many_collection',
            db('nivaro_relations')
              .where('one_collection', collection)
              .whereNotNull('junction_field')
              .select('many_collection')
          )
      )
      .select('many_collection', 'many_field', 'one_collection', 'one_field', 'junction_field')
      .catch(() => []) as Promise<Rel[]>
  ])

  // ── Fields (and file fields) on the record itself ──
  const [revs, pre] = await Promise.all([
    db('nivaro_revisions as r')
      .join('nivaro_activity as a', 'r.activity', 'a.id')
      .where('a.collection', collection)
      .where('a.item', String(item))
      .where('a.action', 'update')
      .where('a.timestamp', '>', since)
      .orderBy('a.timestamp', 'asc')
      .limit(500)
      .select('r.delta', 'a.user', 'a.timestamp') as Promise<Rev[]>,
    db('nivaro_revisions as r')
      .join('nivaro_activity as a', 'r.activity', 'a.id')
      .where('a.collection', collection)
      .where('a.item', String(item))
      .where('a.timestamp', '<=', since)
      .orderBy('a.timestamp', 'desc')
      .first('r.data') as Promise<{ data: unknown } | undefined>
  ])
  const oldRow = parseObj(pre?.data) ?? {}
  const changed = changedFields(revs, allowed)
  const keys = [...changed.keys()].slice(0, MAX_FIELDS)
  const meta = keys.length
    ? ((await db('nivaro_fields')
        .where({ collection })
        .whereIn('field', keys)
        .select('field', 'label', 'type', 'computed_type', 'options')
        .catch(() => [])) as Array<{
        field: string
        label: string | null
        type?: string | null
        computed_type?: string | null
        options?: unknown
      }>)
    : []
  const metaOf = new Map(meta.map((m) => [m.field, m]))
  const fkTarget = new Map(
    relsRaw
      .filter(
        (r) =>
          r.many_collection === collection &&
          keys.includes(r.many_field) &&
          !r.junction_field &&
          r.one_collection
      )
      .map((r) => [r.many_field, r.one_collection as string])
  )
  const fileFieldKeys = keys.filter((k) => fkTarget.get(k) === FILES)
  const linkWant = new Map<string, Set<string>>()
  for (const k of keys) {
    const t = fkTarget.get(k)
    if (!t || t === FILES) continue
    for (const v of [oldRow[k], changed.get(k)?.value]) {
      if (v == null || v === '' || typeof v === 'object') continue
      const set = linkWant.get(t) ?? new Set<string>()
      set.add(String(v))
      linkWant.set(t, set)
    }
  }

  // ── Lines: one-to-many children and file links ──
  const o2m = relsRaw
    .filter(
      (r) =>
        r.one_collection === collection &&
        r.one_field &&
        !r.junction_field &&
        r.many_collection !== collection &&
        IDENT.test(r.many_collection) &&
        IDENT.test(r.many_field) &&
        !/^(nivaro_|directus_)/i.test(r.many_collection)
    )
    .slice(0, MAX_CHILD_RELS)
  const fileLinks = relsRaw
    .filter((r) => r.one_collection === collection && r.junction_field && r.one_field)
    .map((leg) => ({
      leg,
      other: relsRaw.find(
        (x) => x.many_collection === leg.many_collection && x.many_field === leg.junction_field
      )
    }))
    .filter(
      (p) =>
        p.other?.one_collection === FILES &&
        IDENT.test(p.leg.many_collection) &&
        IDENT.test(p.leg.many_field)
    )
    .slice(0, MAX_CHILD_RELS)

  const lineGroups: ResubLineGroup[] = []
  const files: ResubFileChange[] = []
  const peopleWant: Array<string | null> = [win.sentBack.user, win.returned.user]
  const fileWant: string[] = []
  const parentFieldLabels = new Map<string, string>()
  const aliasNames = [...o2m, ...fileLinks.map((p) => p.leg)]
    .map((r) => r.one_field as string)
    .filter(Boolean)
  if (aliasNames.length) {
    const rows = (await db('nivaro_fields')
      .where({ collection })
      .whereIn('field', aliasNames)
      .select('field', 'label')
      .catch(() => [])) as Array<{ field: string; label: string | null }>
    for (const r of rows) if (r.label) parentFieldLabels.set(r.field, r.label)
  }
  const aliasAllowed = (alias: string) => allowed == null || allowed.includes(alias)

  for (const rel of o2m) {
    const alias = rel.one_field as string
    if (!aliasAllowed(alias)) continue
    const child = rel.many_collection
    const gates = await compileAccessGates(user, child, { actingAdmin: !!caller.isAdmin }).catch(
      () => null
    )
    if (!gates || (!gates.bypass && (!gates.permitted || gates.strict))) continue
    const events = await childEvents(child, rel.many_field, String(item), since)
    if (events.length === 0) continue
    const childAllowed = await allowedFor(caller, child)
    const changes = lineChanges(events, childAllowed, rel.many_field)
    if (changes.length === 0) continue
    const existing = changes.filter((c) => c.kind !== 'removed').map((c) => c.id)
    const visible = await visibleIds(gates, existing).catch(() => new Set<string>())
    const exact = gates.bypass || (!gates.rowFilter && gates.scopes.length === 0)
    const shown = changes.filter((c) => (c.kind === 'removed' ? true : visible.has(c.id)))
    if (shown.length === 0) continue
    const labels = await linkLabelsAsUser(user, new Map([[child, new Set(existing)]])).catch(
      () => ({}) as Record<string, string>
    )
    const tmplRow = (await db('nivaro_collections')
      .where({ collection: child })
      .first('display_template')
      .catch(() => undefined)) as { display_template?: string | null } | undefined
    const childMeta = (await db('nivaro_fields')
      .where({ collection: child })
      .select('field', 'label')
      .catch(() => [])) as Array<{ field: string; label: string | null }>
    const childLabel = new Map(childMeta.map((m) => [m.field, m.label || titleCase(m.field)]))
    const items: ResubLineItem[] = shown.slice(0, MAX_LINES_PER_REL).map((c) => {
      // A removed row under a row rule cannot be judged any more: counted, never named.
      const removedName =
        c.kind === 'removed' && exact
          ? snapshotLabel(c.snapshot, tmplRow?.display_template ?? null, childAllowed)
          : null
      const label =
        c.kind === 'removed'
          ? (removedName ?? 'A line')
          : (labels[linkLabelKey(child, c.id)] ?? `Line #${c.id}`)
      peopleWant.push(c.by)
      return {
        id: c.kind === 'removed' && !exact ? '' : c.id,
        label,
        kind: c.kind,
        fields: c.fields.map((f) => childLabel.get(f) ?? titleCase(f)).slice(0, 6),
        by: c.by,
        at: c.at
      }
    })
    lineGroups.push({
      collection: child,
      field: alias,
      label: parentFieldLabels.get(alias) ?? titleCase(alias),
      added: shown.filter((c) => c.kind === 'added').length,
      changed: shown.filter((c) => c.kind === 'changed').length,
      removed: shown.filter((c) => c.kind === 'removed').length,
      items
    })
  }

  // File links (a files junction): a link added or taken off in the window.
  const linkEvents: Array<{
    field: string
    kind: 'added' | 'removed'
    file: string
    by: string | null
    at: string
  }> = []
  for (const { leg, other } of fileLinks) {
    const alias = leg.one_field as string
    if (!aliasAllowed(alias) || !other) continue
    const events = await childEvents(leg.many_collection, leg.many_field, String(item), since)
    const fileCol = other.many_field
    const nowRows = events.some((e) => e.action === 'create')
      ? ((await db(leg.many_collection)
          .where(leg.many_field, String(item))
          .limit(MAX_CHILD_IDS)
          .select('id', fileCol)
          .catch(() => [])) as Array<Record<string, unknown>>)
      : []
    const fileOfRow = new Map(nowRows.map((r) => [String(r.id), String(r[fileCol] ?? '')]))
    for (const c of lineChanges(events, null, leg.many_field)) {
      if (c.kind === 'changed') continue
      const file = c.kind === 'removed' ? String(c.snapshot?.[fileCol] ?? '') : fileOfRow.get(c.id)
      if (!file) continue
      fileWant.push(file)
      peopleWant.push(c.by)
      linkEvents.push({ field: alias, kind: c.kind, file, by: c.by, at: c.at })
    }
  }

  // File fields (a file id on the record): swapped, set or cleared.
  for (const k of fileFieldKeys) {
    const o = oldRow[k]
    const n = changed.get(k)?.value
    if (o) fileWant.push(String(o))
    if (n) fileWant.push(String(n))
  }

  const [names, fileName, linkLabels] = await Promise.all([
    peopleNames([...peopleWant, ...[...changed.values()].map((c) => c.by)]),
    fileNames(caller, fileWant),
    linkWant.size
      ? linkLabelsAsUser(user, linkWant).catch(() => ({}) as Record<string, string>)
      : Promise.resolve({} as Record<string, string>)
  ])
  const who = (id: string | null) => (id ? (names.get(up(id)) ?? 'Someone') : null)
  const nameOfFile = (id: unknown) =>
    id == null || id === '' ? null : (fileName.get(String(id).toLowerCase()) ?? 'a file')
  const fieldLabel = (k: string) => metaOf.get(k)?.label || titleCase(k)

  for (const k of fileFieldKeys) {
    const c = changed.get(k)
    if (!c) continue
    const o = oldRow[k]
    const kind: ResubFileChange['kind'] = !o ? 'added' : !c.value ? 'removed' : 'replaced'
    files.push({
      field: k,
      field_label: fieldLabel(k),
      kind,
      name: (kind === 'removed' ? nameOfFile(o) : nameOfFile(c.value)) ?? 'a file',
      old_name: kind === 'replaced' ? nameOfFile(o) : null,
      by: who(c.by),
      at: c.at
    })
  }
  for (const e of linkEvents) {
    files.push({
      field: e.field,
      field_label: parentFieldLabels.get(e.field) ?? titleCase(e.field),
      kind: e.kind,
      name: nameOfFile(e.file) ?? 'a file',
      by: who(e.by),
      at: e.at
    })
  }
  files.sort((a, b) => ms(b.at) - ms(a.at))

  const optionsOf = (k: string): Record<string, unknown> => {
    const o = metaOf.get(k)?.options
    if (o && typeof o === 'object') return o as Record<string, unknown>
    if (typeof o === 'string') {
      try {
        const p = JSON.parse(o)
        return p && typeof p === 'object' ? p : {}
      } catch {
        return {}
      }
    }
    return {}
  }
  const kindOf = (k: string): ResubFieldChange['kind'] => {
    if (fkTarget.get(k)) return undefined
    const t = String(metaOf.get(k)?.type ?? '').toLowerCase()
    if (t === 'date') return 'date'
    if (t === 'datetime' || t === 'timestamp' || t === 'datetimeoffset') return 'datetime'
    if (['integer', 'biginteger', 'bigint', 'decimal', 'float', 'double', 'number'].includes(t))
      return 'number'
    return undefined
  }
  const show = (k: string, v: unknown) => {
    const t = fkTarget.get(k)
    if (t && v != null && v !== '' && typeof v !== 'object')
      return linkLabels[linkLabelKey(t, v)] ?? `#${String(v)}`
    if (String(metaOf.get(k)?.type ?? '').toLowerCase() === 'boolean') return bit(v) ? 'Yes' : 'No'
    const kind = kindOf(k)
    if (kind && v != null && v !== '' && typeof v !== 'object') {
      if (kind === 'number') {
        const n = Number(v)
        if (Number.isFinite(n)) return String(n)
      } else {
        const iso = v instanceof Date ? v.toISOString() : String(v)
        if (!Number.isNaN(Date.parse(iso))) return iso
      }
    }
    return shortValue(v)
  }
  const fields: ResubFieldChange[] = keys
    .filter((k) => !fileFieldKeys.includes(k))
    .map((k) => {
      const c = changed.get(k)!
      return {
        field: k,
        label: fieldLabel(k),
        old: k in oldRow ? show(k, oldRow[k]) : '',
        new: show(k, c.value),
        by: who(c.by),
        at: c.at,
        ...(isDerivedField(metaOf.get(k)) ? { auto: true } : {}),
        ...(() => {
          const kind = kindOf(k)
          if (!kind) return {}
          const o = optionsOf(k)
          const p = Number(o.precision)
          return {
            kind,
            ...(kind === 'number'
              ? {
                  format: typeof o.format === 'string' ? o.format : null,
                  precision: Number.isFinite(p) ? p : null
                }
              : {})
          }
        })()
      }
    })
    // A field set back to what it was when the record was sent back changed nothing.
    .filter((f) => f.old === '' || f.old !== f.new)

  for (const g of lineGroups) for (const it of g.items) it.by = who(it.by)

  const sentBy = win.sentBack.user
  return {
    sent_back: {
      by: who(sentBy),
      by_you: !!sentBy && up(sentBy) === up(user.id),
      at: new Date(win.sentBack.timestamp).toISOString(),
      from_label: labelOfState.get(up(win.sentBack.from_state)) ?? null,
      to_label: labelOfState.get(up(win.sentBack.to_state)) ?? null,
      reason: win.sentBack.comment?.trim() ? win.sentBack.comment.trim().slice(0, 400) : null
    },
    returned: { by: who(win.returned.user), at: new Date(win.returned.timestamp).toISOString() },
    fields,
    lines: lineGroups,
    files,
    total:
      fields.length +
      lineGroups.reduce((n, g) => n + g.added + g.changed + g.removed, 0) +
      files.length
  }
}
