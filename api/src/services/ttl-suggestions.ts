import { createHash } from 'node:crypto'
import { procedureText } from './query-freshness.js'

/**
 * TTL suggestions for slow uncached queries (#2446).
 *
 * The cache panel (#476) already names queries at cache_ttl 0 that take
 * seconds. This turns that into an offer: for each such query, what each of a
 * few TTLs would save per day (calls avoided x average run time) and the
 * staleness window it introduces. Every accepted TTL is a window someone
 * agreed to, so the window is part of every option. Nothing is applied here:
 * the admin PATCHes cache_ttl through the normal route.
 *
 * Two things keep this honest:
 *  - a query that may WRITE is never offered a TTL (a cached write silently
 *    stops writing). Judged from the query text and, one EXEC at a time, the
 *    text of the procedures it calls; an unreadable procedure counts as unsafe.
 *  - savings are an UPPER bound: they assume one cache key, while a query whose
 *    parameters (or User Scope allowance; scope values are part of the cq: key)
 *    vary needs one miss per key per window.
 */

export const SUGGEST_TTLS = [60, 300, 900] as const
/** A TTL at or under this still counts as "very low" and gets offered a longer one. */
export const LOW_TTL_MAX = 30
export const MIN_AVG_EXEC_MS = 500
export const MIN_CALLS = 5
export const MIN_SAVED_MS_PER_DAY = 5000
/** Observation shorter than this is extrapolated from at least this long. */
const MIN_OBSERVED_HOURS = 1
const LOW_CONFIDENCE_HOURS = 6

// ── write safety ────────────────────────────────────────────────────────────

/** Comments and string literals out, so words inside them never count. */
function stripNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

// Writes into a #temp table or an @table variable are scratch work, not data writes.
const SCRATCH_WRITES =
  /\b(?:insert\s+(?:into\s+)?|update\s+|delete\s+(?:from\s+)?|truncate\s+table\s+|drop\s+table\s+(?:if\s+exists\s+)?|create\s+table\s+|alter\s+table\s+|merge\s+(?:into\s+)?|into\s+)(?:#|@)\w+/gi
const WRITE_WORDS =
  /\b(?:insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|backup|restore|shutdown|dbcc|sp_executesql|openrowset|openquery|bulk)\b|\bxp_\w+|\bexec(?:ute)?\s*\(|\binto\s+[\w[\]#@.]+/i
const EXEC_TARGET =
  /\bexec(?:ute)?\s+(?:@\w+\s*=\s*)?\[?(?:dbo\]?\.\[?)?([A-Za-z_][A-Za-z0-9_]*)\]?/gi
const MAX_PROCS = 8

/** First write-capable thing in a piece of T-SQL, or null. */
export function writeCapableIn(sql: string): string | null {
  const text = stripNoise(sql).replace(SCRATCH_WRITES, ' ')
  const m = WRITE_WORDS.exec(text)
  return m ? m[0].trim().toLowerCase() : null
}

export interface WriteSafety {
  safe: boolean
  reason: string | null
}

/**
 * Whether a saved query is safe to serve from a cache. `readProc` returns a
 * procedure's definition, or null when it cannot be read. Procedures are
 * followed through nested EXECs up to MAX_PROCS; past that, or when one cannot
 * be read, the answer is "not safe": the suggestion is withheld, not guessed.
 */
export async function assessWriteSafety(
  sql: string,
  readProc: (name: string) => Promise<string | null> = procedureText
): Promise<WriteSafety> {
  const own = writeCapableIn(sql)
  if (own) return { safe: false, reason: `the query text contains "${own}"` }
  const queue = [...stripNoise(sql).matchAll(EXEC_TARGET)].map((m) => m[1])
  const seen = new Set<string>()
  while (queue.length) {
    const name = queue.shift() as string
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    if (seen.size >= MAX_PROCS)
      return { safe: false, reason: 'it calls too many procedures to verify' }
    seen.add(key)
    if (/^(sp|xp)_/i.test(name))
      return { safe: false, reason: `it calls the system procedure ${name}` }
    const body = await readProc(name)
    if (body == null) return { safe: false, reason: `the procedure ${name} could not be read` }
    const hit = writeCapableIn(body)
    if (hit) return { safe: false, reason: `the procedure ${name} contains "${hit}"` }
    for (const m of stripNoise(body).matchAll(EXEC_TARGET)) queue.push(m[1])
  }
  return { safe: true, reason: null }
}

const safetyCache = new Map<string, { at: number; value: Promise<WriteSafety> }>()
const SAFETY_TTL_MS = 10 * 60_000

/** assessWriteSafety, remembered ten minutes per query text (the panel refetches every 30 s). */
export function cachedWriteSafety(sql: string): Promise<WriteSafety> {
  const key = createHash('sha1').update(sql).digest('hex')
  const hit = safetyCache.get(key)
  if (hit && Date.now() - hit.at < SAFETY_TTL_MS) return hit.value
  const value = assessWriteSafety(sql).catch(() => ({
    safe: false,
    reason: 'it could not be checked'
  }))
  safetyCache.set(key, { at: Date.now(), value })
  return value
}

// ── the math ────────────────────────────────────────────────────────────────

export interface TtlOption {
  ttl_seconds: number
  /** Calls the cache would answer per day, at best (one key). */
  hits_per_day: number
  saved_ms_per_day: number
  /** The longest a viewer can be shown an older figure, in words. */
  staleness: string
}

export function describeWindow(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${Math.round((seconds / 3600) * 10) / 10} h`
}

/**
 * What each candidate TTL saves for a query called `callsPerDay` times at
 * `avgMs` a run. The cache can answer at most (calls - windows) of them, where
 * a window is one TTL-long stretch in which the first call must run; an option
 * that saves nothing (calls rarer than the window) is dropped.
 */
export function ttlOptions(callsPerDay: number, avgMs: number): TtlOption[] {
  const out: TtlOption[] = []
  for (const ttl of SUGGEST_TTLS) {
    const windows = 86_400 / ttl
    const hits = Math.max(0, callsPerDay - Math.min(callsPerDay, windows))
    const saved = Math.round(hits * avgMs)
    if (hits < 1 || saved < MIN_SAVED_MS_PER_DAY) continue
    out.push({
      ttl_seconds: ttl,
      hits_per_day: Math.round(hits),
      saved_ms_per_day: saved,
      staleness: `up to ${describeWindow(ttl)} old`
    })
  }
  return out
}

/** The shortest option that earns at least 70% of the best one: least staleness for most of the saving. */
export function recommend(options: TtlOption[]): TtlOption | null {
  if (!options.length) return null
  const best = Math.max(...options.map((o) => o.saved_ms_per_day))
  return options.find((o) => o.saved_ms_per_day >= best * 0.7) ?? options[options.length - 1]
}

export interface TtlSuggestion {
  id: number
  slug: string
  name: string
  current_ttl: number
  calls_per_day: number
  avg_exec_ms: number
  observed_hours: number
  low_confidence: boolean
  options: TtlOption[]
  recommended: TtlOption
}

export interface SuggestInput {
  id: number
  slug: string
  name: string
  sql_text: string
  cache_ttl: number
  enabled: boolean
  /** From the cache stats; null when the query has not run since boot. */
  stat: { hits: number; misses: number; uncached_runs: number; avg_exec_ms: number | null } | null
}

export interface WithheldQuery {
  slug: string
  name: string
  reason: string
}

/** Suggestions for the queries that qualify, biggest saving first. */
export async function buildTtlSuggestions(
  queries: SuggestInput[],
  since: string,
  now: number = Date.now(),
  safety: (sql: string) => Promise<WriteSafety> = cachedWriteSafety
): Promise<{ suggestions: TtlSuggestion[]; withheld: WithheldQuery[] }> {
  const observedHours = Math.max(MIN_OBSERVED_HOURS, (now - new Date(since).getTime()) / 3_600_000)
  const suggestions: TtlSuggestion[] = []
  const withheld: WithheldQuery[] = []
  for (const q of queries) {
    if (!q.enabled || q.cache_ttl > LOW_TTL_MAX || !q.stat) continue
    const avg = q.stat.avg_exec_ms
    const calls = q.stat.uncached_runs + q.stat.hits + q.stat.misses
    if (avg == null || avg < MIN_AVG_EXEC_MS || calls < MIN_CALLS) continue
    const callsPerDay = (calls / observedHours) * 24
    const options = ttlOptions(callsPerDay, avg).filter((o) => o.ttl_seconds > q.cache_ttl)
    const rec = recommend(options)
    if (!rec) continue
    const s = await safety(q.sql_text)
    if (!s.safe) {
      withheld.push({ slug: q.slug, name: q.name, reason: s.reason ?? 'it may write' })
      continue
    }
    suggestions.push({
      id: q.id,
      slug: q.slug,
      name: q.name,
      current_ttl: q.cache_ttl,
      calls_per_day: Math.round(callsPerDay),
      avg_exec_ms: Math.round(avg),
      observed_hours: Math.round(observedHours * 10) / 10,
      low_confidence: observedHours < LOW_CONFIDENCE_HOURS,
      options,
      recommended: rec
    })
  }
  suggestions.sort((a, b) => b.recommended.saved_ms_per_day - a.recommended.saved_ms_per_day)
  return { suggestions, withheld }
}
