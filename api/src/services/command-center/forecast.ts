import type { FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import { withReadGate } from '../read-gate.js'
import { ccIsAdmin } from './auth.js'
import { readCcScope } from './scope.js'
import { tenantMemo, Viewer } from './work-access.js'
import {
  bucketDaysByLocalHour,
  DAY_MS,
  expectedByHour,
  expectedSoFar,
  HOUR_MS,
  isBehind,
  localParts,
  validTimeZone,
  zonedMidnightUtc
} from './work-math.js'

/**
 * CC-33 today's forecast: arrivals (pipeline instances started — a record entering its workflow)
 * and completions (instances completed) per local hour today, against the expectation — the mean
 * of the same hour on the same weekday over the previous 4 weeks. `*_expected` is the expectation
 * BY NOW (whole past hours + the elapsed share of the current one), so it compares with
 * `*_so_far`; by_hour carries the whole day's curve. Behind = today's backlog growth beats the
 * usual growth by more than the band in work-math isBehind.
 *
 * Hours are the viewer's local hours (`tz` query parameter, IANA name; default UTC). Only
 * collections the caller may read, only records they can open, inside the focused region. Rewind:
 * the day of `at`, up to `at`.
 *
 * Mirrors packages/shared/src/components/command-center/types.ts ForecastToday.
 */
export interface ForecastToday {
  arrivals_so_far: number
  arrivals_expected: number
  completions_so_far: number
  completions_expected: number
  behind: boolean
  by_hour: Array<{
    hour: number
    arrivals: number
    completions: number
    expected_arrivals: number
    expected_completions: number
  }>
  live_only?: boolean
  region_applies?: boolean
  /** How many past same-weekdays the expectation averages (0 = no history yet). */
  history_days?: number
  time_zone?: string
}

const ROW_CAP = 50_000
const WEEKS = 4

interface Row {
  collection: string
  item: string
  at: number
}

/** The 5 local days (today + the same weekday 1..4 weeks back) as UTC windows. */
export function forecastDays(
  nowMs: number,
  tz: string
): Array<{ ymd: string; from: number; to: number }> {
  return Array.from({ length: WEEKS + 1 }, (_, k) => {
    const day = localParts(nowMs - k * 7 * DAY_MS, tz).ymd
    const midnight = zonedMidnightUtc(day, tz)
    // Two spare hours each side cover DST; rows are bucketed by their local date afterwards.
    return { ymd: day, from: midnight - 2 * HOUR_MS, to: midnight + 26 * HOUR_MS }
  })
}

async function readRows(
  collections: string[],
  days: Array<{ from: number; to: number }>,
  column: 'started_at' | 'completed_at',
  upTo: number
): Promise<Row[]> {
  if (collections.length === 0) return []
  const rows = (await db('nivaro_workflow_instances')
    .whereIn('collection', collections)
    .where((w) => {
      for (const d of days) w.orWhereBetween(column, [new Date(d.from), new Date(d.to)])
    })
    .where(column, '<=', new Date(upTo))
    .limit(ROW_CAP)
    .select('collection', 'item', `${column} as at`)) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    collection: String(r.collection),
    item: String(r.item),
    at: new Date(r.at as Date).getTime()
  }))
}

/** Pure assembly from bucketed counts (tests). */
export function assembleForecast(input: {
  today: { arrivals: number[]; completions: number[] }
  past: Array<{ arrivals: number[]; completions: number[] }>
  hour: number
  fraction: number
}): ForecastToday {
  const expA = expectedByHour(input.past.map((p) => p.arrivals))
  const expC = expectedByHour(input.past.map((p) => p.completions))
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
  const f = {
    arrivals_so_far: sum(input.today.arrivals),
    completions_so_far: sum(input.today.completions),
    arrivals_expected: expectedSoFar(expA, input.hour, input.fraction),
    completions_expected: expectedSoFar(expC, input.hour, input.fraction)
  }
  return {
    ...f,
    behind: input.past.length > 0 && isBehind(f),
    by_hour: Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      arrivals: input.today.arrivals[h] ?? 0,
      completions: input.today.completions[h] ?? 0,
      expected_arrivals: expA[h],
      expected_completions: expC[h]
    })),
    history_days: input.past.length
  }
}

export async function forecastForRequest(req: FastifyRequest): Promise<ForecastToday> {
  const scope = readCcScope(req.query)
  const tz = validTimeZone((req.query as Record<string, unknown>)?.tz)
  const viewer = new Viewer(req.user!, ccIsAdmin(req), scope.region)
  const now = scope.at ? scope.at.getTime() : Date.now()
  const days = forecastDays(now, tz)

  const bindings = (await db('nivaro_workflow_bindings').distinct('collection')) as Array<{
    collection: string
  }>
  const collections: string[] = []
  for (const b of bindings) if (await viewer.mayRead(b.collection)) collections.push(b.collection)

  // Raw rows are viewer-independent: shared per tenant + zone + minute, then narrowed per viewer.
  const minute = Math.floor(now / 60_000)
  const raw = await tenantMemo(
    `cc:forecast:${tz}:${minute}:${collections.sort().join(',')}`,
    60_000,
    () =>
      withReadGate(
        String(req.user!.id),
        async () => {
          const [starts, ends] = await Promise.all([
            readRows(collections, days, 'started_at', now),
            readRows(collections, days, 'completed_at', now)
          ])
          return { starts, ends }
        },
        { label: 'cc:forecast' }
      )
  )
  const narrow = async (rows: Row[]) => {
    const by = new Map<string, Row[]>()
    for (const r of rows) {
      const list = by.get(r.collection)
      if (list) list.push(r)
      else by.set(r.collection, [r])
    }
    const out: Row[] = []
    for (const [c, list] of by) out.push(...(await viewer.filter(c, list, (r) => r.item)))
    return out
  }
  const starts = await narrow(raw?.starts ?? [])
  const ends = await narrow(raw?.ends ?? [])

  // One pass per side over all five days.
  const ymds = days.map((d) => d.ymd)
  const startsBy = bucketDaysByLocalHour(
    starts.map((r) => r.at),
    ymds,
    tz
  )
  const endsBy = bucketDaysByLocalHour(
    ends.map((r) => r.at),
    ymds,
    tz
  )
  // A past day with nothing at all (before the pipeline existed, or a closed day) still counts:
  // it is what that weekday looked like.
  const past = days.slice(1).map((d) => ({
    arrivals: startsBy.get(d.ymd) as number[],
    completions: endsBy.get(d.ymd) as number[]
  }))
  const hasHistory =
    starts.some((r) => r.at < days[0].from) || ends.some((r) => r.at < days[0].from)
  const p = localParts(now, tz)
  const out = assembleForecast({
    today: {
      arrivals: startsBy.get(days[0].ymd) as number[],
      completions: endsBy.get(days[0].ymd) as number[]
    },
    past: hasHistory ? past : [],
    hour: p.hour,
    fraction: p.minute / 60
  })
  return {
    ...out,
    time_zone: tz,
    ...(scope.region ? { region_applies: viewer.regionApplied } : {})
  }
}
