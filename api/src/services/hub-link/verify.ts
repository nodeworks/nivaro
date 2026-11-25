import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { HUB_SMOKE_KIND } from '../../auth/role-sign-in.js'
import { db } from '../../db/index.js'
import { rawRows } from '../../db/raw-rows.js'
import { sqlDialect } from '../../db/sql-dialect.js'
import { extensionRegistry } from '../../extensions/loader.js'
import type { User } from '../../types.js'
import { NIVARO_VERSION } from '../../version.js'
import { buildFinalParams, type ParamDef } from '../custom-query-exec.js'
import { substituteDialectOf, substituteParams } from '../custom-query-substitute.js'
import { can } from '../permissions.js'
import { tablesReadBy } from '../query-freshness.js'
import { readOnlySqlRefusal } from './read-only-sql.js'
import { MAX_READS, READ_CONCURRENCY, READ_TIMEOUT_MS } from './verify-limits.js'

/**
 * Hub verification, APP side (0.3.215+): what a Nivaro Hub's post-deploy smoke checks and its
 * extension version manager may ask of an app over its hub link (routes/hub-verify-link.ts).
 *
 * Smoke reads (`runVerifyReads`): signed-in reads run IN-PROCESS as the app's smoke identity —
 * never as a person and never with a token the Hub holds. The identity is one account per app of
 * its own kind (`hub_smoke`, found by the id this code stored, never by address; every sign-in
 * path refuses that kind, auth/role-sign-in.ts) in a role of its own: read every collection, no
 * administration, app access off.
 *  - a `read` is a GET of an /api/ path through `app.inject` with a temporary API key for the
 *    identity (scope `*`: read, 3 minutes, never leaving this process, deleted after the run);
 *  - a `query` is a custom query run HERE, never through its execute route: enabled, access
 *    `authenticated` or `public`, its SQL provably a single read (read-only-sql.ts), every table it
 *    reads readable by the smoke role (`can`), and run inside a transaction that is always rolled
 *    back. Refused otherwise (SMOKE_QUERY_*), when the Hub saves the check and again on every run.
 * Up to MAX_READS reads, READ_CONCURRENCY at a time, each bounded by READ_TIMEOUT_MS
 * (verify-limits.ts, shared with the Hub). A timed-out `read` is answered TIMEOUT at once; the
 * injected request itself cannot be cancelled and finishes in the background (its key is deleted
 * with the run, so it ends 401 if it outlives it). The answer is facts only — HTTP status,
 * milliseconds, a row count and a short code — never a body, a value or a header.
 *
 * Extensions (`extensionInventory`): the extensions this process loaded — id, status, enabled,
 * the manifest version and the build (the export's `build` or the deploy's `.release-sha`).
 */

const KEY_TTL_MS = 3 * 60_000

export { MAX_READS }

const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/

/** Paths a smoke read may never name: the links, sign-in, streams, files, MCP. */
const REFUSED_PREFIXES = [
  '/api/hub-link',
  '/api/hub-deployment',
  '/api/hub-transfer',
  '/api/hub/',
  '/api/auth',
  '/api/oauth',
  '/api/mcp',
  '/api/files',
  '/api/realtime',
  '/api/graphql',
  '/api/batch-get',
  '/api/internal'
]

export interface VerifyRead {
  kind: 'read' | 'query'
  /** read: the GET path (`/api/items/projects?limit=1`). */
  path?: string
  /** query: the custom query's slug and its params. */
  slug?: string
  params?: Record<string, string | number | boolean | null>
}

export interface VerifyReadResult {
  status: number
  ms: number
  /** Rows in the answer's `data` (an array's length, 1 for an object); null when there is none. */
  rows: number | null
  /** A short refusal code from the answer, or our own (TIMEOUT, BAD_PATH…). */
  code: string | null
}

/** A read path the Hub may name: /api/…, no traversal, no refused area. Null = refused. */
export function readPathOk(path: unknown): string | null {
  if (typeof path !== 'string') return null
  const p = path.trim()
  if (!p.startsWith('/api/') || p.length > 500) return null
  if (/[\s\\]|\/\.\.?(\/|$|\?)|%2e|%2f|%5c/i.test(p)) return null
  const bare = p.split('?')[0].toLowerCase()
  if (REFUSED_PREFIXES.some((x) => bare === x || bare.startsWith(x.endsWith('/') ? x : `${x}/`)))
    return null
  if (/\/(stream|events|download)(\/|$)/.test(bare)) return null
  return p
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i

/** Validates the request body: up to MAX_READS reads. */
export function parseReads(body: unknown): VerifyRead[] | { error: string } {
  const list = (body as { reads?: unknown } | null)?.reads
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_READS)
    return { error: `Send 1 to ${MAX_READS} reads` }
  const out: VerifyRead[] = []
  for (const r of list as Array<Record<string, unknown>>) {
    if (r?.kind === 'read') {
      const path = readPathOk(r.path)
      if (!path) return { error: 'A read names a GET path under /api/ the Hub may read' }
      out.push({ kind: 'read', path })
    } else if (r?.kind === 'query') {
      if (typeof r.slug !== 'string' || !SLUG_RE.test(r.slug))
        return { error: 'A query names a custom query slug' }
      const params: Record<string, string | number | boolean | null> = {}
      const raw = r.params && typeof r.params === 'object' ? (r.params as object) : {}
      for (const [k, v] of Object.entries(raw).slice(0, 20)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) return { error: 'Bad query parameter name' }
        if (v === null || typeof v === 'number' || typeof v === 'boolean') params[k] = v
        else if (typeof v === 'string' && v.length <= 200) params[k] = v
        else return { error: 'Query parameters are short text, numbers, true/false or null' }
      }
      out.push({ kind: 'query', slug: r.slug, params })
    } else return { error: 'Each read is a read or a query' }
  }
  return out
}

/** Where the identity's ids live: one row in nivaro_extension_settings (no migration). */
export const SMOKE_STORE = { extension_id: 'nivaro-core', key: 'hub_smoke_identity' } as const
const ROLE_NAME = 'Hub smoke check'

export class SmokeIdentityError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

interface StoredIdentity {
  user_id: string
  role_id: string
}

async function readStored(): Promise<StoredIdentity | null> {
  const row = (await db('nivaro_extension_settings').where(SMOKE_STORE).first('value')) as
    | { value: string | null }
    | undefined
  try {
    const v = JSON.parse(String(row?.value ?? 'null')) as Partial<StoredIdentity> | null
    return v && typeof v.user_id === 'string' && typeof v.role_id === 'string'
      ? { user_id: v.user_id, role_id: v.role_id }
      : null
  } catch {
    return null
  }
}

const blank = (v: unknown) => v == null || v === ''
const yes = (v: unknown) => v === true || v === 1 || v === '1'

/**
 * Why a stored row may not act as the smoke identity, or null when it may: a SERVICE account
 * (account_kind service) with no credential of a person — no password, no Entra object id, no
 * external (identity provider) id, no static token — holding exactly our own role, active.
 */
export function smokeUserRefusal(
  u: Record<string, unknown> | undefined,
  roleId: string
): string | null {
  if (!u) return 'SMOKE_IDENTITY_MISSING'
  if (String(u.account_kind ?? '') !== HUB_SMOKE_KIND) return 'SMOKE_IDENTITY_NOT_SERVICE'
  if (!blank(u.password_hash) || !blank(u.entra_oid) || !blank(u.external_id))
    return 'SMOKE_IDENTITY_HAS_CREDENTIAL'
  if (!blank(u.static_token)) return 'SMOKE_IDENTITY_HAS_CREDENTIAL'
  if (String(u.role ?? '').toLowerCase() !== roleId.toLowerCase()) return 'SMOKE_IDENTITY_CHANGED'
  if (u.status !== 'active') return 'SMOKE_IDENTITY_SUSPENDED'
  return null
}

/** Why the stored role may not be the smoke role, or null: no administration, no sign-in, reads only. */
async function smokeRoleRefusal(roleId: string): Promise<string | null> {
  const role = (await db('nivaro_roles').where({ id: roleId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!role) return 'SMOKE_ROLE_MISSING'
  if (yes(role.admin_access) || !(role.app_access === false || role.app_access === 0))
    return 'SMOKE_ROLE_CHANGED'
  const writes = await db('nivaro_policies')
    .where({ role: roleId })
    .whereNot({ action: 'read' })
    .first('id')
  return writes ? 'SMOKE_ROLE_CHANGED' : null
}

const REFUSAL_WORDS: Record<string, string> = {
  SMOKE_IDENTITY_MISSING: 'The smoke service account was deleted',
  SMOKE_IDENTITY_NOT_SERVICE: 'The stored smoke account is not a service account',
  SMOKE_IDENTITY_HAS_CREDENTIAL: 'The smoke service account was given a sign-in credential',
  SMOKE_IDENTITY_CHANGED: 'The smoke service account’s role was changed',
  SMOKE_IDENTITY_SUSPENDED: 'The smoke service account is suspended',
  SMOKE_ROLE_MISSING: 'The smoke role was deleted',
  SMOKE_ROLE_CHANGED: 'The smoke role was given more than read access'
}

/**
 * Creates the identity: a role of its own (no administration, app access off so nobody in it
 * signs in, one policy: read every collection) and a service account in it under a random address
 * nobody else holds. The ids are stored; a process that lost the race removes its own rows.
 */
async function createIdentity(): Promise<StoredIdentity> {
  const tag = randomBytes(4).toString('hex')
  const roleId = randomUUID()
  const userId = randomUUID().toUpperCase()
  const taken = await db('nivaro_roles').where({ name: ROLE_NAME }).first('id')
  await db('nivaro_roles').insert({
    id: roleId,
    name: taken ? `${ROLE_NAME} (${tag})` : ROLE_NAME,
    description: 'The Nivaro Hub smoke checks read with this role. Read only; nobody signs in.',
    admin_access: false,
    app_access: false
  })
  await db('nivaro_policies').insert({
    role: roleId,
    collection: '*',
    action: 'read',
    fields: '*'
  })
  // A machine account of its own kind (hub_smoke): never a person, never offboarded, never mailed,
  // never signed in (auth/role-sign-in.ts isHubSmokeAccount); it acts only through the temporary
  // key minted below, and is found again by its stored id only, never by its address.
  await db('nivaro_users').insert({
    id: userId,
    email: `hub-smoke-${tag}@nivaro.local`,
    first_name: 'Hub smoke check',
    status: 'active',
    account_kind: HUB_SMOKE_KIND,
    role: roleId
  })
  try {
    await db('nivaro_extension_settings').insert({
      ...SMOKE_STORE,
      value: JSON.stringify({ user_id: userId, role_id: roleId }),
      updated_at: new Date()
    })
    return { user_id: userId, role_id: roleId }
  } catch (err) {
    await db('nivaro_users')
      .where({ id: userId })
      .delete()
      .catch(() => undefined)
    await db('nivaro_policies')
      .where({ role: roleId })
      .delete()
      .catch(() => undefined)
    await db('nivaro_roles')
      .where({ id: roleId })
      .delete()
      .catch(() => undefined)
    const won = await readStored()
    if (won) return won
    throw err
  }
}

/**
 * The smoke identity's user id — found by the id this code stored, never by an address — and
 * refused (never repaired, never promoted) when the row or its role is no longer what this code
 * made (SMOKE_IDENTITY_* / SMOKE_ROLE_*; an administrator removes the stored row to start over).
 */
export async function smokeIdentity(): Promise<string> {
  const stored = (await readStored()) ?? (await createIdentity())
  const user = (await db('nivaro_users').where({ id: stored.user_id }).first()) as
    | Record<string, unknown>
    | undefined
  const refusal = smokeUserRefusal(user, stored.role_id) ?? (await smokeRoleRefusal(stored.role_id))
  if (refusal) throw new SmokeIdentityError(refusal, REFUSAL_WORDS[refusal] ?? refusal)
  return String(user?.id)
}

/** Mints the run's temporary read-only key; answers the key and its row id. */
async function mintKey(userId: string): Promise<{ key: string; hash: string }> {
  const key = `nvk_${randomBytes(16).toString('hex')}`
  const hash = createHash('sha256').update(key).digest('hex')
  await db('nivaro_api_keys').insert({
    name: 'Hub smoke check (temporary)',
    key_hash: hash,
    prefix: key.slice(0, 8),
    user: userId,
    scopes: JSON.stringify([{ collection: '*', actions: ['read'] }]),
    expires_at: new Date(Date.now() + KEY_TTL_MS),
    rate_limit_per_minute: null,
    ip_allowlist: '[]',
    scope_restrictions: null,
    is_active: true,
    sandbox: false,
    created_at: new Date()
  })
  return { key, hash }
}

function rowsOf(body: string): number | null {
  try {
    const b = JSON.parse(body) as { data?: unknown } | null
    const d = b?.data
    if (Array.isArray(d)) return d.length
    if (d && typeof d === 'object') return 1
    return null
  } catch {
    return null
  }
}

function codeOf(body: string): string | null {
  try {
    const c = (JSON.parse(body) as { code?: unknown } | null)?.code
    return typeof c === 'string' && CODE_RE.test(c) ? c : null
  } catch {
    return null
  }
}

type Inject = FastifyInstance['inject']

export interface VerifyDeps {
  inject: Inject
  /** The Host the injected requests carry (a shared deployment picks the app by it). */
  host?: string | null
  now?: () => number
  timeoutMs?: number
}

async function oneRead(r: VerifyRead, key: string, deps: VerifyDeps): Promise<VerifyReadResult> {
  const now = deps.now ?? Date.now
  const t0 = now()
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    accept: 'application/json',
    ...(deps.host ? { host: deps.host } : {})
  }
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deps.timeoutMs ?? READ_TIMEOUT_MS)
  })
  try {
    const res = await Promise.race([
      deps.inject({ method: 'GET', url: r.path as string, headers }),
      timeout
    ])
    const ms = Math.max(0, Math.round(now() - t0))
    if (res === 'timeout') return { status: 0, ms, rows: null, code: 'TIMEOUT' }
    const body = typeof res.body === 'string' ? res.body : ''
    const ok = res.statusCode >= 200 && res.statusCode < 300
    return {
      status: res.statusCode,
      ms,
      rows: ok ? rowsOf(body) : null,
      code: ok ? null : codeOf(body)
    }
  } catch {
    return { status: 0, ms: Math.round(now() - t0), rows: null, code: 'READ_FAILED' }
  } finally {
    clearTimeout(timer)
  }
}

interface QueryRow {
  id: unknown
  slug: string
  sql_text: string | null
  params: string | null
  access: string | null
  enabled: unknown
  scope_params?: string | null
}

export class SmokeQueryRefusal extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * Why `slug` may not be a smoke query for this identity, or null. Refusals: SMOKE_QUERY_MISSING
 * (no such enabled query), SMOKE_QUERY_ACCESS (administrators only), SMOKE_QUERY_NOT_READ_ONLY
 * (its SQL is not provably one read), SMOKE_QUERY_NOT_READABLE (it reads a table the smoke role
 * may not read).
 */
export async function smokeQueryRefusal(
  q: QueryRow | undefined,
  user: User
): Promise<SmokeQueryRefusal | null> {
  if (!q || !(q.enabled === true || q.enabled === 1 || q.enabled === '1'))
    return new SmokeQueryRefusal(
      'SMOKE_QUERY_MISSING',
      'No enabled custom query with that slug',
      404
    )
  if (q.access !== 'authenticated' && q.access !== 'public')
    return new SmokeQueryRefusal(
      'SMOKE_QUERY_ACCESS',
      'The query is for administrators only; a smoke query must be Signed in or Public'
    )
  const why = readOnlySqlRefusal(q.sql_text)
  if (why)
    return new SmokeQueryRefusal(
      'SMOKE_QUERY_NOT_READ_ONLY',
      `The query is not one plain read (${why}), so smoke checks may not run it`
    )
  const tables = await tablesReadBy(q.sql_text ?? '').catch(() => null)
  if (!tables)
    return new SmokeQueryRefusal(
      'SMOKE_QUERY_NOT_READABLE',
      'The tables the query reads are unknown'
    )
  for (const t of tables)
    if (!(await can(user, 'read', t)))
      return new SmokeQueryRefusal(
        'SMOKE_QUERY_NOT_READABLE',
        `The smoke role may not read ${String(t).slice(0, 64)}`
      )
  return null
}

const ROLLBACK = Symbol('smoke-query-rollback')

/** Runs one smoke query: checked, then inside a transaction that is always rolled back. */
async function oneQuery(r: VerifyRead, user: User, deps: VerifyDeps): Promise<VerifyReadResult> {
  const now = deps.now ?? Date.now
  const t0 = now()
  const ms = () => Math.max(0, Math.round(now() - t0))
  try {
    const q = (await db('nivaro_custom_queries').where({ slug: r.slug }).first()) as
      | QueryRow
      | undefined
    const refusal = await smokeQueryRefusal(q, user)
    if (refusal) return { status: refusal.status, ms: ms(), rows: null, code: refusal.code }
    const row = q as QueryRow
    let defs: ParamDef[] = []
    try {
      defs = row.params ? (JSON.parse(row.params) as ParamDef[]) : []
    } catch {
      defs = []
    }
    let finalParams: Record<string, unknown>
    try {
      finalParams = buildFinalParams(defs, r.params ?? {})
    } catch {
      return { status: 400, ms: ms(), rows: null, code: 'BAD_QUERY_PARAMS' }
    }
    const { applyScopeParams } = await import('../custom-query-scope.js')
    await applyScopeParams(row.scope_params ?? null, finalParams, String(user.id), false, {
      slug: row.slug,
      sqlText: row.sql_text ?? ''
    })
    const text = substituteParams(
      row.sql_text ?? '',
      finalParams,
      substituteDialectOf(sqlDialect(db as never))
    )
    let rows = 0
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), deps.timeoutMs ?? READ_TIMEOUT_MS)
    })
    const run = db
      .transaction(async (trx) => {
        rows = rawRows(await trx.raw(text)).length
        // Never committed: whatever the statement did (nothing — it is a read) is undone.
        throw ROLLBACK
      })
      .then(
        () => 'done' as const,
        (err) => (err === ROLLBACK ? ('done' as const) : Promise.reject(err))
      )
    try {
      if ((await Promise.race([run, timeout])) === 'timeout') {
        run.catch(() => undefined)
        return { status: 0, ms: ms(), rows: null, code: 'TIMEOUT' }
      }
    } finally {
      clearTimeout(timer)
    }
    return { status: 200, ms: ms(), rows, code: null }
  } catch {
    // The app answered: its query failed on this database (a missing column after a deploy…).
    return { status: 400, ms: ms(), rows: null, code: 'QUERY_FAILED' }
  }
}

/** Runs `fn` over `items`, at most `width` at a time; answers in order. */
async function mapLimited<T, R>(items: T[], width: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const lane = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i])
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane))
  return out
}

async function smokeUser(id: string): Promise<User> {
  return (await db('nivaro_users').where({ id }).first()) as User
}

/** Runs the reads as the smoke identity, READ_CONCURRENCY at a time. The key is gone afterwards. */
export async function runVerifyReads(
  reads: VerifyRead[],
  deps: VerifyDeps
): Promise<{ version: string; results: VerifyReadResult[] }> {
  if (reads.length > MAX_READS) throw new SmokeQueryRefusal('BAD_READS', 'Too many reads', 400)
  const userId = await smokeIdentity()
  const user = await smokeUser(userId)
  const needsKey = reads.some((r) => r.kind === 'read')
  const minted = needsKey ? await mintKey(userId) : null
  try {
    const results = await mapLimited(reads, READ_CONCURRENCY, (r) =>
      r.kind === 'read' ? oneRead(r, minted?.key as string, deps) : oneQuery(r, user, deps)
    )
    return { version: NIVARO_VERSION, results }
  } finally {
    // Expires in 3 minutes on its own if this delete does not get through.
    if (minted)
      await db('nivaro_api_keys')
        .where({ key_hash: minted.hash })
        .delete()
        .catch(() => undefined)
  }
}

/** The Hub asks before it saves a suite: may each slug be a smoke query here? */
export async function checkSmokeQueries(
  body: unknown
): Promise<{ results: Array<{ slug: string; code: string | null; reason: string | null }> }> {
  const list = (body as { slugs?: unknown } | null)?.slugs
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_READS)
    throw new SmokeQueryRefusal('BAD_READS', `Send 1 to ${MAX_READS} slugs`, 400)
  const slugs = list.map((x) => String(x))
  if (!slugs.every((x) => SLUG_RE.test(x)))
    throw new SmokeQueryRefusal('BAD_READS', 'A slug is not a custom query slug', 400)
  const user = await smokeUser(await smokeIdentity())
  const results = []
  for (const slug of slugs) {
    const q = (await db('nivaro_custom_queries').where({ slug }).first()) as QueryRow | undefined
    const r = await smokeQueryRefusal(q, user)
    results.push({ slug, code: r?.code ?? null, reason: r?.message ?? null })
  }
  return { results }
}

export interface ExtensionFact {
  id: string
  status: string
  enabled: boolean
  version: string | null
  build: string | null
}

const clip = (v: unknown, n: number) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null

/** The extensions this process loaded (never a path, an error text or a setting). */
export function extensionInventory(): { version: string; extensions: ExtensionFact[] } {
  const extensions: ExtensionFact[] = []
  for (const e of extensionRegistry.values()) {
    if (e.cloud) continue
    extensions.push({
      id: String(e.id).slice(0, 64),
      status: e.status,
      enabled: e.enabled !== false,
      version: clip(e.manifest?.version, 64),
      build: clip(e.build, 80)
    })
    if (extensions.length >= 50) break
  }
  extensions.sort((a, b) => a.id.localeCompare(b.id))
  return { version: NIVARO_VERSION, extensions }
}
