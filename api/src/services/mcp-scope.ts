import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { hasColumn } from '../lib/column-probe.js'
import { mcpConnOf } from './mcp-calls.js'
import { normalizedPath } from './mcp-config.js'
import {
  cleanActions,
  cleanCollections,
  cleanTools,
  kitMap,
  SCOPE_ACTIONS,
  type ScopeAction,
  type ToolKit
} from './mcp-kits.js'
import { scopeAllows } from './permissions.js'

/**
 * Per-connection scope (#3205): an MCP connection — an OAuth connection (`o<grant>`) or an API
 * key used for MCP (`k<id>`) — may carry a kit (#3214), a tool allowlist, a collection allowlist
 * and an action list (nivaro_mcp_connection_scopes, migration 509). It only ever NARROWS:
 *
 *   - tools: the hosted endpoint registers only the allowed tools (routes/mcp.ts →
 *     createNivaroMcpServer `allowedTools`), and every in-process call a tool makes back into the
 *     API (`req.mcpInner`) is refused when its `x-nivaro-mcp-tool` (or the instance tool it calls)
 *     is not allowed — so a stale tool list or a hand-made call cannot get round it;
 *   - collections + actions: become key-style scopes intersected with whatever the credential
 *     already had (`user.api_key_scopes`, read by can()), so every permission-checked read and
 *     write on /api/mcp and its inner calls is held to them — exactly like a collection-scoped
 *     API key (admin tools and administrator routes are off for a collection-limited connection).
 *
 * Applied only on POST /api/mcp and its inner calls: an API key keeps its own REST scopes when it
 * is used outside MCP. A kit that no longer exists allows nothing (fails closed).
 */

export const SCOPE_TABLE = 'nivaro_mcp_connection_scopes'
export const SCOPABLE_CONN_RE = /^(o[0-9a-f-]{36}|k\d{1,12})$/

export interface ScopeRow {
  conn: string
  kit: string | null
  tools: string[] | null
  collections: string[] | null
  actions: ScopeAction[] | null
  locked: boolean
  note: string | null
  user: string | null
  updated_by: string | null
  updated_at: string | null
}

export interface EffectiveScope {
  conn: string
  kit: string | null
  /** The kit is named but gone: nothing is allowed. */
  kit_missing: boolean
  tools: string[] | null
  collections: string[] | null
  actions: ScopeAction[] | null
  locked: boolean
}

type KeyScope = { collection: string; actions: string[] }

declare module 'fastify' {
  interface FastifyRequest {
    /** The connection's scope (#3205), set on /api/mcp and its inner calls when it has one. */
    mcpScope?: EffectiveScope
  }
}

// ─── Pure ────────────────────────────────────────────────────────────────────

/** null = no limit. Two limits meet in what both allow. */
export function intersectLists<T extends string>(a: T[] | null, b: T[] | null): T[] | null {
  if (a == null) return b == null ? null : [...b]
  if (b == null) return [...a]
  return a.filter((x) => b.includes(x))
}

/** A stored row + the kits → what the connection may do. */
export function effectiveScope(row: ScopeRow, kits: Map<string, ToolKit>): EffectiveScope {
  const kit = row.kit ? kits.get(row.kit) : undefined
  if (row.kit && !kit)
    return {
      conn: row.conn,
      kit: row.kit,
      kit_missing: true,
      tools: [],
      collections: [],
      actions: [],
      locked: row.locked
    }
  return {
    conn: row.conn,
    kit: row.kit,
    kit_missing: false,
    tools: intersectLists(kit?.tools ?? null, row.tools),
    collections: intersectLists(kit?.collections ?? null, row.collections),
    actions: intersectLists(kit?.actions ?? null, row.actions),
    locked: row.locked
  }
}

/** True when the scope limits nothing at all. */
export const scopeIsOpen = (s: Pick<EffectiveScope, 'tools' | 'collections' | 'actions'>) =>
  s.tools == null && s.collections == null && s.actions == null

/**
 * The collection/action part as key-style scopes, or null when it limits nothing. A
 * collection-limited connection keeps reading the people directory (nivaro_users, which is
 * still the role's own directory access) so records keep showing who is who.
 */
export function scopeAsKeyScopes(
  s: Pick<EffectiveScope, 'collections' | 'actions'>
): KeyScope[] | null {
  if (s.collections == null && s.actions == null) return null
  const actions = s.actions == null ? ['*'] : [...s.actions]
  const out: KeyScope[] = (s.collections ?? ['*']).map((collection) => ({
    collection,
    actions
  }))
  if (s.collections != null && !s.collections.includes('nivaro_users') && actions.length)
    out.push({ collection: 'nivaro_users', actions: ['read'] })
  return out
}

/**
 * Pure: what two scope lists BOTH allow (a missing `existing` allows everything). `$` entries of
 * the existing list (`$chat`) are not collections and are kept as they are.
 */
export function intersectScopes(existing: KeyScope[] | undefined, narrow: KeyScope[]): KeyScope[] {
  if (!existing) return narrow.map((s) => ({ collection: s.collection, actions: [...s.actions] }))
  const special = existing.filter((s) => s.collection?.startsWith('$'))
  const plain = existing.filter((s) => !s.collection?.startsWith('$'))
  const names = new Set<string>(['*'])
  for (const s of [...plain, ...narrow])
    if (s.collection && s.collection !== '*') names.add(s.collection)
  const extra = new Set<string>()
  for (const s of [...plain, ...narrow])
    for (const a of s.actions ?? [])
      if (a !== '*' && !(SCOPE_ACTIONS as string[]).includes(a)) extra.add(a)
  const out: KeyScope[] = []
  for (const c of names) {
    // scopeAllows reads the '*' action as "every action".
    if (scopeAllows(plain, '*', c) && scopeAllows(narrow, '*', c)) {
      out.push({ collection: c, actions: ['*'] })
      continue
    }
    const acts = [...SCOPE_ACTIONS, ...extra].filter(
      (a) => scopeAllows(plain, a, c) && scopeAllows(narrow, a, c)
    )
    if (acts.length) out.push({ collection: c, actions: acts })
  }
  return [...out, ...special]
}

export const toolAllowed = (s: Pick<EffectiveScope, 'tools'> | undefined, tool: string) =>
  !s || s.tools == null || s.tools.includes(tool)

const INSTANCE_CALL = /^\/api\/mcp-tools\/([^/]+)\/call\/?$/

/**
 * Pure: why an in-process call is refused under a tool allowlist, or null. `tool` is the
 * `x-nivaro-mcp-tool` the MCP package stamps on every request a tool makes; a request with none
 * (a resource read) may only read.
 */
export function innerToolRefusal(
  s: Pick<EffectiveScope, 'tools'>,
  tool: string | null,
  method: string,
  path: string
): string | null {
  if (s.tools == null) return null
  if (tool && !s.tools.includes(tool)) return `This connection may not use the ${tool} tool`
  const m = path.match(INSTANCE_CALL)
  if (m) {
    let name = m[1]
    try {
      name = decodeURIComponent(name)
    } catch {
      // keep it as it came
    }
    if (!s.tools.includes(name)) return `This connection may not use the ${name} tool`
  }
  const verb = method.toUpperCase()
  if (!tool && verb !== 'GET' && verb !== 'HEAD')
    return 'This connection may only use the tools it was given'
  return null
}

// ─── Store ───────────────────────────────────────────────────────────────────

export async function scopesReady(): Promise<boolean> {
  return hasColumn(SCOPE_TABLE, 'conn').catch(() => false)
}

interface DbRow {
  conn: string
  kit: string | null
  tools: string | null
  collections: string | null
  actions: string | null
  locked: boolean | number | null
  note: string | null
  user: string | null
  updated_by: string | null
  updated_at: Date | string | null
}

const COLS = [
  'conn',
  'kit',
  'tools',
  'collections',
  'actions',
  'locked',
  'note',
  'user',
  'updated_by',
  'updated_at'
]

export function rowFromDb(r: DbRow): ScopeRow {
  return {
    conn: String(r.conn).toLowerCase(),
    kit: r.kit || null,
    tools: cleanTools(r.tools),
    collections: cleanCollections(r.collections),
    actions: cleanActions(r.actions),
    locked: r.locked === true || r.locked === 1,
    note: r.note ?? null,
    user: r.user ? String(r.user) : null,
    updated_by: r.updated_by ? String(r.updated_by) : null,
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null
  }
}

/** Per tenant + connection; a miss is cached too, so an unscoped connection costs nothing. */
const cache = new Map<string, { at: number; row: ScopeRow | null }>()
const SCOPE_TTL_MS = 10_000
const CACHE_MAX = 5_000

const cacheKey = (conn: string) => `${getTenantId() ?? ''}\u0001${conn}`

export async function readScopeRow(conn: string): Promise<ScopeRow | null> {
  const key = cacheKey(conn)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < SCOPE_TTL_MS) return hit.row
  let row: ScopeRow | null = null
  if (await scopesReady()) {
    const r = (await db(SCOPE_TABLE).where({ conn }).first(COLS)) as DbRow | undefined
    row = r ? rowFromDb(r) : null
  }
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(key, { at: Date.now(), row })
  return row
}

export async function readScopeRows(conns: string[]): Promise<Map<string, ScopeRow>> {
  const out = new Map<string, ScopeRow>()
  if (!conns.length || !(await scopesReady())) return out
  const { selectInChunks } = await import('./db-batch.js')
  const rows = (await selectInChunks([...new Set(conns)], 1000, (chunk) =>
    Promise.resolve(db(SCOPE_TABLE).whereIn('conn', chunk).select(COLS))
  )) as DbRow[]
  for (const r of rows) out.set(String(r.conn).toLowerCase(), rowFromDb(r))
  return out
}

export async function allScopeRows(): Promise<ScopeRow[]> {
  if (!(await scopesReady())) return []
  return ((await db(SCOPE_TABLE).select(COLS).limit(10_000)) as DbRow[]).map(rowFromDb)
}

export async function kitUseCount(kit: string): Promise<number> {
  if (!(await scopesReady())) return 0
  const r = (await db(SCOPE_TABLE).where({ kit }).count({ n: '*' }).first()) as
    | { n?: number | string }
    | undefined
  return Number(r?.n ?? 0)
}

export function bustScopes(): void {
  cache.clear()
}

export interface ScopePatch {
  kit: string | null
  tools: string[] | null
  collections: string[] | null
  actions: ScopeAction[] | null
  locked: boolean
  note: string | null
}

/** Pure: a posted scope → a clean patch, or why not. Unknown kits are refused by the caller. */
export function normalizeScopePatch(raw: unknown): { patch: ScopePatch } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Send a scope object' }
  const r = raw as Record<string, unknown>
  for (const k of ['tools', 'collections', 'actions'] as const)
    if (r[k] != null && !Array.isArray(r[k])) return { error: `${k} must be a list or null` }
  const kit = r.kit == null || r.kit === '' ? null : String(r.kit)
  const actions = r.actions == null ? null : cleanActions(r.actions)
  return {
    patch: {
      kit,
      tools: r.tools == null ? null : (cleanTools(r.tools) ?? []),
      collections: r.collections == null ? null : (cleanCollections(r.collections) ?? []),
      actions,
      locked: r.locked === true,
      note: typeof r.note === 'string' && r.note.trim() ? r.note.trim().slice(0, 300) : null
    }
  }
}

export async function writeScope(
  conn: string,
  patch: ScopePatch,
  by: { userId: string; owner: string | null }
): Promise<ScopeRow> {
  const now = new Date()
  const body = {
    kit: patch.kit,
    tools: patch.tools ? JSON.stringify(patch.tools) : null,
    collections: patch.collections ? JSON.stringify(patch.collections) : null,
    actions: patch.actions ? JSON.stringify(patch.actions) : null,
    locked: patch.locked,
    note: patch.note,
    user: by.owner,
    updated_by: by.userId,
    updated_at: now
  }
  const n = await db(SCOPE_TABLE).where({ conn }).update(body)
  if (!Number(n)) await db(SCOPE_TABLE).insert({ conn, ...body, created_at: now })
  bustScopes()
  return (await readScopeRow(conn)) as ScopeRow
}

export async function deleteScope(conn: string): Promise<boolean> {
  if (!(await scopesReady())) return false
  const n = await db(SCOPE_TABLE).where({ conn }).delete()
  bustScopes()
  return Number(n) > 0
}

/** The scope a connection runs under, or null when it has none. */
export async function scopeForConn(conn: string): Promise<EffectiveScope | null> {
  if (!SCOPABLE_CONN_RE.test(conn)) return null
  const row = await readScopeRow(conn)
  if (!row) return null
  return effectiveScope(row, await kitMap())
}

// ─── Request ─────────────────────────────────────────────────────────────────

function refusal(message: string, code: string) {
  return Object.assign(new Error(message), { statusCode: 403, code })
}

/**
 * Called by authenticate after the identity is known: on POST /api/mcp and every in-process
 * call it makes, put the connection's scope on the request, narrow the user's key scopes and
 * refuse an inner call whose tool the connection may not use. Idempotent (authenticate may run
 * twice on one request). A lookup failure fails CLOSED for a request it cannot judge.
 */
export async function applyMcpConnectionScope(req: FastifyRequest): Promise<void> {
  const user = req.user
  if (!user) return
  const outer = normalizedPath(req.url ?? '') === '/api/mcp'
  if (!outer && !req.mcpInner) return
  if (req.authMethod !== 'oauth' && req.authMethod !== 'api_key') return
  const conn = mcpConnOf(req)
  if (!conn || !SCOPABLE_CONN_RE.test(conn)) return
  let scope: EffectiveScope | null
  try {
    scope = await scopeForConn(conn)
  } catch {
    throw Object.assign(new Error('This connection’s limits could not be read. Try again.'), {
      statusCode: 503,
      code: 'MCP_SCOPE_UNAVAILABLE'
    })
  }
  if (!scope) return
  req.mcpScope = scope
  const narrow = scopeAsKeyScopes(scope)
  if (narrow) user.api_key_scopes = intersectScopes(user.api_key_scopes, narrow)
  if (req.mcpInner) {
    const raw = req.headers['x-nivaro-mcp-tool']
    const tool = typeof raw === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(raw) ? raw : null
    const why = innerToolRefusal(scope, tool, req.method, normalizedPath(req.url ?? ''))
    if (why) throw refusal(why, 'MCP_TOOL_NOT_ALLOWED')
  }
}

/** The tools to register for this request (null = all), from the scope applied above. */
export const allowedToolsOf = (req: FastifyRequest): string[] | null => req.mcpScope?.tools ?? null

// ─── Listings ────────────────────────────────────────────────────────────────

export interface ScopeSummary {
  kit: string | null
  kit_label: string | null
  kit_missing: boolean
  /** What the connection may use (kit ∩ own lists); null = no limit there. */
  tools: string[] | null
  collections: string[] | null
  actions: ScopeAction[] | null
  /** The connection's own lists, before the kit (what an editor starts from). */
  own: { tools: string[] | null; collections: string[] | null; actions: ScopeAction[] | null }
  locked: boolean
  note: string | null
  updated_at: string | null
}

export function summarize(row: ScopeRow, kits: Map<string, ToolKit>): ScopeSummary {
  const eff = effectiveScope(row, kits)
  return {
    kit: row.kit,
    kit_label: row.kit ? (kits.get(row.kit)?.label ?? null) : null,
    kit_missing: eff.kit_missing,
    tools: eff.tools,
    collections: eff.collections,
    actions: eff.actions,
    own: { tools: row.tools, collections: row.collections, actions: row.actions },
    locked: row.locked,
    note: row.note,
    updated_at: row.updated_at
  }
}

interface Listed {
  conn: string
  kind: string
  name: string
  user_id: string
  created_at: string | null
}

export type WithScope<T> = T & { scope: ScopeSummary | null; scope_editable: boolean }

/**
 * Connections with their scope (`scope: null` = no limits) and whether this caller may change
 * it: an administrator always; the owner for their own signed-in connection unless it is locked.
 */
export async function withScopes<T extends Listed>(
  connections: T[],
  opts: { admin: boolean }
): Promise<Array<WithScope<T>>> {
  if (!(await scopesReady().catch(() => false)))
    return connections.map((c) => ({ ...c, scope: null, scope_editable: false }))
  const kits = await kitMap()
  const rows = await readScopeRows(
    connections.filter((c) => SCOPABLE_CONN_RE.test(c.conn)).map((c) => c.conn)
  )
  return connections.map((c) => {
    const row = rows.get(c.conn)
    const scopable = SCOPABLE_CONN_RE.test(c.conn)
    const own = c.kind === 'oauth' && !!c.created_at
    return {
      ...c,
      scope: row ? summarize(row, kits) : null,
      scope_editable: scopable && (opts.admin ? own || c.kind === 'api_key' : own && !row?.locked)
    }
  })
}

/**
 * API keys that carry limits but are not in a listing (no MCP call in the window), so a key
 * limited ahead of use still shows to administrators.
 */
export async function scopedKeysNotListed(listed: Set<string>): Promise<
  Array<{
    conn: string
    name: string
    user_id: string
    created_at: string | null
    last_used_at: string | null
    scope: ScopeSummary
  }>
> {
  if (!(await scopesReady().catch(() => false))) return []
  const extra = (await allScopeRows()).filter((r) => r.conn.startsWith('k') && !listed.has(r.conn))
  if (!extra.length) return []
  const kits = await kitMap()
  const keys = (await db('nivaro_api_keys')
    .whereIn(
      'id',
      extra.slice(0, 1000).map((r) => Number(r.conn.slice(1)))
    )
    .select('id', 'name', 'user', 'created_at', 'last_used_at')) as Array<{
    id: number
    name: string
    user: string
    created_at: Date | string | null
    last_used_at: Date | string | null
  }>
  const byConn = new Map(keys.map((k) => [`k${k.id}`, k]))
  const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null)
  return extra.flatMap((r) => {
    const k = byConn.get(r.conn)
    return k
      ? [
          {
            conn: r.conn,
            name: k.name,
            user_id: String(k.user),
            created_at: iso(k.created_at),
            last_used_at: iso(k.last_used_at),
            scope: summarize(r, kits)
          }
        ]
      : []
  })
}
