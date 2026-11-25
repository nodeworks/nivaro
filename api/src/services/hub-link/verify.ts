import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { extensionRegistry } from '../../extensions/loader.js'
import { isUniqueViolation } from '../../lib/unique-violation.js'
import { NIVARO_VERSION } from '../../version.js'

/**
 * Hub verification, APP side (0.3.215+): what a Nivaro Hub's post-deploy smoke checks and its
 * extension version manager may ask of an app over its hub link (routes/hub-verify-link.ts).
 *
 * Smoke reads (`runVerifyReads`): a signed-in read, run IN-PROCESS as a SERVICE identity — never
 * as a person and never with a token the Hub holds. The identity is one machine account per app
 * (`hub-smoke@nivaro.local`, account_kind `service`, the administrator role so a check can read
 * what it names); every call mints a temporary API key for it — read-only scope (`*`: read),
 * expiring in 3 minutes, never leaving this process — runs the reads through `app.inject` with it
 * and deletes the key again. Because the key's scope is read-only, administration routes refuse
 * it (a "keys limited to named collections" refusal) and no write route accepts it; the methods
 * are fixed here anyway: a `read` is a GET of an /api/ path, a `query` is the custom query
 * execute route. The answer is facts only — HTTP status, milliseconds, a row count and a short
 * error code — never a body, a value or a header.
 *
 * Extensions (`extensionInventory`): the extensions this process loaded — id, status, enabled,
 * the manifest version and the build (the export's `build` or the deploy's `.release-sha`).
 */

export const SMOKE_EMAIL = 'hub-smoke@nivaro.local'
const KEY_TTL_MS = 3 * 60_000
const READ_TIMEOUT_MS = 15_000
export const MAX_READS = 10
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

async function adminRoleId(): Promise<string | null> {
  const role = (await db('nivaro_roles').where({ admin_access: true }).orderBy('id').first('id')) as
    | { id: string }
    | undefined
  return role ? String(role.id) : null
}

const smokeRow = async () =>
  (await db('nivaro_users').where({ email: SMOKE_EMAIL }).orderBy('id').first('id', 'role')) as
    | { id: string; role: string | null }
    | undefined

/**
 * The service identity's user id: created on first use, its role kept on the administrator role.
 * A lost insert (unique email, another process) reads the winner; every reader takes the lowest id.
 */
export async function smokeIdentity(): Promise<string> {
  const role = await adminRoleId()
  if (!role) throw Object.assign(new Error('no administrator role'), { code: 'NO_ADMIN_ROLE' })
  let row = await smokeRow()
  if (!row) {
    try {
      // A machine account (account_kind service): never a person, never offboarded, never
      // mailed; it signs in only through the temporary key minted below.
      await db('nivaro_users').insert({
        id: randomUUID().toUpperCase(),
        email: SMOKE_EMAIL,
        first_name: 'Hub smoke check',
        status: 'active',
        account_kind: 'service',
        role
      })
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
    }
    row = await smokeRow()
    if (!row) throw new Error('the smoke identity could not be created')
  }
  if (String(row.role ?? '') !== role)
    await db('nivaro_users').where({ id: row.id }).update({ role })
  return String(row.id)
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
  const req =
    r.kind === 'read'
      ? deps.inject({ method: 'GET', url: r.path as string, headers })
      : deps.inject({
          method: 'POST',
          url: `/api/custom-queries/${encodeURIComponent(r.slug as string)}/execute`,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: JSON.stringify({ params: r.params ?? {} })
        })
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deps.timeoutMs ?? READ_TIMEOUT_MS)
  })
  try {
    const res = await Promise.race([req, timeout])
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

/** Runs the reads one after another as the service identity. The key is gone afterwards. */
export async function runVerifyReads(
  reads: VerifyRead[],
  deps: VerifyDeps
): Promise<{ version: string; results: VerifyReadResult[] }> {
  const userId = await smokeIdentity()
  const { key, hash } = await mintKey(userId)
  try {
    const results: VerifyReadResult[] = []
    for (const r of reads) results.push(await oneRead(r, key, deps))
    return { version: NIVARO_VERSION, results }
  } finally {
    // Expires in 3 minutes on its own if this delete does not get through.
    await db('nivaro_api_keys')
      .where({ key_hash: hash })
      .delete()
      .catch(() => undefined)
  }
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
