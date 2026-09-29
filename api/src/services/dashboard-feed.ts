import { db } from '../db/index.js'
import type { User } from '../types.js'
import { recordLink } from './app-links.js'
import { parseSpecial } from './collections.js'
import { selectInChunks } from './db-batch.js'
import { can, getRowFilter } from './permissions.js'
import { resolveStateOwnersBatch } from './pipeline-engine.js'
import { compileAccessGates, visibleIds } from './record-access.js'

/**
 * Per-viewer reads behind the dashboard canvas (/api/dashboard/*): what was
 * sent back to me or by me, whose owners on my records cannot act right now,
 * and which records changed since I last opened them.
 *
 * Every read is scoped to the VIEWER (records they created, send-backs they
 * made, watermarks they hold) and every record passes the same gates as its
 * record page (role, row filter, User Scopes) before it leaves — a row the
 * viewer cannot open never appears.
 *
 * A read that decides the answer THROWS: a failure must never read as
 * "nothing sent back", "everyone can act" or "0". The routes turn it into a
 * 503. Only decorations (labels, names, links) fall back quietly.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const SYSTEM = /^(nivaro_|directus_)/i
const SEND_BACK_LABEL = /send.?back|sent.?back/i
const CREATOR_FALLBACKS = ['user_created', 'creator', 'created_by']
/** Newest created records per collection considered by the creator-scoped reads. */
const CREATED_CAP = 5000

// ── Pure helpers ────────────────────────────────────────────────────────────

/** A send-back: the destination sorts before the origin on the template, or
 *  the transition says so in its label ('Send Back', 'sent back to …').
 *  Leaving the canceled state (an uncancel) hops backwards but sends nothing
 *  back to anyone, so a move FROM `canceled` never counts. */
export function isSendBackEdge(
  fromSort: number | null | undefined,
  toSort: number | null | undefined,
  label: string | null | undefined,
  fromKey?: string | null
): boolean {
  if (fromKey && String(fromKey).toLowerCase() === 'canceled') return false
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
  const rows = (await db('nivaro_workflow_bindings').distinct('collection')) as Array<{
    collection: string
  }>
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
      .select('collection', 'field', 'special') as Promise<
      Array<{ collection: string; field: string; special: unknown }>
    >,
    db('information_schema.columns')
      .whereIn('table_name', collections)
      .select('table_name', 'column_name') as Promise<
      Array<{ table_name: string; column_name: string }>
    >
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
        .pluck('id')) as unknown[]
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
    if (isAdmin || (await can(user, 'read', c))) ok.add(c)
  }
  return ok
}

/**
 * The records (of those given) the viewer can open — the record page's own
 * gates: role, row filter and User Scopes. One query per collection. A failed
 * read throws: dropping the record would read as "nothing to see".
 */
async function visibleRecords<T extends { collection: string; item: string }>(
  user: User,
  isAdmin: boolean,
  records: T[]
): Promise<T[]> {
  if (isAdmin || records.length === 0) return records
  const byCollection = new Map<string, string[]>()
  for (const r of records) {
    const list = byCollection.get(r.collection) ?? []
    list.push(r.item)
    byCollection.set(r.collection, list)
  }
  const allowed = new Set<string>()
  await Promise.all(
    [...byCollection.entries()].map(async ([collection, ids]) => {
      const gates = await compileAccessGates(user, collection)
      for (const id of await visibleIds(gates, [...new Set(ids)])) {
        allowed.add(`${collection}:${String(id).toUpperCase()}`)
      }
    })
  )
  return records.filter((r) => allowed.has(`${r.collection}:${r.item.toUpperCase()}`))
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
  // One batched friendly-id read per collection (never one per record).
  let resolveFriendlyIds: ((c: string, ids: string[]) => Promise<Map<string, string>>) | null = null
  try {
    resolveFriendlyIds = (await import('./workflow-transitions.js')).resolveFriendlyIds
  } catch {
    resolveFriendlyIds = null
  }
  for (const [collection, ids] of byCollection) {
    const friendly = resolveFriendlyIds
      ? await resolveFriendlyIds(collection, [...ids]).catch(() => new Map<string, string>())
      : new Map<string, string>()
    for (const item of ids) {
      const k = `${collection}:${item}`
      const f = friendly.get(item)
      out.set(k, f && f !== item ? f : (labels[k] ?? `#${item}`))
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

/** Instance id → newest moment it entered its CURRENT state (else started_at).
 *  null when the read failed: every entry is then unknown, never "today". */
async function stateEntries(
  instances: Array<{ instance_id: string; started_at: Date | string | null }>
): Promise<Map<string, Date | string | null> | null> {
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
  ).catch(() => null)) as Array<{ instance: string; at: Date | string | null }> | null
  if (!rows) return null
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
  /** null when the moment it entered its state could not be read. */
  days_in_state: number | null
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
      'fs.key as from_key',
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
 * Send-backs in the last `days`: `to_me` = on records the viewer created, made
 * by someone else (or no one — an automatic move);
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
            // A send-back you made on your own record was not sent back TO you.
            .where((qb) => {
              void qb.whereNull('h.user').orWhereNot('h.user', userId)
            })
            .limit(SEND_BACK_CAP * 4)
        )
      )
    )
    const me = userId.toUpperCase()
    rows = (parts.flat() as Array<Record<string, unknown>>).filter(
      (r) => !r.user || String(r.user).toUpperCase() !== me
    )
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
      .limit(SEND_BACK_CAP * 4)) as Array<Record<string, unknown>>
  }

  // The label regex is the authority (LIKE is only a coarse prefilter).
  rows = rows
    .filter((r) =>
      isSendBackEdge(
        r.from_sort as number | null,
        r.to_sort as number | null,
        r.transition_label as string | null,
        r.from_key as string | null
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
  rows = rows.filter((r) => readable.has(String(r.collection)))
  rows = (
    await visibleRecords(
      opts.user,
      opts.isAdmin,
      rows.map((r) => ({ collection: String(r.collection), item: String(r.item), r }))
    )
  )
    .map((v) => v.r)
    .slice(0, SEND_BACK_CAP)
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
      const entered = entries ? entries.get(String(r.instance)) : null
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
        days_in_state: entered ? daysBetween(entered, now) : null,
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
        )
      )
  )
  const found = (parts.flat() as Array<Record<string, unknown>>).map((i) => ({
    collection: String(i.collection),
    item: String(i.item),
    i
  }))
  const instances = (await visibleRecords(opts.user, opts.isAdmin, found))
    .map((v) => v.i)
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
  )

  const ownerIds = new Set<string>()
  for (const list of owners.values()) for (const o of list) ownerIds.add(String(o.id))
  if (ownerIds.size === 0) return []
  const userRows = (await selectInChunks([...ownerIds], 2000, (chunk) =>
    db('nivaro_users').whereIn('id', chunk).select(AVAILABILITY_COLS)
  )) as AvailabilityUserRow[]
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
    )) as AvailabilityUserRow[]
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
 * never moves it. A record the viewer never opened (or cannot open) answers
 * changed:false with since:null — there is nothing to compare against. A
 * failed watermark read throws; a failed change read for one collection
 * leaves its records OUT of the answer, never "unchanged".
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
  const visible = await visibleRecords(
    opts.user,
    opts.isAdmin,
    items.filter((i) => readable.has(i.collection))
  )
  if (visible.length === 0) return out

  const views = (await db('nivaro_record_views')
    .where('user', userId)
    .where((qb) => {
      for (const v of visible) {
        void qb.orWhere((q2) => q2.where('collection', v.collection).where('item_id', v.item))
      }
    })
    .select('collection', 'item_id', 'last_viewed_at')) as Array<{
    collection: string
    item_id: string
    last_viewed_at: Date
  }>
  const sinceByKey = new Map(
    views.map((v) => [
      `${v.collection}:${String(v.item_id).toUpperCase()}`,
      new Date(v.last_viewed_at)
    ])
  )

  const byCollection = new Map<string, WatermarkedItem[]>()
  for (const v of visible) {
    const since = sinceByKey.get(`${v.collection}:${v.item.toUpperCase()}`)
    if (!since) continue
    const list = byCollection.get(v.collection) ?? []
    list.push({ item: v.item, since, key: `${v.collection}:${v.item}` })
    byCollection.set(v.collection, list)
  }
  await Promise.all(
    [...byCollection.entries()].map(async ([collection, list]) => {
      try {
        const recaps = await recapBatch(collection, list, userId)
        for (const l of list) {
          const r = recaps.get(l.item.toUpperCase()) ?? {
            editors: [],
            field_changes: 0,
            comments: 0,
            transitions: 0
          }
          out[l.key] = {
            changed: r.field_changes > 0 || r.comments > 0 || r.transitions > 0,
            since: l.since.toISOString(),
            ...r
          }
        }
      } catch {
        for (const l of list) delete out[l.key]
      }
    })
  )
  return out
}

interface WatermarkedItem {
  item: string
  since: Date
  key: string
}

/**
 * The since-you-last-looked counts for several records of one collection,
 * each against its own watermark: one activity read, one comments count and
 * one history count, whatever the number of records. Keys are upper-cased
 * item ids. Reads throw.
 */
async function recapBatch(
  collection: string,
  list: WatermarkedItem[],
  userId: string
): Promise<Map<string, Omit<ChangedSince, 'changed' | 'since'>>> {
  const window = (itemCol: string, tsCol: string) => (qb: import('knex').Knex.QueryBuilder) => {
    for (const l of list) {
      void qb.orWhere((q2) => q2.where(itemCol, l.item).where(tsCol, '>', l.since))
    }
  }
  const [activity, comments, transitions] = await Promise.all([
    db('nivaro_activity as a')
      .leftJoin('nivaro_revisions as r', 'r.activity', 'a.id')
      .leftJoin('nivaro_users as u', 'u.id', 'a.user')
      .where('a.collection', collection)
      .whereIn('a.action', ['create', 'update'])
      .where(window('a.item', 'a.timestamp'))
      .where((b) => b.whereNull('a.user').orWhereNot('a.user', userId))
      .select('a.item', 'u.first_name', 'u.last_name', 'u.email', 'r.delta') as Promise<
      Array<Record<string, unknown>>
    >,
    db('nivaro_comments')
      .where('collection', collection)
      .where(window('item', 'created_at'))
      .whereNot('user', userId)
      .groupBy('item')
      .select('item')
      .count({ c: '*' }) as Promise<Array<{ item: unknown; c: unknown }>>,
    db('nivaro_workflow_history as h')
      .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
      .where('i.collection', collection)
      .where(window('i.item', 'h.timestamp'))
      .where((b) => b.whereNull('h.user').orWhereNot('h.user', userId))
      .groupBy('i.item')
      .select('i.item as item')
      .count({ c: '*' }) as Promise<Array<{ item: unknown; c: unknown }>>
  ])
  const out = new Map<string, Omit<ChangedSince, 'changed' | 'since'>>()
  const entry = (item: unknown) => {
    const k = String(item).toUpperCase()
    let e = out.get(k)
    if (!e) {
      e = { editors: [], field_changes: 0, comments: 0, transitions: 0 }
      out.set(k, e)
    }
    return e
  }
  const fields = new Map<string, Set<string>>()
  for (const row of activity) {
    const e = entry(row.item)
    const name =
      [row.first_name, row.last_name].filter(Boolean).join(' ') ||
      (row.email as string | null) ||
      null
    if (name && !e.editors.includes(name) && e.editors.length < 5) e.editors.push(name)
    const k = String(row.item).toUpperCase()
    const set = fields.get(k) ?? new Set<string>()
    let delta: unknown = null
    try {
      delta = typeof row.delta === 'string' ? JSON.parse(row.delta) : row.delta
    } catch {
      delta = null
    }
    if (delta && typeof delta === 'object') for (const f of Object.keys(delta)) set.add(f)
    fields.set(k, set)
    e.field_changes = set.size
  }
  for (const r of comments) entry(r.item).comments = Number(r.c ?? 0)
  for (const r of transitions) entry(r.item).transitions = Number(r.c ?? 0)
  return out
}

// ── Shared helpers (second batch) ───────────────────────────────────────────

/** Median of a list; null when empty. */
export function median(nums: number[]): number | null {
  if (nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const round1 = (n: number | null): number | null => (n == null ? null : Math.round(n * 10) / 10)

/** preferences is nvarchar JSON on the raw row, an object once parsed. */
function parsePrefs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function titleCase(field: string): string {
  return field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const isEmptyValue = (v: unknown) => v == null || String(v).trim() === ''

/** Run `fn` over `items` at most `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await fn(next)
  }
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, worker))
}

/** A collection's physical columns. A failed read throws — "no columns"
 *  would read as nothing to check. */
async function physicalColumns(collection: string): Promise<Set<string>> {
  const rows = (await db('information_schema.columns')
    .where('table_name', collection)
    .select('column_name')) as Array<{ column_name: string }>
  return new Set(rows.map((r) => String(r.column_name)))
}

// ── My integrity ────────────────────────────────────────────────────────────

const LINE_FINDING = /^Line (#?\S+):\s*/

/** 'Line 3: Category is empty' → { line: '3', message: 'Category is empty' };
 *  a record-level message → null. */
export function splitLineFinding(message: string): { line: string; message: string } | null {
  const m = LINE_FINDING.exec(message ?? '')
  if (!m) return null
  return { line: m[1], message: message.slice(m[0].length) }
}

export interface IntegrityRecord {
  collection: string
  item: string
  label: string
  url: string
  findings: Array<{ field: string | null; rule: string; message: string; fixable: boolean }>
  line_findings: Array<{ line: string; field: string | null; message: string }>
}

const INTEGRITY_CAP = 200

/**
 * Stored integrity findings (nivaro_record_integrity — the row the record
 * banner reads) on records the viewer created, newest check first, capped at
 * 200 records. On a pipeline-bound collection only records whose instance is
 * still open count; an unbound collection counts every record. A finding
 * worded 'Line N: …' is a line finding; the rest are record findings.
 */
export async function listMyIntegrity(opts: { user: User; isAdmin: boolean }): Promise<{
  records: IntegrityRecord[]
  totals: { records: number; findings: number; lines: number }
}> {
  const empty = { records: [], totals: { records: 0, findings: 0, lines: 0 } }
  const userId = String(opts.user.id)
  const found = (await db('nivaro_record_integrity')
    .whereNot('findings', '[]')
    .distinct('collection')) as Array<{ collection: string }>
  const readable = await readableFilter(
    opts.user,
    opts.isAdmin,
    found.map((r) => String(r.collection))
  )
  if (readable.size === 0) return empty
  const [creators, bound] = await Promise.all([
    creatorColumns([...readable]),
    boundCollections().then((b) => new Set(b))
  ])

  const kept: Array<{ collection: string; item: string; findings: string; at: number }> = []
  await Promise.all(
    [...creators.entries()].map(async ([collection, col]) => {
      // Owner (and, on a bound collection, open-instance) filtering happens IN
      // SQL, so an older flagged record of the viewer's is never cut off by
      // a newest-N scan of everyone's rows.
      const q = db('nivaro_record_integrity as ri')
        .join(`${collection} as r`, function () {
          this.on(db.raw('CAST(r.id AS NVARCHAR(255)) = ri.item_id'))
        })
        .where('ri.collection', collection)
        .where(`r.${col}`, userId)
        .whereNot('ri.findings', '[]')
      if (bound.has(collection)) {
        void q.whereExists(function () {
          void this.select(db.raw('1'))
            .from('nivaro_workflow_instances as wi')
            .where('wi.collection', collection)
            .whereRaw('wi.item = ri.item_id')
            .whereNull('wi.completed_at')
        })
      }
      const mine = (await q
        .orderBy('ri.checked_at', 'desc')
        .limit(INTEGRITY_CAP)
        .select('ri.item_id', 'ri.findings', 'ri.checked_at')) as Array<{
        item_id: string
        findings: string
        checked_at: Date
      }>
      for (const r of mine) {
        kept.push({
          collection,
          item: String(r.item_id),
          findings: r.findings,
          at: new Date(r.checked_at).getTime() || 0
        })
      }
    })
  )

  const parsed = (await visibleRecords(opts.user, opts.isAdmin, kept))
    .sort((a, b) => b.at - a.at)
    .map((k) => {
      let list: Array<{ field?: string | null; rule?: string; message?: string }> = []
      try {
        const v = JSON.parse(k.findings)
        if (Array.isArray(v)) list = v
      } catch {
        list = []
      }
      const findings: IntegrityRecord['findings'] = []
      const lines: IntegrityRecord['line_findings'] = []
      for (const f of list) {
        const message = String(f.message ?? '')
        const field = f.field ? String(f.field) : null
        const split = splitLineFinding(message)
        if (split) lines.push({ line: split.line, field, message: split.message })
        else findings.push({ field, rule: String(f.rule ?? ''), message, fixable: !!field })
      }
      return { ...k, findings, lines }
    })
    .filter((k) => k.findings.length + k.lines.length > 0)
    .slice(0, INTEGRITY_CAP)
  if (parsed.length === 0) return empty

  const labels = await labelRecords(parsed.map((p) => ({ collection: p.collection, item: p.item })))
  const records = await Promise.all(
    parsed.map(async (p) => ({
      collection: p.collection,
      item: p.item,
      label: labels.get(`${p.collection}:${p.item}`) ?? `#${p.item}`,
      url: await recordLink(p.collection, p.item, { app: 'portal' }),
      findings: p.findings,
      line_findings: p.lines
    }))
  )
  return {
    records,
    totals: {
      records: records.length,
      findings: records.reduce((n, r) => n + r.findings.length, 0),
      lines: records.reduce((n, r) => n + r.line_findings.length, 0)
    }
  }
}

// ── Submission readiness ────────────────────────────────────────────────────

export interface ReadinessBlocker {
  kind: 'field' | 'lines' | 'requirement'
  field?: string
  label: string
  message: string
}

export const READINESS_ID_CAP = 50

interface RelationRow {
  many_collection: string | null
  many_field: string | null
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

interface RequiredField {
  field: string
  label: string
}

/** The required fields a record must fill: on the active grouped layout, the
 *  assigned fields whose layout override (else the field itself) says
 *  required; without a layout, every field flagged required. A failed read
 *  throws: "no required fields" would read as ready. */
async function requiredFieldsFor(collection: string): Promise<RequiredField[]> {
  const fields = (await db('nivaro_fields')
    .where('collection', collection)
    .select('field', 'label', 'required')) as Array<{
    field: string
    label: string | null
    required: unknown
  }>
  const byField = new Map(fields.map((f) => [f.field, f]))
  const layout = (await db('nivaro_collection_layouts')
    .where({ collection, layout_type: 'grouped', is_active: true })
    .first('id')) as { id: number } | undefined
  if (!layout?.id) {
    return fields
      .filter((f) => truthy(f.required))
      .map((f) => ({ field: f.field, label: f.label || titleCase(f.field) }))
  }
  const assignments = (await db('nivaro_layout_field_assignments')
    .where('layout_id', layout.id)
    .select('field', 'label_override', 'overrides')) as Array<{
    field: string
    label_override: string | null
    overrides: string | null
  }>
  const out: RequiredField[] = []
  for (const a of assignments) {
    if (!a.field || a.field.startsWith('__') || a.field.includes('.')) continue
    const o = parsePrefs(a.overrides)
    const f = byField.get(a.field)
    const required = 'required' in o ? truthy(o.required) : truthy(f?.required)
    if (!required) continue
    const label =
      (typeof o.label === 'string' && o.label) || a.label_override || f?.label || titleCase(a.field)
    out.push({ field: a.field, label })
  }
  return out
}

/**
 * Readiness blockers per record id. A `null` entry means that record's own
 * lookup failed: it is unknown, and `assembleReadiness` leaves it out rather
 * than call it ready.
 */
export type BlockerLookup = Map<string, ReadinessBlocker[] | null>

/** Field blockers (empty required columns / aliases) and empty required line
 *  sets. Every read here covers all the ids at once, so a failed read throws
 *  and the caller answers none of them. Exported for tests. */
export async function fieldBlockers(
  collection: string,
  ids: string[]
): Promise<Map<string, ReadinessBlocker[]>> {
  const out = new Map<string, ReadinessBlocker[]>()
  const push = (id: string, b: ReadinessBlocker) => {
    const list = out.get(id) ?? []
    list.push(b)
    out.set(id, list)
  }
  const [required, physical, relations] = await Promise.all([
    requiredFieldsFor(collection),
    physicalColumns(collection),
    db('nivaro_relations')
      .where('one_collection', collection)
      .orWhere('many_collection', collection)
      .select(
        'many_collection',
        'many_field',
        'one_collection',
        'one_field',
        'junction_field'
      ) as Promise<RelationRow[]>
  ])
  if (required.length === 0) return out

  const columns = required.filter((r) => physical.has(r.field))
  if (columns.length > 0) {
    const rows = (await db(collection)
      .whereIn('id', ids)
      .select(['id', ...columns.map((c) => c.field)])) as Array<Record<string, unknown>>
    for (const row of rows) {
      for (const c of columns) {
        if (!isEmptyValue(row[c.field])) continue
        push(String(row.id), {
          kind: 'field',
          field: c.field,
          label: c.label,
          message: `${c.label} is required`
        })
      }
    }
  }

  // Aliases: an O2M set of lines, or an M2M link set on a junction.
  for (const r of required.filter((f) => !physical.has(f.field))) {
    const alias = relations.find(
      (rel) => rel.one_collection === collection && rel.one_field === r.field
    )
    const childTable =
      alias ??
      relations.find(
        (rel) =>
          rel.many_collection === r.field &&
          rel.one_collection === collection &&
          !rel.junction_field
      )
    const rel = childTable
    if (!rel?.many_collection || !rel.many_field) continue
    if (!IDENT.test(rel.many_collection) || !IDENT.test(rel.many_field)) continue
    if (SYSTEM.test(rel.many_collection)) continue
    const counts = (await db(rel.many_collection)
      .whereIn(rel.many_field, ids)
      .groupBy(rel.many_field)
      .select(rel.many_field)
      .count({ n: '*' })) as Array<Record<string, unknown>>
    const has = new Set(
      counts
        .filter((c) => Number(c.n) > 0)
        .map((c) => String(c[rel.many_field as string]).toUpperCase())
    )
    const isLines = !rel.junction_field
    for (const id of ids) {
      if (has.has(id.toUpperCase())) continue
      push(
        id,
        isLines
          ? { kind: 'lines', field: r.field, label: r.label, message: 'No lines yet' }
          : { kind: 'field', field: r.field, label: r.label, message: `${r.label} is required` }
      )
    }
  }
  return out
}

interface TransitionRow {
  id: string
  template: string
  from_state: string | null
  to_state: string
  label: string
  sort: number | null
  auto_trigger: unknown
  condition_rules: string | null
  required_roles: string | null
  requirements: string | null
}

/** Requirement blockers: the first manual forward transition from each
 *  record's current state whose conditions hold (whoever may press it),
 *  evaluated through its requirements gate exactly as the transition
 *  endpoint would. When every forward step is closed by its conditions, one
 *  blocker names the first failing condition. A read covering every record
 *  (instances, states, transitions) throws; a read for one record that fails
 *  marks just that record unknown (`null`). Exported for tests. */
export async function requirementBlockers(
  collection: string,
  ids: string[]
): Promise<BlockerLookup> {
  const out: BlockerLookup = new Map()
  const instances = (await db('nivaro_workflow_instances')
    .where('collection', collection)
    .whereIn('item', ids)
    .whereNull('completed_at')
    .whereNotNull('current_state')
    .orderBy('started_at', 'desc')
    .select('id', 'item', 'template', 'current_state')) as Array<{
    id: string
    item: string
    template: string
    current_state: string
  }>
  const latest = new Map<string, (typeof instances)[number]>()
  for (const i of instances) if (!latest.has(String(i.item))) latest.set(String(i.item), i)
  if (latest.size === 0) return out

  const templates = [...new Set([...latest.values()].map((i) => String(i.template)))]
  const [states, transitions] = await Promise.all([
    db('nivaro_workflow_states')
      .whereIn('template', templates)
      .select('id', 'key', 'sort') as Promise<
      Array<{ id: string; key: string; sort: number | null }>
    >,
    db('nivaro_workflow_transitions')
      .whereIn('template', templates)
      .orderBy('sort')
      .select(
        'id',
        'template',
        'from_state',
        'to_state',
        'label',
        'sort',
        'auto_trigger',
        'condition_rules',
        'required_roles',
        'requirements'
      ) as Promise<TransitionRow[]>
  ])
  const stateById = new Map(states.map((s) => [String(s.id).toUpperCase(), s]))
  const {
    evaluateConditionRules,
    evalConditionRule,
    fetchRecordForConditions,
    parseConditionRules
  } = await import('./workflow-conditions.js')
  const { evaluateTransitionRequirements } = await import('./transition-requirements.js')

  await pool([...latest.values()], 6, async (inst) => {
    try {
      await blockersForInstance(inst)
    } catch {
      out.set(String(inst.item), null)
    }
  })
  return out

  async function blockersForInstance(inst: (typeof instances)[number]): Promise<void> {
    const current = stateById.get(String(inst.current_state).toUpperCase())
    const candidates = transitions.filter((t) => {
      if (String(t.template) !== String(inst.template)) return false
      if (truthy(t.auto_trigger)) return false
      if (
        t.from_state != null &&
        String(t.from_state).toUpperCase() !== String(inst.current_state).toUpperCase()
      )
        return false
      const to = stateById.get(String(t.to_state).toUpperCase())
      if (!to || String(to.key).toLowerCase() === 'canceled') return false
      if (isSendBackEdge(current?.sort, to.sort, t.label, current?.key)) return false
      // required_roles is deliberately NOT applied: readiness is about the
      // RECORD, not whether the viewer may press the button — a creator's
      // draft waiting on an approver-only step still has its gaps listed.
      return !(current?.sort != null && to.sort != null && Number(to.sort) <= Number(current.sort))
    })
    if (candidates.length === 0) return
    let pick: TransitionRow | undefined
    const withRules = candidates.filter((t) => t.condition_rules)
    const record =
      withRules.length > 0
        ? await fetchRecordForConditions(
            collection,
            String(inst.item),
            withRules.map((t) => t.condition_rules),
            { strict: true }
          )
        : {}
    let firstFailing: { transition: TransitionRow; rule: ConditionRuleLike | null } | null = null
    for (const t of candidates) {
      if (t.condition_rules && !evaluateConditionRules(t.condition_rules, record)) {
        if (!firstFailing) {
          const rule =
            (parseConditionRules(t.condition_rules) ?? []).find(
              (r) => !evalConditionRule(r, record)
            ) ?? null
          firstFailing = { transition: t, rule }
        }
        continue
      }
      pick = t
      break
    }
    if (!pick && firstFailing) {
      // Every way forward is closed by its conditions — say which one.
      const why = firstFailing.rule
        ? describeConditionRule(firstFailing.rule)
        : 'Its conditions are not met'
      out.set(String(inst.item), [
        {
          kind: 'requirement',
          label: 'No forward step available',
          message: `“${firstFailing.transition.label}”: ${why}`
        }
      ])
      return
    }
    if (!pick?.requirements) return
    const blocks = await evaluateTransitionRequirements(
      db,
      pick.requirements,
      String(inst.item),
      undefined,
      collection,
      // Fail closed: a read that fails inside the check throws, so the
      // per-instance catch marks the record unknown instead of "ready".
      { strict: true }
    )
    if (!blocks) return
    const list: ReadinessBlocker[] = []
    for (const b of blocks) {
      if (b.type === 'record_fields') {
        if (b.optional) continue
        const missing = b.fields.filter((f) => isEmptyValue(b.values[f.field]))
        if (missing.length === 0) continue
        list.push({
          kind: 'requirement',
          label: b.title,
          message: `Before “${pick.label}”: ${missing.map((f) => f.label).join(', ')} needed`
        })
      } else {
        const incomplete = b.rows.filter((r) => !r.complete).length
        if (incomplete === 0) continue
        list.push({
          kind: 'requirement',
          label: b.title,
          message: `Before “${pick.label}”: ${incomplete} of ${b.rows.length} lines need ${b.fields
            .map((f) => f.label)
            .join(', ')}`
        })
      }
    }
    if (list.length > 0) out.set(String(inst.item), list)
  }
}

export interface ConditionRuleLike {
  field: string
  op: string
  value: string | number | null
}

function fieldWords(field: string): string {
  return field
    .split('.')
    .map((seg) => titleCase(seg))
    .join(' › ')
}

/** A transition condition rule in words: 'Vendor must be set',
 *  'Needs at least one Workflow Line Items row'. */
export function describeConditionRule(rule: ConditionRuleLike): string {
  const op = String(rule.op)
  const value = rule.value == null ? '' : String(rule.value)
  if (op === 'related_some' || op === 'related_none') {
    const child = fieldWords(String(rule.field).split(':')[0] ?? '')
    return op === 'related_some'
      ? `Needs at least one ${child} row`
      : `Must have no matching ${child} rows`
  }
  const f = fieldWords(String(rule.field))
  switch (op) {
    case 'nnull':
      return `${f} must be set`
    case 'null':
      return `${f} must be empty`
    case 'eq':
      return `${f} must be ${value}`
    case 'neq':
      return `${f} must not be ${value}`
    case 'in':
      return `${f} must be one of ${value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .join(', ')}`
    case 'notin':
      return `${f} must not be any of ${value}`
    case 'contains':
      return `${f} must contain ${value}`
    case 'gt':
      return `${f} must be more than ${value}`
    case 'gte':
      return `${f} must be at least ${value}`
    case 'lt':
      return `${f} must be less than ${value}`
    case 'lte':
      return `${f} must be at most ${value}`
    case 'within_days':
      return `${f} must be within ${value} days`
    case 'beyond_days':
      return `${f} must be more than ${value} days away`
    default:
      return `${f} ${op.replace(/_/g, ' ')} ${value}`.trim()
  }
}

/**
 * For each of the viewer's own records (admins: any record), what still
 * stands between it and its next step: required fields left empty, a
 * required line set with no lines, and the requirements gate of the first
 * manual forward transition. Ids the viewer did not create are left out.
 */
export async function submissionReadiness(opts: {
  user: User
  isAdmin: boolean
  collection: string
  ids: string[]
}): Promise<Record<string, { ready: boolean; blockers: ReadinessBlocker[] }>> {
  const { collection } = opts
  const out: Record<string, { ready: boolean; blockers: ReadinessBlocker[] }> = {}
  if (!IDENT.test(collection) || SYSTEM.test(collection)) return out
  const readable = await readableFilter(opts.user, opts.isAdmin, [collection])
  if (!readable.has(collection)) return out
  const ids = [...new Set(opts.ids.map(String).filter(Boolean))]
  if (ids.length === 0) return out

  let owned: string[]
  if (opts.isAdmin) {
    owned = (
      (await db(collection)
        .whereIn('id', ids)
        .pluck('id')
        .catch(() => [])) as unknown[]
    ).map(String)
  } else {
    const col = (await creatorColumns([collection])).get(collection)
    if (!col) return out
    owned = (
      (await db(collection)
        .whereIn('id', ids)
        .where(col, String(opts.user.id))
        .pluck('id')
        .catch(() => [])) as unknown[]
    ).map(String)
  }
  // Answer in the caller's spelling of each id.
  const ownedSet = new Set(owned.map((id) => id.toUpperCase()))
  const mine = (
    await visibleRecords(
      opts.user,
      opts.isAdmin,
      ids.filter((id) => ownedSet.has(id.toUpperCase())).map((item) => ({ collection, item }))
    )
  ).map((r) => r.item)
  if (mine.length === 0) return out

  const [fields, reqs] = await Promise.all([
    fieldBlockers(collection, mine).catch(() => null),
    requirementBlockers(collection, mine).catch(() => null)
  ])
  return assembleReadiness(mine, fields, reqs)
}

/**
 * One readiness entry per id from the two blocker lookups. A lookup that
 * failed is `null`, and then no id is answered at all; an id whose own entry
 * is `null` (its record could not be read) is left out on its own. An empty
 * blocker list reads as "ready", which a failure must never claim. The
 * client shows no chips for an id it did not get back.
 */
export function assembleReadiness(
  ids: string[],
  fields: BlockerLookup | null,
  reqs: BlockerLookup | null
): Record<string, { ready: boolean; blockers: ReadinessBlocker[] }> {
  const out: Record<string, { ready: boolean; blockers: ReadinessBlocker[] }> = {}
  if (!fields || !reqs) return out
  const pick = (m: BlockerLookup, id: string): ReadinessBlocker[] | null => {
    if (m.has(id)) return m.get(id) ?? null
    const hit = [...m.entries()].find(([k]) => k.toUpperCase() === id.toUpperCase())
    return hit ? hit[1] : []
  }
  for (const id of ids) {
    const f = pick(fields, id)
    const r = pick(reqs, id)
    if (!f || !r) continue
    const blockers = [...f, ...r]
    out[id] = { ready: blockers.length === 0, blockers }
  }
  return out
}

// ── My throughput ───────────────────────────────────────────────────────────

export interface ThroughputRow {
  at: Date | string
  send_back: boolean
  completion: boolean
  tta_hours: number | null
}

interface Counts {
  transitions: number
  send_backs: number
  completions: number
}

export interface ThroughputSummary {
  this_week: Counts
  median: Counts
  time_to_action_hours: { this_week: number | null; median: number | null }
  send_back_ratio: number | null
}

/** Days since the epoch of `d`'s calendar date in `tz` (UTC when unreadable). */
function localEpochDay(d: Date, tz: string): number {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(d)
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(d)
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  return Math.floor(Date.UTC(get('year'), get('month') - 1, get('day')) / 86_400_000)
}

/** The epoch day of the Monday that starts `d`'s week in `tz`. */
function mondayOf(d: Date, tz: string): number {
  const day = localEpochDay(d, tz)
  const weekday = new Date(day * 86_400_000).getUTCDay() // 0 = Sunday
  return day - ((weekday + 6) % 7)
}

/**
 * Bucket a person's moves into Monday-based weeks in their own time zone:
 * this week on its own, and the median of the `weeks` whole weeks before it
 * (a week with nothing in it counts as a zero). Time to action = hours from
 * the record's previous move to this one — this week's median beside the
 * median over the earlier weeks. The send-back ratio is over the whole window.
 */
export function weekBuckets(
  rows: ThroughputRow[],
  weeks: number,
  now: Date = new Date(),
  tz = 'UTC'
): ThroughputSummary {
  const thisMonday = mondayOf(now, tz)
  const zero = (): Counts => ({ transitions: 0, send_backs: 0, completions: 0 })
  const buckets: Counts[] = Array.from({ length: weeks + 1 }, zero)
  const ttaThis: number[] = []
  const ttaPrior: number[] = []
  for (const r of rows) {
    const at = new Date(r.at)
    if (!Number.isFinite(at.getTime())) continue
    const idx = (thisMonday - mondayOf(at, tz)) / 7
    if (idx < 0 || idx > weeks) continue
    const b = buckets[idx]
    b.transitions++
    if (r.send_back) b.send_backs++
    if (r.completion) b.completions++
    if (r.tta_hours != null && Number.isFinite(r.tta_hours)) {
      ;(idx === 0 ? ttaThis : ttaPrior).push(r.tta_hours)
    }
  }
  const prior = buckets.slice(1)
  const med = (k: keyof Counts) => median(prior.map((b) => b[k])) ?? 0
  const total = buckets.reduce((n, b) => n + b.transitions, 0)
  const sendBacks = buckets.reduce((n, b) => n + b.send_backs, 0)
  return {
    this_week: buckets[0],
    median: {
      transitions: med('transitions'),
      send_backs: med('send_backs'),
      completions: med('completions')
    },
    time_to_action_hours: {
      this_week: round1(median(ttaThis)),
      median: round1(median(ttaPrior))
    },
    send_back_ratio: total > 0 ? sendBacks / total : null
  }
}

/** The viewer's own pipeline moves over the last `weeks` weeks plus this one. */
export async function myThroughput(opts: {
  user: User
  weeks: number
}): Promise<ThroughputSummary> {
  const userId = String(opts.user.id)
  const now = new Date()
  const userRow = (await db('nivaro_users')
    .where('id', userId)
    .first('preferences')
    .catch(() => undefined)) as { preferences?: unknown } | undefined
  const tzPref = parsePrefs(userRow?.preferences).timezone
  const tz = typeof tzPref === 'string' && tzPref.trim() !== '' ? tzPref : 'UTC'
  // One spare day either side of the window absorbs any time-zone offset.
  const since = new Date(now.getTime() - ((opts.weeks + 1) * 7 + 1) * 86_400_000)
  const rows = (await db('nivaro_workflow_history as h')
    .leftJoin('nivaro_workflow_states as fs', 'fs.id', 'h.from_state')
    .leftJoin('nivaro_workflow_states as ts', 'ts.id', 'h.to_state')
    .leftJoin('nivaro_workflow_transitions as t', 't.id', 'h.transition')
    .leftJoin('nivaro_workflow_instances as i', 'i.id', 'h.instance')
    .where('h.user', userId)
    .where('h.timestamp', '>=', since)
    .whereNotNull('h.from_state')
    .orderBy('h.timestamp', 'desc')
    .limit(5000)
    .select(
      'h.timestamp',
      'fs.sort as from_sort',
      'ts.sort as to_sort',
      'fs.key as from_key',
      'ts.key as to_key',
      'ts.is_terminal as to_terminal',
      't.label as transition_label',
      'i.started_at',
      db.raw(
        '(SELECT MAX(p.timestamp) FROM nivaro_workflow_history p WHERE p.instance = h.instance AND p.timestamp < h.timestamp) AS prev_at'
      )
    )) as Array<Record<string, unknown>>
  const history: ThroughputRow[] = rows.map((r) => {
    const at = new Date(r.timestamp as string)
    const prevRaw = (r.prev_at ?? r.started_at) as string | Date | null
    const prev = prevRaw ? new Date(prevRaw) : null
    const hours =
      prev && Number.isFinite(prev.getTime()) ? (at.getTime() - prev.getTime()) / 3_600_000 : null
    return {
      at,
      send_back: isSendBackEdge(
        r.from_sort as number | null,
        r.to_sort as number | null,
        r.transition_label as string | null,
        r.from_key as string | null
      ),
      // A cancel lands on a terminal state but finishes nothing.
      completion: truthy(r.to_terminal) && String(r.to_key ?? '').toLowerCase() !== 'canceled',
      tta_hours: hours != null && hours >= 0 ? hours : null
    }
  })
  return weekBuckets(history, opts.weeks, now, tz)
}

// ── Onboarding ──────────────────────────────────────────────────────────────

export interface OnboardingSteps {
  scope_defaults: boolean
  notification_rules: boolean
  timezone: boolean
  watching: boolean
  delegate: boolean
}

/** Which first-week setup steps the person has done. */
export function onboardingSteps(
  prefs: Record<string, unknown> | null,
  scopesCount: number,
  subsCount: number,
  user: { delegate_id?: string | null }
): OnboardingSteps {
  const p = prefs ?? {}
  const np = p.notification_prefs as { matrix?: unknown } | undefined
  const matrix = np?.matrix
  return {
    scope_defaults: scopesCount > 0,
    notification_rules:
      !!matrix && typeof matrix === 'object' && Object.keys(matrix as object).length > 0,
    timezone: typeof p.timezone === 'string' && p.timezone.trim() !== '',
    watching: subsCount > 0,
    delegate: !!user.delegate_id
  }
}

const NEW_WINDOW_MS = 7 * 86_400_000

/** First-week guide state: when the person's role last changed (else when the
 *  account was made), whether that makes them new, and the setup steps. */
export async function onboardingState(opts: { user: User }): Promise<{
  role_changed_at: string | null
  is_new: boolean
  dismissed: boolean
  steps: OnboardingSteps
}> {
  const userId = String(opts.user.id)
  const [row, roleChange, scopes, subs] = await Promise.all([
    db('nivaro_users')
      .where('id', userId)
      .first('preferences', 'delegate_id', 'created_at')
      .catch(() => undefined) as Promise<
      { preferences?: unknown; delegate_id?: string | null; created_at?: Date | null } | undefined
    >,
    db('nivaro_activity as a')
      .join('nivaro_revisions as r', 'r.activity', 'a.id')
      .where('a.collection', 'nivaro_users')
      .whereIn('a.item', [...new Set([userId, userId.toUpperCase(), userId.toLowerCase()])])
      .where('r.delta', 'like', '%"role"%')
      .orderBy('a.timestamp', 'desc')
      .first('a.timestamp')
      .catch(() => undefined) as Promise<{ timestamp?: Date | null } | undefined>,
    import('./user-scopes.js').then((m) => m.getUserScopes(userId)).catch(() => []),
    db('nivaro_notification_subscriptions')
      .where('user', userId)
      .where('is_active', true)
      .count({ n: '*' })
      .first()
      .catch(() => undefined) as Promise<{ n?: number | string } | undefined>
  ])
  const prefs = parsePrefs(row?.preferences)
  const created = row?.created_at ? new Date(row.created_at) : null
  const changed = roleChange?.timestamp ? new Date(roleChange.timestamp) : created
  const now = Date.now()
  const recent = (d: Date | null) =>
    !!d && Number.isFinite(d.getTime()) && now - d.getTime() <= NEW_WINDOW_MS
  const defaults = scopes.filter((s) => s.mode === 'default' && s.values.length > 0).length
  return {
    role_changed_at: changed && Number.isFinite(changed.getTime()) ? changed.toISOString() : null,
    is_new: recent(changed) || recent(created),
    dismissed: truthy(prefs.onboarding_done),
    steps: onboardingSteps(prefs, defaults, Number(subs?.n ?? 0), {
      delegate_id: row?.delegate_id ?? null
    })
  }
}

// ── Integrations summary ────────────────────────────────────────────────────

const PUSH_FAILED = new Set(['failed', 'rejected'])
const PUSH_OK = new Set(['accepted', 'pending', 'submitted'])

export interface IntegrationVerdict {
  verdict: 'healthy' | 'failing' | 'idle'
  failed_24h: number
  last_failure_at: string | null
}

/** A partner's day at a glance: failing when the newest push failed, healthy
 *  when a success landed after the last failure, idle when nothing was sent. */
export function verdictOf(rows: Array<{ status: string; at: Date | string }>): IntegrationVerdict {
  const sorted = [...rows]
    .map((r) => ({ status: String(r.status).toLowerCase(), at: new Date(r.at) }))
    .filter((r) => Number.isFinite(r.at.getTime()))
    .sort((a, b) => b.at.getTime() - a.at.getTime())
  const failures = sorted.filter((r) => PUSH_FAILED.has(r.status))
  let verdict: IntegrationVerdict['verdict'] = 'idle'
  for (const r of sorted) {
    if (PUSH_FAILED.has(r.status)) {
      verdict = 'failing'
      break
    }
    if (PUSH_OK.has(r.status)) {
      verdict = 'healthy'
      break
    }
  }
  return {
    verdict,
    failed_24h: failures.length,
    last_failure_at: failures[0] ? failures[0].at.toISOString() : null
  }
}

/** Every enabled external API with its last-24-hour verdict. Names only —
 *  never hosts or credentials. */
export async function integrationsSummary(): Promise<Array<{ name: string } & IntegrationVerdict>> {
  const since = new Date(Date.now() - 86_400_000)
  const [apis, subs] = await Promise.all([
    db('nivaro_external_apis')
      .where('enabled', true)
      .orderBy('name')
      .select('id', 'name') as Promise<Array<{ id: number; name: string }>>,
    db('nivaro_erp_submissions')
      .where('updated_at', '>=', since)
      .whereNotNull('external_api')
      .orderBy('updated_at', 'desc')
      .limit(5000)
      .select('external_api', 'status', 'updated_at') as Promise<
      Array<{ external_api: number; status: string; updated_at: Date }>
    >
  ])
  const byApi = new Map<number, Array<{ status: string; at: Date }>>()
  for (const s of subs) {
    const list = byApi.get(Number(s.external_api)) ?? []
    list.push({ status: s.status, at: s.updated_at })
    byApi.set(Number(s.external_api), list)
  }
  return apis.map((a) => ({ name: a.name, ...verdictOf(byApi.get(Number(a.id)) ?? []) }))
}

// ── Zone pulse ──────────────────────────────────────────────────────────────

export interface ZonePulse {
  dimension: {
    name: string
    label: string
    target_collection: string
    display_field: string | null
  }
  zones: Array<{
    id: string
    label: string
    open: Record<string, number>
    breached: number
    linked_recent: number
  }>
  /** A readable collection was left out because its reads failed. */
  partial: boolean
  /** A scan stopped at its cap: the counts are a lower bound. */
  truncated: boolean
}

const PULSE_TTL = 5 * 60_000
const PULSE_ZONES = 12
const PULSE_SCAN = 20_000
const PULSE_BREACH_CAP = 2000
const RECENT_COLUMNS = ['date_updated', 'changed', 'updated_at']
const pulseCache = new Map<string, { at: number; value: ZonePulse }>()
interface CollectionTally {
  open: Map<string, number>
  breached: Map<string, number>
  recent: Map<string, number>
  truncated: boolean
}
const tallyCache = new Map<string, { at: number; value: CollectionTally }>()

/** Tally each target id's open records, SLA breaches and recent updates in
 *  one collection, as the viewer can see it (`enforcement` = the viewer's
 *  User Scopes on it). A failed read throws, so nothing is cached for it. */
async function tallyCollection(
  scopes: typeof import('./user-scopes.js'),
  collection: string,
  hops: import('./user-scopes.js').ScopeHop[],
  cacheKey: string,
  enforcement: import('./user-scopes.js').ScopeEnforcement
): Promise<CollectionTally> {
  const hit = tallyCache.get(cacheKey)
  if (hit && Date.now() - hit.at < PULSE_TTL) return hit.value
  let truncated = false
  const visible = (qb: import('knex').Knex.QueryBuilder) =>
    scopes.applyScopeEnforcement(qb, collection, enforcement)
  const needsRecord = enforcement.deny || enforcement.filters.length > 0

  const instQ = db('nivaro_workflow_instances as i')
    .where('i.collection', collection)
    .whereNull('i.completed_at')
    .whereNotNull('i.current_state')
  if (needsRecord) {
    void instQ.whereExists(function () {
      void this.select(db.raw('1'))
        .from(collection)
        .whereRaw('CAST(??.?? AS NVARCHAR(255)) = i.item', [collection, 'id'])
      visible(this)
    })
  }
  const instances = (await instQ
    .orderBy('i.started_at', 'desc')
    .limit(PULSE_SCAN)
    .select('i.id', 'i.item', 'i.current_state', 'i.template', 'i.started_at')) as Array<{
    id: string
    item: string
    current_state: string | null
    template: string
    started_at: Date
  }>
  if (instances.length >= PULSE_SCAN) truncated = true
  const latest = new Map<string, (typeof instances)[number]>()
  for (const i of instances) if (!latest.has(String(i.item))) latest.set(String(i.item), i)

  const zonesOf = async (ids: string[]) => {
    const map = new Map<string, string[]>()
    for (let k = 0; k < ids.length; k += 1500) {
      const part = await scopes.resolveRecordDimensionIds(collection, ids.slice(k, k + 1500), hops)
      for (const [id, zs] of part) map.set(id, zs)
    }
    return map
  }
  const bump = (m: Map<string, number>, z: string) =>
    m.set(z.toUpperCase(), (m.get(z.toUpperCase()) ?? 0) + 1)

  const open = new Map<string, number>()
  const itemsByZone = new Map<string, string[]>()
  const openZones = await zonesOf([...latest.keys()])
  for (const [id, zs] of openZones) {
    for (const z of zs) {
      bump(open, z)
      const list = itemsByZone.get(z.toUpperCase()) ?? []
      if (list.length < PULSE_BREACH_CAP) list.push(id)
      else truncated = true
      itemsByZone.set(z.toUpperCase(), list)
    }
  }

  const breached = new Map<string, number>()
  const statusIds = [...new Set([...itemsByZone.values()].flat())]
  if (statusIds.length > 0) {
    const { computeStatusBatch } = await import('../routes/sla.js')
    const statuses = await computeStatusBatch(
      collection,
      statusIds,
      statusIds.map((id) => latest.get(id)).filter((i) => i != null)
    )
    for (const [z, list] of itemsByZone) {
      breached.set(z, list.filter((id) => statuses[id]?.status === 'breached').length)
    }
  }

  const recent = new Map<string, number>()
  const cols = await physicalColumns(collection)
  const recentCol = RECENT_COLUMNS.find((c) => cols.has(c))
  if (recentCol) {
    const q = db(collection).where(recentCol, '>=', new Date(Date.now() - 7 * 86_400_000))
    visible(q)
    const ids = ((await q.limit(PULSE_SCAN).pluck('id')) as unknown[]).map(String)
    if (ids.length >= PULSE_SCAN) truncated = true
    for (const zs of (await zonesOf(ids)).values()) for (const z of zs) bump(recent, z)
  }

  const value = { open, breached, recent, truncated }
  tallyCache.set(cacheKey, { at: Date.now(), value })
  return value
}

/**
 * Per zone (a scope dimension's target rows — the viewer's own restrictions,
 * else every row, 12 at most): open pipeline records per bound collection,
 * how many of those are past their SLA, and how many records changed in the
 * last 7 days. Counts only what the viewer can read; a collection whose read
 * policy carries a row filter is left out entirely; one whose reads fail is
 * left out too and the answer says `partial`. Cached 5 minutes per viewer and
 * dimension (a partial answer is not cached). Answers null for an unknown
 * dimension; a failed dimension, restriction or zone read throws.
 */
export async function zonePulse(opts: {
  user: User
  isAdmin: boolean
  dimension?: string
}): Promise<ZonePulse | null> {
  const scopes = await import('./user-scopes.js')
  const dims = await scopes.listScopeDimensions()
  const dim = opts.dimension ? dims.find((d) => d.name === opts.dimension) : dims[0]
  if (!dim || !IDENT.test(dim.target_collection) || SYSTEM.test(dim.target_collection)) return null
  const userId = String(opts.user.id)
  const cacheKey = `${userId.toUpperCase()}|${dim.name}`
  const hit = pulseCache.get(cacheKey)
  if (hit && Date.now() - hit.at < PULSE_TTL) return hit.value

  const target = dim.target_collection
  const display = dim.display_field && IDENT.test(dim.display_field) ? dim.display_field : null
  const restricted = opts.isAdmin
    ? []
    : (await scopes.getUserScopes(userId))
        .filter((s) => s.mode === 'restrict' && s.dimension === dim.name)
        .flatMap((s) => s.values)
  const cols = ['id', ...(display ? [display] : [])]
  let zoneRows: Array<Record<string, unknown>>
  if (restricted.length > 0) {
    zoneRows = (await db(target)
      .whereIn('id', restricted.slice(0, PULSE_ZONES) as never)
      .select(cols)) as Array<Record<string, unknown>>
  } else {
    const sortRaw = dim.options_sort ?? display ?? 'id'
    const desc = sortRaw.startsWith('-')
    const sortCol = desc ? sortRaw.slice(1) : sortRaw
    zoneRows = (await db(target)
      .orderBy(IDENT.test(sortCol) ? sortCol : 'id', desc ? 'desc' : 'asc')
      .limit(PULSE_ZONES)
      .select(cols)) as Array<Record<string, unknown>>
  }

  const bound = await boundCollections()
  const readable = await readableFilter(opts.user, opts.isAdmin, bound)
  const tallies = new Map<string, CollectionTally>()
  let partial = false
  let truncated = false
  await pool([...readable], 3, async (collection) => {
    try {
      // A row-filtered read policy (RLS) cannot be honoured by raw counts —
      // the collection is left out rather than over-counted (the ai-chat
      // aggregate precedent).
      const rowFiltered = opts.isAdmin
        ? false
        : await getRowFilter(opts.user, 'read', collection).then(
            (rf) => Array.isArray(rf) && rf.length > 0
          )
      if (rowFiltered) return
      const hops = await scopes.scopeHopsFor(dim, collection)
      if (!hops) return
      const enforcement = await scopes.getUserScopeEnforcement(opts.user, collection)
      const tally = await tallyCollection(
        scopes,
        collection,
        hops,
        `${collection}|${dim.name}|${JSON.stringify(enforcement)}`,
        enforcement
      )
      tallies.set(collection, tally)
      if (tally.truncated) truncated = true
    } catch {
      // Left out, and said so — never counted as zero.
      partial = true
    }
  })

  const value: ZonePulse = {
    dimension: {
      name: dim.name,
      label: dim.label,
      target_collection: target,
      display_field: dim.display_field
    },
    zones: zoneRows.map((z) => {
      const id = String(z.id)
      const key = id.toUpperCase()
      const open: Record<string, number> = {}
      let breached = 0
      let linked = 0
      for (const [collection, t] of tallies) {
        open[collection] = t.open.get(key) ?? 0
        breached += t.breached.get(key) ?? 0
        linked += t.recent.get(key) ?? 0
      }
      const label = display && z[display] != null ? String(z[display]) : `#${id}`
      return { id, label, open, breached, linked_recent: linked }
    }),
    partial,
    truncated
  }
  if (!partial) pulseCache.set(cacheKey, { at: Date.now(), value })
  return value
}
