import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import { getHuddleSettings, type HuddleSettings, iceServersFrom } from './huddle-settings.js'
import { type ProbeResult, probeIceServers } from './huddle-turn-probe.js'

/**
 * Continuous coturn monitoring (#2850). The `huddle-turn-probe` cron (every 5 minutes, only
 * where crons tick, never in cloud mode) does a real allocation against each configured TURN
 * url — and a Binding request against each STUN url — with the credential a browser would
 * get, keeps a day of history in Redis, and after PROBE_FAILURES_TO_RAISE failures in a row
 * raises one deduped issue. Settings → Huddles shows the strip and sparkline from
 * `huddleProbeStatus`.
 */

export const PROBE_FAILURES_TO_RAISE = 3
/** One sample every 5 minutes: a day of history. */
const HISTORY_MAX = 288
const KEY_HISTORY = 'nvr:huddle:probe:history'
const KEY_STATE = 'nvr:huddle:probe:state'
const ISSUE_FINGERPRINT = createHash('sha256').update('huddle-turn-probe').digest('hex')

export interface ProbeSample {
  at: string
  ok: boolean
  /** Slowest successful allocation, ms (null when nothing succeeded). */
  ms: number | null
  results: ProbeResult[]
}

export interface ProbeRedis {
  lpush(key: string, ...values: string[]): Promise<unknown>
  ltrim(key: string, start: number, stop: number): Promise<unknown>
  lrange(key: string, start: number, stop: number): Promise<string[]>
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>
}

interface ProbeState {
  failures: number
  issue_id: number | null
}

async function readState(redis: ProbeRedis): Promise<ProbeState> {
  try {
    const raw = await redis.get(KEY_STATE)
    const s = raw ? (JSON.parse(raw) as Partial<ProbeState>) : {}
    return { failures: Number(s.failures) || 0, issue_id: s.issue_id ?? null }
  } catch {
    return { failures: 0, issue_id: null }
  }
}

async function writeState(redis: ProbeRedis, s: ProbeState): Promise<void> {
  await redis.set(KEY_STATE, JSON.stringify(s), 'EX', 7 * 24 * 3600)
}

/** Does this configuration give the probe anything to test? */
export function probeTargets(s: HuddleSettings): { turn: number; stun: number } {
  return { turn: s.turn_urls.length, stun: s.stun_urls.length }
}

/** Pure: a sample is ok when every probed url answered. */
export function sampleOf(results: ProbeResult[], at = new Date()): ProbeSample {
  const okMs = results.filter((r) => r.ok).map((r) => r.ms)
  return {
    at: at.toISOString(),
    ok: results.length > 0 && results.every((r) => r.ok),
    ms: okMs.length ? Math.max(...okMs) : null,
    results
  }
}

async function raiseIssue(failures: number, sample: ProbeSample): Promise<number | null> {
  try {
    const bad = sample.results.filter((r) => !r.ok)
    const details = [
      `The huddle TURN probe has failed ${failures} times in a row (one probe every 5 minutes).`,
      '',
      ...bad.map((r) => `  ${r.url} — ${r.error ?? 'failed'}`),
      '',
      'Consequence: people behind strict firewalls or NAT cannot join huddles; calls between people on different networks fail while this lasts.',
      'Check that coturn is running, the ports (3478/5349 and the relay range) are open, and the shared secret in Settings → Huddles matches coturn’s static-auth-secret.'
    ].join('\n')
    const existing = (await db('nivaro_issues')
      .where({ fingerprint: ISSUE_FINGERPRINT })
      .whereIn('status', ['open', 'acknowledged'])
      .first('id')) as { id: number } | undefined
    if (existing) {
      await db('nivaro_issues')
        .where({ id: existing.id })
        .update({
          details,
          occurrence_count: db.raw('occurrence_count + 1'),
          last_seen_at: new Date(),
          updated_at: new Date()
        })
      return existing.id
    }
    const row = (await db('nivaro_issues')
      .insert({
        title: 'Huddle TURN server is not answering',
        severity: 'high',
        status: 'open',
        source: 'server',
        details,
        fingerprint: ISSUE_FINGERPRINT,
        occurrence_count: 1,
        last_seen_at: new Date(),
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('id')) as Array<number | { id: number }>
    const first = row[0]
    return typeof first === 'object' && first ? first.id : (first as number | null)
  } catch (err) {
    console.warn('huddle-turn-probe issue write failed:', err)
    return null
  }
}

export interface ProbeRunDeps {
  redis: ProbeRedis
  settings?(): Promise<HuddleSettings>
  probe?: typeof probeIceServers
  raise?: typeof raiseIssue
  now?(): Date
}

/** One probe cycle. `skipped` = nothing configured (no history is written). */
export async function runHuddleProbe(
  deps: ProbeRunDeps
): Promise<{ skipped: true } | { skipped: false; sample: ProbeSample; failures: number }> {
  const s = await (deps.settings ?? getHuddleSettings)()
  if (!s.enabled || (!s.turn_urls.length && !s.stun_urls.length)) return { skipped: true }
  // The credential a person would get for a room they can see (minted the same way).
  const servers = iceServersFrom({ ...s, turn_ttl_s: 120 }, 'huddle-probe')
  const results = await (deps.probe ?? probeIceServers)(servers)
  const sample = sampleOf(results, deps.now?.())
  await deps.redis.lpush(KEY_HISTORY, JSON.stringify(sample))
  await deps.redis.ltrim(KEY_HISTORY, 0, HISTORY_MAX - 1)
  const state = await readState(deps.redis)
  // A run with only STUN urls counts as healthy only if those answer; TURN is what we raise on.
  const turnFailed = sample.results.some((r) => r.kind === 'turn' && !r.ok)
  const failures = turnFailed ? state.failures + 1 : 0
  let issue = state.issue_id
  if (
    turnFailed &&
    (failures === PROBE_FAILURES_TO_RAISE || (failures > 3 && failures % 12 === 0))
  ) {
    issue = (await (deps.raise ?? raiseIssue)(failures, sample)) ?? issue
  }
  if (!turnFailed) issue = null
  await writeState(deps.redis, { failures, issue_id: issue })
  return { skipped: false, sample, failures }
}

export interface ProbeStatus {
  configured: boolean
  enabled: boolean
  turn_urls: number
  stun_urls: number
  last: ProbeSample | null
  /** Oldest first, for the sparkline. */
  history: Array<{ at: string; ok: boolean; ms: number | null }>
  consecutive_failures: number
  failures_to_raise: number
  issue_id: number | null
  /** Lifetime of a minted TURN credential, seconds (0 when TURN uses a static credential). */
  credential_ttl_s: number
  credential_kind: 'rest-secret' | 'static' | 'none'
}

export async function huddleProbeStatus(
  redis: ProbeRedis,
  s?: HuddleSettings
): Promise<ProbeStatus> {
  const settings = s ?? (await getHuddleSettings())
  const raw = await redis.lrange(KEY_HISTORY, 0, HISTORY_MAX - 1).catch(() => [] as string[])
  const samples: ProbeSample[] = []
  for (const r of raw) {
    try {
      samples.push(JSON.parse(r) as ProbeSample)
    } catch {
      /* torn row */
    }
  }
  const state = await readState(redis)
  return {
    configured: settings.turn_urls.length > 0 || settings.stun_urls.length > 0,
    enabled: settings.enabled,
    turn_urls: settings.turn_urls.length,
    stun_urls: settings.stun_urls.length,
    last: samples[0] ?? null,
    history: samples
      .slice()
      .reverse()
      .map((x) => ({ at: x.at, ok: x.ok, ms: x.ms })),
    consecutive_failures: state.failures,
    failures_to_raise: PROBE_FAILURES_TO_RAISE,
    issue_id: state.issue_id,
    credential_ttl_s: settings.turn_secret ? settings.turn_ttl_s : 0,
    credential_kind: settings.turn_secret
      ? 'rest-secret'
      : settings.turn_username && settings.turn_credential
        ? 'static'
        : 'none'
  }
}
