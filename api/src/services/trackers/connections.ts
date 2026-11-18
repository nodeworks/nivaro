import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { db } from '../../db/index.js'
import { decryptValue, encryptValue, isEncrypted } from '../encryption.js'
import { gitlabProvider } from './gitlab.js'
import { LANE_KEYS, mergeLabels, safeLabel, safeLabels } from './labels.js'
import { normalizeSeverity, SEVERITIES, type SeverityName } from './rules.js'
import { TrackerError, type TrackerProvider } from './types.js'

const TABLE = 'nivaro_tracker_connections'
export const TOKEN_MASK = '••••••••'

/** Labels every create gets, plus the ones added when a new example joins a GitLab issue. */
export interface LabelOptions {
  always: string[]
  by_severity: Record<string, string[]>
  by_source: Record<string, string[]>
  on_example: string[]
}

/** Similar-ticket matching: join at/above `join_at`, suggest at/above `suggest_at`. */
export interface SimilarOptions {
  enabled: boolean
  join_at: number
  suggest_at: number
}

export interface SyncOptions {
  status_map: { closed: 'resolved' | 'closed' }
  close_on_resolve: boolean
  reopen_on_recur: boolean
  recur_when_closed: 'reopen' | 'new'
  comments: boolean
  seen_note: boolean
  seen_note_min_minutes: number
  labels: LabelOptions
  similar: SimilarOptions
  /** One GitLab label per issue-log priority (severity). */
  priority_map: Partial<Record<SeverityName, string>>
  /** One GitLab lane label per Nivaro status. */
  lane_map: Partial<Record<'open' | 'in_progress' | 'resolved' | 'closed', string>>
  priority_two_way: boolean
  lanes_two_way: boolean
  /**
   * A GitLab issue a person wrote (link `created_via 'linked'`) gets comments and example notes
   * only; with this on it also gets close/reopen and priority/lane label changes. Default off.
   */
  push_to_linked: boolean
  /** One GitLab label per support-ticket priority. */
  ticket_priority_map: Partial<Record<TicketPriority, string>>
  /** One GitLab lane label per support-ticket status (cancelled rides the done lane). */
  ticket_lane_map: Partial<Record<TicketLane, string>>
  /**
   * Role ids whose people may also create / link GitLab issues from support tickets and records
   * they can update (admins always may). Default none.
   */
  create_roles: string[]
  /** What this connection syncs. A source switched off: no rules, no create/link, no sync. */
  sources: SourceSwitches
  /**
   * Issues people open directly in GitLab (in the connection's projects) become issue-log
   * entries, linked like any other (services/trackers/import.ts). Default off.
   */
  import_new_issues: boolean
  /** Only GitLab issues carrying this label are brought in; '' = every new issue. */
  import_label: string
  /**
   * When import_new_issues was last switched on (ISO), set by the server on save — never by the
   * client. Only issues opened after it are brought in (no back-import of old issues).
   */
  import_since: string | null
}

export const TICKET_PRIORITIES = ['low', 'normal', 'urgent'] as const
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]
export const TICKET_LANE_KEYS = ['open', 'in_progress', 'done'] as const
export type TicketLane = (typeof TICKET_LANE_KEYS)[number]
export interface SourceSwitches {
  issue: boolean
  ticket: boolean
  record: boolean
}

export { sourceOn } from './source-switch.js'

const MAX_CREATE_ROLES = 100

function roleList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const id = v.trim().slice(0, 100)
    const key = id.toLowerCase()
    if (!id || seen.has(key)) continue
    seen.add(key)
    out.push(id)
    if (out.length >= MAX_CREATE_ROLES) break
  }
  return out
}

export interface TrackerConnection {
  id: number
  name: string
  provider: 'gitlab'
  base_url: string
  default_project_id: number | null
  default_project_path: string | null
  is_active: boolean
  sync: SyncOptions
  status: 'ok' | 'broken'
  last_ok_at: string | null
  last_error: string | null
  last_webhook_at: string | null
  last_reconcile_at: string | null
  token_set: boolean
}

type Row = Record<string, unknown>

const bool = (v: unknown, d: boolean) => (v === undefined || v === null ? d : v === true || v === 1)

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const labelList = (v: unknown): string[] =>
  Array.isArray(v) ? safeLabels(v.filter((x) => typeof x === 'string')) : []

const MAX_SOURCE_KEYS = 50

function normalizeLabelOptions(raw: unknown): LabelOptions {
  const src = obj(raw)
  const by_severity: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(obj(src.by_severity))) {
    const key = k.trim().toLowerCase()
    // real severities and the legacy aliases (info / warning / error) only
    if (!(SEVERITIES as string[]).includes(key) && !['info', 'warning', 'error'].includes(key))
      continue
    const sev = normalizeSeverity(key)
    const list = labelList(v)
    if (list.length) by_severity[sev] = mergeLabels(by_severity[sev], list)
  }
  const by_source: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(obj(src.by_source))) {
    const key = k.trim().toLowerCase().slice(0, 100)
    const list = labelList(v)
    if (!key || !list.length) continue
    if (!Object.hasOwn(by_source, key) && Object.keys(by_source).length >= MAX_SOURCE_KEYS) continue
    by_source[key] = mergeLabels(Object.hasOwn(by_source, key) ? by_source[key] : [], list)
  }
  return {
    always: labelList(src.always),
    by_severity,
    by_source,
    on_example: labelList(src.on_example)
  }
}

const clamp = (v: unknown, d: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN
  if (!Number.isFinite(n)) return d
  return Math.min(0.99, Math.max(0.5, n))
}

function normalizeSimilar(raw: unknown): SimilarOptions {
  const src = obj(raw)
  const join_at = clamp(src.join_at, 0.88)
  const suggest_at = Math.min(clamp(src.suggest_at, 0.78), join_at)
  return { enabled: bool(src.enabled, true), join_at, suggest_at }
}

/** Known keys only, one label-safe non-empty label each. */
function labelMap<K extends string>(raw: unknown, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {}
  const src = obj(raw)
  for (const k of keys) {
    if (!Object.hasOwn(src, k) || typeof src[k] !== 'string') continue
    const label = safeLabel(src[k])
    if (label) out[k] = label
  }
  return out
}

/** The shortest gap between two seen-again notes on one GitLab issue (one an hour). */
export const SEEN_NOTE_MIN_MINUTES = 60

/** Fill defaults, drop unknown keys, coerce bad values back to the default. */
export function normalizeSync(raw: unknown): SyncOptions {
  let src: Record<string, unknown> = {}
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw)
      if (p && typeof p === 'object') src = p as Record<string, unknown>
    } catch {
      // keep defaults
    }
  } else if (raw && typeof raw === 'object') {
    src = raw as Record<string, unknown>
  }
  const sm = src.status_map as { closed?: unknown } | undefined
  const mins = Number(src.seen_note_min_minutes)
  return {
    status_map: { closed: sm?.closed === 'closed' ? 'closed' : 'resolved' },
    close_on_resolve: bool(src.close_on_resolve, true),
    reopen_on_recur: bool(src.reopen_on_recur, true),
    recur_when_closed: src.recur_when_closed === 'new' ? 'new' : 'reopen',
    comments: bool(src.comments, true),
    seen_note: bool(src.seen_note, true),
    // at most one seen-again note an hour (spec): anything shorter is saved as 60
    seen_note_min_minutes: Number.isFinite(mins)
      ? Math.max(SEEN_NOTE_MIN_MINUTES, Math.floor(mins))
      : 60,
    labels: normalizeLabelOptions(src.labels),
    similar: normalizeSimilar(src.similar),
    priority_map: labelMap(src.priority_map, SEVERITIES),
    lane_map: labelMap(src.lane_map, LANE_KEYS),
    priority_two_way: bool(src.priority_two_way, true),
    lanes_two_way: bool(src.lanes_two_way, true),
    push_to_linked: bool(src.push_to_linked, false),
    ticket_priority_map: labelMap(src.ticket_priority_map, TICKET_PRIORITIES),
    ticket_lane_map: labelMap(src.ticket_lane_map, TICKET_LANE_KEYS),
    create_roles: roleList(src.create_roles),
    sources: {
      issue: bool(obj(src.sources).issue, true),
      ticket: bool(obj(src.sources).ticket, true),
      record: bool(obj(src.sources).record, true)
    },
    import_new_issues: bool(src.import_new_issues, false),
    import_label: safeLabel(src.import_label),
    import_since: bool(src.import_new_issues, false) ? iso(src.import_since) : null
  }
}

/**
 * The import switch-on time is the server's, whatever the client sent: it starts (now) when
 * bringing in goes on, and again whenever it was not running — the issue log source switched
 * back on, the connection resumed (`restart`), GitLab sync turned back on (restartImportClocks).
 * Otherwise the stored time is kept. Off (or the issue log off) = none. `stored` = the saved sync
 * (null: a new connection). Never back-dated: reconcile must not bring in the gap.
 */
export function withImportSince(
  next: SyncOptions,
  stored: SyncOptions | null,
  now = new Date(),
  restart = false
): SyncOptions {
  if (!next.import_new_issues || !next.sources.issue) return { ...next, import_since: null }
  const kept =
    !restart && stored?.import_new_issues && stored.sources.issue ? stored.import_since : null
  return { ...next, import_since: kept ?? now.toISOString() }
}

/**
 * GitLab sync was turned back on: every connection that brings in new issues starts counting
 * again from now, so issues opened while sync was off are not brought in by reconcile.
 */
export async function restartImportClocks(now = new Date()): Promise<number> {
  const rows = (await db(TABLE).select('id', 'sync')) as Row[]
  let n = 0
  for (const r of rows) {
    const sync = normalizeSync(r.sync)
    if (!sync.import_new_issues || !sync.import_since) continue
    await db(TABLE)
      .where({ id: r.id })
      .update({ sync: JSON.stringify({ ...sync, import_since: now.toISOString() }) })
    n++
  }
  return n
}

const iso = (v: unknown): string | null => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function toView(row: Row): TrackerConnection {
  return {
    id: Number(row.id),
    name: String(row.name),
    provider: 'gitlab',
    base_url: String(row.base_url),
    default_project_id: row.default_project_id == null ? null : Number(row.default_project_id),
    default_project_path:
      row.default_project_path == null ? null : String(row.default_project_path),
    is_active: bool(row.is_active, true),
    sync: normalizeSync(row.sync),
    status: row.status === 'broken' ? 'broken' : 'ok',
    last_ok_at: iso(row.last_ok_at),
    last_error: row.last_error == null ? null : String(row.last_error),
    last_webhook_at: iso(row.last_webhook_at),
    last_reconcile_at: iso(row.last_reconcile_at),
    token_set: !!row.token
  }
}

export async function listConnections(): Promise<TrackerConnection[]> {
  const rows = (await db(TABLE).orderBy('id')) as Row[]
  return rows.map(toView)
}

export async function getConnection(id: number): Promise<TrackerConnection | null> {
  const row = (await db(TABLE).where({ id }).first()) as Row | undefined
  return row ? toView(row) : null
}

/** A provider bound to the connection's stored (decrypted) token. */
export async function providerFor(id: number): Promise<TrackerProvider> {
  const row = (await db(TABLE).where({ id }).first()) as Row | undefined
  if (!row) throw new TrackerError('Connection not found', 404, 'not_found')
  const stored = row.token == null ? '' : String(row.token)
  if (!stored) throw new TrackerError('No token is set for this connection', null, 'auth')
  const token = isEncrypted(stored) ? decryptValue(stored) : stored
  return gitlabProvider({ baseUrl: String(row.base_url), token })
}

export class ConnectionInputError extends Error {
  constructor(
    message: string,
    readonly code: string = 'INVALID_CONNECTION'
  ) {
    super(message)
    this.name = 'ConnectionInputError'
  }
}

const originOf = (u: unknown): string => {
  try {
    return new URL(String(u)).origin.toLowerCase()
  } catch {
    return ''
  }
}

export type ConnectionInput = Partial<
  Pick<
    TrackerConnection,
    | 'name'
    | 'provider'
    | 'base_url'
    | 'default_project_id'
    | 'default_project_path'
    | 'is_active'
    | 'sync'
  >
> & { id?: number; token?: string }

function validUrl(v: string): boolean {
  if (v.length > 500) return false
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export async function saveConnection(
  input: ConnectionInput,
  userId: string
): Promise<TrackerConnection> {
  const patch: Row = {}
  const creating = input.id === undefined

  if (input.name !== undefined || creating) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name.length < 1 || name.length > 200)
      throw new ConnectionInputError('Name must be 1 to 200 characters')
    patch.name = name
  }
  if (input.provider !== undefined && input.provider !== 'gitlab')
    throw new ConnectionInputError('Provider must be gitlab')
  if (input.base_url !== undefined || creating) {
    const url = typeof input.base_url === 'string' ? input.base_url.trim() : ''
    if (!validUrl(url))
      throw new ConnectionInputError('Base URL must be an http or https URL (500 characters max)')
    patch.base_url = url.replace(/\/+$/, '')
  }
  if (input.default_project_id !== undefined) {
    patch.default_project_id =
      input.default_project_id === null ? null : Number(input.default_project_id)
  }
  if (input.default_project_path !== undefined) {
    patch.default_project_path =
      input.default_project_path === null ? null : String(input.default_project_path).slice(0, 300)
  }
  if (input.is_active !== undefined) patch.is_active = !!input.is_active
  {
    const stored =
      input.id === undefined
        ? null
        : ((await db(TABLE)
            .where({ id: Number(input.id) })
            .first('sync', 'is_active')) as Row | undefined)
    const storedSync = stored ? normalizeSync(stored.sync) : null
    // a paused connection read nothing meanwhile: resuming starts the import clock again
    const resumed = !!stored && !bool(stored.is_active, true) && input.is_active === true
    if (input.sync !== undefined || (resumed && storedSync?.import_new_issues))
      patch.sync = JSON.stringify(
        withImportSince(
          input.sync !== undefined ? normalizeSync(input.sync) : (storedSync as SyncOptions),
          storedSync,
          new Date(),
          resumed
        )
      )
  }
  if (typeof input.token === 'string' && input.token !== '' && input.token !== TOKEN_MASK) {
    patch.token = process.env.ENCRYPTION_KEY ? encryptValue(input.token) : input.token
  }

  const now = new Date()
  patch.updated_by = userId
  patch.updated_at = now

  let id: number
  if (creating) {
    if (patch.sync === undefined) patch.sync = JSON.stringify(normalizeSync({}))
    patch.provider = 'gitlab'
    patch.created_by = userId
    patch.created_at = now
    const inserted = (await db(TABLE).insert(patch).returning('id')) as unknown[]
    const first = inserted[0]
    id = Number(typeof first === 'object' && first !== null ? (first as { id: unknown }).id : first)
  } else {
    id = Number(input.id)
    const exists = (await db(TABLE).where({ id }).first('id', 'base_url')) as Row | undefined
    if (!exists) throw new ConnectionInputError('Connection not found')
    // The saved token must never be sent to a different origin than the one it was saved for.
    if (
      typeof patch.base_url === 'string' &&
      originOf(patch.base_url) !== originOf(exists.base_url) &&
      patch.token === undefined
    )
      throw new ConnectionInputError(
        'Enter the token again when you change the GitLab address — the saved token is never sent to a new address.',
        'TOKEN_REQUIRED_FOR_NEW_URL'
      )
    await db(TABLE).where({ id }).update(patch)
  }
  const view = await getConnection(id)
  if (!view) throw new ConnectionInputError('Connection not found')
  return view
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** New webhook secret (32 random bytes hex). Plain value is returned once. */
export async function rotateWebhookSecret(id: number): Promise<string> {
  const secret = randomBytes(32).toString('hex')
  await db(TABLE)
    .where({ id })
    .update({ webhook_secret_hash: sha256(secret), updated_at: new Date() })
  return secret
}

export async function verifyWebhookToken(id: number, token: string | undefined): Promise<boolean> {
  if (!token) return false
  const row = (await db(TABLE).where({ id }).first('webhook_secret_hash')) as Row | undefined
  const stored = row?.webhook_secret_hash ? String(row.webhook_secret_hash) : ''
  if (!stored) return false
  const a = Buffer.from(sha256(token), 'hex')
  const b = Buffer.from(stored, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function markBroken(id: number, reason: string): Promise<void> {
  await db(TABLE)
    .where({ id })
    .update({ status: 'broken', last_error: reason.slice(0, 1000), updated_at: new Date() })
}

export async function markOk(id: number): Promise<void> {
  const now = new Date()
  await db(TABLE)
    .where({ id })
    .update({ status: 'ok', last_error: null, last_ok_at: now, updated_at: now })
}
