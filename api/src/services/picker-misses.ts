import { getTenantId } from '../db/tenant-context.js'

/**
 * #2726 — picker search gaps. When a record-form picker search finds
 * nothing, the form reports the words (once per picker session, on close);
 * the server keeps an aggregate count per placement (form + field) per UTC
 * day in Redis — no person, no record, nothing else — for 14 days. The layout
 * inspector shows the top misses for a field and a suggested fix.
 *
 * Keys: `nvr:pickmiss:<tenant>:<layout>:<field>:<day>` (sorted set term →
 * count, at most KEEP_PER_DAY terms) and `nvr:pickmiss:<tenant>:<layout>:f`
 * (the fields with misses). Redis down = nothing stored, nothing shown.
 */

export const KEEP_DAYS = 14
const KEEP_PER_DAY = 300
const TTL_S = (KEEP_DAYS + 1) * 86_400
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** The ioredis subset used here (unit tests pass a fake). */
export interface MissRedis {
  multi(): {
    zincrby(key: string, n: number, member: string): unknown
    zremrangebyrank(key: string, start: number, stop: number): unknown
    expire(key: string, s: number): unknown
    sadd(key: string, member: string): unknown
    exec(): Promise<unknown>
  }
  zrevrange(key: string, start: number, stop: number, ws: 'WITHSCORES'): Promise<string[]>
  smembers(key: string): Promise<string[]>
  del(...keys: string[]): Promise<number>
  srem(key: string, member: string): Promise<number>
}

/** What people typed, as stored: trimmed, spaces collapsed, lower case; null when unusable. */
export function normalizeMissTerm(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // Control characters read as spaces.
  const plain = [...raw].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
  const t = plain.join('').replace(/\s+/g, ' ').trim().toLowerCase()
  if (t.length < 2 || t.length > 60) return null
  return t
}

/** Distinct usable terms of one session; a term that is the start of a longer one is dropped. */
export function sessionTerms(raw: unknown, max = 3): string[] {
  const list = (Array.isArray(raw) ? raw : [raw]).flatMap((r) => normalizeMissTerm(r) ?? [])
  const uniq = [...new Set(list)]
  return uniq.filter((t) => !uniq.some((o) => o !== t && o.startsWith(t))).slice(0, max)
}

export function validMissField(field: unknown): field is string {
  return typeof field === 'string' && FIELD_RE.test(field)
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function base(layoutId: number): string {
  return `nvr:pickmiss:${getTenantId() ?? ''}:${layoutId}`
}

function dayKey(layoutId: number, field: string, day: string): string {
  return `${base(layoutId)}:${field}:${day}`
}

export async function recordPickerMisses(
  redis: MissRedis | null | undefined,
  layoutId: number,
  field: string,
  terms: string[],
  now: Date = new Date()
): Promise<void> {
  if (!redis || terms.length === 0) return
  const key = dayKey(layoutId, field, utcDay(now))
  const fieldsKey = `${base(layoutId)}:f`
  const m = redis.multi()
  for (const t of terms) m.zincrby(key, 1, t)
  m.zremrangebyrank(key, 0, -(KEEP_PER_DAY + 1))
  m.expire(key, TTL_S)
  m.sadd(fieldsKey, field)
  m.expire(fieldsKey, TTL_S)
  await m.exec()
}

export interface MissCount {
  term: string
  count: number
  /** Last UTC day it was typed. */
  last: string
}

/** Sums daily `[member, score, …]` lists (newest day first) into the top misses. */
export function mergeDailyMisses(
  days: Array<{ day: string; flat: string[] }>,
  top = 10
): MissCount[] {
  const by = new Map<string, MissCount>()
  for (const { day, flat } of days) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const term = flat[i]
      const n = Number(flat[i + 1]) || 0
      const cur = by.get(term)
      if (cur) {
        cur.count += n
        if (day > cur.last) cur.last = day
      } else by.set(term, { term, count: n, last: day })
    }
  }
  return [...by.values()]
    .sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1) || a.term.localeCompare(b.term))
    .slice(0, top)
}

/** Top misses for each field of a layout (or one field) over the last KEEP_DAYS days. */
export async function topPickerMisses(
  redis: MissRedis | null | undefined,
  layoutId: number,
  field?: string | null,
  now: Date = new Date(),
  top = 10
): Promise<Array<{ field: string; total: number; misses: MissCount[] }>> {
  if (!redis) return []
  const fields = field ? [field] : await redis.smembers(`${base(layoutId)}:f`)
  const days: string[] = []
  for (let i = 0; i < KEEP_DAYS; i++) days.push(utcDay(new Date(now.getTime() - i * 86_400_000)))
  const out: Array<{ field: string; total: number; misses: MissCount[] }> = []
  for (const f of fields.filter(validMissField).slice(0, 200)) {
    const lists = await Promise.all(
      days.map(async (day) => ({
        day,
        flat: await redis.zrevrange(dayKey(layoutId, f, day), 0, 49, 'WITHSCORES')
      }))
    )
    const all = mergeDailyMisses(lists, Number.MAX_SAFE_INTEGER)
    if (all.length === 0) continue
    out.push({
      field: f,
      total: all.reduce((s, m) => s + m.count, 0),
      misses: all.slice(0, top)
    })
  }
  return out.sort((a, b) => b.total - a.total)
}

export async function clearPickerMisses(
  redis: MissRedis | null | undefined,
  layoutId: number,
  field: string,
  now: Date = new Date()
): Promise<void> {
  if (!redis) return
  const keys: string[] = []
  for (let i = 0; i <= KEEP_DAYS; i++)
    keys.push(dayKey(layoutId, field, utcDay(new Date(now.getTime() - i * 86_400_000))))
  await redis.del(...keys)
  await redis.srem(`${base(layoutId)}:f`, field)
}

export type MissSuggestionKind = 'found_now' | 'filter' | 'hidden' | 'option'

export interface MissSuggestion {
  kind: MissSuggestionKind
  text: string
}

/**
 * The fix to suggest for one miss, from counts an administrator reads now:
 * `shown` = what the picker offers today, `withoutFilter` = without the
 * field's option filter, `withoutCuration` = also without picker exclusions
 * and the collection's picker filter.
 */
export function suggestMissFix(input: {
  term: string
  target: string
  shown: number
  withoutFilter: number | null
  withoutCuration: number
  hasFilter: boolean
  filterDependsOnRecord: boolean
  quickCreate: boolean
}): MissSuggestion {
  const q = `“${input.term}”`
  const n = (v: number) => `${v.toLocaleString('en-US')} ${v === 1 ? 'record' : 'records'}`
  if (input.shown > 0)
    return {
      kind: 'found_now',
      text: `${q} finds ${n(input.shown)} now — added since, or found only on some records.`
    }
  const wf = input.withoutFilter ?? 0
  if (input.hasFilter && wf > 0)
    return {
      kind: 'filter',
      text: `${n(wf)} match ${q}, but this field’s option filter leaves them out${
        input.filterDependsOnRecord ? ' (it depends on other fields of the record)' : ''
      }. Loosen the option filter if people should be able to pick them.`
    }
  if (input.withoutCuration > wf)
    return {
      kind: 'hidden',
      text: `${n(input.withoutCuration - wf)} match ${q} but are hidden from pickers (the ${input.target} picker filter or records an admin hid).`
    }
  return {
    kind: 'option',
    text: input.quickCreate
      ? `Nothing in ${input.target} matches ${q}. People can add it from the picker with Quick create.`
      : `Nothing in ${input.target} matches ${q}. Add it as a ${input.target} record, or turn on Quick create so people can add it from the picker.`
  }
}
