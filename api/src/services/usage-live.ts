import type { Knex } from 'knex'
import { isMssql } from '../db/dialect.js'
import { rawRows } from '../db/raw-rows.js'
import { pokeOps } from './ops-live.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Realtime round 9 (#25) — live usage signals, generic and cloud-agnostic.
 *
 *   GET /api/usage/live (admin)   what this instance holds right now: records, file storage,
 *                                 AI tokens this month, people who can sign in
 *   ops topic `usage` (admin)     a coalesced poke (ops-live.ts) when any of those moved —
 *                                 `ops:changed {topic: 'usage', at}`, never a figure
 *
 * Nothing here knows about plans or limits: a hosting layer (the cloud billing bundle) reads the
 * figures and sets them against its own plan. The figures follow the hosting layer's own
 * counting where one exists (records = rows in every table that is not a `nivaro_` system table;
 * people = accounts that are not suspended), so a meter and a limit check agree.
 *
 * Cheap on purpose: records come from the database's own row-count statistics (no COUNT(*) per
 * table — `records.approx` says so), the answer is cached per tenant for a few seconds and read
 * single-flight, and a write only marks the cache stale and pokes the topic (≤ 1 per ~2 s per
 * tenant, ops-live.ts). Module state is keyed by tenant (cloud: one process, many tenants).
 */

export interface LiveUsage {
  records: { count: number | null; approx: boolean }
  storage: { bytes: number; files: number }
  ai: { tokens: number; calls: number; since: string }
  users: { count: number }
  at: string
}

const CACHE_MS = 10_000

interface Entry {
  value?: LiveUsage
  at: number
  /** Bumped by every write that moves a figure; an answer read before the bump is stale. */
  gen: number
  readGen: number
  flight?: Promise<LiveUsage>
}
const cache = new Map<string, Entry>()

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** The first moment of this calendar month, UTC. */
export function monthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/** Rows in every non-system table, from the row-count statistics . */
async function recordCount(knex: Knex): Promise<number | null> {
  try {
    if (isMssql(knex)) {
      // sys.partitions needs no server-state permission; heap (0) or clustered (1) rows only.
      const rows = (await knex.raw(
        `SELECT SUM(p.rows) AS n FROM sys.partitions p
           JOIN sys.tables t ON t.object_id = p.object_id
          WHERE p.index_id IN (0, 1) AND t.is_ms_shipped = 0 AND t.name NOT LIKE 'nivaro[_]%'`
      )) as Array<{ n?: unknown }>
      return num(rows?.[0]?.n)
    }
    const client = (knex as any)?.client?.config?.client
    if (client === 'pg' || client === 'postgres' || client === 'postgresql') {
      const res = (await knex.raw(
        `SELECT COALESCE(SUM(n_live_tup), 0) AS n FROM pg_stat_user_tables
          WHERE relname NOT LIKE 'nivaro\\_%'`
      )) as { rows?: Array<{ n?: unknown }> }
      return num(res?.rows?.[0]?.n)
    }
    if (client === 'mysql' || client === 'mysql2') {
      const res = rawRows<{ n?: unknown }>(
        await knex.raw(
          `SELECT COALESCE(SUM(table_rows), 0) AS n FROM information_schema.tables
            WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
              AND table_name NOT LIKE 'nivaro\\_%'`
        )
      )
      return num(res?.[0]?.n)
    }
  } catch {
    /* statistics not readable here — the meter says "unknown" */
  }
  return null
}

async function storageUse(knex: Knex): Promise<{ bytes: number; files: number }> {
  try {
    const row = (await knex('nivaro_files').sum({ b: 'filesize' }).count({ c: '*' }).first()) as
      | { b?: unknown; c?: unknown }
      | undefined
    return { bytes: num(row?.b), files: num(row?.c) }
  } catch {
    return { bytes: 0, files: 0 }
  }
}

async function aiUse(knex: Knex, since: Date): Promise<{ tokens: number; calls: number }> {
  try {
    const row = (await knex('nivaro_ai_calls')
      .where('created_at', '>=', since)
      .sum({ i: 'input_tokens', o: 'output_tokens' })
      .count({ c: '*' })
      .first()) as { i?: unknown; o?: unknown; c?: unknown } | undefined
    return { tokens: num(row?.i) + num(row?.o), calls: num(row?.c) }
  } catch {
    return { tokens: 0, calls: 0 }
  }
}

async function userCount(knex: Knex): Promise<number> {
  try {
    // The same people a user limit counts: every account that is not suspended.
    const row = (await knex('nivaro_users')
      .whereNot('status', 'suspended')
      .count({ c: '*' })
      .first()) as { c?: unknown } | undefined
    return num(row?.c)
  } catch {
    return 0
  }
}

/** Read the figures now (no cache). */
export async function measureUsage(knex: Knex, now: Date = new Date()): Promise<LiveUsage> {
  const since = monthStartUtc(now)
  const [records, storage, ai, users] = await Promise.all([
    recordCount(knex),
    storageUse(knex),
    aiUse(knex, since),
    userCount(knex)
  ])
  return {
    records: { count: records, approx: true },
    storage,
    ai: { ...ai, since: since.toISOString() },
    users: { count: users },
    at: now.toISOString()
  }
}

function entry(key: string): Entry {
  let e = cache.get(key)
  if (!e) {
    e = { at: 0, gen: 1, readGen: 0 }
    cache.set(key, e)
  }
  return e
}

/** The figures for the caller's tenant: cached a few seconds, one read at a time.
 *  `maxAgeMs` (a per-write limit check, ctx.usage.read) takes the last answer while it is
 *  younger than that, writes since or not — so a busy tenant's every create costs no read. */
export async function readLiveUsage(
  measure: () => Promise<LiveUsage>,
  opts: { fresh?: boolean; maxAgeMs?: number } = {}
): Promise<LiveUsage> {
  const key = currentTenantKey() || '-'
  const e = entry(key)
  const age = Date.now() - e.at
  const maxAge = opts.maxAgeMs
  if (!opts.fresh && e.value && maxAge != null && maxAge > 0 && age < maxAge) return e.value
  const young = e.value && e.readGen === e.gen && age < CACHE_MS
  if (young && !opts.fresh && e.value) return e.value
  if (e.flight) return e.flight
  const startGen = e.gen
  const run = measure()
  e.flight = run
  try {
    const v = await run
    e.value = v
    e.at = Date.now()
    // A write that landed while this read ran keeps the answer stale for the next reader.
    e.readGen = startGen
    return v
  } finally {
    e.flight = undefined
  }
}

/** System tables whose writes move a figure (files = storage, users = people). */
const COUNTED_SYSTEM = new Set(['nivaro_files', 'nivaro_users'])

/** Does a collection write move a usage figure? (pure) */
export function writeMovesUsage(
  collection: string,
  item: string | number,
  action: 'create' | 'update' | 'delete' | undefined,
  changedFields?: readonly string[]
): boolean {
  if (collection.startsWith('nivaro_') && !COUNTED_SYSTEM.has(collection)) return false
  if (collection.startsWith('directus_')) return false
  if (action === 'create' || action === 'delete') return true
  // A procedure or import announcing a bulk raw write (item '*'): rows may have come or gone.
  if (item === '*') return true
  if (action !== 'update') return false
  // A file replaced in place changes its size; a person suspended or restored changes the count.
  // Unnamed fields count as "maybe" — but a person's every sign-in stamp must not poke.
  const fields = changedFields ?? []
  if (collection === 'nivaro_files') return fields.length === 0 || fields.includes('filesize')
  if (collection === 'nivaro_users') return fields.includes('status')
  return false
}

/** Something that moves a figure happened: drop the cached answer and poke the admins watching. */
export function noteUsageChanged(): void {
  entry(currentTenantKey() || '-').gen++
  pokeOps('usage')
}

/** Tests only. */
export function _resetUsageCache(): void {
  cache.clear()
}
