import { db } from '../db/index.js'
import type { User } from '../types.js'
import { dayIn, safeTimeZone } from './activity-export.js'
import { activityLabelsFor, changesFromDelta } from './activity-readable.js'
import {
  type ActivityLabels,
  activityPredicate,
  collectionNouns,
  fieldLabel,
  HIDDEN_RECORD,
  linkChanges,
  linkPairText,
  parseTransitionComment,
  ROUTINE_READ_ACTIONS,
  recordPhrase,
  transitionVerb
} from './activity-sentence.js'
import { selectInChunks } from './db-batch.js'
import {
  buildJunctionMap,
  type JunctionInfo,
  junctionsOf,
  loadJunctionMap
} from './junction-map.js'

/**
 * "What {person} did" (#13, profile cleanup 2026-11-13): a person's audit trail in plain
 * words. The day → collection summary folds link-table (junction) writes into their parent
 * collection and counts with plain verbs ("Opened 3 · Edited 1"); a group's entries become
 * readable lines — repeated reads of one record are one "Opened 4×" line, the link rows one
 * edit wrote ride that edit ("Changed Amount, Divisions and Regions"), records are named by
 * their label read AS THE VIEWER (services/activity-readable.ts `activityLabelsFor`), and a
 * record the viewer cannot read is "a workflow record" — never its id.
 *
 * Pure: buildJunctionMap, personVerb, groupPersonDays, foldPersonLines. I/O:
 * loadJunctionMap (cached per tenant), readChangedFields, personDidLabels (records and link rows
 * labelled as the viewer; a link row's parent comes from its labels).
 */

export interface PersonDidRow {
  id: number
  action: string
  timestamp: string
  collection: string | null
  item: string | null
  comment: string | null
}

export interface DidPart {
  verb: string
  count: number
}

export interface DidGroup {
  collection: string | null
  count: number
  actions: Record<string, number>
  parts: DidPart[]
  label?: string
}

export interface DidDay {
  day: string
  total: number
  collections: DidGroup[]
}

export interface DidLine {
  key: string
  ids: number[]
  /** Newest time in the line. */
  at: string
  /** Oldest time, when the line folds more than one entry. */
  first_at?: string
  count: number
  verb: string
  kind: VerbKind
  /** What it was done to ("Workflow CM26-372916 · Fiber build", "a workflow record"). */
  target: string
  detail: string | null
  /** A note the person wrote (on a transition). */
  note?: string | null
  /** Set only when the viewer may open the record. */
  record: { collection: string; id: string } | null
}

export type VerbKind =
  | 'read'
  | 'edit'
  | 'create'
  | 'delete'
  | 'move'
  | 'access'
  | 'grant'
  | 'signin'
  | 'comment'
  | 'other'

// ─── Junctions (services/junction-map.ts) ──────────────────────────────────

export { buildJunctionMap, type JunctionInfo, junctionsOf, loadJunctionMap }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Verbs ──────────────────────────────────────────────────────────────────

const TRANSITIONS = new Set(['transition', 'pipeline-transition'])
const ROUTINE_READS = new Set(ROUTINE_READ_ACTIONS)

function capital(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/** The plain verb for one row (summary and lines share it). */
export function personVerb(r: PersonDidRow): { verb: string; kind: VerbKind } {
  const a = String(r.action ?? '')
  if (ROUTINE_READS.has(a))
    return { verb: a === 'notification-read' ? 'Read' : 'Opened', kind: 'read' }
  if (TRANSITIONS.has(a))
    return { verb: transitionVerb(parseTransitionComment(r.comment).via), kind: 'move' }
  switch (a) {
    case 'update':
    case 'o2m-create':
    case 'o2m-update':
    case 'o2m-delete':
      return { verb: 'Edited', kind: 'edit' }
    case 'create':
      return { verb: 'Created', kind: 'create' }
    case 'delete':
      return { verb: 'Deleted', kind: 'delete' }
    case 'restore':
      return { verb: 'Restored', kind: 'other' }
    case 'pipeline-start':
      return { verb: 'Started', kind: 'move' }
    case 'access-request':
      return { verb: 'Requested access', kind: 'access' }
    case 'access-request-grant':
      return {
        verb: /^\s*partial\b/i.test(r.comment ?? '') ? 'Partly granted access' : 'Granted access',
        kind: 'grant'
      }
    case 'access-request-deny':
      return { verb: 'Declined access', kind: 'grant' }
    case 'comment':
      return { verb: 'Commented', kind: 'comment' }
    case 'login':
      return { verb: 'Signed in', kind: 'signin' }
    case 'logout':
      return { verb: 'Signed out', kind: 'signin' }
    default:
      break
  }
  if (a.startsWith('bulk-')) return { verb: 'Ran a bulk action', kind: 'other' }
  const first = activityPredicate({ ...r, item: r.item ?? null }).split(' ')[0] ?? ''
  return { verb: capital(first) || 'Did', kind: 'other' }
}

// ─── Summary ────────────────────────────────────────────────────────────────

const PART_ORDER = [
  'Created',
  'Edited',
  'Submitted',
  'Approved',
  'Rejected',
  'Declined',
  'Sent back',
  'Cancelled',
  'Moved',
  'Started',
  'Deleted',
  'Restored',
  'Commented',
  'Requested access',
  'Granted access',
  'Partly granted access',
  'Declined access',
  'Ran a bulk action',
  'Exported',
  'Downloaded',
  'Opened',
  'Read',
  'Signed in',
  'Signed out'
]

function partRank(verb: string): number {
  const i = PART_ORDER.indexOf(verb)
  return i < 0 ? PART_ORDER.length : i
}

const minuteOf = (ts: string) => String(ts).slice(0, 16)

interface GroupAcc {
  count: number
  actions: Record<string, number>
  distinct: Map<string, Set<string>>
  events: Map<string, number>
  editMinutes: Set<string>
  linkMinutes: Set<string>
}

/** Rows → days (newest first) → collections (busiest first); link tables fold into their parent. */
export function groupPersonDays(
  rows: PersonDidRow[],
  tz: string,
  junctions: Map<string, JunctionInfo>
): DidDay[] {
  const zone = safeTimeZone(tz)
  const days = new Map<string, Map<string, GroupAcc>>()
  for (const r of rows) {
    const day = dayIn(r.timestamp, zone)
    let cols = days.get(day)
    if (!cols) {
      cols = new Map()
      days.set(day, cols)
    }
    const j = r.collection ? junctions.get(r.collection) : undefined
    const key = j ? j.parent : (r.collection ?? '')
    let g = cols.get(key)
    if (!g) {
      g = {
        count: 0,
        actions: {},
        distinct: new Map(),
        events: new Map(),
        editMinutes: new Set(),
        linkMinutes: new Set()
      }
      cols.set(key, g)
    }
    g.count++
    g.actions[r.action] = (g.actions[r.action] ?? 0) + 1
    if (j) {
      g.linkMinutes.add(minuteOf(r.timestamp))
      continue
    }
    const { verb, kind } = personVerb(r)
    if ((kind === 'read' || kind === 'edit') && r.item) {
      const set = g.distinct.get(verb) ?? new Set<string>()
      set.add(String(r.item))
      g.distinct.set(verb, set)
      if (kind === 'edit') g.editMinutes.add(minuteOf(r.timestamp))
    } else {
      g.events.set(verb, (g.events.get(verb) ?? 0) + 1)
    }
  }
  return [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([day, cols]) => {
      const collections = [...cols.entries()]
        .map(([collection, g]) => {
          const counts = new Map<string, number>(g.events)
          for (const [verb, set] of g.distinct) counts.set(verb, (counts.get(verb) ?? 0) + set.size)
          // Link writes in a minute with no edit of the parent: an edit of their own.
          let linkEdits = 0
          for (const m of g.linkMinutes) if (!g.editMinutes.has(m)) linkEdits++
          if (linkEdits) counts.set('Edited', (counts.get('Edited') ?? 0) + linkEdits)
          const parts = [...counts.entries()]
            .map(([verb, count]) => ({ verb, count }))
            .sort((a, b) => partRank(a.verb) - partRank(b.verb) || b.count - a.count)
          return { collection: collection || null, count: g.count, actions: g.actions, parts }
        })
        .sort(
          (a, b) =>
            (a.collection == null ? 1 : 0) - (b.collection == null ? 1 : 0) ||
            b.count - a.count ||
            String(a.collection).localeCompare(String(b.collection))
        )
      return { day, total: collections.reduce((n, c) => n + c.count, 0), collections }
    })
}

// ─── Lines ──────────────────────────────────────────────────────────────────

export interface FoldContext {
  junctions: Map<string, JunctionInfo>
  labels: ActivityLabels
  /** `junction:item` → the parent record's id (readJunctionParents). */
  parentOf?: Map<string, string | null>
  /** activity id → changed field names (readChangedFields). */
  fields?: Map<number, string[]>
}

const EDIT_FOLD_MS = 10 * 60_000
const LINK_ATTACH_MS = 2 * 60_000
const SYSTEM_RE = /^(nivaro|directus)_/i

function lowerNoun(s: string): string {
  return s
    .split(' ')
    .map((w) => (/[A-Z][^ ]*[A-Z]/.test(w) ? w : w.toLowerCase()))
    .join(' ')
}

interface Target {
  text: string
  record: { collection: string; id: string } | null
  hidden: boolean
}

function targetOf(
  collection: string | null,
  item: string | null,
  labels: ActivityLabels,
  action = ''
): Target {
  if (!collection || !item) return { text: '', record: null, hidden: false }
  const id = String(item)
  const key = `${collection}:${id}`
  const { singular } = collectionNouns(collection, labels)
  const generic = `a ${lowerNoun(singular)} record`
  const records = labels.records ?? {}
  const linkable = !SYSTEM_RE.test(collection) && action !== 'delete'
  if (key in records && records[key] == null) return { text: generic, record: null, hidden: true }
  const label = key in records ? String(records[key] ?? '').trim() : ''
  const record = linkable ? { collection, id } : null
  if (UUID_RE.test(id) && (!label || label === id)) return { text: generic, record, hidden: false }
  const phrase = recordPhrase(collection, id, labels) ?? generic
  return { text: phrase === HIDDEN_RECORD ? generic : phrase, record, hidden: false }
}

function listText(names: string[]): string {
  const n = [...new Set(names.filter(Boolean))]
  if (n.length <= 1) return n[0] ?? ''
  if (n.length <= 6) return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
  return `${n.slice(0, 5).join(', ')} and ${n.length - 5} more`
}

/** "Add CHI to their Region filter" → "Added CHI to their Region filter". */
function pastTense(label: string): string {
  return label
    .trim()
    .replace(/^Add\b/, 'Added')
    .replace(/^Give\b/, 'Gave')
    .replace(/^Remove\b/, 'Removed')
}

const GRANT_RE = /^\s*(partial\s+)?for user ([0-9a-f-]{36})(.*)$/is

function grantDetail(comment: string | null, labels: ActivityLabels): string | null {
  const m = GRANT_RE.exec(String(comment ?? ''))
  if (!m) return null
  const who = labels.users?.[m[2].toUpperCase()] ?? 'someone'
  let rest = m[3].trim()
  let blocked = false
  if (m[1]) {
    rest = rest.replace(/^:\s*/, '')
    const cut = rest.indexOf(' — still blocked:')
    if (cut >= 0) {
      blocked = true
      rest = rest.slice(0, cut)
    }
  } else {
    rest = rest.replace(/^\(([\s\S]*)\)$/, '$1')
  }
  const applied = rest
    .split(/;\s*/)
    .map((s) => s.trim())
    .filter((s) => s && s !== 'nothing to apply')
    .map(pastTense)
  return [`For ${who}`, ...applied, ...(blocked ? ['Still blocked'] : [])].join(' · ')
}

interface EditAcc {
  line: DidLine
  collection: string
  item: string | null
  newest: number
  oldest: number
  names: string[]
  /** The link rows that rode this edit (newest first) — said in words when labelled. */
  links: PersonDidRow[]
  /** Names of the link fields, for when the link rows have no labels. */
  linkNames: string[]
  hidden: boolean
}

/** One group's rows (newest first) → readable lines (newest first). */
export function foldPersonLines(rows: PersonDidRow[], ctx: FoldContext): DidLine[] {
  const { junctions, labels } = ctx
  const lines: DidLine[] = []
  const dayFolds = new Map<string, DidLine>()
  const edits = new Map<string, EditAcc[]>()
  const links: PersonDidRow[] = []
  let prev: { line: DidLine; sig: string } | null = null

  const bump = (line: DidLine, r: PersonDidRow) => {
    line.ids.push(r.id)
    line.count++
    line.first_at = r.timestamp
  }
  const fieldNames = (collection: string, fields: string[]) =>
    fields.map((f) => fieldLabel(collection, f, labels))

  for (const r of rows) {
    if (r.collection && junctions.has(r.collection)) {
      links.push(r)
      continue
    }
    const { verb, kind } = personVerb(r)
    const t = targetOf(r.collection, r.item, labels, r.action)

    // Reads of one record and a day's sign-ins: one line for the day.
    if (kind === 'read' || kind === 'signin') {
      const system = !!r.collection && SYSTEM_RE.test(r.collection)
      const foldKey =
        kind === 'signin'
          ? `s:${verb}`
          : system
            ? `r:${r.action}:${r.collection}`
            : `r:${r.collection}:${r.item ?? ''}`
      const existing = dayFolds.get(foldKey)
      if (existing) {
        bump(existing, r)
        continue
      }
      const target =
        kind === 'signin'
          ? ''
          : system
            ? lowerNoun(collectionNouns(r.collection, labels).plural)
            : t.text
      const line: DidLine = {
        key: `r:${r.id}`,
        ids: [r.id],
        at: r.timestamp,
        count: 1,
        verb,
        kind,
        target,
        detail: null,
        record: system ? null : t.record
      }
      dayFolds.set(foldKey, line)
      lines.push(line)
      prev = null
      continue
    }

    // Edits of one record within ten minutes (autosave) are one line.
    if (kind === 'edit' && r.collection) {
      const recKey = `${r.collection}:${r.item ?? ''}`
      const ms = new Date(r.timestamp).getTime()
      const names = t.hidden ? [] : fieldNames(r.collection, ctx.fields?.get(r.id) ?? [])
      const open = (edits.get(recKey) ?? []).find((e) => e.oldest - ms <= EDIT_FOLD_MS)
      if (open) {
        bump(open.line, r)
        open.oldest = Math.min(open.oldest, ms)
        open.names.push(...names)
        continue
      }
      const line: DidLine = {
        key: `e:${r.id}`,
        ids: [r.id],
        at: r.timestamp,
        count: 1,
        verb,
        kind,
        target: t.text,
        detail: null,
        record: t.record
      }
      edits.set(recKey, [
        ...(edits.get(recKey) ?? []),
        {
          line,
          collection: r.collection,
          item: r.item,
          newest: ms,
          oldest: ms,
          names,
          links: [],
          linkNames: [],
          hidden: t.hidden
        }
      ])
      lines.push(line)
      prev = null
      continue
    }

    let line: DidLine
    if (kind === 'move') {
      const p = parseTransitionComment(r.comment)
      const states = p.from && p.to ? `${p.from} → ${p.to}` : p.to ? `→ ${p.to}` : null
      line = {
        key: `m:${r.id}`,
        ids: [r.id],
        at: r.timestamp,
        count: 1,
        verb,
        kind,
        target: t.text || 'a record',
        detail: t.hidden ? null : states,
        note: t.hidden ? null : p.note,
        record: t.record
      }
    } else if (kind === 'grant') {
      line = {
        key: `g:${r.id}`,
        ids: [r.id],
        at: r.timestamp,
        count: 1,
        verb: `${verb} to`,
        kind,
        target: t.text || lowerNoun(collectionNouns(r.collection, labels).plural),
        detail: grantDetail(r.comment, labels),
        record: t.record
      }
    } else if (
      kind === 'access' ||
      kind === 'create' ||
      kind === 'delete' ||
      kind === 'comment' ||
      (verb === 'Restored' && t.text)
    ) {
      line = {
        key: `x:${r.id}`,
        ids: [r.id],
        at: r.timestamp,
        count: 1,
        verb: kind === 'access' ? `${verb} to` : verb,
        kind,
        target: t.text || lowerNoun(collectionNouns(r.collection, labels).plural),
        detail: null,
        record: t.record
      }
    } else {
      // Everything else reads from the shared sentence ("ran “Hold all” on 12 workflows").
      const generic = t.text || 'a record'
      const sentence = activityPredicate(
        { ...r, item: r.item ?? null },
        labels as ActivityLabels
      ).replace(HIDDEN_RECORD, generic)
      const [first, ...rest] = sentence.split(' ')
      line = {
        key: `o:${r.id}`,
        ids: [r.id],
        at: r.timestamp,
        count: 1,
        verb: capital(first ?? ''),
        kind,
        target: rest.join(' '),
        detail: null,
        record: t.record
      }
    }
    // The same thing twice in a row (a double click): one line.
    const sig = `${line.verb}\u0000${line.target}\u0000${line.detail ?? ''}`
    if (prev && prev.sig === sig) {
      bump(prev.line, r)
      continue
    }
    prev = { line, sig }
    lines.push(line)
  }

  // Link-table rows ride their parent's edit; otherwise they are an edit of their own.
  for (const r of links) {
    const j = junctions.get(String(r.collection))!
    const parentId =
      ctx.parentOf?.get(`${j.junction}:${r.item ?? ''}`) ??
      labels.junctions?.[`${j.junction}:${r.item ?? ''}`]?.parent_id ??
      null
    const ms = new Date(r.timestamp).getTime()
    const recKey = `${j.parent}:${parentId ?? `?${minuteOf(r.timestamp)}`}`
    const name = j.alias
      ? fieldLabel(j.parent, j.alias, labels)
      : j.target
        ? collectionNouns(j.target, labels).plural
        : 'links'
    const list = edits.get(recKey) ?? []
    const near = list.find(
      (e) => ms >= e.oldest - LINK_ATTACH_MS && ms <= e.newest + LINK_ATTACH_MS
    )
    if (near) {
      near.line.ids.push(r.id)
      if (ms < near.oldest) near.oldest = ms
      if (!near.hidden) {
        near.links.push(r)
        near.linkNames.push(name)
      }
      continue
    }
    const t = parentId
      ? targetOf(j.parent, parentId, labels)
      : {
          // No parent id: unknown, or not the viewer's to see (activityLabelsFor withholds it).
          text: `a ${lowerNoun(collectionNouns(j.parent, labels).singular)} record`,
          record: null,
          hidden: true
        }
    const line: DidLine = {
      key: `l:${r.id}`,
      ids: [r.id],
      at: r.timestamp,
      count: 1,
      verb: 'Edited',
      kind: 'edit',
      target: t.text,
      detail: null,
      record: t.record
    }
    list.push({
      line,
      collection: j.parent,
      item: parentId,
      newest: ms,
      oldest: ms,
      names: [],
      links: t.hidden ? [] : [r],
      linkNames: t.hidden ? [] : [name],
      hidden: t.hidden
    })
    edits.set(recKey, list)
    lines.push(line)
  }

  for (const list of edits.values())
    for (const e of list) {
      // Labelled link rows say what changed ("Division Zone 1 → Zone 2"); else their names.
      const said = e.links.length ? linkChanges(e.links, labels) : null
      const names = listText(said ? e.names : [...e.names, ...e.linkNames])
      const parts = [
        ...(names ? [`Changed ${names}`] : []),
        ...(said ? [...said.pairs.map(linkPairText), ...said.rest] : [])
      ]
      e.line.detail = parts.length ? capital(parts.join(' · ')) : null
      if (e.oldest < e.newest) e.line.first_at = new Date(e.oldest).toISOString()
    }

  return lines.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

// ─── I/O ────────────────────────────────────────────────────────────────────

/** Update activity ids → the field names their revision delta changed. */
export async function readChangedFields(ids: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>()
  if (ids.length === 0) return out
  try {
    const rows = (await selectInChunks(ids, 500, (chunk) =>
      Promise.resolve(db('nivaro_revisions').whereIn('activity', chunk).select('activity', 'delta'))
    )) as Array<{ activity: number; delta: unknown }>
    for (const r of rows) {
      const fields = (changesFromDelta(r.delta) ?? []).map((c) => c.field)
      if (fields.length) out.set(Number(r.activity), fields)
    }
  } catch {
    /* no deltas: "Edited" without a field list */
  }
  return out
}

const GRANT_USER_RE = /for user ([0-9a-f-]{36})/i
const REF_CHUNK = 200

/** Labels for a set of rows, read AS `user` (records, people named in grants, fields). */
export async function personDidLabels(
  user: User,
  isAdmin: boolean,
  rows: PersonDidRow[],
  ctx: Pick<FoldContext, 'junctions' | 'parentOf' | 'fields'>
): Promise<ActivityLabels> {
  const refs = new Map<string, { collection: string; id: string }>()
  const users = new Set<string>()
  const fields = new Map<string, { collection: string; field: string }>()
  const collections = new Set<string>()
  for (const r of rows) {
    const j = r.collection ? ctx.junctions.get(r.collection) : undefined
    if (j) {
      collections.add(j.parent)
      if (j.target) collections.add(j.target)
      if (j.alias) fields.set(`${j.parent}.${j.alias}`, { collection: j.parent, field: j.alias })
      // The link row itself: the labels say what it linked to what (as the viewer).
      if (r.item)
        refs.set(`${j.junction}:${r.item}`, { collection: j.junction, id: String(r.item) })
      continue
    }
    if (r.collection) collections.add(r.collection)
    if (r.collection && r.item)
      refs.set(`${r.collection}:${r.item}`, { collection: r.collection, id: String(r.item) })
    const g = GRANT_USER_RE.exec(String(r.comment ?? ''))
    if (g) users.add(g[1])
    for (const f of ctx.fields?.get(r.id) ?? [])
      if (r.collection) fields.set(`${r.collection}.${f}`, { collection: r.collection, field: f })
  }
  const all = [...refs.values()].slice(0, 1000)
  const chunks: Array<typeof all> = []
  for (let i = 0; i < all.length; i += REF_CHUNK) chunks.push(all.slice(i, i + REF_CHUNK))
  if (chunks.length === 0) chunks.push([])
  const results = await Promise.all(
    chunks.map((chunk, i) =>
      activityLabelsFor(
        user,
        {
          refs: chunk,
          ...(i === 0
            ? { users: [...users], fields: [...fields.values()], collections: [...collections] }
            : {})
        },
        { isAdmin }
      )
    )
  )
  const out: ActivityLabels = { ...results[0], records: {} }
  for (const r of results) Object.assign(out.records!, r.records ?? {})
  return out
}

/** A summary group's label: the collection's plural name, as the viewer reads it. */
export function groupLabel(group: DidGroup, labels: ActivityLabels): string {
  if (!group.collection) {
    const onlySignIns = group.parts.every((p) => p.verb === 'Signed in' || p.verb === 'Signed out')
    return onlySignIns ? 'Sign-ins' : 'Sign-ins and other'
  }
  return collectionNouns(group.collection, labels).plural
}
