/**
 * Read-through cache for CONFIGURATION reads, at the driver seam.
 *
 * A single record write reads the same metadata dozens of times: relations by
 * collection, field lists, rules, layouts, column lists. Each is one round
 * trip, and every call site asks on its own — a workflow line create spent
 * ~70% of its round trips on rows that change when an admin edits the data
 * model, not when a record is saved. Caching per call site means finding all
 * of them and keeping them found; this sits underneath every one instead.
 *
 * What is cached: a SELECT whose every FROM/JOIN target is on the allow-list
 * below, outside a transaction. Nothing else. Keyed by database + statement +
 * bindings, held for a short TTL.
 *
 * What clears it: ANY statement through this driver that is not a read and
 * names an allow-listed table, and any DDL. So a config edit made by this
 * process is visible on the next read. An edit made by ANOTHER process (a
 * second replica, a script) is visible within the TTL — the same staleness
 * the collection/field metadata cache has always had.
 *
 * mssql only: the cached form is rebuilt into the driver's raw row shape, and
 * that shape is dialect-specific. Other dialects run untouched.
 */

const TABLES = new Set([
  'nivaro_relations',
  'nivaro_fields',
  'nivaro_collections',
  'nivaro_roles',
  'nivaro_rules',
  'nivaro_field_rules',
  'nivaro_field_groups',
  'nivaro_collection_layouts',
  'nivaro_layout_field_assignments',
  'nivaro_ai_collection_settings',
  'nivaro_webhooks',
  'nivaro_workflow_bindings',
  'nivaro_workflow_states',
  'nivaro_workflow_transitions',
  'nivaro_workflow_templates',
  'nivaro_alert_definitions',
  'nivaro_at_risk_rules',
  'nivaro_sla_rules',
  'nivaro_workspaces',
  'information_schema.columns',
  'information_schema.tables'
])

const TTL_MS = Math.max(0, Number(process.env.METADATA_QUERY_CACHE_TTL_MS) || 30_000)
const ENABLED = process.env.METADATA_QUERY_CACHE !== 'off' && TTL_MS > 0
const MAX_ENTRIES = 4000
const MAX_ROWS = 5000

type Cell = { n: string; v: unknown }
type Entry = { at: number; rows: Cell[][] }

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<Cell[][]>>()
let generation = 0
const counters = { hits: 0, misses: 0, shared: 0, busts: 0 }

const FROM_RE =
  /\b(?:from|join)\s+((?:\[[^\]]+\]|[A-Za-z_][\w]*)(?:\.(?:\[[^\]]+\]|[A-Za-z_][\w]*))*)/gi
const DDL_RE = /^\s*(?:alter|create|drop|truncate)\b|\bsp_rename\b/i
const NAMES_RE = new RegExp(
  `\\b(?:${[...TABLES].map((t) => t.replace('.', '\\.')).join('|')})\\b`,
  'i'
)

function normalizeName(raw: string): string {
  const parts = raw.replace(/[[\]]/g, '').toLowerCase().split('.')
  // dbo.nivaro_fields → nivaro_fields; information_schema.columns stays whole
  if (parts.length >= 2 && parts[parts.length - 2] === 'information_schema') {
    return `information_schema.${parts[parts.length - 1]}`
  }
  return parts[parts.length - 1]
}

/** Exported for tests: is this statement a read of allow-listed tables only? */
export function isCacheableRead(sql: string): boolean {
  if (!/^\s*select\b/i.test(sql)) return false
  // A read that takes locks, writes through OUTPUT/INTO, or runs more than one
  // statement is not a plain read.
  if (/\b(?:into|output|exec|execute|insert|update|delete|merge)\b/i.test(sql)) return false
  if (sql.includes(';')) return false
  let seen = 0
  for (const m of sql.matchAll(FROM_RE)) {
    if (!TABLES.has(normalizeName(m[1]))) return false
    seen++
  }
  return seen > 0
}

/** Exported for tests: does this statement invalidate the cache? */
export function isInvalidatingWrite(sql: string): boolean {
  if (/^\s*(?:select|with)\b/i.test(sql) && !/\b(?:insert|update|delete|merge)\b/i.test(sql)) {
    return false
  }
  if (DDL_RE.test(sql)) return true
  return NAMES_RE.test(sql.replace(/[[\]]/g, ''))
}

export function clearMetadataQueryCache(): void {
  if (cache.size > 0 || inflight.size > 0) counters.busts++
  cache.clear()
  // A read that started before the write must not store what it saw.
  generation++
}

export function metadataQueryCacheStats(): Record<string, number | boolean> {
  return { enabled: ENABLED, ttl_ms: TTL_MS, entries: cache.size, ...counters }
}

function cloneValue(v: unknown): unknown {
  if (v instanceof Date) return new Date(v.getTime())
  if (Buffer.isBuffer(v)) return Buffer.from(v)
  return v
}

function reduce(response: unknown): Cell[][] | null {
  if (!Array.isArray(response) || response.length > MAX_ROWS) return null
  const out: Cell[][] = []
  for (const row of response) {
    if (!Array.isArray(row)) return null
    const cells: Cell[] = []
    for (const c of row as Array<{ value: unknown; metadata?: { colName?: string } }>) {
      const n = c?.metadata?.colName
      if (typeof n !== 'string') return null
      cells.push({ n, v: cloneValue(c.value) })
    }
    out.push(cells)
  }
  return out
}

function rebuild(rows: Cell[][]): unknown[] {
  return rows.map((row) => row.map((c) => ({ value: cloneValue(c.v), metadata: { colName: c.n } })))
}

type QueryObj = { sql?: string; bindings?: unknown[]; response?: unknown; output?: unknown }
type DriverClient = {
  _query: (connection: unknown, query: QueryObj) => Promise<QueryObj>
  connectionSettings?: { server?: string; host?: string; database?: string }
}

const PATCHED = Symbol.for('nivaro.metadataQueryCache')

function scopeOf(client: DriverClient): string {
  const s = client.connectionSettings ?? {}
  return `${s.server ?? s.host ?? ''}/${s.database ?? ''}`
}

function keyOf(client: DriverClient, q: QueryObj): string | null {
  try {
    return `${scopeOf(client)}\u0000${q.sql}\u0000${JSON.stringify(q.bindings ?? [])}`
  } catch {
    return null
  }
}

/**
 * Patch the DRIVER PROTOTYPE, not the client instance: knex builds a fresh
 * client object per transaction from the prototype, and a write made inside a
 * transaction has to clear the cache like any other.
 */
export function attachMetadataQueryCache(knexInstance: { client?: unknown }): void {
  const client = knexInstance.client as
    | (DriverClient & { config?: { client?: string } })
    | undefined
  if (client?.config?.client !== 'mssql') return
  const proto = Object.getPrototypeOf(client) as DriverClient & { [PATCHED]?: boolean }
  if (!proto || proto[PATCHED] || typeof proto._query !== 'function') return
  proto[PATCHED] = true
  const original = proto._query

  proto._query = function patched(this: DriverClient, connection: unknown, query: QueryObj) {
    const sql = typeof query?.sql === 'string' ? query.sql : ''
    if (!sql) return original.call(this, connection, query)

    if (isInvalidatingWrite(sql)) {
      // Clear before AND after: before, so nothing reads the old rows while
      // the write is in flight; after, so a read that raced it is dropped.
      clearMetadataQueryCache()
      return original.call(this, connection, query).finally(() => clearMetadataQueryCache())
    }

    const inTransaction = !!(connection as { __knexTxId?: unknown } | null)?.__knexTxId
    if (!ENABLED || inTransaction || query.output || !isCacheableRead(sql)) {
      return original.call(this, connection, query)
    }
    const key = keyOf(this, query)
    if (!key) return original.call(this, connection, query)

    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < TTL_MS) {
      counters.hits++
      query.response = rebuild(hit.rows)
      return Promise.resolve(query)
    }

    const running = inflight.get(key)
    if (running) {
      counters.shared++
      return running.then(
        (rows) => {
          query.response = rebuild(rows)
          return query
        },
        // The shared read failed; this caller asks for itself.
        () => original.call(this, connection, query)
      )
    }

    counters.misses++
    const startedAt = generation
    let settle: (rows: Cell[][]) => void = () => {}
    let fail: (err: unknown) => void = () => {}
    const shared = new Promise<Cell[][]>((res, rej) => {
      settle = res
      fail = rej
    })
    // Followers attach their own handlers; an unobserved rejection must not
    // surface as an unhandled one.
    shared.catch(() => {})
    inflight.set(key, shared)

    return original.call(this, connection, query).then(
      (done) => {
        inflight.delete(key)
        const rows = reduce(done.response)
        if (rows) {
          if (startedAt === generation) {
            if (cache.size >= MAX_ENTRIES) cache.clear()
            cache.set(key, { at: Date.now(), rows })
          }
          settle(rows)
        } else {
          fail(new Error('uncacheable response'))
        }
        return done
      },
      (err) => {
        inflight.delete(key)
        fail(err)
        throw err
      }
    )
  }
}
