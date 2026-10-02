// api/src/services/traffic-inspect/record.ts
/**
 * Traffic Map drill-down, group "record" (#1192 #1193 #1194 #1201): the inspect sources for
 *   chain     — an integration event chain drawn as its path (id = chain uuid)
 *   recording — a session replay seeked to a moment (id = recording uuid, or `for:<user uuid>`
 *               to find the one covering `?at=`)
 *   record    — one business record read AS THE CALLER, with its writes near the moment
 *               (id = `collection:id`)
 *   write     — one nivaro_activity row and its field delta (id = activity id)
 *   issue     — one nivaro_issues row (id = issue id, or `rid:<request uuid>` = the open server
 *               issue that request raised, matched by its error fingerprint — route + message
 *               — with a route-only fallback the answer names)
 * Sources register at module load; routes/traffic-map-extras/inspect-record.ts imports this.
 */
import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import type { User } from '../../types.js'
import { hasChainColumns } from '../chain-columns.js'
import { issueFingerprint, issueMessage } from '../error-tracking.js'
import { buildChainPath } from '../event-path/index.js'
import {
  CollectionNotFoundError,
  ForbiddenError,
  ItemNotFoundError,
  RouteOnlyCollectionError,
  readOne
} from '../items.js'
import { labelledChanges } from '../mail-types.js'
import { getLabels } from '../queues.js'
import { type InspectCtx, type InspectPeek, registerInspectSource } from '../traffic-inspect.js'
import { messageOfBody } from '../traffic-taps/error-groups.js'
import {
  API_LOG_RETENTION_MS,
  CLIP_SLACK_MS,
  INT_RE,
  type IssueMatchBy,
  parseIssueId,
  parseRecordId,
  parseRecordingId,
  pickIssueForRequest,
  pickRecordingFor,
  type RecordingPick,
  type RecordingRow,
  recordingEnd,
  shapeWriteDelta,
  splitIssueDetails,
  toMs,
  touchesNote,
  UUID_RE
} from './record-logic.js'

const WRITE_ACTIONS = ['create', 'update', 'delete']
/** Data URIs larger than this are left out of the issue detail (a screenshot is ~50–400 KB). */
const SCREENSHOT_MAX_CHARS = 3_000_000

function iso(v: unknown): string | null {
  const t = toMs(v)
  return t == null ? null : new Date(t).toISOString()
}

function personName(r: Record<string, unknown> | undefined | null): string | null {
  if (!r) return null
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
  return name || (r.email ? String(r.email) : null)
}

async function userNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const clean = [...new Set(ids.filter((x): x is string => !!x && UUID_RE.test(String(x))))]
  const out = new Map<string, string>()
  if (!clean.length) return out
  const rows = (await db('nivaro_users')
    .whereIn('id', clean)
    .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
  for (const r of rows) {
    const n = personName(r)
    if (n) out.set(String(r.id).toUpperCase(), n)
  }
  return out
}

function nameOf(names: Map<string, string>, id: unknown): string | null {
  return id ? (names.get(String(id).toUpperCase()) ?? null) : null
}

/** The request that started a chain: its api-log row with no chain_parent. */
async function chainRequest(
  chainId: string
): Promise<{ log_id: string; request_id: string | null; at: string | null } | null> {
  if (!(await hasChainColumns('nivaro_api_logs'))) return null
  const withRid = await hasColumn('nivaro_api_logs', 'request_id')
  const row = (await db('nivaro_api_logs')
    .where('chain_id', chainId)
    .whereNull('chain_parent')
    .orderBy('id')
    .first(['id', 'created_at', ...(withRid ? ['request_id'] : [])])) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  return {
    log_id: String(row.id),
    request_id: row.request_id ? String(row.request_id) : null,
    at: iso(row.created_at)
  }
}

// ── chain ────────────────────────────────────────────────────────────────────────────────────

async function chainDetail(id: string): Promise<unknown | null> {
  const chainId = id.toLowerCase()
  const path = await buildChainPath(chainId, { isAdmin: true })
  if (!path) return null
  const req = await chainRequest(chainId).catch(() => null)
  const rootAt = toMs(path.root.at)
  let note: string | null = null
  if (req && !req.request_id)
    note = 'The request that started this chain was logged before request ids existed.'
  else if (!req)
    note = path.root.key.startsWith('request:')
      ? rootAt != null && Date.now() - rootAt > API_LOG_RETENTION_MS
        ? 'The request that started this chain is older than API log retention (14 days).'
        : 'The request that started this chain has no API log row (not flushed yet, or not logged).'
      : 'No inbound request started this chain (a schedule, an import or a feed did).'
  return { chain_id: chainId, path, request: req, request_note: note }
}

async function chainPeek(id: string): Promise<InspectPeek | null> {
  const chainId = id.toLowerCase()
  const lines: string[] = []
  let at: number | null = null
  if (await hasChainColumns('nivaro_api_logs')) {
    const row = (await db('nivaro_api_logs')
      .where('chain_id', chainId)
      .whereNull('chain_parent')
      .orderBy('id')
      .first('method', 'path', 'status', 'created_at')) as Record<string, unknown> | undefined
    if (row) {
      lines.push(`${row.method} ${row.path} · ${row.status}`)
      at = toMs(row.created_at)
    }
  }
  if (await hasChainColumns('nivaro_activity')) {
    const c = (await db('nivaro_activity')
      .where('chain_id', chainId)
      .whereIn('action', WRITE_ACTIONS)
      .count('* as n')
      .first()) as { n?: number | string } | undefined
    const n = Number(c?.n ?? 0)
    lines.push(n === 1 ? '1 write' : `${n} writes`)
  }
  return { title: `Path ${chainId.slice(0, 8)}`, lines, at }
}

// ── recording ────────────────────────────────────────────────────────────────────────────────

async function recordingSwitches(): Promise<{ recordingOn: boolean; clipsOn: boolean }> {
  const [hasRec, hasClip] = await Promise.all([
    hasColumn('nivaro_settings', 'session_recording_enabled'),
    hasColumn('nivaro_settings', 'error_replay_enabled')
  ])
  const cols = [
    ...(hasRec ? ['session_recording_enabled'] : []),
    ...(hasClip ? ['error_replay_enabled'] : [])
  ]
  if (!cols.length) return { recordingOn: false, clipsOn: false }
  const row = (await db('nivaro_settings').first(cols)) as Record<string, unknown> | undefined
  return {
    recordingOn: !!row?.session_recording_enabled,
    clipsOn: !!row?.error_replay_enabled
  }
}

/** The recording that shows what `user` saw at `at` (see pickRecordingFor). */
export async function recordingFor(user: string, at: number): Promise<RecordingPick> {
  const rows = (await db('nivaro_session_recordings')
    .where('user', user)
    .where('started_at', '<=', new Date(at + CLIP_SLACK_MS))
    .whereRaw('COALESCE(last_event_at, ended_at, started_at) >= ?', [new Date(at - CLIP_SLACK_MS)])
    .orderBy('started_at', 'desc')
    .limit(40)
    .select(
      'id',
      'user',
      'app',
      'started_at',
      'ended_at',
      'last_event_at',
      'event_count'
    )) as RecordingRow[]
  const sw = await recordingSwitches()
  return pickRecordingFor(rows, at, { now: Date.now(), ...sw })
}

async function recordingRow(id: string): Promise<Record<string, unknown> | null> {
  const row = (await db('nivaro_session_recordings as r')
    .leftJoin('nivaro_users as u', 'u.id', 'r.user')
    .where('r.id', id)
    .first(
      'r.id',
      'r.user',
      'r.app',
      'r.origin',
      'r.started_at',
      'r.ended_at',
      'r.last_event_at',
      'r.event_count',
      'r.byte_size',
      'r.truncated',
      'u.first_name',
      'u.last_name',
      'u.email'
    )) as Record<string, unknown> | undefined
  return row ?? null
}

function recordingWire(r: Record<string, unknown>) {
  const end = recordingEnd(r as unknown as RecordingRow)
  return {
    id: String(r.id),
    user: r.user ? String(r.user) : null,
    user_name: personName(r),
    app: r.app ? String(r.app) : null,
    clip: r.app === 'error-clip',
    origin: r.origin ? String(r.origin) : null,
    started_at: iso(r.started_at),
    ended_at: iso(r.ended_at),
    last_event_at: iso(r.last_event_at),
    event_count: Number(r.event_count ?? 0),
    byte_size: Number(r.byte_size ?? 0),
    truncated: !!r.truncated,
    live: !r.ended_at && end != null && Date.now() - end < 2 * 60_000
  }
}

async function recordingDetail(id: string, ctx: InspectCtx): Promise<unknown | null> {
  const parsed = parseRecordingId(id)
  if (!parsed) return null
  const sw = await recordingSwitches()
  if (parsed.kind === 'for') {
    const at = ctx.at ?? Date.now()
    const names = await userNames([parsed.user])
    const pick = await recordingFor(parsed.user, at)
    if (!pick.found) {
      return {
        none: true,
        reason: pick.reason,
        user: parsed.user,
        user_name: nameOf(names, parsed.user),
        at: new Date(at).toISOString(),
        recording_on: sw.recordingOn
      }
    }
    const row = await recordingRow(pick.id)
    if (!row) return null
    return {
      none: false,
      recording: recordingWire(row),
      offset_ms: pick.offset_ms,
      clip_distance_ms: pick.clip ? pick.distance_ms : null,
      recording_on: sw.recordingOn
    }
  }
  // A recording uuid that is gone (purged after 7 days) is a 404, like every missing thing.
  const row = await recordingRow(parsed.id)
  if (!row) return null
  const start = toMs(row.started_at)
  const offset = ctx.at != null && start != null ? Math.max(0, ctx.at - start) : null
  return {
    none: false,
    recording: recordingWire(row),
    offset_ms: offset,
    recording_on: sw.recordingOn
  }
}

async function recordingPeek(id: string, ctx: InspectCtx): Promise<InspectPeek | null> {
  const parsed = parseRecordingId(id)
  if (!parsed) return null
  if (parsed.kind === 'for') {
    const names = await userNames([parsed.user])
    return {
      title: `Recording of ${nameOf(names, parsed.user) ?? 'this person'}`,
      lines: ['Finds the recording that covers this moment']
    }
  }
  const row = await recordingRow(parsed.id)
  if (!row) return null
  const w = recordingWire(row)
  const start = toMs(row.started_at)
  const end = recordingEnd(row as unknown as RecordingRow)
  const mins = start != null && end != null ? Math.max(0, Math.round((end - start) / 60_000)) : 0
  return {
    title: `${w.clip ? 'Error clip' : 'Recording'} · ${w.user_name ?? 'someone'}`,
    lines: [
      `${mins} min${w.live ? ' · live' : ''}`,
      `${w.event_count.toLocaleString()} events${w.app && !w.clip ? ` · ${w.app}` : ''}`
    ],
    at: ctx.at ?? start
  }
}

// ── record ───────────────────────────────────────────────────────────────────────────────────

function shortValue(v: unknown): string | number | boolean | null {
  if (v == null) return null
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    const s = JSON.stringify(v)
    return s.length > 200 ? `${s.slice(0, 199)}…` : s
  }
  const s = String(v)
  return s.length > 200 ? `${s.slice(0, 199)}…` : s
}

async function touchRows(collection: string, item: string, from?: Date, to?: Date, limit = 50) {
  let q = db('nivaro_activity as a')
    .leftJoin('nivaro_users as u', 'u.id', 'a.user')
    .where('a.collection', collection)
    .where('a.item', item)
    .whereIn('a.action', WRITE_ACTIONS)
  if (from && to) q = q.whereBetween('a.timestamp', [from, to])
  const withOrigin = await hasColumn('nivaro_activity', 'origin')
  const withChain = await hasChainColumns('nivaro_activity')
  const rows = (await q
    .orderBy('a.id', 'desc')
    .limit(limit)
    .select(
      'a.id',
      'a.action',
      'a.timestamp',
      'a.comment',
      'u.first_name',
      'u.last_name',
      'u.email',
      ...(withOrigin ? ['a.origin'] : []),
      ...(withChain ? ['a.chain_id'] : [])
    )) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    action: String(r.action),
    at: iso(r.timestamp),
    who: personName(r),
    origin: r.origin ? String(r.origin) : null,
    comment: r.comment ? String(r.comment).slice(0, 160) : null,
    chain_id: r.chain_id ? String(r.chain_id).toLowerCase() : null
  }))
}

async function inTrash(collection: string, item: string): Promise<boolean> {
  try {
    const row = await db('nivaro_trash').where({ collection, item_id: item }).first('id')
    return !!row
  } catch {
    return false
  }
}

async function recordDetail(id: string, ctx: InspectCtx): Promise<unknown | null> {
  const parsed = parseRecordId(id)
  if (!parsed) return null
  const { collection, item } = parsed
  let values: Record<string, unknown> | null = null
  let reason: string | null = null
  try {
    values = (await readOne(ctx.req.user as User, collection, item)) as Record<string, unknown>
  } catch (err) {
    if (err instanceof CollectionNotFoundError)
      reason = /^(nivaro|directus)_/i.test(collection)
        ? `"${collection}" is a system table, not a browsable collection — its writes are listed below.`
        : `"${collection}" is not a collection Nivaro knows.`
    else if (err instanceof ItemNotFoundError)
      reason = (await inTrash(collection, item))
        ? 'This record was deleted — it is in the trash.'
        : 'No such record — it was deleted, or it never existed.'
    else if (err instanceof ForbiddenError)
      reason = 'Your role cannot read this record (permissions, a row filter or your scopes).'
    else if (err instanceof RouteOnlyCollectionError)
      reason = `"${collection}" is only readable through its own screen (per-room visibility), so its values are not shown here.`
    else throw err
  }
  if (!values && !reason)
    reason = (await inTrash(collection, item))
      ? 'This record was deleted — it is in the trash.'
      : 'No such record — it was deleted, or it never existed.'
  const labels = values
    ? await getLabels(new Map([[collection, new Set([item])]])).catch(
        () => ({}) as Record<string, string>
      )
    : {}
  const at = ctx.at ?? Date.now()
  const from = new Date(at - ctx.windowSec * 1000)
  const to = new Date(at + ctx.windowSec * 1000)
  let touches = await touchRows(collection, item, from, to)
  const totalRow = (await db('nivaro_activity')
    .where({ collection, item })
    .whereIn('action', WRITE_ACTIONS)
    .count('* as n')
    .first()) as { n?: number | string } | undefined
  const total = Number(totalRow?.n ?? 0)
  const inWindow = touches.length
  if (inWindow === 0 && total > 0)
    touches = await touchRows(collection, item, undefined, undefined, 5)
  const shown: Record<string, unknown> = {}
  if (values) {
    for (const k of Object.keys(values).slice(0, 60)) shown[k] = shortValue(values[k])
  }
  return {
    collection,
    item,
    label: labels[`${collection}:${item}`] ?? null,
    exists: !!values,
    reason,
    values: values ? shown : null,
    touches,
    touches_in_window: inWindow,
    touches_total: total,
    touches_note: touchesNote(inWindow, ctx.windowSec, total),
    window_sec: ctx.windowSec
  }
}

async function recordPeek(id: string): Promise<InspectPeek | null> {
  const parsed = parseRecordId(id)
  if (!parsed) return null
  const labels = await getLabels(new Map([[parsed.collection, new Set([parsed.item])]])).catch(
    () => ({}) as Record<string, string>
  )
  const last = await touchRows(parsed.collection, parsed.item, undefined, undefined, 1)
  return {
    title: labels[id] ?? `${parsed.collection} ${parsed.item}`,
    lines: [
      parsed.collection,
      last[0] ? `last ${last[0].action} by ${last[0].who ?? 'someone'}` : 'no recorded writes'
    ],
    at: toMs(last[0]?.at)
  }
}

// ── write ────────────────────────────────────────────────────────────────────────────────────

async function activityRow(id: number): Promise<Record<string, unknown> | null> {
  const opt = await Promise.all([
    hasColumn('nivaro_activity', 'origin'),
    hasChainColumns('nivaro_activity'),
    hasColumn('nivaro_activity', 'auth_method'),
    hasColumn('nivaro_activity', 'api_key_id')
  ])
  const row = (await db('nivaro_activity as a')
    .leftJoin('nivaro_users as u', 'u.id', 'a.user')
    .where('a.id', id)
    .first(
      'a.id',
      'a.action',
      'a.user',
      'a.timestamp',
      'a.ip',
      'a.user_agent',
      'a.collection',
      'a.item',
      'a.comment',
      'u.first_name',
      'u.last_name',
      'u.email',
      ...(opt[0] ? ['a.origin'] : []),
      ...(opt[1] ? ['a.chain_id', 'a.chain_parent'] : []),
      ...(opt[2] ? ['a.auth_method'] : []),
      ...(opt[3] ? ['a.api_key_id'] : [])
    )) as Record<string, unknown> | undefined
  return row ?? null
}

/**
 * May the caller see this record's field values? The same `readOne` gate the record level uses
 * (permissions, tree permission, row filter, route-only collections). A deleted record cannot
 * be read by anyone, so a `delete` write still shows what the record held — nothing is left to
 * filter — while every other refusal hides the old/new values.
 */
async function mayShowValues(
  user: User,
  collection: string,
  item: string,
  action: string
): Promise<{ ok: boolean; note: string | null }> {
  try {
    await readOne(user, collection, item)
    return { ok: true, note: null }
  } catch (err) {
    if (err instanceof ItemNotFoundError && action === 'delete') return { ok: true, note: null }
    if (err instanceof ItemNotFoundError)
      return {
        ok: false,
        note: 'The record cannot be read as you (gone, or outside your row filter), so the values it changed are not shown.'
      }
    if (err instanceof ForbiddenError)
      return {
        ok: false,
        note: 'Your role cannot read this record, so the values this write changed are not shown.'
      }
    if (err instanceof RouteOnlyCollectionError)
      return {
        ok: false,
        note: `"${collection}" is only readable through its own screen, so the values this write changed are not shown.`
      }
    if (err instanceof CollectionNotFoundError)
      return {
        ok: false,
        note: `"${collection}" is not a browsable collection, so the values this write changed are not shown.`
      }
    throw err
  }
}

async function writeDetail(id: string, ctx: InspectCtx): Promise<unknown | null> {
  if (!INT_RE.test(id)) return null
  const row = await activityRow(Number(id))
  if (!row) return null
  const collection = row.collection ? String(row.collection) : null
  const item = row.item != null ? String(row.item) : null
  const gate =
    collection && item
      ? await mayShowValues(ctx.req.user as User, collection, item, String(row.action))
      : { ok: false, note: null }
  const rev = (await db('nivaro_revisions')
    .where('activity', Number(id))
    .orderBy('id')
    .first('id', 'data', 'delta')) as Record<string, unknown> | undefined
  let prevData: unknown = null
  if (rev && collection && item && row.action !== 'create') {
    const prev = (await db('nivaro_revisions')
      .where({ collection, item })
      .where('id', '<', Number(rev.id))
      .orderBy('id', 'desc')
      .first('data')) as Record<string, unknown> | undefined
    prevData = prev?.data ?? null
  }
  const shaped = shapeWriteDelta({
    action: String(row.action),
    delta: rev?.delta,
    data: rev?.data,
    prevData,
    hasRevision: !!rev
  })
  const changes =
    gate.ok && shaped.delta && collection
      ? await labelledChanges(collection, shaped.delta, shaped.previous, 80).catch(() => [])
      : []
  const chainId = row.chain_id ? String(row.chain_id).toLowerCase() : null
  const req = chainId ? await chainRequest(chainId).catch(() => null) : null
  const at = toMs(row.timestamp)
  let requestNote: string | null = null
  if (!req?.request_id) {
    if (!chainId) requestNote = 'This write was not made inside a recorded request (no chain id).'
    else if (!req)
      requestNote =
        at != null && Date.now() - at > API_LOG_RETENTION_MS
          ? 'Older than API log retention (14 days).'
          : 'No API log row for the request that started its chain — older than API log retention (14 days), started by a schedule, import or feed, or not flushed yet. The path shows how it began.'
    else requestNote = 'The request was logged before request ids existed.'
  }
  let apiKeyName: string | null = null
  if (row.api_key_id != null) {
    const k = (await db('nivaro_api_keys')
      .where('id', Number(row.api_key_id))
      .first('name')
      .catch(() => undefined)) as { name?: string } | undefined
    apiKeyName = k?.name ?? null
  }
  const labels =
    collection && item
      ? await getLabels(new Map([[collection, new Set([item])]])).catch(
          () => ({}) as Record<string, string>
        )
      : {}
  return {
    id: Number(row.id),
    action: String(row.action),
    at: iso(row.timestamp),
    collection,
    item,
    record_label: collection && item ? (labels[`${collection}:${item}`] ?? null) : null,
    user: row.user ? String(row.user) : null,
    who: personName(row),
    origin: row.origin ? String(row.origin) : null,
    auth_method: row.auth_method ? String(row.auth_method) : null,
    api_key: row.api_key_id != null ? { id: Number(row.api_key_id), name: apiKeyName } : null,
    ip: row.ip ? String(row.ip) : null,
    user_agent: row.user_agent ? String(row.user_agent).slice(0, 300) : null,
    comment: row.comment ? String(row.comment) : null,
    chain_id: chainId,
    revision_id: rev ? Number(rev.id) : null,
    changes,
    changes_note: gate.ok ? shaped.note : (gate.note ?? shaped.note),
    request: req,
    request_note: requestNote
  }
}

async function writePeek(id: string): Promise<InspectPeek | null> {
  if (!INT_RE.test(id)) return null
  const row = await activityRow(Number(id))
  if (!row) return null
  return {
    title: `${row.action} ${row.collection ?? ''} ${row.item ?? ''}`.trim(),
    lines: [personName(row) ?? 'no person', row.origin ? `origin ${row.origin}` : ''].filter(
      Boolean
    ),
    at: toMs(row.timestamp)
  }
}

// ── issue ────────────────────────────────────────────────────────────────────────────────────

/** The request a `rid:` issue lookup resolved — the anchor for "what they saw". */
export interface MatchedRequest {
  id: string
  /** The signed-in person who made it (uuid), if any. */
  user: string | null
  /** When it was logged, epoch ms. */
  at: number | null
  /** `fingerprint` = the issue's error-tracking fingerprint (route + message) equals this
   *  request's; `route` = only the route matched, the message did not. */
  matched_by: IssueMatchBy
}

export type IssueForRequest =
  | { id: number; reason: null; request: MatchedRequest; pending: false }
  | {
      id: null
      reason: string
      request: null
      /** The log row is probably still in the logger's batch — worth asking again shortly. */
      pending: boolean
    }

/** A request this fresh with no log row is probably still in the logger's batch. */
export const LOG_PENDING_MS = 60_000

/**
 * The open server issue a request raised. The api-log row carries the error body, so the
 * request's message goes through the same `messageOfBody` → `issueMessage` → `issueFingerprint`
 * rule the error handler and the map's error groups use; among the open (or acknowledged)
 * server issues seen around that time whose route names the request, the fingerprint hit wins.
 * Without one, the newest route match is returned marked `route` so the panel can say so.
 * `eventAt` (the event's time, when known) tells a missing log row apart from one not flushed
 * yet.
 */
export async function issueForRequest(
  rid: string,
  eventAt: number | null = null
): Promise<IssueForRequest> {
  if (!(await hasColumn('nivaro_api_logs', 'request_id')))
    return {
      id: null,
      reason: 'This database does not record request ids yet.',
      request: null,
      pending: false
    }
  const log = (await db('nivaro_api_logs')
    .where('request_id', rid)
    .orderBy('id')
    .first('method', 'path', 'status', 'created_at', 'error', 'user')) as
    | Record<string, unknown>
    | undefined
  if (!log) {
    const pending = eventAt == null || Date.now() - eventAt < LOG_PENDING_MS
    return {
      id: null,
      reason: pending
        ? 'This request is not in the API log yet — the log is written in batches a few seconds apart. Checking again shortly.'
        : 'This request is not in the API log (never flushed, or older than API log retention).',
      request: null,
      pending
    }
  }
  const status = Number(log.status)
  if (status < 500)
    return {
      id: null,
      reason: 'Only server errors (5xx) raise issues; this request did not.',
      request: null,
      pending: false
    }
  const at = toMs(log.created_at) ?? Date.now()
  const message = issueMessage(
    messageOfBody(log.error == null ? null : String(log.error)) || `HTTP ${status}`
  )
  const rows = (await db('nivaro_issues')
    .where('source', 'server')
    .whereIn('status', ['open', 'acknowledged'])
    .where('last_seen_at', '>=', new Date(at - 5_000))
    .where('created_at', '<=', new Date(at + 120_000))
    .orderBy('id', 'desc')
    .limit(50)
    .select('id', 'title', 'fingerprint')) as Array<{
    id: number
    title: string | null
    fingerprint: string | null
  }>
  const hit = pickIssueForRequest(
    rows,
    { method: String(log.method), path: String(log.path) },
    (routeKey) => issueFingerprint('server', routeKey, message)
  )
  if (!hit)
    return {
      id: null,
      reason: 'No open issue matches this request’s route around its time.',
      request: null,
      pending: false
    }
  return {
    id: hit.id,
    reason: null,
    request: {
      id: rid,
      user: log.user && UUID_RE.test(String(log.user)) ? String(log.user) : null,
      at: toMs(log.created_at),
      matched_by: hit.matched_by
    },
    pending: false
  }
}

async function issueDetail(id: string, ctx: InspectCtx): Promise<unknown | null> {
  const parsed = parseIssueId(id)
  if (!parsed) return null
  let issueId: number
  let matchedRequest: MatchedRequest | null = null
  if (parsed.kind === 'rid') {
    const found = await issueForRequest(parsed.rid, ctx.at)
    if (found.id == null)
      return { none: true, reason: found.reason, request_id: parsed.rid, pending: found.pending }
    issueId = found.id
    matchedRequest = found.request
  } else issueId = parsed.id
  const row = (await db('nivaro_issues').where('id', issueId).first()) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  const names = await userNames([row.raised_by as string, row.assigned_to as string])
  const details = splitIssueDetails(row.details)
  let recording: Record<string, unknown> | null = null
  let recordingNote: string | null = null
  const recId = row.recording_id ? String(row.recording_id) : null
  if (recId && UUID_RE.test(recId)) {
    const rec = await recordingRow(recId)
    if (rec) {
      const start = toMs(rec.started_at)
      const off = row.recording_offset_ms != null ? Number(row.recording_offset_ms) : null
      recording = {
        ...recordingWire(rec),
        offset_ms: off,
        at: start != null && off != null ? start + off : start
      }
    } else recordingNote = 'The replay this issue linked is gone — recordings are kept for 7 days.'
  } else if (!recId) {
    recordingNote =
      row.source === 'client'
        ? 'No replay was captured with this error (error clips were off).'
        : 'Server errors carry no replay; the person’s recording around that time may show it.'
  }
  const shot = row.screenshot ? String(row.screenshot) : null
  return {
    id: Number(row.id),
    title: row.title ? String(row.title) : null,
    severity: row.severity ? String(row.severity) : null,
    status: row.status ? String(row.status) : null,
    source: row.source ? String(row.source) : null,
    fingerprint: row.fingerprint ? String(row.fingerprint) : null,
    occurrence_count: Number(row.occurrence_count ?? 1),
    created_at: iso(row.created_at),
    last_seen_at: iso(row.last_seen_at),
    updated_at: iso(row.updated_at),
    collection: row.collection ? String(row.collection) : null,
    item: row.item != null ? String(row.item) : null,
    raised_by: row.raised_by ? String(row.raised_by) : null,
    raised_by_name: nameOf(names, row.raised_by),
    assigned_to_name: nameOf(names, row.assigned_to),
    resolution_notes: row.resolution_notes ? String(row.resolution_notes) : null,
    route: details.route,
    request_context: details.context,
    stack: details.stack,
    details_other: details.other,
    recording,
    recording_note: recordingNote,
    screenshot: shot && shot.length <= SCREENSHOT_MAX_CHARS ? shot : null,
    screenshot_note:
      shot && shot.length > SCREENSHOT_MAX_CHARS ? 'Screenshot too large to show here.' : null,
    matched_request: matchedRequest
  }
}

async function issuePeek(id: string): Promise<InspectPeek | null> {
  const parsed = parseIssueId(id)
  if (!parsed) return null
  if (parsed.kind === 'rid')
    return { title: 'Issue for this request', lines: ['Matched by its error message and route'] }
  const row = (await db('nivaro_issues')
    .where('id', parsed.id)
    .first('title', 'status', 'occurrence_count', 'last_seen_at')) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  return {
    title: `Issue #${parsed.id}`,
    lines: [
      String(row.title ?? '').slice(0, 140),
      `${row.status} · ×${Number(row.occurrence_count ?? 1)}`
    ],
    at: toMs(row.last_seen_at)
  }
}

registerInspectSource({
  kind: 'chain',
  validId: (id) => UUID_RE.test(id),
  detail: (id) => chainDetail(id),
  peek: (id) => chainPeek(id)
})
registerInspectSource({
  kind: 'recording',
  validId: (id) => parseRecordingId(id) != null,
  detail: recordingDetail,
  peek: recordingPeek
})
registerInspectSource({
  kind: 'record',
  validId: (id) => parseRecordId(id) != null,
  detail: recordDetail,
  peek: (id) => recordPeek(id)
})
registerInspectSource({
  kind: 'write',
  validId: (id) => INT_RE.test(id),
  detail: writeDetail,
  peek: (id) => writePeek(id)
})
registerInspectSource({
  kind: 'issue',
  validId: (id) => parseIssueId(id) != null,
  detail: issueDetail,
  peek: (id) => issuePeek(id)
})
