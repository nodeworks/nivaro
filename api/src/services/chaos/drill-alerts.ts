import type { FastifyInstance } from 'fastify'
import type { AlertFired } from '../alert-fired.js'
import type { NotifyUserOptions } from '../notification-channels.js'
import { isBlindRun } from './blind.js'
import { type ArmedFault, getFault } from './catalog.js'
import { armedFaults } from './registry.js'
import { type ChaosRun, getRun } from './runs.js'

/**
 * Alerts tagged as drill (#2847). An alert that fires while a fault is armed is NEVER silenced
 * or rerouted: its normal recipients and channels stay exactly as they are (an operator must not
 * be able to arm a trivial fault to quiet real alerts, and a real incident during a drill must
 * still be seen). What changes:
 *  - the message carries a drill note naming the run: "may be caused by the chaos drill X" when
 *    the alert's subject matches the armed fault (its area, points, key or target — a database
 *    alert during a database fault), else "fired during the chaos drill X";
 *  - the run's participants are told too (in-app, never email), when they were not already;
 *  - the alert rows on the Ops Console, Telemetry and the Integrations console show a Drill tag
 *    by time (`GET /api/chaos/drill-windows`).
 * Blind runs (#2854) keep the note out of the normal recipients' copy — the alert itself still
 * reaches them. The run's `alert` events are written by the run monitor (chaos/monitors.ts,
 * services/alert-fired.ts), not here. With nothing armed, `drillAlert` answers null.
 */

const UUID_RE = /^[0-9a-f-]{36}$/i

function ids(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw]
  return list.map((v) => String(v ?? '').toLowerCase()).filter((v) => UUID_RE.test(v))
}

/**
 * Who takes part in a run: whoever started it plus the game day's people (`meta.participants`,
 * `meta.roles.{lead, scribe, responders}` on the run or on its game-day row — gameday.ts
 * rolesMeta). Blind runs (#2854, `meta.blind` or an open blind window) leave the responders
 * out — they are being tested. A monkey run's people are administrators and chaos operators.
 */
export async function runParticipants(run: ChaosRun): Promise<string[]> {
  const out = new Set<string>(ids(run.started_by))
  const rows: ChaosRun[] = [run]
  if (run.gameday_id) {
    const day = await getRun(run.gameday_id).catch(() => null)
    if (day) rows.push(day)
  }
  const blind = rows.some(blindRow)
  for (const r of rows) {
    const roles = (r.meta?.roles ?? {}) as Record<string, unknown>
    for (const id of ids(r.started_by)) out.add(id)
    for (const id of ids(roles.lead)) out.add(id)
    for (const id of ids(r.meta?.lead)) out.add(id)
    if (blind) continue
    for (const id of ids(r.meta?.participants)) out.add(id)
    for (const id of ids(roles.scribe)) out.add(id)
    for (const id of ids(roles.responders)) out.add(id)
  }
  // Chaos Monkey (#2829) starts runs with nobody behind them: its people are the ones it tells
  // when it starts — administrators and chaos operators.
  if (run.kind === 'monkey' && out.size === 0) {
    const { monkeyAudience } = await import('./monkey.js')
    for (const id of ids(await monkeyAudience())) out.add(id)
  }
  return [...out]
}

export interface DrillRouting {
  run_id: string
  label: string
  participants: string[]
  /** The alert's subject matches an armed fault ("may be caused by"). */
  related: boolean
  /** Blind run (#2854): the normal recipients' copy carries no drill note. */
  blind: boolean
  /** The sentence added to the message. */
  note: string
}

/** The run(s) armed here right now, newest first. */
async function activeRuns(): Promise<Array<{ run: ChaosRun; faults: ArmedFault[] }>> {
  const byRun = new Map<string, ArmedFault[]>()
  for (const f of armedFaults().sort((a, b) => b.started_at - a.started_at)) {
    if (!f.run_id) continue
    byRun.set(f.run_id, [...(byRun.get(f.run_id) ?? []), f])
  }
  const out: Array<{ run: ChaosRun; faults: ArmedFault[] }> = []
  for (const [id, faults] of byRun) {
    const run = await getRun(id).catch(() => null)
    if (run && run.status === 'running') out.push({ run, faults })
  }
  return out
}

/** What an area's alerts tend to say. */
const AREA_WORDS: Record<string, string[]> = {
  http: ['http', 'request', 'latency', 'slow', '5xx', 'error rate', 'p95', 'response', 'api'],
  db: ['db', 'database', 'sql', 'pool', 'deadlock', 'query', 'connection', 'mssql'],
  redis: ['redis', 'cache', 'session', 'lease'],
  socket: ['socket', 'realtime', 'websocket', 'reconnect'],
  mail: ['mail', 'smtp', 'email'],
  outbound: ['partner', 'integration', 'external', 'erp', 'webhook', 'push'],
  storage: ['file', 'disk', 'storage', 'share', 'upload', 'space', 'enospc'],
  ai: ['ai', 'model', 'gateway'],
  cron: ['cron', 'job', 'lease', 'schedule']
}
const AREA_ALIAS: Record<string, string> = {
  external: 'outbound',
  partner: 'outbound',
  files: 'storage',
  realtime: 'socket',
  sockets: 'socket',
  pool: 'db'
}
const GENERIC = new Set(['down', 'fault', 'faults', 'slow', 'errors', 'error', 'drill', 'pause'])

/** The words that would name this fault's subject in an alert. */
export function faultWords(f: ArmedFault): string[] {
  const def = getFault(f.fault_key)
  const areas = new Set<string>()
  const add = (a: string | undefined | null) => {
    if (!a) return
    const k = AREA_ALIAS[a] ?? a
    areas.add(k)
  }
  // Where it acts says more than the file that registered it (mail_down lives in the http area).
  for (const p of def?.points ?? []) add(p.split('.')[0])
  if (!areas.size) add(def?.area)
  for (const t of f.fault_key.split('_')) if (AREA_WORDS[AREA_ALIAS[t] ?? t]) add(t)
  const words = new Set<string>()
  for (const a of areas) for (const w of AREA_WORDS[a] ?? [a]) words.add(w)
  for (const t of f.fault_key.split('_')) if (t.length >= 3 && !GENERIC.has(t)) words.add(t)
  const t = f.target
  if (t.kind === 'table') words.add(t.table.toLowerCase())
  if (t.kind === 'route')
    for (const seg of t.pattern.split('/'))
      if (seg.length >= 3 && !seg.includes('*')) words.add(seg.toLowerCase())
  return [...words]
}

/** Does the alert's subject match this fault (pure)? Whole-word match on source + label + key. */
export function alertRelatesTo(
  alert: Pick<AlertFired, 'source' | 'label' | 'key'>,
  f: ArmedFault
): boolean {
  const text = `${alert.source} ${alert.label} ${alert.key}`.toLowerCase().replace(/[_./:-]+/g, ' ')
  return faultWords(f).some((w) =>
    new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(text)
  )
}

/**
 * Call where an alert fires and people are about to be told. null = no drill: carry on exactly
 * as before. Otherwise the caller tells its normal recipients as always (message through
 * `withDrillNote`) and then `tellDrillParticipants` for the run's people not already told.
 */
export async function drillAlert(
  alert: Pick<AlertFired, 'source' | 'label' | 'key'>
): Promise<DrillRouting | null> {
  if (!armedFaults().length) return null
  const runs = await activeRuns()
  if (!runs.length) return null
  const related = runs.find((r) => r.faults.some((f) => alertRelatesTo(alert, f)))
  const pick = related ?? runs[0]
  const people = new Set<string>()
  for (const { run } of runs) for (const id of await runParticipants(run)) people.add(id)
  const blind = await runIsBlind(pick.run)
  const label = pick.run.label
  return {
    run_id: pick.run.id,
    label,
    participants: [...people],
    related: !!related,
    blind,
    note: related
      ? `May be caused by the chaos drill “${label}” (run ${pick.run.id}).`
      : `Fired during the chaos drill “${label}” (run ${pick.run.id}).`
  }
}

/** Blind (#2854): inside an unrevealed blind window (blind.ts — single blind drills and game
 *  days), or a game day whose plan is blind and not yet revealed (`meta.blind`, rolesMeta). */
function blindRow(run: ChaosRun): boolean {
  return run.meta?.blind === true || isBlindRun(run.id)
}

async function runIsBlind(run: ChaosRun): Promise<boolean> {
  if (blindRow(run)) return true
  if (!run.gameday_id) return false
  if (isBlindRun(run.gameday_id)) return true
  const day = await getRun(run.gameday_id).catch(() => null)
  return !!day && blindRow(day)
}

/** The message a recipient gets: the drill note appended (participants always see it). */
export function withDrillNote(
  message: string,
  drill: DrillRouting | null,
  forParticipant = false
): string {
  if (!drill || (drill.blind && !forParticipant)) return message
  return `${message ?? ''}\n\n${drill.note}`.trim()
}

/** Tell the run's participants who were not already told (in-app, never email). */
export async function tellDrillParticipants(
  app: FastifyInstance,
  routing: DrillRouting,
  opts: NotifyUserOptions,
  alreadyTold: Iterable<string> = []
): Promise<number> {
  const { notifyUser } = await import('../notification-channels.js')
  const skip = new Set([...alreadyTold].map((s) => String(s).toLowerCase()))
  let told = 0
  for (const userId of routing.participants) {
    if (skip.has(userId.toLowerCase())) continue
    try {
      const r = await notifyUser(app, userId, {
        ...opts,
        subject: `[Drill] ${opts.subject}`,
        message: withDrillNote(opts.message ?? '', routing, true),
        channels: { inapp: true }
      })
      if (!r?.decision?.dropped) told++
    } catch {
      /* the rest still deserve a try */
    }
  }
  return told
}

export interface DrillWindow {
  run_id: string
  kind: ChaosRun['kind']
  label: string
  fault_key: string | null
  started_at: string
  /** null while it runs. */
  ended_at: string | null
}

/** Runs that armed something, overlapping [since, now] — the tag the alert rows show. */
export function drillWindows(runs: ChaosRun[], since: number, now = Date.now()): DrillWindow[] {
  const out: DrillWindow[] = []
  for (const r of runs) {
    if (!r.started_at || r.status === 'refused' || r.status === 'planned') continue
    if (r.kind === 'ci') continue
    const start = Date.parse(r.started_at)
    const end = r.ended_at
      ? Date.parse(r.ended_at)
      : r.status === 'running'
        ? now
        : Date.parse(r.ends_at ?? '')
    if (!Number.isFinite(start)) continue
    if (Number.isFinite(end) && end < since) continue
    out.push({
      run_id: r.id,
      kind: r.kind,
      label: r.label,
      fault_key: r.fault_key,
      started_at: r.started_at,
      ended_at: r.status === 'running' ? null : (r.ended_at ?? r.ends_at)
    })
  }
  return out
}
