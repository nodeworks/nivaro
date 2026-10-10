/**
 * Readiness check `session-replay` (#1412): is session recording doing its
 * job? Only while recording (or error clips) is on; each warning carries the
 * figure and the likely cause.
 *
 *  - Chunk uploads failing above 5% over the last day — from the per-day
 *    counters the events route keeps (#1368): refusals the server saw (413
 *    too large, 409 closed / size-capped) plus failed attempts the recorders
 *    report on their next successful upload (`retries`). A browser that never
 *    gets through again is invisible to the server.
 *  - No recording started in 24 hours while people were signed in.
 *  - The daily byte cap was hit (recorders stopped for the rest of the day).
 *  - The oldest recording is past retention (the purge is not running).
 */
import type { ReadinessResult } from '@nivaro/extension-kit'
import { db } from '../db/index.js'
import { registerReadinessCheck } from './readiness.js'
import { flushReplayUsage, parseReplaySampling, utcDay } from './session-replay-cost.js'

export const FAILURE_RATE_WARN = 0.05
/** Below this many upload attempts a failure rate is noise. */
export const MIN_ATTEMPTS = 20
/** Retention purge runs daily; a day of slack before calling it late. */
const RETENTION_GRACE_DAYS = 1

export interface ReplayHealthFigures {
  recording_enabled: boolean
  clips_enabled: boolean
  uploads: {
    accepted: number
    duplicates: number
    rejected_closed: number
    rejected_size_cap: number
    rejected_too_large: number
    rejected_daily_cap: number
    client_failures: number
  }
  recordings_24h: number
  active_people_24h: number
  sampling_default: number
  cap_mb: number | null
  cap_hit_at: Date | null
  /** The page that stored the most on the day the cap was hit. */
  cap_top_route: { route: string; bytes: number } | null
  retention_days: number
  oldest_started_at: Date | null
}

const mb = (bytes: number) => `${Math.round((bytes / 1_048_576) * 10) / 10} MB`
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`

export function evaluateReplayHealth(
  f: ReplayHealthFigures,
  now: Date = new Date()
): ReadinessResult {
  if (!f.recording_enabled && !f.clips_enabled) {
    return { status: 'skip', detail: 'Session recording and error clips are off.' }
  }
  const warns: string[] = []
  const u = f.uploads

  // 1. Upload failures
  const failures =
    u.rejected_closed + u.rejected_size_cap + u.rejected_too_large + u.client_failures
  const attempts = u.accepted + u.duplicates + failures
  const rate = attempts > 0 ? failures / attempts : 0
  if (attempts >= MIN_ATTEMPTS && rate > FAILURE_RATE_WARN) {
    const causes: Array<[number, string]> = [
      [
        u.client_failures,
        `${u.client_failures} attempt(s) failed before reaching the server — network, a proxy or a deploy's 5xx between browsers and the API (the recorders retried)`
      ],
      [
        u.rejected_too_large,
        `${u.rejected_too_large} chunk(s) over 8 MB were refused (413) — a page's full snapshot is too heavy; mark big widgets nvr-no-record`
      ],
      [
        u.rejected_size_cap,
        `${u.rejected_size_cap} chunk(s) arrived after their recording hit the 15 MB per-recording cap — long sessions on heavy pages`
      ],
      [
        u.rejected_closed,
        `${u.rejected_closed} chunk(s) were posted to a recording already ended (409) — a tab still recording after its recording was closed`
      ]
    ]
    causes.sort((a, b) => b[0] - a[0])
    const top = causes.filter(([n]) => n > 0).map(([, why]) => why)
    warns.push(
      `${pct(rate)} of chunk uploads failed since yesterday (${failures} of ${attempts}). Likely cause: ${top[0] ?? 'unknown'}.${top.length > 1 ? ` Also: ${top.slice(1).join('; ')}.` : ''}`
    )
  }

  // 2. Daily cap hit
  const capHitRecently =
    !!f.cap_hit_at && now.getTime() - new Date(f.cap_hit_at).getTime() < 36 * 3_600_000
  if (capHitRecently && f.cap_hit_at) {
    const at = new Date(f.cap_hit_at)
    const top = f.cap_top_route
      ? ` The page that stored the most that day: ${f.cap_top_route.route || '(not stamped)'} (${mb(f.cap_top_route.bytes)}).`
      : ''
    warns.push(
      `The daily recording cap${f.cap_mb ? ` of ${f.cap_mb} MB` : ''} was reached at ${at.toISOString().slice(11, 16)} UTC on ${utcDay(at)}; recorders stopped for the rest of that day. Likely cause: more recording than the cap allows — raise replay_daily_cap_mb or lower the sampling share on the heaviest page.${top}`
    )
  }

  // 3. Nothing recorded while people were working
  if (f.recording_enabled && f.recordings_24h === 0 && f.active_people_24h > 0 && !capHitRecently) {
    const why =
      f.sampling_default === 0
        ? 'sampling records 0% of sessions by default (Settings → Session replay)'
        : 'the recorder is not starting — rrweb failed to load (a content-security policy or an ad blocker), or POST /session-recordings/start is failing'
    warns.push(
      `No recording started in the last 24 hours while ${f.active_people_24h} people were signed in. Likely cause: ${why}.`
    )
  }

  // 4. Retention purge behind
  if (f.oldest_started_at) {
    const ageDays = (now.getTime() - new Date(f.oldest_started_at).getTime()) / 86_400_000
    if (ageDays > f.retention_days + RETENTION_GRACE_DAYS) {
      warns.push(
        `The oldest recording is ${Math.floor(ageDays)} days old; retention is ${f.retention_days} days. Likely cause: the daily retention purge is not running or is failing — check the API log for "[retention] purge failed".`
      )
    }
  }

  if (warns.length > 0) {
    return {
      status: 'warn',
      detail: warns.length > 1 ? `${warns[0]} (+${warns.length - 1} more)` : warns[0],
      blockers: warns
    }
  }
  return {
    status: 'pass',
    detail: `${attempts} chunk upload(s) since yesterday, ${pct(rate)} failed; ${f.recordings_24h} recording(s) in the last 24 hours.`
  }
}

async function count(q: Promise<unknown>): Promise<number> {
  const row = (await q) as { n?: unknown } | undefined
  return Number(row?.n) || 0
}

export async function collectReplayHealthFigures(
  now: Date = new Date()
): Promise<ReplayHealthFigures> {
  await flushReplayUsage().catch(() => {})
  const since24h = new Date(now.getTime() - 86_400_000)
  const yesterday = utcDay(since24h)
  const settings = ((await db('nivaro_settings')
    .where({ id: 1 })
    .first(
      'session_recording_enabled',
      'error_replay_enabled',
      'replay_daily_cap_mb',
      'replay_sampling'
    )) ?? {}) as Record<string, unknown>
  const daily = (await db('nivaro_session_replay_daily')
    .where('day', '>=', yesterday)
    .select('*')
    .catch(() => [])) as Array<Record<string, unknown>>
  const sum = (k: string) => daily.reduce((a, d) => a + (Number(d[k]) || 0), 0)
  let capHitAt: Date | null = null
  for (const d of daily) {
    if (d.cap_hit_at) {
      const t = new Date(d.cap_hit_at as string)
      if (!capHitAt || t > capHitAt) capHitAt = t
    }
  }
  let capTop: ReplayHealthFigures['cap_top_route'] = null
  if (capHitAt) {
    const top = (await db('nivaro_session_replay_usage')
      .where({ day: utcDay(capHitAt) })
      .groupBy('route')
      .select('route')
      .sum({ bytes: 'bytes' })
      .orderByRaw('SUM(bytes) DESC')
      .first()
      .catch(() => undefined)) as { route?: string; bytes?: unknown } | undefined
    if (top) capTop = { route: String(top.route ?? ''), bytes: Number(top.bytes) || 0 }
  }
  const [recordings24h, active24h, oldest] = await Promise.all([
    count(
      db('nivaro_session_recordings')
        .where('started_at', '>=', since24h)
        .where((q) => q.whereNull('app').orWhereNot('app', 'error-clip'))
        .count({ n: '*' })
        .first()
    ),
    count(db('nivaro_users').where('last_access', '>=', since24h).count({ n: '*' }).first()),
    db('nivaro_session_recordings').min({ oldest: 'started_at' }).first() as Promise<
      { oldest?: unknown } | undefined
    >
  ])
  const { recordingRetentionDays } = await import('../routes/session-recordings.js')
  const cap = Number(settings.replay_daily_cap_mb)
  return {
    recording_enabled: !!settings.session_recording_enabled,
    clips_enabled: !!settings.error_replay_enabled,
    uploads: {
      accepted: sum('accepted'),
      duplicates: sum('duplicates'),
      rejected_closed: sum('rejected_closed'),
      rejected_size_cap: sum('rejected_size_cap'),
      rejected_too_large: sum('rejected_too_large'),
      rejected_daily_cap: sum('rejected_daily_cap'),
      client_failures: sum('client_failures')
    },
    recordings_24h: recordings24h,
    active_people_24h: active24h,
    sampling_default: parseReplaySampling(settings.replay_sampling).default,
    cap_mb: Number.isFinite(cap) && cap > 0 ? cap : null,
    cap_hit_at: capHitAt,
    cap_top_route: capTop,
    retention_days: await recordingRetentionDays(),
    oldest_started_at: oldest?.oldest ? new Date(oldest.oldest as string) : null
  }
}

let registered = false
export function registerReplayReadiness(): void {
  if (registered) return
  registered = true
  registerReadinessCheck({
    id: 'session-replay',
    label: 'Session recording is healthy',
    group: 'Operations',
    description:
      'While session recording or error clips are on: warns when more than 5% of chunk uploads failed since yesterday (refusals the server saw plus failed attempts recorders reported), when no recording started in 24 hours while people were signed in, when the daily recording cap was hit, or when the oldest recording is past retention — each with the figure and the likely cause.',
    run: async () => evaluateReplayHealth(await collectReplayHealthFigures())
  })
}
