import { db } from '../db/index.js'
import { recordRecapSince } from '../routes/record-views.js'
import type { User } from '../types.js'
import { recordLink } from './app-links.js'
import { parseSpecial } from './collections.js'
import { selectInChunks } from './db-batch.js'
import { can } from './permissions.js'
import { type ResolvedOwner, resolveStateOwnersBatch } from './pipeline-engine.js'

/**
 * Per-viewer reads behind the dashboard canvas (/api/dashboard/*): what was
 * sent back to me or by me, whose owners on my records cannot act right now,
 * and which records changed since I last opened them.
 *
 * Every read is scoped to the VIEWER (records they created, send-backs they
 * made, watermarks they hold) and every record is re-checked with can(read)
 * before it leaves — a row the viewer cannot open never appears. Each part is
 * best-effort: a failed collection degrades to nothing, never a 500.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const SYSTEM = /^(nivaro_|directus_)/i
const SEND_BACK_LABEL = /send.?back|sent.?back/i
const CREATOR_FALLBACKS = ['user_created', 'creator', 'created_by']
/** Newest created records per collection considered by the creator-scoped reads. */
const CREATED_CAP = 5000

// ── Pure helpers ────────────────────────────────────────────────────────────

/** A send-back: the destination sorts before the origin on the template, or
 *  the transition says so in its label ('Send Back', 'sent back to …'). */
export function isSendBackEdge(
  fromSort: number | null | undefined,
  toSort: number | null | undefined,
  label: string | null | undefined
): boolean {
  if (fromSort != null && toSort != null && Number(toSort) < Number(fromSort)) return true
  return !!label && SEND_BACK_LABEL.test(label)
}

/** Whole days from `a` to `b`, floored, never negative; 0 for an unreadable date. */
export function daysBetween(a: Date | string, b: Date | string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime()
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.floor(ms / 86_400_000)
}

/**
 * The column naming who created a record: a field flagged `user-created`
 * (special stored as JSON or a bare/comma list) that physically exists, else
 * the first of user_created / creator / created_by present, else null.
 */
export function creatorColumnFor(
  fieldsRows: Array<{ field: string; special?: unknown }>,
  physicalCols: string[]
): string | null {
  const physical = new Map(physicalCols.map((c) => [c.toLowerCase(), c]))
  for (const f of fieldsRows) {
    if (!(parseSpecial(f.special) ?? []).includes('user-created')) continue
    const col = physical.get(String(f.field).toLowerCase())
    if (col) return col
  }
  for (const name of CREATOR_FALLBACKS) {
    const col = physical.get(name)
    if (col) return col
  }
  return null
}

export interface AvailabilityUserRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  status: string | null
  is_redacted: boolean | number | null
  is_out_of_office: boolean | number | null
  delegate_id: string | null
  delegate_expires_at: Date | string | null
}

export interface UnavailableOwner {
  id: string
  name: string
  reason: 'out' | 'suspended' | 'redacted'
  delegate: { id: string; name: string; expires_at: string | null } | null
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

function personName(u: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  id?: string
}): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || u.id || 'Unknown'
}

function hardUnavailable(u: AvailabilityUserRow): 'suspended' | 'redacted' | null {
  if (truthy(u.is_redacted)) return 'redacted'
  if (u.status != null && u.status !== 'active') return 'suspended'
  return null
}

/**
 * The raw owners who cannot act right now: suspended / inactive, redacted, or
 * out of office (with the delegate covering them when that delegation is
 * live and the delegate can act). `userRows` holds the owners AND their
 * delegates; ids compare case-insensitively (uniqueidentifiers come back
 * upper-case).
 */
export function pickUnavailable(
  rawOwners: Array<{ id: string; first_name?: string | null; last_name?: string | null }>,
  userRows: AvailabilityUserRow[],
  now: number = Date.now()
): UnavailableOwner[] {
  const byId = new Map(userRows.map((u) => [String(u.id).toUpperCase(), u]))
  const out: UnavailableOwner[] = []
  for (const o of rawOwners) {
    const u = byId.get(String(o.id).toUpperCase())
    if (!u) continue
    const hard = hardUnavailable(u)
    if (hard) {
      out.push({ id: o.id, name: personName(u), reason: hard, delegate: null })
      continue
    }
    if (!truthy(u.is_out_of_office)) continue
    let delegate: UnavailableOwner['delegate'] = null
    const expired =
      u.delegate_expires_at != null && new Date(u.delegate_expires_at).getTime() <= now
    if (u.delegate_id && !expired) {
      const d = byId.get(String(u.delegate_id).toUpperCase())
      if (d && !hardUnavailable(d) && !truthy(d.is_out_of_office)) {
        delegate = {
          id: d.id,
          name: personName(d),
          expires_at: u.delegate_expires_at ? new Date(u.delegate_expires_at).toISOString() : null
        }
      }
    }
    out.push({ id: o.id, name: personName(u), reason: 'out', delegate })
  }
  return out
}

// ── Shared reads ────────────────────────────────────────────────────────────

/** Business collections a pipeline is bound to. */
async function boundCollections(): Promise<string[]> {
  const rows = (await db('nivaro_workflow_bindings')
    .distinct('collection')
    .catch(() => [])) as Array<{ collection: string }>
  return [
    ...new Set(
      rows.map((r) => String(r.collection)).filter((c) => IDENT.test(c) && !SYSTEM.test(c))
    )
  ]
}

/** collection → its creator column (collections without one are left out). */
async function creatorColumns(collections: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (collections.length === 0) return out
  const [fieldRows, colRows] = await Promise.all([
    db('nivaro_fields')
      .whereIn('collection', collections)
      .whereNotNull('special')
      .select('collection', 'field', 'special')
      .catch(() => []) as Promise<Array<{ collection: string; field: string; special: unknown }>>,
    db('information_schema.columns')
      .whereIn('table_name', collections)
      .select('table_name', 'column_name')
      .catch(() => []) as Promise<Array<{ table_name: string; column_name: string }>>
  ])
  for (const c of collections) {
    const lc = c.toLowerCase()
    const physical = colRows
      .filter((r) => String(r.table_name).toLowerCase() === lc)
      .map((r) => String(r.column_name))
    const fields = fieldRows.filter((r) => String(r.collection).toLowerCase() === lc)
    const col = creatorColumnFor(fields, physical)
    if (col) out.set(c, col)
  }
  return out
}

/** Ids of the newest records the viewer created in each collection. */
async function createdIds(userId: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const cols = await creatorColumns(await boundCollections())
  await Promise.all(
    [...cols.entries()].map(async ([collection, col]) => {
      const ids = (await db(collection)
        .where(col, userId)
        .orderBy('id', 'desc')
        .limit(CREATED_CAP)
        .pluck('id')
        .catch(() => [])) as unknown[]
      if (ids.length > 0)
        out.set(
          collection,
          ids.map((id) => String(id))
        )
    })
  )
  return out
}

/** Collections the viewer may read (admins read everything). */
async function readableFilter(
  user: User,
  isAdmin: boolean,
  collections: Iterable<string>
): Promise<Set<string>> {
  const ok = new Set<string>()
  for (const c of new Set(collections)) {
    if (SYSTEM.test(c) || !IDENT.test(c)) continue
    if (isAdmin || (await can(user, 'read', c).catch(() => false))) ok.add(c)
  }
  return ok
}

/** `collection:id` → friendly label (friendly id, else display label, else #id). */
async function labelRecords(
  records: Array<{ collection: string; item: string }>
): Promise<Map<string, string>> {
  const byCollection = new Map<string, Set<string>>()
  for (const r of records) {
    const set = byCollection.get(r.collection) ?? new Set<string>()
    set.add(r.item)
    byCollection.set(r.collection, set)
  }
  let labels: Record<string, string> = {}
  try {
    const { getLabels } = await import('./queues.js')
    labels = await getLabels(byCollection)
  } catch {
    labels = {}
  }
  const out = new Map<string, string>()
  let resolveFriendlyId: ((c: string, i: string) => Promise<string>) | null = null
  try {
    resolveFriendlyId = (await import('./workflow-transitions.js')).resolveFriendlyId
  } catch {
    resolveFriendlyId = null
  }
  for (const [collection, ids] of byCollection) {
    for (const item of ids) {
      const k = `${collection}:${item}`
      const friendly = resolveFriendlyId
        ? await resolveFriendlyId(collection, item).catch(() => null)
        : null
      out.set(k, friendly && friendly !== item ? friendly : (labels[k] ?? `#${item}`))
    }
  }
  return out
}

async function userNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return out
  const rows = (await selectInChunks(unique, 2000, (chunk) =>
    db('nivaro_users').whereIn('id', chunk).select('id', 'first_name', 'last_name', 'email')
  ).catch(() => [])) as Array<{ id: string } & Record<string, string | null>>
  for (const r of rows) out.set(String(r.id).toUpperCase(), personName(r))
  return out
}

/** Instance id → newest moment it entered its CURRENT state (else started_at). */
async function stateEntries(
  instances: Array<{ instance_id: string; started_at: Date | string | null }>
): Promise<Map<string, Date | string | null>> {
  const out = new Map<string, Date | string | null>()
  for (const i of instances) out.set(String(i.instance_id), i.started_at)
  const ids = [...out.keys()]
  if (ids.length === 0) return out
  const rows = (await selectInChunks(ids, 2000, (chunk) =>
    db('nivaro_workflow_history as h')
      .join('nivaro_workflow_instances as i', function () {
        this.on('i.id', 'h.instance').andOn('i.current_state', 'h.to_state')
      })
      .whereIn('h.instance', chunk)
      .groupBy('h.instance')
      .select('h.instance')
      .max({ at: 'h.timestamp' })
  ).catch(() => [])) as Array<{ instance: string; at: Date | string | null }>
  for (const r of rows) if (r.at) out.set(String(r.instance), r.at)
  return out
}

// ── Send-backs ──────────────────────────────────────────────────────────────

export interface SendBackRow {
  collection: string
  item: string
  label: string
  url: string
  comment: string | null
  at: string | null
  by: { id: string; name: string } | null
  from_label: string | null
  to_label: string | null
  current_state_key: string | null
  current_state_label: string | null
  days_in_state: number
  instance_id: string
}

const SEND_BACK_CAP = 50

function historyQuery(since: Date) {
  return db('nivaro_workflow_history as h')
    .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
    .join('nivaro_workflow_states as fs', 'fs.id', 'h.from_state')
    .join('nivaro_workflow_states as ts', 'ts.id', 'h.to_state')
    .leftJoin('nivaro_workflow_transitions as t', 't.id', 'h.transition')
    .leftJoin('nivaro_workflow_states as cs', 'cs.id', 'i.current_state')
    .where('h.timestamp', '>=', since)
    .where((qb) => {
      void qb
        .whereRaw('ts.sort < fs.sort')
        .orWhere('t.label', 'like', '%send%back%')
        .orWhere('t.label', 'like', '%sent%back%')
    })
    .orderBy([
      { column: 'h.timestamp', order: 'desc' },
      { column: 'h.id', order: 'desc' }
    ])
    .select(
      'h.id',
      'h.instance',
      'h.comment',
      'h.timestamp',
      'h.user',
      'h.to_state',
      'fs.sort as from_sort',
      'ts.sort as to_sort',
      'fs.label as from_label',
      'ts.label as to_label',
      't.label as transition_label',
      'i.collection',
      'i.item',
      'i.current_state',
      'i.started_at',
      'cs.key as current_key',
      'cs.label as current_label'
    )
}

/**
 * Send-backs in the last `days`: `to_me` = on records the viewer created;
 * `by_me` = made by the viewer, where the record still sits in the state it
 * was sent back to. Newest first, capped at 50.
 */
export async function listSendBacks(opts: {
  user: User
  isAdmin: boolean
  dir: 'to_me' | 'by_me'
  days: number
}): Promise<SendBackRow[]> {
  const userId = String(opts.user.id)
  const since = new Date(Date.now() - opts.days * 86_400_000)
  let rows: Array<Record<string, unknown>> = []

  if (opts.dir === 'to_me') {
    const created = await createdIds(userId)
    const parts = await Promise.all(
      [...created.entries()].map(([collection, ids]) =>
        selectInChunks(ids, 1000, (chunk) =>
          historyQuery(since)
            .where('i.collection', collection)
            .whereIn('i.item', chunk)
            .limit(SEND_BACK_CAP * 4)
        ).catch(() => [] as Array<Record<string, unknown>>)
      )
    )
    rows = parts.flat() as Array<Record<string, unknown>>
  } else {
    rows = (await historyQuery(since)
      .where('h.user', userId)
      .whereRaw('i.current_state = h.to_state')
      .whereNotExists(function () {
        this.select(db.raw('1'))
          .from('nivaro_workflow_history as later')
          .whereRaw('later.instance = h.instance')
          .where(function () {
            this.whereRaw('later.timestamp > h.timestamp').orWhere(function () {
              this.whereRaw('later.timestamp = h.timestamp').whereRaw('later.id > h.id')
            })
          })
      })
      .limit(SEND_BACK_CAP * 4)
      .catch(() => [])) as Array<Record<string, unknown>>
  }

  // The label regex is the authority (LIKE is only a coarse prefilter).
  rows = rows
    .filter((r) =>
      isSendBackEdge(
        r.from_sort as number | null,
        r.to_sort as number | null,
        r.transition_label as string | null
      )
    )
    .sort(
      (a, b) =>
        new Date(b.timestamp as string).getTime() - new Date(a.timestamp as string).getTime()
    )

  const readable = await readableFilter(
    opts.user,
    opts.isAdmin,
    rows.map((r) => String(r.collection))
  )
  rows = rows.filter((r) => readable.has(String(r.collection))).slice(0, SEND_BACK_CAP)
  if (rows.length === 0) return []

  const records = rows.map((r) => ({ collection: String(r.collection), item: String(r.item) }))
  const [labels, names, entries] = await Promise.all([
    labelRecords(records),
    userNames(rows.map((r) => (r.user ? String(r.user) : ''))),
    stateEntries(
      rows.map((r) => ({
        instance_id: String(r.instance),
        started_at: r.started_at as Date | null
      }))
    )
  ])
  const now = new Date()
  return Promise.all(
    rows.map(async (r) => {
      const collection = String(r.collection)
      const item = String(r.item)
      const by = r.user ? String(r.user) : null
      const entered = entries.get(String(r.instance))
      const comment =
        r.comment != null && String(r.comment).trim() !== '' ? String(r.comment) : null
      return {
        collection,
        item,
        label: labels.get(`${collection}:${item}`) ?? `#${item}`,
        url: await recordLink(collection, item, { app: 'portal' }),
        comment,
        at: r.timestamp ? new Date(r.timestamp as string).toISOString() : null,
        by: by ? { id: by, name: names.get(by.toUpperCase()) ?? 'Unknown' } : null,
        from_label: (r.from_label as string) ?? null,
        to_label: (r.to_label as string) ?? null,
        current_state_key: (r.current_key as string) ?? null,
        current_state_label: (r.current_label as string) ?? null,
        days_in_state: entered ? daysBetween(entered, now) : 0,
        instance_id: String(r.instance)
      }
    })
  )
}

// ── Owner absence ───────────────────────────────────────────────────────────

export interface OwnerAbsenceRow {
  collection: string
  item: string
  label: string
  url: string
  state_label: string | null
  unavailable: UnavailableOwner[]
}

const ABSENCE_CAP = 100
const AVAILABILITY_COLS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'status',
  'is_redacted',
  'is_out_of_office',
  'delegate_id',
  'delegate_expires_at'
]

/**
 * The viewer's own records on an open pipeline instance (newest 100) whose
 * current-state RAW owners include someone who cannot act: out of office
 * (with their live delegate, if any), suspended or redacted. Records where
 * every owner can act are left out.
 */
export async function listOwnerAbsence(opts: {
  user: User
  isAdmin: boolean
}): Promise<OwnerAbsenceRow[]> {
  const userId = String(opts.user.id)
  const created = await createdIds(userId)
  const readable = await readableFilter(opts.user, opts.isAdmin, created.keys())
  const parts = await Promise.all(
    [...created.entries()]
      .filter(([collection]) => readable.has(collection))
      .map(([collection, ids]) =>
        selectInChunks(ids, 1000, (chunk) =>
          db('nivaro_workflow_instances as i')
            .leftJoin('nivaro_workflow_states as s', 's.id', 'i.current_state')
            .where('i.collection', collection)
            .whereIn('i.item', chunk)
            .whereNull('i.completed_at')
            .whereNotNull('i.current_state')
            .select(
              'i.id',
              'i.collection',
              'i.item',
              'i.current_state',
              'i.started_at',
              's.label as state_label'
            )
        ).catch(() => [] as Array<Record<string, unknown>>)
      )
  )
  const instances = (parts.flat() as Array<Record<string, unknown>>)
    .sort(
      (a, b) =>
        new Date(String(b.started_at ?? 0)).getTime() -
        new Date(String(a.started_at ?? 0)).getTime()
    )
    .slice(0, ABSENCE_CAP)
  if (instances.length === 0) return []

  const keyOf = (i: Record<string, unknown>) => `${i.collection}:${i.item}`
  const owners = await resolveStateOwnersBatch(
    instances.map((i) => ({
      key: keyOf(i),
      stateId: String(i.current_state),
      instanceId: String(i.id),
      collection: String(i.collection),
      itemId: String(i.item)
    })),
    db,
    { skipDelegation: true }
  ).catch(() => new Map<string, ResolvedOwner[]>())

  const ownerIds = new Set<string>()
  for (const list of owners.values()) for (const o of list) ownerIds.add(String(o.id))
  if (ownerIds.size === 0) return []
  const userRows = (await selectInChunks([...ownerIds], 2000, (chunk) =>
    db('nivaro_users').whereIn('id', chunk).select(AVAILABILITY_COLS)
  ).catch(() => [])) as AvailabilityUserRow[]
  const known = new Set(userRows.map((u) => String(u.id).toUpperCase()))
  const delegateIds = [
    ...new Set(
      userRows
        .map((u) => (u.delegate_id ? String(u.delegate_id) : ''))
        .filter((id) => id && !known.has(id.toUpperCase()))
    )
  ]
  if (delegateIds.length > 0) {
    const delegates = (await selectInChunks(delegateIds, 2000, (chunk) =>
      db('nivaro_users').whereIn('id', chunk).select(AVAILABILITY_COLS)
    ).catch(() => [])) as AvailabilityUserRow[]
    userRows.push(...delegates)
  }

  const flagged = instances
    .map((i) => ({ i, unavailable: pickUnavailable(owners.get(keyOf(i)) ?? [], userRows) }))
    .filter((x) => x.unavailable.length > 0)
  if (flagged.length === 0) return []
  const labels = await labelRecords(
    flagged.map(({ i }) => ({ collection: String(i.collection), item: String(i.item) }))
  )
  return Promise.all(
    flagged.map(async ({ i, unavailable }) => ({
      collection: String(i.collection),
      item: String(i.item),
      label: labels.get(keyOf(i)) ?? `#${i.item}`,
      url: await recordLink(String(i.collection), String(i.item), { app: 'portal' }),
      state_label: (i.state_label as string) ?? null,
      unavailable
    }))
  )
}

// ── Changed since ───────────────────────────────────────────────────────────

export interface ChangedSince {
  changed: boolean
  since: string | null
  editors: string[]
  field_changes: number
  comments: number
  transitions: number
}

export const CHANGED_SINCE_CAP = 60
const NOTHING: Omit<ChangedSince, 'since'> = {
  changed: false,
  editors: [],
  field_changes: 0,
  comments: 0,
  transitions: 0
}

/**
 * For each record: did OTHER people change it after the viewer last opened
 * it? Reads the viewer's watermark (nivaro_record_views.last_viewed_at) and
 * never moves it. A record the viewer never opened (or cannot read) answers
 * changed:false with since:null.
 */
export async function changedSince(opts: {
  user: User
  isAdmin: boolean
  items: Array<{ collection: string; item: string }>
}): Promise<Record<string, ChangedSince>> {
  const userId = String(opts.user.id)
  const items = opts.items.filter((i) => IDENT.test(i.collection) && !SYSTEM.test(i.collection))
  const out: Record<string, ChangedSince> = {}
  for (const i of opts.items) out[`${i.collection}:${i.item}`] = { ...NOTHING, since: null }
  if (items.length === 0) return out

  const readable = await readableFilter(
    opts.user,
    opts.isAdmin,
    items.map((i) => i.collection)
  )
  const visible = items.filter((i) => readable.has(i.collection))
  if (visible.length === 0) return out

  const views = (await db('nivaro_record_views')
    .where('user', userId)
    .where((qb) => {
      for (const v of visible) {
        void qb.orWhere((q2) => q2.where('collection', v.collection).where('item_id', v.item))
      }
    })
    .select('collection', 'item_id', 'last_viewed_at')
    .catch(() => [])) as Array<{ collection: string; item_id: string; last_viewed_at: Date }>
  const sinceByKey = new Map(
    views.map((v) => [`${v.collection}:${v.item_id}`, new Date(v.last_viewed_at)])
  )

  // Three reads per record — run a few at a time, never 180 at once.
  const queue = visible.filter((v) => sinceByKey.has(`${v.collection}:${v.item}`))
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const key = `${next.collection}:${next.item}`
      const since = sinceByKey.get(key) as Date
      try {
        const recap = await recordRecapSince(next.collection, next.item, userId, since, {
          labels: false
        })
        out[key] = {
          changed: recap.field_changes > 0 || recap.comments > 0 || recap.transitions > 0,
          since: since.toISOString(),
          editors: recap.editors,
          field_changes: recap.field_changes,
          comments: recap.comments,
          transitions: recap.transitions
        }
      } catch {
        out[key] = { ...NOTHING, since: since.toISOString() }
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  return out
}
