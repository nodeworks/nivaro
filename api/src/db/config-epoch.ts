/**
 * One number per database that moves whenever configuration is written.
 *
 * In-process caches (field lists, relations, owner groups, scope paths, mail
 * overrides, …) are cleared by the process that made the edit. Every OTHER
 * process — a second replica, another instance on the same database, a
 * script — kept serving what it had until a TTL ran out, and during that time
 * a filter naming a new relation was silently dropped.
 *
 * The write side sits at the driver seam: any statement that is not a read
 * and names a watched table moves the number, so no call site has to
 * remember. The read side is a poll: a process that sees the number move
 * clears its caches.
 *
 * Leaf module: no import from db/index.ts (which imports this).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Knex } from 'knex'
// Leaf too (no db import) — read for who made a configuration write (#1053).
import { currentTraceMeta } from '../services/request-trace.js'

const TABLE = 'nivaro_cache_epochs'
export const CONFIG_EPOCH = '__config__'
export const SCHEDULES_EPOCH = '__schedules__'

/** Configuration tables whose in-process copies live outside the driver
 *  cache's own allow-list. */
const WATCHED = [
  'nivaro_relations',
  'nivaro_fields',
  'nivaro_collections',
  'nivaro_roles',
  'nivaro_policies',
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
  'nivaro_pipeline_owner_groups',
  'nivaro_pipeline_owner_group_users',
  'nivaro_pipeline_owner_group_teams',
  'nivaro_pipeline_owner_dimensions',
  'nivaro_user_groups',
  'nivaro_user_group_members',
  'nivaro_user_scopes',
  'nivaro_scope_dimensions',
  'nivaro_alert_definitions',
  'nivaro_at_risk_rules',
  'nivaro_sla_rules',
  'nivaro_workspaces',
  'nivaro_tree_configs',
  'nivaro_tree_permissions',
  'nivaro_mail_templates',
  'nivaro_extension_settings',
  'nivaro_settings_overrides',
  'nivaro_custom_queries',
  'nivaro_widgets',
  'nivaro_integration_contracts',
  'nivaro_payload_templates',
  // #1053 — flows are configuration too: an edit lands on the incident timeline.
  'nivaro_flows',
  'nivaro_flow_operations'
]

const WATCHED_RE = new RegExp(`\\b(?:${WATCHED.join('|')})\\b`, 'i')
const WATCHED_ALL_RE = new RegExp(`\\b(?:${WATCHED.join('|')})\\b`, 'gi')
/** The table a DDL statement names (`alter table [x]`, `create table "x"`, …). */
const DDL_TABLE_RE =
  /\b(?:alter|create|drop|truncate)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?[["`]?(?:\w+[\]"`]?\.[["`]?)?(\w+)/i
const DDL_RE = /^\s*(?:alter|create|drop|truncate)\b|\bsp_rename\b/i

const WATCHED_SET = new Set(WATCHED)

/**
 * Comments and string literals removed (neither can make or hide a write), in ONE left-to-right
 * pass so a quote inside a [bracketed name] or a comment marker inside a string reads as what it
 * is. Delimited names keep their text without the delimiters; characters a bare name cannot hold
 * (a space, an apostrophe in `[it's]`) become `_`.
 */
function flatten(sql: string): string {
  return sql.replace(
    /\[[^\]]*\]?|"[^"]*"?|`[^`]*`?|N?'(?:[^']|'')*'?|\/\*[\s\S]*?(?:\*\/|$)|--[^\n]*/gi,
    (m) => {
      const c = m[0]
      if (c === '[' || c === '"' || c === '`') {
        const close = c === '[' ? ']' : c
        const inner = m.length > 1 && m.endsWith(close) ? m.slice(1, -1) : m.slice(1)
        return inner.replace(/[^\w.#@]/g, '_')
      }
      if (c === '/' || c === '-') return ' '
      return "''"
    }
  )
}

// A (possibly schema-qualified) object name; #temp, ##global temp and @table variables keep
// their sigil so they can be told apart from real tables.
const NAME_SRC = String.raw`(?:\w+\.){0,2}[#@]{0,2}\w+`
const NAME = `(${NAME_SRC})`
const TOP = String.raw`(?:top\s*\([^)]*\)\s*(?:percent\s+)?)?`
/** The object each DML statement in a batch writes to. */
const DML_TARGET_RE = new RegExp(
  String.raw`\b(?:insert\s+${TOP}(?:into\s+)?|update\s+${TOP}|delete\s+${TOP}(?:from\s+)?|merge\s+${TOP}(?:into\s+)?)${NAME}`,
  'gi'
)
/** `… OUTPUT inserted.x INTO <table>` writes a second table. */
const OUTPUT_INTO_RE = new RegExp(String.raw`\boutput\b[\s\S]*?\binto\s+${NAME}`, 'gi')
/** Every DML keyword, except a MERGE's own `when … then insert|update|delete` actions. */
const DML_KEYWORD_RE = /(?<!\bthen\s+)\b(?:insert|update|delete|merge)\b/gi
const ANY_DDL_RE = /\b(?:alter|create|drop|truncate)\s+\w+/gi
const TABLE_DDL_RE = new RegExp(
  String.raw`\b(?:alter|create|drop|truncate)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?(${NAME_SRC}(?:\s*,\s*${NAME_SRC})*)`,
  'gi'
)
const INDEX_DDL_RE = new RegExp(
  String.raw`\b(?:create|drop)\s+(?:unique\s+)?(?:(?:non)?clustered\s+)?(?:columnstore\s+)?index\s+\w+\s+on\s+${NAME}`,
  'gi'
)

const bare = (name: string) => (name.split('.').pop() ?? name).toLowerCase()
const isScratch = (name: string) => /^[#@]/.test(bare(name))
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when every DDL statement in the batch only builds or drops #temp tables and their
 *  indexes — the scratch work of a report batch, never a schema change. A `DROP TABLE #a, x`
 *  list is judged name by name. */
function ddlOnlyOnScratch(flat: string): boolean {
  const all = flat.match(ANY_DDL_RE)?.length ?? 0
  const tableStatements = [...flat.matchAll(TABLE_DDL_RE)]
  const tables = tableStatements.flatMap((m) => m[1].split(',').map((n) => n.trim()))
  // `create … index` matches ANY_DDL_RE once per statement (as "create unique", "create
  // clustered", "create index"), so count index statements once each.
  const indexes = [...flat.matchAll(INDEX_DDL_RE)].map((m) => m[1])
  if (tableStatements.length + indexes.length < all) return false
  return [...tables, ...indexes].every(isScratch)
}

/** True when the batch holds DDL on a real (non-#temp) object, or sp_rename. */
export function hasSchemaChange(sql: string): boolean {
  const flat = flatten(sql)
  if (/\bsp_rename\b/i.test(flat)) return true
  ANY_DDL_RE.lastIndex = 0
  return ANY_DDL_RE.test(flat) && !ddlOnlyOnScratch(flat)
}

/** Dynamic SQL hides its statements in a string literal. */
export function hasDynamicSql(sql: string): boolean {
  return /\bexec(?:ute)?\s*\(|\bsp_executesql\b/i.test(sql)
}

/**
 * The tables of `tables` (bare lower-case names) a statement WRITES, or null when its targets
 * cannot be told — the caller then falls back to "does it name one". Targets: each DML
 * statement's object (aliases resolved through every `from|join|using <table> <alias>` binding),
 * `OUTPUT … INTO <table>`; #temp and @table targets are skipped. null when: the target is a CTE
 * (what it writes through is not visible), an alias is bound to different tables, or the batch
 * holds more DML keywords than targets were found (an unrecognised shape).
 */
export function writeTargetsIn(sql: string, tables: ReadonlySet<string>): string[] | null {
  const flat = flatten(sql)
  const out = new Set<string>()
  const dml = [...flat.matchAll(DML_TARGET_RE)]
  const keywords = flat.match(DML_KEYWORD_RE)?.length ?? 0
  if (keywords > dml.length) return null
  const names = [...dml.map((m) => m[1]), ...[...flat.matchAll(OUTPUT_INTO_RE)].map((m) => m[1])]
  for (const name of names) {
    if (isScratch(name)) continue
    const t = bare(name)
    if (tables.has(t)) {
      out.add(t)
      continue
    }
    const tr = escapeRe(t)
    // A CTE (with or without a column list) as the target.
    if (new RegExp(String.raw`\b${tr}\s*(?:\([^)]*\))?\s+as\s*\(`, 'i').test(flat)) return null
    // `update a set … from nivaro_x a` / `delete a from nivaro_x as a`: resolve the alias
    // through EVERY binding — a batch may reuse one alias for several tables.
    const bindings = [
      ...flat.matchAll(
        new RegExp(String.raw`\b(?:from|join|using)\s+(${NAME_SRC})\s+(?:as\s+)?${tr}\b`, 'gi')
      )
    ].map((m) => m[1])
    if (bindings.length === 0) continue
    const real = bindings.filter((b) => !isScratch(b)).map(bare)
    const hit = real.find((b) => tables.has(b))
    if (hit) {
      out.add(hit)
      continue
    }
    if (new Set(bindings.map((b) => b.toLowerCase())).size > 1) return null
  }
  return [...out]
}

/**
 * Exported for tests: the configuration tables a statement WRITES, or null when its targets
 * cannot be told (see writeTargetsIn). A batch that only reads a watched table — a report
 * joining nivaro_workflow_states, an UPDATE of a #temp built from it — writes none
 * (2026-10-28: a 5-minute job's read batch moved the config epoch all day and every open form
 * re-read its definition each time).
 */
export function configWriteTargets(sql: string): string[] | null {
  return writeTargetsIn(sql, WATCHED_SET)
}

/** Exported for tests: does this statement change configuration? */
export function isConfigWrite(sql: string): boolean {
  if (!sql) return false
  if (sql.includes(TABLE)) return false
  if (/^\s*(?:select|with)\b/i.test(sql) && !/\b(?:insert|update|delete|merge)\b/i.test(sql)) {
    return false
  }
  // Dynamic SQL hides its statements in a string: keep the old, cautious rule for it.
  if (hasDynamicSql(sql)) {
    return DDL_RE.test(sql) || WATCHED_RE.test(sql.replace(/[[\]]/g, ''))
  }
  if (hasSchemaChange(sql)) return true
  if (!WATCHED_RE.test(flatten(sql))) return false
  const targets = configWriteTargets(sql)
  // Unknown shape: keep the old, cautious rule — a statement that names a watched table.
  if (targets === null) return true
  return targets.length > 0
}

/**
 * A person's own preference write (#perf 2026-10-28: Profile → my default scopes). Inside it,
 * a statement whose ONLY configuration target is one of `tables` does not move the
 * tenant-wide epoch: nothing another process caches for OTHER people depends on it, and the
 * route that runs it refreshes the person's own copies. Any other configuration write in the
 * same context still moves it.
 */
const personal = new AsyncLocalStorage<{ tables: Set<string> }>()

export function runPersonalConfigWrite<T>(tables: string[], fn: () => Promise<T>): Promise<T> {
  return personal.run({ tables: new Set(tables.map((t) => t.toLowerCase())) }, fn)
}

/** The driver seam's question: should this statement move the configuration epoch? */
export function movesConfigEpoch(sql: string): boolean {
  if (!isConfigWrite(sql)) return false
  const p = personal.getStore()
  if (!p) return true
  if (hasSchemaChange(sql)) return true
  const targets = configWriteTargets(sql)
  if (!targets || targets.length === 0) return true
  return !targets.every((t) => p.tables.has(t))
}

const ENABLED = process.env.CACHE_EPOCH !== 'off' && !process.env.CLOUD_META_DB_URL
const TRAILING_MS = 2_000
const MIN_GAP_MS = 10_000

let knexRef: Knex | null = null
let lastBumpAt = 0
let pending: NodeJS.Timeout | null = null
let dirty = false
/** Values this process wrote, per name — its own poll does not act on them. */
const own = new Map<string, Set<number>>()
let missingUntil = 0
let lastStatement: string | null = null
// ── #2441: the epoch a shared (Redis) cache may key on ──────────────────────
/** The configuration epoch as last read from the database (poll, direct read or own move). */
let latestKnown: number | null = null
let lastReadAt = 0
/** Orders reads and moves: a slower, older answer never overwrites a newer one. */
let opSeq = 0
let lastAssignedSeq = 0
/** Moves started by this process (ever) and in flight now — a read that overlapped one is not
 *  trusted, it may have seen the number before or after the move. */
let bumpGen = 0
let bumpsInFlight = 0
let direct: Promise<void> | null = null
/** True while a handler for ANOTHER process's move runs (clears must not drop shared entries). */
let remoteClear = false
const EPOCH_FRESH_MS = 15_000
let writesSeen = 0
let moves = 0

// ── #1053: what a run of configuration writes touched, and who made it ──────
/** One configuration change as the incident timeline reads it: the epoch it moved to, the
 *  tables a run of writes named, and the people / requests behind them. */
export interface ConfigStamp {
  epoch: number | null
  tables: Array<{ table: string; writes: number }>
  ddl: number
  statements: number
  users: string[]
  paths: string[]
  from: string
  to: string
  /** A cache bust asked for by hand (no write behind it). */
  manual: boolean
}

interface RunAcc {
  tables: Map<string, number>
  ddl: number
  statements: number
  users: Set<string>
  paths: Set<string>
  from: number
  to: number
}
let run: RunAcc | null = null
const stampListeners = new Set<(stamp: ConfigStamp) => void | Promise<void>>()

/** Called once per configuration change (a run of writes, on its trailing edge). */
export function onConfigStamp(fn: (stamp: ConfigStamp) => void | Promise<void>): () => void {
  stampListeners.add(fn)
  return () => stampListeners.delete(fn)
}

/** Exported for tests: the configuration tables a statement names (DDL names its own table). */
export function tablesInStatement(sql: string): string[] {
  const flat = sql.replace(/[[\]"`]/g, '')
  const out = new Set<string>()
  for (const m of flat.matchAll(WATCHED_ALL_RE)) out.add(m[0].toLowerCase())
  if (DDL_RE.test(sql)) {
    const t = sql.match(DDL_TABLE_RE)?.[1]
    if (t) out.add(t.toLowerCase())
  }
  return [...out]
}

function accumulate(sql: string): void {
  const now = Date.now()
  if (!run)
    run = {
      tables: new Map(),
      ddl: 0,
      statements: 0,
      users: new Set(),
      paths: new Set(),
      from: now,
      to: now
    }
  run.statements++
  run.to = now
  if (DDL_RE.test(sql)) run.ddl++
  // The tables the statement WRITES when that can be told; else every one it names.
  const written = configWriteTargets(sql)
  const named = written?.length ? written : tablesInStatement(sql)
  for (const t of named) run.tables.set(t, (run.tables.get(t) ?? 0) + 1)
  try {
    const meta = currentTraceMeta()
    if (meta?.userId && run.users.size < 10) run.users.add(meta.userId)
    if (meta?.urlHint && run.paths.size < 10) run.paths.add(meta.urlHint.slice(0, 160))
  } catch {
    /* outside a request: a script, a migration or a cron */
  }
}

function emitStamp(epoch: number | null, manual: boolean): void {
  const acc = run
  run = null
  if (stampListeners.size === 0) return
  if (!acc && !manual) return
  const now = new Date().toISOString()
  const stamp: ConfigStamp = {
    epoch,
    tables: acc
      ? [...acc.tables]
          .map(([table, writes]) => ({ table, writes }))
          .sort((a, b) => b.writes - a.writes)
      : [],
    ddl: acc?.ddl ?? 0,
    statements: acc?.statements ?? 0,
    users: acc ? [...acc.users] : [],
    paths: acc ? [...acc.paths] : [],
    from: acc ? new Date(acc.from).toISOString() : now,
    to: acc ? new Date(acc.to).toISOString() : now,
    manual
  }
  for (const fn of stampListeners) {
    try {
      void Promise.resolve(fn(stamp)).catch(() => {})
    } catch {
      /* a listener never breaks the write path */
    }
  }
}

function remember(name: string, value: number): void {
  let set = own.get(name)
  if (!set) {
    set = new Set()
    own.set(name, set)
  }
  set.add(value)
  if (set.size > 50) set.delete(set.values().next().value as number)
}

async function bump(name: string): Promise<number | null> {
  const k = knexRef
  if (!k || !ENABLED) return null
  if (Date.now() < missingUntil) return null
  const isConfig = name === CONFIG_EPOCH
  const seq = ++opSeq
  if (isConfig) {
    dirty = false
    lastBumpAt = Date.now()
    bumpGen++
    bumpsInFlight++
  }
  try {
    const changed = await k(TABLE)
      .where({ name })
      .update({ epoch: k.raw('epoch + 1'), updated_at: new Date() })
    if (!changed) {
      await k(TABLE)
        .insert({ name, epoch: 1, updated_at: new Date() })
        .catch(async () => {
          await k(TABLE)
            .where({ name })
            .update({ epoch: k.raw('epoch + 1'), updated_at: new Date() })
        })
    }
    const row = (await k(TABLE).where({ name }).first('epoch')) as
      | { epoch: number | string }
      | undefined
    const value = row ? Number(row.epoch) : null
    moves++
    if (value != null) remember(name, value)
    if (isConfig && value != null) assignKnown(value, seq)
    return value
  } catch {
    // The table arrives with migration 358; until then there is nothing to move.
    missingUntil = Date.now() + 60_000
    return null
  } finally {
    if (isConfig) bumpsInFlight--
  }
}

function assignKnown(value: number, seq: number): void {
  if (seq < lastAssignedSeq) return
  lastAssignedSeq = seq
  const backwards = latestKnown != null && value < latestKnown
  latestKnown = value
  lastReadAt = Date.now()
  // The number only ever grows; smaller means the database was restored underneath us.
  if (backwards) emitReset(true)
}

const resetListeners = new Set<(e: { backwards: boolean }) => void>()
let pollFailing = false

/**
 * #2441 — hear what a database restore looks like from here: the configuration number went
 * BACKWARDS (`backwards: true`), or moved in another process / could not be read (`false`: a
 * restore may hide behind it). Synchronous; a throw is swallowed.
 */
export function onEpochReset(fn: (e: { backwards: boolean }) => void): () => void {
  resetListeners.add(fn)
  return () => {
    resetListeners.delete(fn)
  }
}

function emitReset(backwards: boolean): void {
  for (const fn of resetListeners) {
    try {
      fn({ backwards })
    } catch {
      /* a listener never breaks the watch */
    }
  }
}

/** A read of the number, begun now: assigns its answer when it lands, unless a move by this
 *  process overlapped it. */
function beginRead(): (value: number) => void {
  const seq = ++opSeq
  const gen = bumpGen
  const clean = bumpsInFlight === 0
  return (value: number) => {
    if (clean && gen === bumpGen && bumpsInFlight === 0) assignKnown(value, seq)
  }
}

/**
 * #2441 — the configuration epoch a SHARED cache may key on right now, or null when it must not
 * be used: the mechanism is off, the number has not been read lately, or this process has a
 * configuration write whose move has not landed (it would key on the epoch it is leaving).
 */
export function configEpochNow(): number | null {
  if (!ENABLED || !knexRef) return null
  if (Date.now() < missingUntil) return null
  if (pending || dirty || bumpsInFlight > 0) return null
  if (latestKnown == null || Date.now() - lastReadAt > EPOCH_FRESH_MS) return null
  return latestKnown
}

/** configEpochNow(), reading the number first when it is stale or was never read (a fresh
 *  process before its first poll). One read at a time; a failure answers null. */
export async function configEpochForRead(): Promise<number | null> {
  const now = configEpochNow()
  if (now != null) return now
  const k = knexRef
  if (!ENABLED || !k || Date.now() < missingUntil) return null
  if (pending || dirty || bumpsInFlight > 0) return null
  if (!direct) {
    const land = beginRead()
    direct = (async () => {
      try {
        const row = (await k(TABLE).where({ name: CONFIG_EPOCH }).first('epoch')) as
          | { epoch: number | string }
          | undefined
        // No row: the number has never moved on this database.
        land(row ? Number(row.epoch) : 0)
      } catch {
        /* unreadable now: the shared cache is skipped */
      } finally {
        direct = null
      }
    })()
  }
  await direct
  return configEpochNow()
}

/** True while this process clears caches because ANOTHER process moved the number. */
export function isRemoteEpochClear(): boolean {
  return remoteClear
}

const writeListeners = new Set<() => void>()

/** Hear this process's configuration writes as the driver sees them (before the statement runs;
 *  cheap and synchronous — a throw is swallowed). Fires whether or not the epoch is enabled. */
export function onConfigWrite(fn: () => void): () => void {
  writeListeners.add(fn)
  return () => {
    writeListeners.delete(fn)
  }
}

/** Called for every configuration write the driver sees. First write moves
 *  the number at once; a run of writes moves it again when the run ends. */
export function noteConfigWrite(sql?: string): void {
  for (const fn of writeListeners) {
    try {
      fn()
    } catch {
      /* a listener never affects the write */
    }
  }
  if (!ENABLED || !knexRef) return
  if (sql) {
    lastStatement = sql.replace(/\s+/g, ' ').slice(0, 160)
    writesSeen++
    accumulate(sql)
  }
  dirty = true
  if (Date.now() - lastBumpAt >= MIN_GAP_MS) {
    void bump(CONFIG_EPOCH)
    dirty = true // the run may continue; the trailing edge covers its end
  }
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    // #1053 — one stamp per run of writes, on its trailing edge (the leading move only clears
    // caches early; the stamp waits until the run has said everything it touched).
    if (dirty) void bump(CONFIG_EPOCH).then((v) => emitStamp(v, false))
  }, TRAILING_MS)
  pending.unref?.()
}

/** Move the configuration number now — for a bust someone asked for by hand. */
export async function bumpConfigEpoch(): Promise<number | null> {
  const v = await bump(CONFIG_EPOCH)
  emitStamp(v, true)
  return v
}

/** Move any other named number (schedules, …). */
export async function bumpEpoch(name: string): Promise<number | null> {
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(name)) return null
  return bump(name)
}

/**
 * Remember the connection and make `destroy()` wait for a pending move: a
 * script writes its last row and closes the pool in the same breath.
 */
export function attachConfigEpoch(knexInstance: Knex): void {
  if (!ENABLED || knexRef) return
  knexRef = knexInstance
  // knex.destroy itself is read-only; it hands over to the client's destroy.
  try {
    const client = (knexInstance as unknown as { client?: { destroy?: unknown } }).client as
      | { destroy: (...a: unknown[]) => Promise<unknown> }
      | undefined
    if (!client || typeof client.destroy !== 'function') return
    const original = client.destroy.bind(client)
    client.destroy = (...args: unknown[]) => {
      if (pending) {
        clearTimeout(pending)
        pending = null
      }
      const flushed = dirty
        ? bump(CONFIG_EPOCH)
            .then((v) => {
              emitStamp(v, false)
              return v
            })
            .catch(() => null)
        : Promise.resolve(null)
      return flushed.then(() => original(...args))
    }
  } catch {
    // A pool that cannot be wrapped still moves the number on its first write.
  }
}

// ── read side ────────────────────────────────────────────────────────────────
let watcher: NodeJS.Timeout | null = null
const seen = new Map<string, number>()
let primed = false
const handlers = new Map<string, (epoch: number) => void | Promise<void>>()

async function readEpochs(): Promise<Map<string, number> | null> {
  const k = knexRef
  if (!k) return null
  if (Date.now() < missingUntil) return null
  try {
    const rows = (await k(TABLE).select('name', 'epoch')) as Array<{
      name: string
      epoch: number | string
    }>
    return new Map(rows.map((r) => [r.name, Number(r.epoch)]))
  } catch {
    missingUntil = Date.now() + 60_000
    return null
  }
}

/** Exported for tests: which names moved, given what was seen before. */
export function movedNames(
  before: Map<string, number>,
  now: Map<string, number>,
  mine: Map<string, Set<number>>
): string[] {
  const out: string[] = []
  for (const [name, value] of now) {
    if (before.get(name) === value) continue
    if (mine.get(name)?.has(value)) continue
    out.push(name)
  }
  return out
}

/** What to do when another process moves a named number. */
export function onEpoch(name: string, handler: (epoch: number) => void | Promise<void>): void {
  handlers.set(name, handler)
}

/**
 * Poll the numbers; call the handler of each name another process moved. The
 * first read only records where the numbers stand.
 */
export function startEpochWatch(intervalMs = 5_000): void {
  if (!ENABLED || watcher || intervalMs <= 0) return
  const tick = async () => {
    const land = beginRead()
    const now = await readEpochs()
    if (!now) {
      // A restore takes the database away for a while: once per outage, say so (#2441).
      if (!pollFailing) emitReset(false)
      pollFailing = true
      return
    }
    pollFailing = false
    land(now.get(CONFIG_EPOCH) ?? 0)
    const moved = primed ? movedNames(seen, now, own) : []
    primed = true
    for (const [name, value] of now) seen.set(name, value)
    if (moved.includes(CONFIG_EPOCH)) emitReset(false)
    for (const name of moved) {
      const handler = handlers.get(name)
      if (!handler) continue
      try {
        // The synchronous part of a handler is a remote clear (#2441: it must not drop the
        // shared metadata entries other processes just stored under the new number).
        let result: void | Promise<void>
        remoteClear = true
        try {
          result = handler(now.get(name) as number)
        } finally {
          remoteClear = false
        }
        await result
      } catch {
        /* one handler that fails must not stop the watch */
      }
    }
  }
  void tick()
  watcher = setInterval(() => void tick(), intervalMs)
  watcher.unref?.()
}

export function stopEpochWatch(): void {
  if (watcher) clearInterval(watcher)
  watcher = null
  seen.clear()
  primed = false
  latestKnown = null
  lastReadAt = 0
}

export function configEpochState(): {
  enabled: boolean
  watching: boolean
  seen: number | null
  last_moved_at: string | null
  /** Configuration writes this process made, and how often it moved a number. */
  writes_seen: number
  moves: number
  /** The newest statement that counted as a configuration write (no values). */
  last_statement: string | null
} {
  return {
    enabled: ENABLED,
    watching: !!watcher,
    seen: seen.get(CONFIG_EPOCH) ?? null,
    last_moved_at: lastBumpAt ? new Date(lastBumpAt).toISOString() : null,
    writes_seen: writesSeen,
    moves,
    last_statement: lastStatement
  }
}
