// api/src/services/traffic-judgements.ts
/**
 * Traffic Map judgements made against the baselines (#2145):
 *
 *  - liveWindow()           the last LIVE_MIN minutes of the request log, rolled up like an hour
 *                           (every instance of this deployment — the same basis the bands are
 *                           learned from, unlike the per-process live map);
 *  - executiveSummary()     #2244 — requests, errors, the slowest area, partners down and people
 *                           active, each green / amber / red against its normal, one sentence each;
 *  - deployCheck()          #2221 — load against normal, heavy jobs and imports running, open
 *                           incidents, and a deterministic "deploy now" or "wait" with the reason.
 *
 * The verdict functions (`summaryTiles`, `deployRecommendation`) are pure.
 */
import { db } from '../db/index.js'
import { openThreads } from './ops-incidents.js'
import {
  type BandWire,
  type Baselines,
  baselinesAt,
  epochHour,
  type HourCells,
  type KeyBands,
  loadHours,
  readLogRows,
  readPartnerCells,
  rollupRows,
  type Score,
  sampleHours,
  scoreAgainstBaseline,
  scoreErrors,
  slotOf
} from './traffic-baselines.js'
import { tapState } from './traffic-taps.js'

export const LIVE_MIN = 15
const LIVE_CACHE_MS = 20_000
const LIVE_ROW_CAP = 60_000

interface LiveState {
  at: number
  cells: HourCells | null
  promise: Promise<HourCells> | null
}
const liveState = (): LiveState =>
  tapState<LiveState>('judgements-live', () => ({ at: 0, cells: null, promise: null }))

/** The last LIVE_MIN minutes rolled up (cached LIVE_CACHE_MS per store). */
export async function liveWindow(nowMs = Date.now()): Promise<HourCells> {
  const s = liveState()
  if (s.cells && nowMs - s.at < LIVE_CACHE_MS) return s.cells
  if (s.promise) return s.promise
  const from = nowMs - LIVE_MIN * 60_000
  s.promise = (async () => {
    const rows = await readLogRows(from, nowMs, LIVE_ROW_CAP)
    const cells = rollupRows(rows)
    // a 15-minute window counts people per window (the band's unit), not per hour
    const p = cells.get('p')
    if (p) cells.set('p', [p[0], p[0], 0, 0])
    for (const [k, c] of await readPartnerCells(from, nowMs)) cells.set(k, c)
    s.cells = cells
    s.at = Date.now()
    return cells
  })().finally(() => {
    s.promise = null
  })
  return s.promise
}

export type Tone = 'green' | 'amber' | 'red'
export interface SummaryTile {
  id: 'requests' | 'errors' | 'slowest' | 'partners' | 'people'
  tone: Tone
  /** The figure, already formatted for a non-technical reader. */
  value: string
  /** What normal is ("usually 120 to 180 a minute"), or null while learning. */
  usual: string | null
  /** One plain sentence; set whenever the tile is not green. */
  sentence: string | null
  /** Node keys the tile names (entity `items/x`, partner `ext:9`) — the page labels them. */
  keys?: string[]
}

const fmt = (v: number) =>
  !Number.isFinite(v) || v <= 0
    ? '0'
    : v >= 100
      ? String(Math.round(v))
      : v >= 10
        ? v.toFixed(0)
        : v >= 1
          ? v.toFixed(1)
          : v.toFixed(2)

function toneOf(s: Score, lowIsBad = false): Tone {
  if (s.level === 'high') return 'red'
  if (s.level === 'elevated' || (lowIsBad && s.level === 'low')) return 'amber'
  return 'green'
}
function usualText(b: BandWire | undefined, unit: string): string | null {
  if (!b) return null
  return `usually ${fmt(b[1])} to ${fmt(b[2])}${unit}`
}
const WEEKDAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export function slotPhrase(h: number, tz: string): string {
  const { dow, hour } = slotOf(h, tz)
  return `a ${WEEKDAY[dow]} at ${String(hour).padStart(2, '0')}:00`
}

/** The five executive tiles from a live window and the bands (pure). */
export function summaryTiles(live: HourCells, b: Baselines, slot: string): SummaryTile[] {
  const t = live.get('t') ?? [0, 0, 0, 0]
  const rpm = t[0] / LIVE_MIN
  const tiles: SummaryTile[] = []

  const rs = scoreAgainstBaseline(rpm, b.total.rpm, true)
  const rTone = toneOf(rs, true)
  tiles.push({
    id: 'requests',
    tone: rTone,
    value: `${fmt(rpm)} a minute`,
    usual: usualText(b.total.rpm, ' a minute'),
    sentence:
      rTone === 'green'
        ? null
        : rs.level === 'low'
          ? `Fewer requests than usual for ${slot}: ${fmt(rpm)} a minute against a usual ${fmt(b.total.rpm?.[0] ?? 0)}. People may be unable to reach the system.`
          : `Busier than usual for ${slot}: ${fmt(rpm)} requests a minute${rs.ratio ? `, ${rs.ratio}× the usual` : ''}.`
  })

  const errPct = t[0] ? (100 * t[1]) / t[0] : 0
  const es = scoreErrors(t[0], t[1], b.total.err_pct)
  let eTone = toneOf(es)
  if (es.level === 'unknown') eTone = errPct >= 5 ? 'red' : errPct >= 2 ? 'amber' : 'green'
  tiles.push({
    id: 'errors',
    tone: eTone,
    value: `${errPct < 0.1 && t[1] === 0 ? '0' : errPct.toFixed(1)}% of requests failed`,
    usual: usualText(b.total.err_pct, '%'),
    sentence:
      eTone === 'green'
        ? null
        : `${t[1]} of ${t[0]} requests failed in the last ${LIVE_MIN} minutes (${errPct.toFixed(1)}%), more than usual for ${slot}.`
  })

  // slowest area: the entity furthest above its own p95 normal (else the slowest outright)
  let worst: { key: string; p95: number; s: Score } | null = null
  let slowest: { key: string; p95: number } | null = null
  for (const [k, c] of live) {
    if (!k.startsWith('n:') || c[0] < 5) continue
    const key = k.slice(2)
    if (!slowest || c[3] > slowest.p95) slowest = { key, p95: c[3] }
    const s = scoreAgainstBaseline(c[3], b.nodes[key]?.p95)
    if (s.z != null && (!worst || (worst.s.z ?? 0) < s.z)) worst = { key, p95: c[3], s }
  }
  const pickSlow =
    worst && (worst.s.level === 'elevated' || worst.s.level === 'high') ? worst : null
  const shown = pickSlow ?? slowest
  let sTone: Tone = pickSlow ? toneOf(pickSlow.s) : 'green'
  if (!pickSlow && slowest && !b.nodes[slowest.key]?.p95)
    sTone = slowest.p95 >= 3000 ? 'red' : slowest.p95 >= 1000 ? 'amber' : 'green'
  const band = shown ? b.nodes[shown.key]?.p95 : undefined
  tiles.push({
    id: 'slowest',
    tone: sTone,
    value: shown ? `${fmt(shown.p95 / 1000)} s for the slowest requests` : 'Nothing to measure',
    usual: band ? `usually under ${fmt(band[2] / 1000)} s` : null,
    sentence:
      sTone === 'green' || !shown
        ? null
        : `One area is slower than usual: its slowest requests take ${fmt(shown.p95 / 1000)} s${band ? ` against a usual ${fmt(band[0] / 1000)} s` : ''}.`,
    keys: shown ? [shown.key] : []
  })

  const down: string[] = []
  const shaky: string[] = []
  for (const [k, c] of live) {
    if (!k.startsWith('d:') || c[0] < 3) continue
    const id = k.slice(2)
    const pctFailed = (100 * c[1]) / c[0]
    if (pctFailed >= 50) down.push(id)
    else if (toneOf(scoreErrors(c[0], c[1], b.downs[id]?.err_pct)) !== 'green') shaky.push(id)
  }
  const pTone: Tone = down.length ? 'red' : shaky.length ? 'amber' : 'green'
  tiles.push({
    id: 'partners',
    tone: pTone,
    value: down.length
      ? `${down.length} partner${down.length === 1 ? '' : 's'} down`
      : 'All partners answering',
    usual: null,
    sentence: down.length
      ? `${down.length === 1 ? 'A partner system is' : `${down.length} partner systems are`} failing most calls right now.`
      : shaky.length
        ? `${shaky.length === 1 ? 'A partner system fails' : `${shaky.length} partner systems fail`} more calls than usual.`
        : null,
    keys: [...down, ...shaky]
  })

  const people = live.get('p')?.[0] ?? 0
  const ps = scoreAgainstBaseline(people, b.people, true)
  const peTone: Tone = ps.level === 'low' ? 'amber' : 'green'
  tiles.push({
    id: 'people',
    tone: peTone,
    value: `${people} ${people === 1 ? 'person' : 'people'} active`,
    usual: b.people ? `usually ${fmt(b.people[1])} to ${fmt(b.people[2])}` : null,
    sentence:
      peTone === 'green'
        ? null
        : `Fewer people than usual for ${slot}: ${people} against a usual ${fmt(b.people?.[0] ?? 0)}.`
  })
  return tiles
}

export interface ExecutiveSummary {
  at: string
  slot: string
  window_min: number
  learning: boolean
  tone: Tone
  headline: string
  tiles: SummaryTile[]
}

const TONE_RANK: Record<Tone, number> = { green: 0, amber: 1, red: 2 }

export async function executiveSummary(tz: string, nowMs = Date.now()): Promise<ExecutiveSummary> {
  const [live, b] = await Promise.all([liveWindow(nowMs), baselinesAt(nowMs)])
  const slot = slotPhrase(epochHour(nowMs), tz)
  const tiles = summaryTiles(live, b, slot)
  const tone = tiles.reduce<Tone>(
    (w, t) => (TONE_RANK[t.tone] > TONE_RANK[w] ? t.tone : w),
    'green'
  )
  const off = tiles.filter((t) => t.tone !== 'green').length
  return {
    at: new Date(nowMs).toISOString(),
    slot,
    window_min: LIVE_MIN,
    learning: b.learning,
    tone,
    headline:
      off === 0
        ? 'Everything is running normally.'
        : `${off} thing${off === 1 ? ' needs' : 's need'} attention.`,
    tiles
  }
}

// ── deploy check (#2221) ────────────────────────────────────────────────────

export interface DeployFacts {
  load: { rpm: number; usual: number | null; score: Score }
  heavy: string[]
  running: string[]
  imports: number
  incidents: string[]
  /** The quietest hour ahead (label + usual requests a minute), when the bands know it. */
  quiet: { label: string; rpm: number } | null
}
export interface DeployVerdict {
  verdict: 'go' | 'wait'
  reasons: string[]
  sentence: string
}

/** The deterministic recommendation (pure). */
export function deployRecommendation(f: DeployFacts): DeployVerdict {
  const reasons: string[] = []
  if (f.incidents.length)
    reasons.push(
      `An incident is open: ${f.incidents[0]}${f.incidents.length > 1 ? ` (and ${f.incidents.length - 1} more)` : ''}.`
    )
  if (f.heavy.length)
    reasons.push(`A heavy job is running: ${f.heavy.join(', ')}. A restart would cut it.`)
  const others = f.running.filter((r) => !f.heavy.includes(r))
  if (others.length)
    reasons.push(
      `${others.length === 1 ? 'A background job is' : `${others.length} background jobs are`} running: ${others.slice(0, 3).join(', ')}.`
    )
  if (f.imports > 0)
    reasons.push(`${f.imports === 1 ? 'An import is' : `${f.imports} imports are`} in progress.`)
  const l = f.load
  if (l.score.level === 'elevated' || l.score.level === 'high')
    reasons.push(
      `Traffic is above normal for this hour: ${fmt(l.rpm)} requests a minute${l.usual != null ? ` against a usual ${fmt(l.usual)}` : ''}.`
    )
  const quiet = f.quiet
    ? ` Quietest hour ahead: ${f.quiet.label} (about ${fmt(f.quiet.rpm)} a minute).`
    : ''
  if (reasons.length) return { verdict: 'wait', reasons, sentence: `Wait. ${reasons[0]}${quiet}` }
  const loadText =
    l.score.level === 'unknown'
      ? `traffic is ${fmt(l.rpm)} requests a minute (no normal learned for this hour yet)`
      : `traffic is ${l.score.level === 'low' ? 'below' : 'at'} normal for this hour (${fmt(l.rpm)} a minute${l.usual != null ? `, usually ${fmt(l.usual)}` : ''})`
  return {
    verdict: 'go',
    reasons: [],
    sentence: `Deploy now: ${loadText}, nothing heavy is running and no incident is open.`
  }
}

async function runningJobs(): Promise<string[]> {
  try {
    const rows = (await db('nivaro_job_runs')
      .where('status', 'running')
      .where('started_at', '>=', new Date(Date.now() - 6 * 3600_000))
      .orderBy('started_at', 'desc')
      .limit(10)
      .select('job_id', 'label')) as Array<{ job_id: string; label: string | null }>
    return [...new Set(rows.map((r) => String(r.label || r.job_id).slice(0, 80)))]
  } catch {
    return []
  }
}
async function importsRunning(): Promise<number> {
  try {
    const row = (await db('nivaro_import_jobs')
      .whereIn('status', ['processing', 'running'])
      .count('* as n')
      .first()) as { n?: number | string } | undefined
    return Number(row?.n ?? 0) || 0
  } catch {
    return 0
  }
}

/** Usual requests a minute for the next `ahead` hours from roll-ups already held (no log reads). */
async function quietestAhead(
  nowMs: number,
  tz: string,
  ahead = 12
): Promise<{ label: string; rpm: number } | null> {
  const h = epochHour(nowMs)
  const future = Array.from({ length: ahead }, (_, i) => h + 1 + i)
  const all = future.flatMap((f) => sampleHours(f, 4, 0))
  const map = await loadHours(all, { maxCompute: 0 })
  let best: { h: number; rpm: number } | null = null
  for (const f of future) {
    const v = sampleHours(f, 4, 0)
      .map((x) => map.get(x))
      .filter((c): c is HourCells => !!c)
      .map((c) => (c.get('t')?.[0] ?? 0) / 60)
      .sort((a, b) => a - b)
    if (v.length < 2) continue
    const med = v[Math.floor((v.length - 1) / 2)]
    if (!best || med < best.rpm) best = { h: f, rpm: med }
  }
  if (!best) return null
  const { hour } = slotOf(best.h, tz)
  return { label: `${String(hour).padStart(2, '0')}:00`, rpm: Math.round(best.rpm * 10) / 10 }
}

export interface DeployCheck extends DeployVerdict {
  at: string
  facts: DeployFacts
  learning: boolean
}

export async function deployCheck(
  app: { cron?: { heavySlotHolder?: () => Promise<string | null> } } | null,
  tz: string,
  nowMs = Date.now()
): Promise<DeployCheck> {
  const [live, b, running, imports, threads, holder, quiet] = await Promise.all([
    liveWindow(nowMs),
    baselinesAt(nowMs),
    runningJobs(),
    importsRunning(),
    openThreads().catch(() => []),
    app?.cron?.heavySlotHolder?.().catch(() => null) ?? Promise.resolve(null),
    quietestAhead(nowMs, tz).catch(() => null)
  ])
  const t = live.get('t') ?? [0, 0, 0, 0]
  const rpm = t[0] / LIVE_MIN
  const band: KeyBands['rpm'] = b.total.rpm
  const facts: DeployFacts = {
    load: { rpm, usual: band ? band[0] : null, score: scoreAgainstBaseline(rpm, band, true) },
    heavy: holder ? [String(holder).slice(0, 120)] : [],
    running,
    imports,
    incidents: threads.map((x) => String(x.title).slice(0, 160)),
    quiet
  }
  return {
    at: new Date(nowMs).toISOString(),
    facts,
    learning: b.learning,
    ...deployRecommendation(facts)
  }
}
