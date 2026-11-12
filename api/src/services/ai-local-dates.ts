/**
 * The day a person means, against the instants the database holds.
 *
 * Ask AI writes date filters the way a person says them — "created today" is
 * `{"_gte": "2026-11-09T00:00:00", "_lte": "2026-11-09T23:59:59"}`, with no
 * zone. A timestamp column holds UTC instants, so read as written that filter
 * is the UTC day: for someone in US Eastern it starts at 7 PM the evening
 * before and ends at 7 PM today. The answer counted last night's records as
 * today's and dropped everything created after 7 PM.
 *
 * Everything here is pure (no database, no clock unless one is passed): the
 * tools hand in the person's time zone and say which columns hold instants.
 */

export interface WallTime {
  y: number
  m: number
  d: number
  h: number
  mi: number
  s: number
  ms: number
}

type Precision = 'day' | 'minute' | 'second' | 'fraction'

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?)?$/

/** A date or date-time written WITHOUT a zone; null for anything else (a value with Z or an offset says its own instant). */
export function parseNaiveDate(v: unknown): (WallTime & { precision: Precision }) | null {
  if (typeof v !== 'string') return null
  const m = NAIVE.exec(v.trim())
  if (!m) return null
  const w = {
    y: Number(m[1]),
    m: Number(m[2]),
    d: Number(m[3]),
    h: Number(m[4] ?? 0),
    mi: Number(m[5] ?? 0),
    s: Number(m[6] ?? 0),
    ms: m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0
  }
  if (w.m < 1 || w.m > 12 || w.d < 1 || w.d > 31 || w.h > 23 || w.mi > 59 || w.s > 59) return null
  const precision: Precision =
    m[4] == null ? 'day' : m[7] != null ? 'fraction' : m[6] != null ? 'second' : 'minute'
  return { ...w, precision }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    formatters.set(timeZone, f)
  }
  return f
}

/** The clock time an instant shows in a zone. */
export function zonedWallTime(at: Date, timeZone: string): WallTime {
  const p: Record<string, number> = {}
  for (const part of formatter(timeZone).formatToParts(at)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  return {
    y: p.year,
    m: p.month,
    d: p.day,
    h: p.hour === 24 ? 0 : p.hour,
    mi: p.minute,
    s: p.second,
    ms: at.getUTCMilliseconds()
  }
}

/** A clock time as if it were UTC — the number wall-time arithmetic is done on. */
function wallMs(w: WallTime): number {
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s, w.ms)
}

/** Zone offset (local − UTC, ms) at an instant. */
function offsetAt(utcMs: number, timeZone: string): number {
  const at = new Date(utcMs)
  return wallMs(zonedWallTime(at, timeZone)) - utcMs
}

function wallMsToUtc(wall: number, timeZone: string): Date {
  // Guess with the offset at the wall time read as UTC, then correct with the
  // offset at that guess — the two differ only across a clock change.
  const guess = wall - offsetAt(wall, timeZone)
  return new Date(wall - offsetAt(guess, timeZone))
}

/** The instant a clock time is in a zone. Days past the end of a month carry over. */
export function wallTimeToUtc(w: WallTime, timeZone: string): Date {
  return wallMsToUtc(wallMs(w), timeZone)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The person's current day and the next one, as YYYY-MM-DD. */
export function localDay(now: Date, timeZone: string): { today: string; tomorrow: string } {
  const w = zonedWallTime(now, timeZone)
  const next = new Date(Date.UTC(w.y, w.m - 1, w.d + 1))
  return {
    today: `${w.y}-${pad(w.m)}-${pad(w.d)}`,
    tomorrow: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
  }
}

/**
 * How an instant is written into a filter: UTC, to the millisecond, with no
 * zone suffix. A timestamp column compares a zone-less value as UTC whether it
 * keeps an offset or not, so one spelling is right for both.
 */
function sqlUtc(d: Date): string {
  return d.toISOString().slice(0, 23)
}

const COMPARE = new Set(['_eq', '_gt', '_gte', '_lt', '_lte'])

/**
 * One field's operators, with every zone-less date read in the person's time
 * zone. A bare date means that whole local day: `_eq` becomes the day's range,
 * `_lte` runs to the end of it, `_gt` starts with the next one. A value that
 * names its own zone, a list, or anything that is not a date is left exactly
 * as written — and so is the whole map when two bounds would land on the same
 * operator (nothing is guessed).
 */
export function localizeDateOps(
  ops: Record<string, unknown>,
  timeZone: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let clash = false
  let changed = false
  const put = (op: string, value: unknown) => {
    if (op in out) clash = true
    out[op] = value
  }
  for (const [op, value] of Object.entries(ops)) {
    const w = COMPARE.has(op) ? parseNaiveDate(value) : null
    if (!w) {
      put(op, value)
      continue
    }
    changed = true
    const wall = wallMs(w)
    if (w.precision === 'day') {
      const start = sqlUtc(wallMsToUtc(wall, timeZone))
      const next = sqlUtc(wallMsToUtc(Date.UTC(w.y, w.m - 1, w.d + 1), timeZone))
      if (op === '_gte') put('_gte', start)
      else if (op === '_lt') put('_lt', start)
      else if (op === '_gt') put('_gte', next)
      else if (op === '_lte') put('_lt', next)
      else {
        put('_gte', start)
        put('_lt', next)
      }
      continue
    }
    // "through 23:59:59" means through the end of that second (or minute).
    if (op === '_lte' && w.precision !== 'fraction') {
      const step = w.precision === 'second' ? 1000 : 60_000
      put('_lt', sqlUtc(wallMsToUtc(wall + step, timeZone)))
    } else put(op, sqlUtc(wallMsToUtc(wall, timeZone)))
  }
  return clash || !changed ? ops : out
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Is there a zone-less date anywhere in this filter? The common "no" costs no lookup. */
export function hasNaiveDate(raw: unknown): boolean {
  if (typeof raw === 'string') return parseNaiveDate(raw) != null
  if (Array.isArray(raw)) return false
  if (!isObject(raw)) return false
  return Object.values(raw).some(hasNaiveDate)
}

/**
 * A model-written filter (`{"field": {"_op": value}}`, dotted keys, nested
 * relation objects, bare-value equality) with its zone-less dates read in the
 * person's time zone — only on columns `isInstant` says hold a moment in time.
 * A calendar date kept as written (a required-by date) is never shifted.
 */
export async function localizeRawFilter(
  raw: unknown,
  timeZone: string,
  isInstant: (path: string[]) => Promise<boolean>
): Promise<unknown> {
  if (!isObject(raw) || !hasNaiveDate(raw)) return raw
  const walk = async (prefix: string[], node: Record<string, unknown>) => {
    const out: Record<string, unknown> = {}
    for (const [key, cond] of Object.entries(node)) {
      // Operators belong to the field above; `$state` and friends hold no dates.
      if (key.startsWith('_') || key.startsWith('$') || !hasNaiveDate(cond)) {
        out[key] = cond
        continue
      }
      const path = [...prefix, ...key.split('.').map((s) => s.trim())]
      if (isObject(cond)) {
        const keys = Object.keys(cond)
        const operators = keys.length > 0 && keys.every((k) => k.startsWith('_'))
        if (!operators) out[key] = await walk(path, cond)
        else out[key] = (await isInstant(path)) ? localizeDateOps(cond, timeZone) : cond
        continue
      }
      // Bare value = equality shorthand.
      out[key] = (await isInstant(path)) ? localizeDateOps({ _eq: cond }, timeZone) : cond
    }
    return out
  }
  return walk([], raw)
}
