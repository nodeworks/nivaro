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
import type { Knex } from 'knex'
// Leaf too (node modules only) — read for who made a configuration write (#1053).
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

/** Exported for tests: does this statement change configuration? */
export function isConfigWrite(sql: string): boolean {
  if (!sql) return false
  if (sql.includes(TABLE)) return false
  if (/^\s*(?:select|with)\b/i.test(sql) && !/\b(?:insert|update|delete|merge)\b/i.test(sql)) {
    return false
  }
  if (DDL_RE.test(sql)) return true
  return WATCHED_RE.test(sql.replace(/[[\]]/g, ''))
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
  for (const t of tablesInStatement(sql)) run.tables.set(t, (run.tables.get(t) ?? 0) + 1)
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
  if (name === CONFIG_EPOCH) {
    dirty = false
    lastBumpAt = Date.now()
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
    return value
  } catch {
    // The table arrives with migration 358; until then there is nothing to move.
    missingUntil = Date.now() + 60_000
    return null
  }
}

/** Called for every configuration write the driver sees. First write moves
 *  the number at once; a run of writes moves it again when the run ends. */
export function noteConfigWrite(sql?: string): void {
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
    const now = await readEpochs()
    if (!now) return
    const moved = primed ? movedNames(seen, now, own) : []
    primed = true
    for (const [name, value] of now) seen.set(name, value)
    for (const name of moved) {
      const handler = handlers.get(name)
      if (!handler) continue
      try {
        await handler(now.get(name) as number)
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
