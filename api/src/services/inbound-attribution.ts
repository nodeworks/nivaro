/**
 * Who, outside the app, wrote to a record (#609 / #617).
 *
 * A write that arrived on a static token or a named API key is an INBOUND
 * call: an integration, a script, a partner. Migration 384 stamps the
 * credential on the activity row (auth_method + api_key_id); rows written
 * before it fall back to the writer's account kind (a machine identity).
 *
 * The caller's name is the API key's name, else the account's display name —
 * never "integration". The request behind a write is found through the event
 * chain (the api-log row that STARTED the activity row's chain), else the
 * same caller's write within a short window of the activity row.
 */
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { hasChainColumns } from './chain-columns.js'
import { isMachineAccount } from './machine-accounts.js'

export type InboundCallerKind = 'api_key' | 'token' | 'account'

export interface InboundCaller {
  kind: InboundCallerKind
  /** "Partner key" / "Order sync" — what a person reads. */
  name: string
  api_key_id: number | null
  user_id: string | null
  /** Stable key for filtering: `k<api key id>` or `u<user id>`. */
  key: string
}

export interface ActivityCallerRow {
  auth_method?: string | null
  api_key_id?: number | string | null
  user?: string | null
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  account_kind?: string | null
}

/** migration 384 applied on this database. */
export async function hasInboundColumns(): Promise<boolean> {
  try {
    return await hasColumn('nivaro_activity', 'auth_method')
  } catch {
    return false
  }
}

/** Columns to add to an activity select when the database carries them. */
export async function inboundSelectColumns(alias = 'a'): Promise<string[]> {
  return (await hasInboundColumns()) ? [`${alias}.auth_method`, `${alias}.api_key_id`] : []
}

/** api key id → name, batched. */
export async function apiKeyNames(ids: Array<number | string | null | undefined>) {
  const want = [...new Set(ids.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0))]
  const out = new Map<number, string>()
  if (want.length === 0) return out
  try {
    const rows = (await db('nivaro_api_keys').whereIn('id', want).select('id', 'name')) as Array<{
      id: number
      name: string | null
    }>
    for (const r of rows) out.set(Number(r.id), String(r.name ?? `Key #${r.id}`))
  } catch {
    /* names are decoration */
  }
  return out
}

function displayName(row: ActivityCallerRow): string {
  return (
    [row.first_name, row.last_name].filter(Boolean).join(' ').trim() ||
    String(row.email ?? '').trim() ||
    'an integration'
  )
}

/**
 * The inbound caller behind an activity row, or null when a person in the
 * app (a session), a masquerade, or the system wrote it. `keyNames` from
 * apiKeyNames() over the same rows.
 */
export function callerOf(
  row: ActivityCallerRow & { timestamp?: Date | string | null },
  keyNames: Map<number, string>,
  /** When migration 384 ran here: rows after it say how they authenticated,
   *  so the account-kind guess only applies to rows written before. */
  stampedSince: Date | null = null
): InboundCaller | null {
  const keyId = row.api_key_id != null ? Number(row.api_key_id) : null
  const auth = row.auth_method ?? null
  if (keyId != null && Number.isFinite(keyId) && keyId > 0) {
    return {
      kind: 'api_key',
      name: keyNames.get(keyId) ?? `API key #${keyId}`,
      api_key_id: keyId,
      user_id: row.user ?? null,
      key: `k${keyId}`
    }
  }
  if (auth === 'api_key') return null // key id lost: nothing honest to name
  if (auth === 'token' && row.user) {
    return {
      kind: 'token',
      name: displayName(row),
      api_key_id: null,
      user_id: row.user,
      key: `u${String(row.user).toUpperCase()}`
    }
  }
  // Written before migration 384: a machine identity is the best evidence.
  // After it, a row with no auth method came from no request at all (a
  // cron, a background job) — the system, not an inbound call.
  const ts = row.timestamp ? new Date(row.timestamp) : null
  const beforeStamping = !stampedSince || !ts || ts.getTime() < stampedSince.getTime()
  if (
    auth == null &&
    beforeStamping &&
    row.user &&
    isMachineAccount({ account_kind: row.account_kind ?? null, email: row.email ?? null })
  ) {
    return {
      kind: 'account',
      name: displayName(row),
      api_key_id: null,
      user_id: row.user,
      key: `u${String(row.user).toUpperCase()}`
    }
  }
  return null
}

export interface InboundRequest {
  log_id: number
  method: string
  path: string
  status: number | null
  auth: string
  api_key_name: string | null
  user_name: string | null
  at: string
  chain_id: string | null
  body: unknown
  /** The stored body as written (the replay control edits and resends it). */
  request_body: string | null
  /** The query string as sent (credential-looking values masked). */
  query: string | null
  /** How the request was matched to the write. */
  matched_by: 'chain' | 'window'
}

/**
 * The inbound request that made an activity row. Chain first (exact); else
 * the same credential's non-GET call answered within a few seconds of the
 * write (the log row is written when the response is sent, so the window
 * leans forward). Null when the write came from elsewhere or the request log
 * has aged out (14 days).
 */
export async function inboundRequestForActivity(activityId: number): Promise<{
  activity: Record<string, unknown>
  request: InboundRequest | null
} | null> {
  const activityChained = await hasChainColumns('nivaro_activity').catch(() => false)
  const cols = [
    'a.id',
    'a.timestamp',
    'a.user',
    'a.collection',
    'a.item',
    'a.action',
    ...(activityChained ? ['a.chain_id'] : []),
    ...(await inboundSelectColumns('a'))
  ]
  const act = (await db('nivaro_activity as a')
    .where('a.id', activityId)
    .first(...cols)) as Record<string, unknown> | undefined
  if (!act) return null
  const logCols = [
    'l.id',
    'l.method',
    'l.path',
    'l.status',
    'l.auth',
    'l.created_at',
    'l.request_body',
    'l.user',
    'k.name as api_key_name',
    'u.first_name',
    'u.last_name',
    'u.email',
    ...((await hasColumn('nivaro_api_logs', 'query').catch(() => false)) ? ['l.query'] : [])
  ]
  const logsChained = await hasChainColumns('nivaro_api_logs').catch(() => false)
  const base = () =>
    db('nivaro_api_logs as l')
      .leftJoin('nivaro_api_keys as k', 'k.id', 'l.api_key_id')
      .leftJoin('nivaro_users as u', 'u.id', 'l.user')
      .whereIn('l.auth', ['token', 'api_key'])
      .whereNot('l.method', 'GET')
  let row: Record<string, unknown> | undefined
  let matched: InboundRequest['matched_by'] = 'chain'
  try {
    if (logsChained && act.chain_id) {
      row = (await base()
        .where('l.chain_id', act.chain_id as string)
        .whereNull('l.chain_parent')
        .orderBy('l.id', 'asc')
        .first(...logCols, 'l.chain_id')) as Record<string, unknown> | undefined
    }
    if (!row) {
      matched = 'window'
      const at = new Date(act.timestamp as string)
      const q = base().whereBetween('l.created_at', [
        new Date(at.getTime() - 5_000),
        new Date(at.getTime() + 120_000)
      ])
      if (act.api_key_id != null) q.where('l.api_key_id', Number(act.api_key_id))
      else if (act.user) q.where('l.user', act.user as string)
      else return { activity: act, request: null }
      row = (await q
        .orderBy('l.created_at', 'asc')
        .first(...logCols, ...(logsChained ? ['l.chain_id'] : []))) as
        | Record<string, unknown>
        | undefined
    }
  } catch {
    row = undefined
  }
  if (!row) return { activity: act, request: null }
  let body: unknown = null
  const raw = row.request_body as string | null
  if (raw) {
    try {
      body = JSON.parse(raw)
    } catch {
      body = raw
    }
  }
  return {
    activity: act,
    request: {
      log_id: Number(row.id),
      method: String(row.method),
      path: String(row.path),
      status: row.status != null ? Number(row.status) : null,
      auth: String(row.auth),
      api_key_name: (row.api_key_name as string | null) ?? null,
      user_name:
        [row.first_name, row.last_name].filter(Boolean).join(' ').trim() ||
        (row.email as string | null) ||
        null,
      at: new Date(row.created_at as string).toISOString(),
      chain_id: (row.chain_id as string | null | undefined) ?? null,
      body,
      request_body: raw ?? null,
      query: (row.query as string | null | undefined) ?? null,
      matched_by: matched
    }
  }
}

/** Parse a caller key (`k12`, `u<uuid>`) from a filter. */
export function parseCallerKey(
  key: string
): { kind: 'api_key'; id: number } | { kind: 'user'; id: string } | null {
  const k = String(key ?? '').trim()
  if (/^k\d+$/.test(k)) return { kind: 'api_key', id: Number(k.slice(1)) }
  if (/^u[0-9A-Fa-f-]{36}$/.test(k)) return { kind: 'user', id: k.slice(1).toUpperCase() }
  return null
}

let stampedSinceCache: { at: number; value: Date | null } | null = null

/** When migration 384 ran on this database (null = not yet, or unknown). */
export async function inboundStampedSince(): Promise<Date | null> {
  if (stampedSinceCache && Date.now() - stampedSinceCache.at < 10 * 60_000)
    return stampedSinceCache.value
  let value: Date | null = null
  try {
    if (await hasInboundColumns()) {
      const row = (await db('nivaro_migrations')
        .where('name', 'like', '384_inbound_attribution%')
        .first('migration_time')) as { migration_time?: Date | string } | undefined
      value = row?.migration_time ? new Date(row.migration_time) : new Date(0)
    }
  } catch {
    value = null
  }
  stampedSinceCache = { at: Date.now(), value }
  return value
}

const HOUSEKEEPING = new Set([
  'id',
  'updated_at',
  'date_updated',
  'user_updated',
  'changed',
  'created',
  'date_created',
  'user_created'
])

/** Field keys of a revision delta a person would care about. */
function deltaFields(delta: unknown): string[] {
  let d: unknown = delta
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d)
    } catch {
      return []
    }
  }
  if (!d || typeof d !== 'object') return []
  return Object.keys(d as Record<string, unknown>).filter(
    (k) => !k.startsWith('_') && !HOUSEKEEPING.has(k)
  )
}

function titleCase(field: string): string {
  const s = field.replace(/_/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

async function fieldLabelMap(collections: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (collections.length === 0) return out
  try {
    const rows = (await db('nivaro_fields')
      .whereIn('collection', [...new Set(collections)])
      .whereNotNull('label')
      .select('collection', 'field', 'label')) as Array<{
      collection: string
      field: string
      label: string | null
    }>
    for (const r of rows) if (r.label) out.set(`${r.collection}.${r.field}`, r.label)
  } catch {
    /* labels are decoration */
  }
  return out
}

function describeWrite(action: string, fields: string[], label: (f: string) => string): string {
  if (action === 'create') return 'created this record'
  if (action === 'delete') return 'deleted this record'
  if (fields.length === 0) return 'saved this record (no field changed)'
  const shown = fields.slice(0, 6).map(label)
  const more = fields.length - shown.length
  return `changed ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

export interface InboundChange {
  activity_id: number
  at: string
  action: string
  collection: string
  collection_label: string
  item: string | null
  record_label: string | null
  fields: Array<{ field: string; label: string }>
  sentence: string
  caller: InboundCaller
}

/**
 * Every write one inbound caller made, newest first (#609) — "Partner key
 * changed Vendor on PO-1024 at 14:02". A key's writes are its owner's
 * activity rows carrying the key id, so the owner narrows the read to the
 * (user, timestamp) index before the key filters it.
 */
export async function inboundChangesForCaller(opts: {
  caller: string
  since: Date
  page: number
  limit: number
  collection?: string | null
}): Promise<{ rows: InboundChange[]; has_more: boolean; stamped: boolean }> {
  const parsed = parseCallerKey(opts.caller)
  const stamped = await hasInboundColumns()
  if (!parsed) return { rows: [], has_more: false, stamped }
  const limit = Math.min(Math.max(opts.limit, 1), 200)
  const offset = (Math.max(opts.page, 1) - 1) * limit
  const q = db('nivaro_activity as a')
    .leftJoin('nivaro_revisions as r', 'r.activity', 'a.id')
    .leftJoin('nivaro_users as u', 'u.id', 'a.user')
    .whereIn('a.action', ['create', 'update', 'delete'])
    .whereNotNull('a.collection')
    .whereNot('a.collection', 'like', 'nivaro%')
    .where('a.timestamp', '>=', opts.since)
  if (opts.collection) q.where('a.collection', opts.collection)
  if (parsed.kind === 'api_key') {
    if (!stamped) return { rows: [], has_more: false, stamped }
    const owner = (await db('nivaro_api_keys').where({ id: parsed.id }).first('user')) as
      | { user?: string | null }
      | undefined
    if (owner?.user) q.where('a.user', owner.user)
    q.where('a.api_key_id', parsed.id)
  } else {
    q.where('a.user', parsed.id)
    const who = (await db('nivaro_users')
      .where({ id: parsed.id })
      .first('email', 'account_kind')) as { email?: string; account_kind?: string } | undefined
    const machine = isMachineAccount({
      account_kind: who?.account_kind ?? null,
      email: who?.email ?? null
    })
    if (stamped) {
      const since = await inboundStampedSince()
      q.where((w) => {
        w.where('a.auth_method', 'token')
        // A machine identity's writes from before the stamping existed.
        if (machine && since)
          w.orWhere((x) => x.whereNull('a.auth_method').where('a.timestamp', '<', since))
      })
    } else if (!machine) {
      return { rows: [], has_more: false, stamped }
    }
  }
  const raw = (await q
    .orderBy('a.id', 'desc')
    .offset(offset)
    .limit(limit + 1)
    .select(
      'a.id',
      'a.timestamp',
      'a.action',
      'a.collection',
      'a.item',
      'a.user',
      'r.delta',
      'u.first_name',
      'u.last_name',
      'u.email',
      'u.account_kind',
      ...(await inboundSelectColumns('a'))
    )) as Array<Record<string, unknown>>
  const has_more = raw.length > limit
  const rows = raw.slice(0, limit)
  const keyNames = await apiKeyNames(rows.map((r) => r.api_key_id as number | null))
  const labels = await fieldLabelMap(rows.map((r) => String(r.collection)))
  const byCollection = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.item) continue
    const c = String(r.collection)
    if (!byCollection.has(c)) byCollection.set(c, new Set())
    byCollection.get(c)?.add(String(r.item))
  }
  let recordLabels: Record<string, string> = {}
  try {
    const { getLabels } = await import('./queues.js')
    recordLabels = await getLabels(byCollection)
  } catch {
    recordLabels = {}
  }
  const collLabels = new Map<string, string>()
  try {
    const cols = (await db('nivaro_collections')
      .whereIn('collection', [...byCollection.keys()])
      .select('collection', 'display_name')) as Array<{
      collection: string
      display_name?: string | null
    }>
    for (const c of cols) if (c.display_name) collLabels.set(c.collection, c.display_name)
  } catch {
    /* decoration */
  }
  const stampedSince = await inboundStampedSince()
  const out: InboundChange[] = []
  for (const r of rows) {
    const caller =
      callerOf(r as ActivityCallerRow & { timestamp?: string }, keyNames, stampedSince) ??
      callerOf(r as ActivityCallerRow, keyNames, null)
    if (!caller) continue
    const collection = String(r.collection)
    const fields = deltaFields(r.delta).map((f) => ({
      field: f,
      label: labels.get(`${collection}.${f}`) ?? titleCase(f)
    }))
    const label = (f: string) => labels.get(`${collection}.${f}`) ?? titleCase(f)
    out.push({
      activity_id: Number(r.id),
      at: new Date(r.timestamp as string).toISOString(),
      action: String(r.action),
      collection,
      collection_label: collLabels.get(collection) ?? titleCase(collection),
      item: r.item != null ? String(r.item) : null,
      record_label: r.item != null ? (recordLabels[`${collection}:${r.item}`] ?? null) : null,
      fields,
      sentence: describeWrite(
        String(r.action),
        fields.map((f) => f.field),
        label
      ),
      caller
    })
  }
  return { rows: out, has_more, stamped }
}

/** The record's inbound writes, for its Notes thread (#609). */
export async function inboundWritesForRecord(
  collection: string,
  item: string,
  cap: number
): Promise<
  Array<{
    activity_id: number
    at: string
    sentence: string
    caller: InboundCaller
    fields: string[]
  }>
> {
  const rows = (await db('nivaro_activity as a')
    .leftJoin('nivaro_revisions as r', 'r.activity', 'a.id')
    .leftJoin('nivaro_users as u', 'u.id', 'a.user')
    .where({ 'a.collection': collection, 'a.item': String(item) })
    .whereIn('a.action', ['create', 'update', 'delete'])
    .orderBy('a.id', 'desc')
    .limit(Math.min(Math.max(cap, 1), 500))
    .select(
      'a.id',
      'a.timestamp',
      'a.action',
      'a.user',
      'a.comment',
      'r.delta',
      'u.first_name',
      'u.last_name',
      'u.email',
      'u.account_kind',
      ...(await inboundSelectColumns('a'))
    )) as Array<Record<string, unknown>>
  if (rows.length === 0) return []
  const keyNames = await apiKeyNames(rows.map((r) => r.api_key_id as number | null))
  const stampedSince = await inboundStampedSince()
  const labels = await fieldLabelMap([collection])
  const label = (f: string) => labels.get(`${collection}.${f}`) ?? titleCase(f)
  const out: Array<{
    activity_id: number
    at: string
    sentence: string
    caller: InboundCaller
    fields: string[]
  }> = []
  for (const r of rows) {
    // An import run has its own entry in the thread.
    if (/^import:/i.test(String(r.comment ?? '').trim())) continue
    const caller = callerOf(r as ActivityCallerRow & { timestamp?: string }, keyNames, stampedSince)
    if (!caller) continue
    const fields = deltaFields(r.delta)
    // An update that changed nothing a person reads is noise here.
    if (String(r.action) === 'update' && fields.length === 0) continue
    out.push({
      activity_id: Number(r.id),
      at: new Date(r.timestamp as string).toISOString(),
      sentence: describeWrite(String(r.action), fields, label),
      caller,
      fields
    })
  }
  return out
}
