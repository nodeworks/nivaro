import { db, isMssql } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { getTenantId } from '../db/tenant-context.js'

/**
 * SQL Server refuses `INSERT/UPDATE/DELETE … OUTPUT` without `INTO` on a table
 * that has an enabled trigger (error 334) — and knex's `.returning()` compiles
 * to exactly that. With `{ includeTriggerModifications: true }` knex writes the
 * OUTPUT into a temp table and selects from it instead, which works with or
 * without triggers, at the price of a temp table per statement.
 *
 * A write whose target is fixed and known to carry a trigger passes the option
 * itself (the workflow instance and history writes: efp-ops keeps its
 * current-state snapshot with triggers on both). A write whose target is a
 * caller's collection goes through `withTriggerSafeReturning`: the catalog says
 * which tables have triggers (one read per tenant a minute), and a 334 from a
 * trigger added since that read retries the statement in the safe form — the
 * refused statement changed nothing, so the retry is the only write.
 */

export const TRIGGER_SAFE = { includeTriggerModifications: true } as const
export type TriggerSafeOptions = typeof TRIGGER_SAFE | undefined

const TTL_MS = 60_000
const cache = new Map<string, { at: number; tables: Set<string> }>()
const inflight = new Map<string, Promise<Set<string> | null>>()

const norm = (name: string) => name.toLowerCase().replace(/[[\]]/g, '')

async function loadTriggerTables(): Promise<Set<string> | null> {
  try {
    const rows = rawRows<{ s: string; name: string }>(
      await db.raw(
        `SELECT OBJECT_SCHEMA_NAME(parent_id) AS s, OBJECT_NAME(parent_id) AS name
           FROM sys.triggers WHERE parent_class = 1 AND is_disabled = 0`
      )
    )
    const out = new Set<string>()
    for (const r of rows) {
      const name = norm(String(r.name))
      out.add(name)
      out.add(`${norm(String(r.s))}.${name}`)
    }
    return out
  } catch {
    return null
  }
}

async function triggerTables(): Promise<Set<string> | null> {
  const key = getTenantId() ?? ''
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tables
  let pending = inflight.get(key)
  if (!pending) {
    pending = loadTriggerTables().finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  const loaded = await pending
  if (loaded) cache.set(key, { at: Date.now(), tables: loaded })
  return loaded ?? hit?.tables ?? null
}

/** The `.returning()` options a write to `table` needs: the safe form when the
 *  table has a trigger — or when the catalog could not be read (the safe form
 *  is always correct). Not MSSQL: none. */
export async function returningOptions(table: string): Promise<TriggerSafeOptions> {
  if (!isMssql()) return undefined
  const tables = await triggerTables()
  if (!tables) return TRIGGER_SAFE
  return tables.has(norm(table)) ? TRIGGER_SAFE : undefined
}

/** Error 334: "The target table … of the DML statement cannot have any enabled
 *  triggers if the statement contains an OUTPUT clause without INTO clause." */
export function isTriggerOutputError(e: unknown): boolean {
  const err = e as {
    number?: unknown
    message?: unknown
    originalError?: { info?: { number?: unknown } }
  }
  if (Number(err?.number) === 334 || Number(err?.originalError?.info?.number) === 334) return true
  return /cannot have any enabled triggers if the statement contains an OUTPUT clause/i.test(
    String(err?.message ?? '')
  )
}

function noteTriggerTable(table: string): void {
  const key = getTenantId() ?? ''
  const hit = cache.get(key)
  if (hit) hit.tables.add(norm(table))
  else cache.set(key, { at: Date.now(), tables: new Set([norm(table)]) })
}

/**
 * Run a write that reads rows back with `.returning()` against a caller-named
 * table: `run(opts)` must pass `opts` as `.returning(cols, opts)`. A trigger
 * the catalog has not seen yet costs one refused statement, then the write runs
 * in the safe form and the table is remembered.
 */
export async function withTriggerSafeReturning<T>(
  table: string,
  run: (opts: TriggerSafeOptions) => Promise<T>
): Promise<T> {
  const opts = await returningOptions(table)
  try {
    return await run(opts)
  } catch (e) {
    if (opts || !isTriggerOutputError(e)) throw e
    noteTriggerTable(table)
    return run(TRIGGER_SAFE)
  }
}

/** Test seam. */
export function resetTriggerSafeCache(): void {
  cache.clear()
  inflight.clear()
}
