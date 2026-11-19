import { db } from '../db/index.js'
import type { User } from '../types.js'

/**
 * "What changed since you last viewed" — the field-by-field list behind the record recap strip
 * ("2 fields changed by Nicholas Desrosiers", 2026-11-18). The strip's count comes from /touch;
 * this answers the popover that opens from it: per field, the value before and after, who
 * changed it and when, grouped by person and time.
 *
 * Read AS THE CALLER: the route gates the record; only fields the caller's read policy lists are
 * ever named, and link values are labelled as the caller may see them (never a primary key). By
 * default only OTHER people's saves are listed (your own edits are not news, same as the count);
 * `everyone` lists every save (the "since this email" strip). Values are always taken from the
 * stored snapshots, so a "before" includes the caller's own earlier edits.
 */

/** Saves read in one window — the popover is a recap, the full history is one click away. */
export const RECAP_CHANGES_MAX_SAVES = 300
/** Two saves by one person this close together read as one group ("Nick · 2 h ago"). */
const GROUP_GAP_MS = 30 * 60 * 1000
/** A value longer than this is cut (a long note); the full text is in the history. */
const VALUE_MAX = 280

const AUDIT_NAMES = new Set([
  'date_created',
  'date_updated',
  'user_created',
  'user_updated',
  'created_at',
  'updated_at',
  'created',
  'changed',
  'sort'
])
const AUDIT_SPECIALS = ['user-created', 'user-updated', 'date-created', 'date-updated']
const USER_COLLECTIONS = new Set(['nivaro_users', 'directus_users'])

export interface RecapSave {
  id: string | number
  timestamp: string | Date | null
  user_id: string | null
  name: string | null
  action: string | null
  data: unknown
  delta: unknown
}

export interface RecapFieldInfo {
  label: string
  /** Bookkeeping or machine field (audit stamps, hidden columns, unknown to the form). */
  system: boolean
  type?: string | null
  interface?: string | null
  options?: Record<string, unknown> | null
  /** Many-to-one target, when the value is a record id. */
  related?: string | null
  /** A to-many field: the value is a list of link-row ids. */
  toMany?: boolean
}

export interface RecapChange {
  field: string
  /** False when no earlier snapshot says what it was (a record older than its history). */
  has_before: boolean
  before: unknown
  after: unknown
  /** The value as words, set when the server had to name it (links, people, rich text). */
  before_text?: string
  after_text?: string
}

export interface RecapGroup {
  user_id: string | null
  name: string
  first_at: string | null
  last_at: string | null
  saves: number
  changes: RecapChange[]
}

export interface RecapChanges {
  since: string
  groups: RecapGroup[]
  /** Field → how to show it (label, system, type/choices for formatting). */
  fields: Record<
    string,
    {
      label: string
      system: boolean
      type: string | null
      interface: string | null
      options: Record<string, unknown> | null
    }
  >
  /** More saves than the window reads — the full history has the rest. */
  truncated: boolean
}

function parseObj(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const iso = (t: string | Date | null): string | null => {
  if (t == null) return null
  const d = t instanceof Date ? t : new Date(t)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
const ms = (t: string | Date | null): number => {
  if (t == null) return 0
  const v = (t instanceof Date ? t : new Date(t)).getTime()
  return Number.isFinite(v) ? v : 0
}

export function sameRecapValue(a: unknown, b: unknown): boolean {
  const s = (v: unknown) =>
    v === null || v === undefined || v === ''
      ? ''
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v)
  return s(a) === s(b)
}

/** Rich text / HTML as plain words, cut to VALUE_MAX. Exported for tests. */
export function plainValue(v: unknown): unknown {
  if (typeof v !== 'string') return v
  let s = v
  if (/<[a-z][^>]*>/i.test(s)) {
    s = s
      .replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
  }
  return s.length > VALUE_MAX ? `${s.slice(0, VALUE_MAX)}…` : s
}

/**
 * Pure assembly — exported for tests. `saves` are oldest first; `baseline` is the snapshot the
 * record had at `since` (null = none recorded). `readable` = the caller's readable fields
 * (null = every field). Only saves after `since` are listed; the caller's own are skipped
 * unless `everyone`.
 */
export function buildRecapChanges(input: {
  since: Date
  viewerId: string
  everyone?: boolean
  baseline: Record<string, unknown> | null
  saves: RecapSave[]
  readable: Set<string> | null
  fields: Map<string, RecapFieldInfo>
  truncated?: boolean
}): RecapChanges {
  const canRead = (f: string) => f !== 'id' && (input.readable == null || input.readable.has(f))
  const sinceMs = input.since.getTime()
  let state: Record<string, unknown> | null = input.baseline ? { ...input.baseline } : null
  const groups: Array<RecapGroup & { byField: Map<string, RecapChange> }> = []
  for (const save of input.saves) {
    const data = parseObj(save.data)
    const delta = parseObj(save.delta) ?? {}
    const before = state
    // The record as this save left it: its snapshot, else the last state with the delta on top.
    state = data ? { ...data } : { ...(state ?? {}), ...delta }
    if (ms(save.timestamp) <= sinceMs) continue
    if (!input.everyone && save.user_id != null && save.user_id === input.viewerId) continue
    const created = save.action === 'create'
    const moved: RecapChange[] = []
    for (const f of Object.keys(delta)) {
      if (!canRead(f)) continue
      const after = state[f]
      const known = created || (before != null && f in before)
      const prior = created ? null : known ? before?.[f] : null
      if (known && sameRecapValue(prior, after)) continue
      moved.push({ field: f, has_before: known, before: prior ?? null, after: after ?? null })
    }
    if (moved.length === 0) continue
    const at = ms(save.timestamp)
    const last = groups[groups.length - 1]
    const name = save.name?.trim() || (save.user_id ? 'Someone' : 'System')
    const joins =
      last && last.user_id === (save.user_id ?? null) && at - ms(last.last_at) <= GROUP_GAP_MS
    const group =
      joins && last
        ? last
        : (() => {
            const g = {
              user_id: save.user_id ?? null,
              name,
              first_at: iso(save.timestamp),
              last_at: iso(save.timestamp),
              saves: 0,
              changes: [] as RecapChange[],
              byField: new Map<string, RecapChange>()
            }
            groups.push(g)
            return g
          })()
    group.saves += 1
    group.last_at = iso(save.timestamp)
    for (const c of moved) {
      const had = group.byField.get(c.field)
      // One person changing a field twice in a sitting: first "before", last "after".
      if (had) had.after = c.after
      else group.byField.set(c.field, { ...c })
    }
  }
  const out: RecapGroup[] = []
  const used = new Set<string>()
  for (const g of groups) {
    const changes = [...g.byField.values()].filter(
      (c) => !(c.has_before && sameRecapValue(c.before, c.after))
    )
    if (changes.length === 0) continue
    for (const c of changes) used.add(c.field)
    // Form order: the field config's order, unknown (machine) fields last.
    const order = [...input.fields.keys()]
    const pos = (f: string) => {
      const i = order.indexOf(f)
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }
    changes.sort((a, b) => pos(a.field) - pos(b.field) || a.field.localeCompare(b.field))
    out.push({
      user_id: g.user_id,
      name: g.name,
      first_at: g.first_at,
      last_at: g.last_at,
      saves: g.saves,
      changes: changes.map((c) => ({
        ...c,
        before: plainValue(c.before),
        after: plainValue(c.after)
      }))
    })
  }
  out.reverse() // newest group first
  const fields: RecapChanges['fields'] = {}
  for (const f of used) {
    const info = input.fields.get(f)
    fields[f] = {
      label: info?.label || f.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      system: info ? info.system : true,
      type: info?.type ?? null,
      interface: info?.interface ?? null,
      options: info?.options ?? null
    }
  }
  return {
    since: input.since.toISOString(),
    groups: out,
    fields,
    truncated: !!input.truncated
  }
}

/** Only the option keys that change how a value reads (choices, money) — never the rest. */
function displayOptions(
  options: Record<string, unknown> | null,
  display: Record<string, unknown> | null
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const src of [display, options]) {
    if (!src) continue
    for (const k of ['choices', 'format', 'currency'])
      if (src[k] !== undefined && out[k] === undefined) out[k] = src[k]
  }
  return Object.keys(out).length ? out : null
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The one rule for "a system field" (audit stamps, sort, hidden fields, a column with no field
 * row): the popover folds them under "and N system fields", and the strip's "N fields changed"
 * leaves them out — "2 fields changed" was one real field plus Date Updated.
 */
export async function recapSystemFieldTest(
  collection: string
): Promise<(field: string) => boolean> {
  const info = await fieldInfo(collection).catch(() => new Map<string, RecapFieldInfo>())
  // No field list (metadata unreadable): judge by name only, never call every field system.
  if (info.size === 0) return (field) => AUDIT_NAMES.has(field)
  return (field) => {
    const f = info.get(field)
    return f ? f.system : true
  }
}

/** The collection's fields as the popover shows them (labels, system, link targets). */
async function fieldInfo(collection: string): Promise<Map<string, RecapFieldInfo>> {
  const { getFields, getRelations } = await import('./collections.js')
  const [fields, rels] = await Promise.all([
    getFields(collection).catch(() => []),
    getRelations(collection).catch(() => [])
  ])
  const map = new Map<string, RecapFieldInfo>()
  for (const f of fields as Array<Record<string, unknown> & { field: string }>) {
    const special = Array.isArray(f.special) ? (f.special as string[]) : []
    const m2o = rels.find(
      (r) => r.many_collection === collection && r.many_field === f.field && !r.junction_field
    )
    const toMany = rels.some(
      (r) => r.one_collection === collection && r.one_field === f.field && r.many_collection
    )
    map.set(f.field, {
      label:
        (typeof f.label === 'string' && f.label.trim()) ||
        f.field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      system:
        AUDIT_NAMES.has(f.field) ||
        special.some((s) => AUDIT_SPECIALS.includes(s)) ||
        f.hidden === true,
      type: (f.type as string | null) ?? null,
      interface: (f.interface as string | null) ?? null,
      options: displayOptions(
        (f.options as Record<string, unknown> | null) ?? null,
        (f.display_options as Record<string, unknown> | null) ?? null
      ),
      related: m2o?.one_collection ?? null,
      toMany
    })
  }
  return map
}

const idOf = (v: unknown): string | null => {
  if (v == null || v === '') return null
  if (typeof v === 'object') {
    const id = (v as { id?: unknown }).id
    return id == null ? null : String(id)
  }
  return String(v)
}

/** Name link values (and people) as the caller may see them. Best effort: never throws. */
async function nameLinks(
  user: User,
  collection: string,
  item: string,
  result: RecapChanges,
  info: Map<string, RecapFieldInfo>,
  seesAll: boolean
): Promise<void> {
  const refs: Array<{ collection: string; id: string }> = []
  const people = new Set<string>()
  let toMany = false
  for (const g of result.groups)
    for (const c of g.changes) {
      const meta = info.get(c.field)
      if (meta?.toMany) toMany = true
      const target = meta?.related
      if (!target || !IDENT.test(target)) continue
      for (const v of [c.before, c.after]) {
        const id = idOf(v)
        if (!id) continue
        if (USER_COLLECTIONS.has(target)) people.add(id)
        else refs.push({ collection: target, id })
      }
    }
  const labels: Record<string, string> = {}
  if (refs.length) {
    try {
      const { recordLabelsAsViewer } = await import('./record-labels-as-viewer.js')
      Object.assign(labels, await recordLabelsAsViewer(user, refs))
    } catch {
      /* the client shows "a linked record" */
    }
  }
  const names = new Map<string, string>()
  if (people.size) {
    try {
      const rows = (await db('nivaro_users')
        .whereIn('id', [...people].slice(0, 100))
        .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
      for (const r of rows)
        names.set(
          String(r.id).toLowerCase(),
          [r.first_name, r.last_name].filter(Boolean).join(' ') || String(r.email ?? 'Someone')
        )
    } catch {
      /* "a person" */
    }
  }
  let links: Record<string, Record<string, { target: string; label: string }>> = {}
  if (toMany) {
    try {
      const { linkLabels } = await import('./revision-link-labels.js')
      links = (await linkLabels(user, collection, item, undefined, { seesAll })).fields
    } catch {
      links = {}
    }
  }
  for (const g of result.groups)
    for (const c of g.changes) {
      const meta = info.get(c.field)
      const name = (v: unknown): string | undefined => {
        if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return undefined
        if (meta?.toMany && Array.isArray(v)) {
          const map = links[c.field] ?? {}
          const named = v.map((x) => map[idOf(x) ?? '']?.label).filter(Boolean) as string[]
          if (named.length === v.length) return named.join(', ')
          // Never ids: what the caller may not name reads as a count.
          const rest = v.length - named.length
          const tail = `${rest} linked record${rest === 1 ? '' : 's'}`
          return named.length ? `${named.join(', ')} + ${tail}` : tail
        }
        const target = meta?.related
        if (!target) return undefined
        const id = idOf(v)
        if (!id) return undefined
        if (USER_COLLECTIONS.has(target)) return names.get(id.toLowerCase()) ?? 'A person'
        return labels[`${target}:${id}`] ?? 'A linked record'
      }
      const b = name(c.before)
      const a = name(c.after)
      if (b !== undefined) c.before_text = b
      if (a !== undefined) c.after_text = a
      // The raw id behind a label never travels.
      if (meta?.related || meta?.toMany) {
        c.before = null
        c.after = null
      }
    }
}

/**
 * What changed on one record after `since`, field by field, as `user` may see it. The caller
 * has already checked the record is readable.
 */
export async function recordRecapChanges(
  user: User,
  isAdmin: boolean,
  collection: string,
  id: string,
  since: Date,
  opts: { everyone?: boolean; seesAll?: boolean } = {}
): Promise<RecapChanges> {
  let readable: Set<string> | null = null
  if (!isAdmin) {
    const { readableFieldSet } = await import('./revision-fields.js')
    readable = await readableFieldSet(user, collection)
  }
  const [baselineRow, rows, info] = await Promise.all([
    db('nivaro_revisions as r')
      .join('nivaro_activity as a', 'a.id', 'r.activity')
      .where({ 'r.collection': collection, 'r.item': id })
      .where('a.timestamp', '<=', since)
      .orderBy('r.id', 'desc')
      .first('r.data') as Promise<{ data?: unknown } | undefined>,
    db('nivaro_revisions as r')
      .join('nivaro_activity as a', 'a.id', 'r.activity')
      .leftJoin('nivaro_users as u', 'u.id', 'a.user')
      .where({ 'r.collection': collection, 'r.item': id })
      .whereIn('a.action', ['create', 'update'])
      .where('a.timestamp', '>', since)
      .orderBy('r.id', 'asc')
      .limit(RECAP_CHANGES_MAX_SAVES + 1)
      .select(
        'r.id',
        'r.data',
        'r.delta',
        'a.timestamp',
        'a.action',
        'a.user as user_id',
        'u.first_name',
        'u.last_name',
        'u.email'
      ) as Promise<Array<Record<string, unknown>>>,
    fieldInfo(collection)
  ])
  const truncated = rows.length > RECAP_CHANGES_MAX_SAVES
  const saves: RecapSave[] = rows.slice(0, RECAP_CHANGES_MAX_SAVES).map((r) => ({
    id: r.id as string | number,
    timestamp: (r.timestamp as string | Date | null) ?? null,
    user_id: r.user_id == null ? null : String(r.user_id),
    name:
      [r.first_name, r.last_name].filter(Boolean).join(' ') ||
      (r.email as string | null | undefined) ||
      null,
    action: (r.action as string | null) ?? null,
    data: r.data,
    delta: r.delta
  }))
  const result = buildRecapChanges({
    since,
    viewerId: user.id,
    everyone: opts.everyone,
    baseline: parseObj(baselineRow?.data),
    saves,
    readable,
    fields: info,
    truncated
  })
  await nameLinks(user, collection, id, result, info, !!opts.seesAll)
  return result
}
