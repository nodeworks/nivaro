import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { db } from '../../db/index.js'
import { decryptValue, encryptValue, isEncrypted } from '../encryption.js'
import { gitlabProvider } from './gitlab.js'
import { TrackerError, type TrackerProvider } from './types.js'

const TABLE = 'nivaro_tracker_connections'
export const TOKEN_MASK = '••••••••'

export interface SyncOptions {
  status_map: { closed: 'resolved' | 'closed' }
  close_on_resolve: boolean
  reopen_on_recur: boolean
  recur_when_closed: 'reopen' | 'new'
  comments: boolean
  seen_note: boolean
  seen_note_min_minutes: number
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
    seen_note_min_minutes: Number.isFinite(mins) && mins >= 0 ? Math.floor(mins) : 60
  }
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
  constructor(message: string) {
    super(message)
    this.name = 'ConnectionInputError'
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
  if (input.sync !== undefined) patch.sync = JSON.stringify(normalizeSync(input.sync))
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
    const exists = await db(TABLE).where({ id }).first('id')
    if (!exists) throw new ConnectionInputError('Connection not found')
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
