/**
 * Change feed (changes_since, #3221) — "what changed since I last looked?" for a client that
 * cannot hold a live session (an MCP agent, a nightly sync, a script).
 *
 * The feed is the activity log read forward by id: every create, update and delete a record
 * write logs (collections whose audit level is "none" log nothing and never appear). It
 * answers record ids, the action and the changed field NAMES only — never a value, never who
 * made the change (the same rule realtime payloads follow) — and only for records the caller
 * can see NOW, judged with the record-room gate (role read permission, then row filters and
 * User Scopes through record-access; an API key's collection scopes first). Field names are
 * cut to the caller's read list. A delete is listed only where the caller could have seen any
 * record of the collection (unrestricted reads), or the caller deleted it themselves: a
 * deleted row can no longer be judged, and its id must not leak past a scope.
 *
 * The cursor is opaque: the last activity id the caller has been given up to. Rows newer than
 * a few seconds wait for the next call, so a write whose activity id was taken before a
 * slower write committed is never stepped over.
 */
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { checkApiKeyScope } from '../middleware/authenticate.js'
import type { User } from '../types.js'
import { chunkArray } from './db-batch.js'
import { can } from './permissions.js'
import { compileAccessGates } from './record-access.js'
import { keepReadable, readableFieldSet } from './revision-fields.js'
import { visibleRecordIds } from './socket-access.js'

export const FEED_ACTIONS = ['create', 'update', 'delete'] as const
export type FeedAction = (typeof FEED_ACTIONS)[number]

/** Most changes one page answers / most activity rows one call reads. */
export const MAX_CHANGES = 500
export const DEFAULT_CHANGES = 100
export const SCAN_MAX = 1000
/** Rows younger than this wait for the next call (see the module note). */
export const SETTLE_MS = 3000
/** Most collections a caller may name. */
export const MAX_COLLECTIONS = 50

/** Audit stamps move on every write; they are not what a reader means by "changed". */
const STAMP_FIELDS = new Set(['updated_at', 'date_updated', 'user_updated', 'changed'])
const NAME_RE = /^[A-Za-z0-9_]{1,128}$/
const SYSTEM_RE = /^(nivaro_|directus_)/i

export interface FeedChange {
  collection: string
  id: string
  /** create / update / delete; a record created and changed in one page reads create. */
  action: FeedAction
  /** update: the fields that changed (names only, readable ones); absent when unknown. */
  fields?: string[]
  at: string
}

export interface FeedPage {
  changes: FeedChange[]
  /** Pass back as `cursor` for the next page. */
  cursor: string
  /** More changes are already waiting: call again at once. */
  has_more: boolean
  /** Named collections the caller cannot read (or that do not exist). */
  not_readable?: string[]
  notes?: string[]
}

// ── Cursor ───────────────────────────────────────────────────────────────────

export function encodeCursor(activityId: number): string {
  return `c1.${Buffer.from(JSON.stringify({ a: activityId })).toString('base64url')}`
}

/** The activity id a cursor carries, or null for a cursor this feed did not make. */
export function decodeCursor(cursor: string): number | null {
  if (typeof cursor !== 'string' || !cursor.startsWith('c1.')) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString('utf8'))
    const a = Number(parsed?.a)
    return Number.isSafeInteger(a) && a >= 0 ? a : null
  } catch {
    return null
  }
}

// ── Folding ──────────────────────────────────────────────────────────────────

export interface FeedRow {
  id: number
  action: string
  collection: string
  item: string
  timestamp: Date | string
  /** Changed field names (updates with a revision), already cut and stamp-free. */
  fields?: string[] | null
}

/**
 * Rows (in id order) folded to one change per record, newest last: a create followed by
 * updates stays a create, anything followed by a delete is a delete, updates union their
 * field names (unknown if any update did not say). Stops at `limit` records; `consumed` is
 * how many rows were folded, so the cursor never steps past a row that did not fit.
 */
export function foldChanges(
  rows: FeedRow[],
  limit: number
): { changes: FeedChange[]; consumed: number } {
  const byKey = new Map<string, FeedChange & { unknownFields?: boolean; last: number }>()
  let consumed = 0
  for (const r of rows) {
    const key = `${r.collection}\u0001${String(r.item).toLowerCase()}`
    const hit = byKey.get(key)
    if (!hit && byKey.size >= limit) break
    consumed++
    const at = r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp)
    const action = r.action as FeedAction
    if (!hit) {
      byKey.set(key, {
        collection: r.collection,
        id: String(r.item),
        action,
        ...(action === 'update' && r.fields ? { fields: [...r.fields] } : {}),
        ...(action === 'update' && !r.fields ? { unknownFields: true } : {}),
        at,
        last: r.id
      })
      continue
    }
    hit.at = at
    hit.last = r.id
    if (action === 'delete') {
      hit.action = 'delete'
      delete hit.fields
      continue
    }
    if (hit.action === 'delete' && action === 'create') {
      hit.action = 'create'
      delete hit.fields
      continue
    }
    if (action === 'update' && hit.action === 'update') {
      if (!r.fields) hit.unknownFields = true
      else hit.fields = [...new Set([...(hit.fields ?? []), ...r.fields])]
    }
  }
  const changes = [...byKey.values()]
    .sort((a, b) => a.last - b.last)
    .map(({ unknownFields, last: _last, ...c }) => {
      if (unknownFields) delete c.fields
      return c
    })
  return { changes, consumed }
}

/** Field names of an activity row's revision delta, without the audit stamps. */
export function deltaFieldNames(delta: unknown): string[] | null {
  let obj: unknown = delta
  if (typeof delta === 'string') {
    try {
      obj = JSON.parse(delta)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  return Object.keys(obj as Record<string, unknown>).filter((k) => !STAMP_FIELDS.has(k))
}

// ── The read ─────────────────────────────────────────────────────────────────

export interface FeedRequest {
  cursor?: string
  /** ISO time: start the feed here (only without a cursor). */
  since?: string
  collections?: string[]
  limit?: number
}

export class FeedRefusal extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message)
  }
}

/** Where a feed without a cursor starts: the last activity before `since`, or the newest. */
async function startingPoint(since: string | undefined): Promise<number> {
  if (since) {
    const at = new Date(since)
    if (!Number.isFinite(at.getTime()))
      throw new FeedRefusal(400, 'BAD_SINCE', 'since must be an ISO date or time')
    const row = (await db('nivaro_activity')
      .where('timestamp', '<', at)
      .orderBy([
        { column: 'timestamp', order: 'desc' },
        { column: 'id', order: 'desc' }
      ])
      .first('id')) as { id?: number } | undefined
    return Number(row?.id ?? 0)
  }
  const row = (await db('nivaro_activity').max({ id: 'id' }).first()) as
    | { id?: number | null }
    | undefined
  return Number(row?.id ?? 0)
}

/** Whether a delete in `collection` may be listed to this caller (see the module note). */
async function deletesListable(
  user: User,
  collection: string,
  admin: boolean,
  keyNarrowed: boolean
): Promise<boolean> {
  if (admin) return true
  if (keyNarrowed && (user.api_key_scope_restrictions?.length ?? 0) > 0) return false
  try {
    const g = await compileAccessGates(user, collection)
    return g.permitted && !g.rowFilter && g.scopes.length === 0 && !g.strict
  } catch {
    return false
  }
}

export async function readChangeFeed(req: FastifyRequest, ask: FeedRequest): Promise<FeedPage> {
  const user = req.user as User
  const limit = Math.min(
    Math.max(Math.trunc(Number(ask.limit ?? DEFAULT_CHANGES)) || DEFAULT_CHANGES, 1),
    MAX_CHANGES
  )
  let after: number
  if (ask.cursor) {
    const decoded = decodeCursor(ask.cursor)
    if (decoded === null)
      throw new FeedRefusal(400, 'BAD_CURSOR', 'That cursor was not made by this feed')
    after = decoded
  } else {
    after = await startingPoint(ask.since)
    if (!ask.since)
      return {
        changes: [],
        cursor: encodeCursor(after),
        has_more: false,
        notes: ['Starting from now. Pass this cursor next time to get what changed since.']
      }
  }

  // An API key narrows even an administrator (its collection scopes, then the full gate).
  const keyNarrowed = !!(user.api_key_scopes || user.api_key_scope_restrictions?.length)
  const admin = !!req.isAdmin && !keyNarrowed
  const readableCache = new Map<string, Promise<boolean>>()
  const readable = (c: string) => {
    let hit = readableCache.get(c)
    if (!hit) {
      hit = (async () =>
        NAME_RE.test(c) &&
        !SYSTEM_RE.test(c) &&
        checkApiKeyScope(req, 'read', c) &&
        (await can(user, 'read', c).catch(() => false)))()
      readableCache.set(c, hit)
    }
    return hit
  }

  let named: string[] | null = null
  const notReadable: string[] = []
  if (ask.collections?.length) {
    const unique = [...new Set(ask.collections.map((c) => String(c).trim()).filter(Boolean))]
    if (unique.length > MAX_COLLECTIONS)
      throw new FeedRefusal(
        400,
        'TOO_MANY_COLLECTIONS',
        `Name at most ${MAX_COLLECTIONS} collections`
      )
    named = []
    for (const c of unique) {
      if (await readable(c)) named.push(c)
      else notReadable.push(c)
    }
    if (named.length === 0)
      return {
        changes: [],
        cursor: encodeCursor(after),
        has_more: false,
        not_readable: notReadable
      }
  }

  const q = db('nivaro_activity')
    .where('id', '>', after)
    .whereIn('action', FEED_ACTIONS as unknown as string[])
    .whereNotNull('collection')
    .whereNotNull('item')
    .orderBy('id', 'asc')
    .limit(SCAN_MAX)
    .select('id', 'action', 'collection', 'item', 'timestamp', 'user')
  if (named) q.whereIn('collection', named)
  else q.whereNot('collection', 'like', 'nivaro_%').whereNot('collection', 'like', 'directus_%')
  const scanned = (await q) as Array<{
    id: number
    action: string
    collection: string
    item: string | number
    timestamp: Date | string
    user: string | null
  }>
  const fullScan = scanned.length >= SCAN_MAX

  // Rows still settling wait: stop at the first one (never step over it).
  const settleAt = Date.now() - SETTLE_MS
  let settled = scanned.length
  for (let i = 0; i < scanned.length; i++) {
    const t = new Date(scanned[i].timestamp).getTime()
    if (Number.isFinite(t) && t > settleAt) {
      settled = i
      break
    }
  }
  const rows = scanned.slice(0, settled)

  // Field names of updates, from their revisions.
  const updateIds = rows.filter((r) => r.action === 'update').map((r) => r.id)
  const deltas = new Map<number, string[] | null>()
  for (const ids of chunkArray(updateIds, 1000)) {
    const revs = (await db('nivaro_revisions')
      .whereIn('activity', ids)
      .select('activity', 'delta')) as Array<{ activity: number; delta: unknown }>
    for (const r of revs) deltas.set(Number(r.activity), deltaFieldNames(r.delta))
  }

  // Who may see what: per collection, the live records the caller can see now.
  const me = String(user.id).toLowerCase()
  const byCollection = new Map<string, typeof rows>()
  for (const r of rows) {
    const list = byCollection.get(r.collection) ?? []
    list.push(r)
    byCollection.set(r.collection, list)
  }
  const visible = new Set<string>()
  let deletesHidden = false
  const fieldSets = new Map<string, Set<string> | null>()
  for (const [collection, list] of byCollection) {
    if (!(await readable(collection))) continue
    fieldSets.set(collection, await readableFieldSet(user, collection).catch(() => new Set(['id'])))
    const live = [...new Set(list.filter((r) => r.action !== 'delete').map((r) => String(r.item)))]
    for (const ids of chunkArray(live, 500)) {
      for (const id of await visibleRecordIds(user, collection, ids, admin))
        visible.add(`${collection}\u0001${String(id).toLowerCase()}`)
    }
    const deletes = list.filter((r) => r.action === 'delete')
    if (deletes.length > 0) {
      const listable = await deletesListable(user, collection, admin, keyNarrowed)
      for (const r of deletes) {
        if (listable || String(r.user ?? '').toLowerCase() === me)
          visible.add(`${collection}\u0001del\u0001${r.id}`)
        else deletesHidden = true
      }
    }
  }

  const feedRows: FeedRow[] = []
  for (const r of rows) {
    const shown =
      r.action === 'delete'
        ? visible.has(`${r.collection}\u0001del\u0001${r.id}`)
        : visible.has(`${r.collection}\u0001${String(r.item).toLowerCase()}`)
    if (!shown) continue
    let fields: string[] | null | undefined
    if (r.action === 'update') {
      const names = deltas.get(r.id) ?? null
      fields = names ? keepReadable(names, fieldSets.get(r.collection) ?? null) : null
    }
    feedRows.push({ ...r, item: String(r.item), fields })
  }

  const folded = foldChanges(feedRows, limit)
  // The cursor moves past every row read — the hidden ones too, so a page of rows the caller
  // cannot see still makes progress — but never past a visible row that did not fit.
  let cursorId = rows.length > 0 ? rows[rows.length - 1].id : after
  let stoppedByLimit = false
  if (folded.consumed < feedRows.length) {
    stoppedByLimit = true
    cursorId = feedRows[folded.consumed].id - 1
  }
  const notes: string[] = []
  if (deletesHidden)
    notes.push(
      'Deletes in collections where you see only some records are not listed: check the records you hold with read_item.'
    )
  return {
    changes: folded.changes,
    cursor: encodeCursor(Math.max(cursorId, after)),
    has_more: stoppedByLimit || (fullScan && settled === scanned.length),
    ...(notReadable.length > 0 ? { not_readable: notReadable } : {}),
    ...(notes.length > 0 ? { notes } : {})
  }
}
