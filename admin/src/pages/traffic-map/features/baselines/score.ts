/**
 * Baselines (#2145) and the health score (#2144), client side. Pure.
 *
 * `scoreAgainstBaseline` / `scoreErrors` are the twins of api/src/services/traffic-baselines.ts —
 * change both (the shared test vectors are in both test files).
 */

/** [median, lo, hi, spread, samples] */
export type BandWire = [number, number, number, number, number]
export interface KeyBands {
  rpm?: BandWire
  err_pct?: BandWire
  p95?: BandWire
}
export interface Baselines {
  h: number
  at: string
  weeks: number
  hours_wanted: number
  hours_known: number
  learning: boolean
  nodes: Record<string, KeyBands>
  callers: Record<string, KeyBands>
  edges: Record<string, KeyBands>
  downs: Record<string, KeyBands>
  total: KeyBands
  people: BandWire | null
}

export type Level = 'unknown' | 'normal' | 'elevated' | 'high' | 'low'
export interface Score {
  level: Level
  z: number | null
  ratio: number | null
}

export const MIN_ERR_REQ = 10

const r2 = (v: number) => Math.round(v * 100) / 100

export function scoreAgainstBaseline(
  value: number,
  band: BandWire | null | undefined,
  lowMatters = false
): Score {
  if (!band || !Number.isFinite(value)) return { level: 'unknown', z: null, ratio: null }
  const [median, , , spread] = band
  const z = (value - median) / Math.max(1e-9, spread)
  const ratio = median > 0 ? value / median : null
  const level: Level =
    z >= 4 ? 'high' : z >= 2 ? 'elevated' : lowMatters && z <= -2 ? 'low' : 'normal'
  return { level, z: Math.round(z * 10) / 10, ratio: ratio == null ? null : r2(ratio) }
}

export function scoreErrors(req: number, errors: number, band: BandWire | null | undefined): Score {
  if (req < MIN_ERR_REQ && errors < 3)
    return { level: band ? 'normal' : 'unknown', z: null, ratio: null }
  return scoreAgainstBaseline(req > 0 ? (100 * errors) / req : 0, band)
}

const RANK: Record<Level, number> = { unknown: 0, normal: 1, low: 2, elevated: 3, high: 4 }
export function worstLevel(levels: Level[]): Level {
  return levels.reduce<Level>((w, l) => (RANK[l] > RANK[w] ? l : w), 'unknown')
}

/** A node's live figures in its normal: requests (traffic drops matter), errors, latency. */
export interface NodeJudgement {
  rpm: Score
  errors: Score
  p95: Score
  /** The worst of errors and latency (what the node is coloured by). */
  worst: Level
}
export function judgeNode(
  live: { req: number; errors: number; windowS: number; p95: number },
  bands: KeyBands | undefined
): NodeJudgement {
  const rpm = scoreAgainstBaseline((live.req * 60) / Math.max(1, live.windowS), bands?.rpm, true)
  const errors = scoreErrors(live.req, live.errors, bands?.err_pct)
  const p95 =
    live.req >= 5 && live.p95 > 0
      ? scoreAgainstBaseline(live.p95, bands?.p95)
      : { level: (bands?.p95 ? 'normal' : 'unknown') as Level, z: null, ratio: null }
  return { rpm, errors, p95, worst: worstLevel([errors.level, p95.level]) }
}

/** "2.4× usual" / "usual 80–120" — short text for a pill or a tip. */
export function ratioText(s: Score): string | null {
  if (s.ratio == null || s.level === 'normal' || s.level === 'unknown') return null
  return s.ratio >= 10 ? `${Math.round(s.ratio)}× usual` : `${s.ratio.toFixed(1)}× usual`
}

// ── health score (#2144) ────────────────────────────────────────────────────

export interface HealthInput {
  req: number
  errors: number
  windowS: number
  p95: number
  bands?: KeyBands
  /** Pool pressure on the database the node uses ('ok' when unknown). */
  pool?: 'ok' | 'warn' | 'error'
  /** Event loop p99 (ms) of this API process. */
  loopP99?: number
  /** Open detector findings on the node (N+1, retry storm, duplicates…). */
  findings?: Array<{ tone: 'warn' | 'error' | 'info'; text: string }>
}
export interface HealthPart {
  id: 'errors' | 'latency' | 'saturation' | 'findings'
  label: string
  /** Points taken off (0 = nothing wrong). */
  penalty: number
  max: number
  detail: string
}
export interface Health {
  score: number
  tone: 'good' | 'warn' | 'bad'
  parts: HealthPart[]
}

export const HEALTH_WEIGHTS = { errors: 40, latency: 30, saturation: 20, findings: 20 } as const
export const HEALTH_GOOD = 80
export const HEALTH_WARN = 60

/**
 * One 0–100 figure: 100 minus penalties for errors (absolute rate, worse when above normal),
 * latency against its normal (or absolute p95 without one), saturation (pool, event loop) and
 * open detector findings. Each part is capped at its weight.
 */
export function healthScore(i: HealthInput): Health {
  const j = judgeNode({ req: i.req, errors: i.errors, windowS: i.windowS, p95: i.p95 }, i.bands)
  const errPct = i.req > 0 ? (100 * i.errors) / i.req : 0
  const parts: HealthPart[] = []

  // errors
  let ep = 0
  let ed = 'No errors'
  if (i.req >= MIN_ERR_REQ || i.errors >= 3) {
    const absolute = Math.min(25, errPct * 2.5)
    const vsNormal = j.errors.level === 'high' ? 15 : j.errors.level === 'elevated' ? 8 : 0
    ep =
      j.errors.level === 'unknown'
        ? Math.min(HEALTH_WEIGHTS.errors, errPct * 4)
        : absolute + vsNormal
    ed =
      i.errors === 0
        ? 'No errors'
        : `${errPct.toFixed(1)}% failed${j.errors.level === 'high' || j.errors.level === 'elevated' ? ', above normal' : ''}`
  } else if (i.errors > 0) ed = `${i.errors} error${i.errors === 1 ? '' : 's'} on few requests`
  parts.push({
    id: 'errors',
    label: 'Errors',
    penalty: Math.round(Math.min(HEALTH_WEIGHTS.errors, ep)),
    max: HEALTH_WEIGHTS.errors,
    detail: ed
  })

  // latency
  let lp = 0
  let ld = 'Normal'
  if (j.p95.level === 'unknown') {
    lp = i.p95 >= 3000 ? 20 : i.p95 >= 1000 ? 10 : 0
    ld = i.p95 > 0 ? `p95 ${Math.round(i.p95)} ms (no normal yet)` : 'No requests'
  } else {
    lp = j.p95.level === 'high' ? 24 : j.p95.level === 'elevated' ? 12 : 0
    if ((j.p95.ratio ?? 0) >= 3) lp = HEALTH_WEIGHTS.latency
    ld =
      j.p95.level === 'normal'
        ? 'Within normal'
        : `p95 ${j.p95.ratio != null ? `${j.p95.ratio.toFixed(1)}×` : 'above'} its normal`
  }
  parts.push({
    id: 'latency',
    label: 'Latency',
    penalty: Math.min(HEALTH_WEIGHTS.latency, lp),
    max: HEALTH_WEIGHTS.latency,
    detail: ld
  })

  // saturation
  let sp = i.pool === 'error' ? 15 : i.pool === 'warn' ? 8 : 0
  const loop = i.loopP99 ?? 0
  sp += loop >= 250 ? 10 : loop >= 100 ? 5 : 0
  const sd: string[] = []
  if (i.pool && i.pool !== 'ok')
    sd.push(`database pool ${i.pool === 'error' ? 'saturated' : 'under pressure'}`)
  if (loop >= 100) sd.push(`event loop p99 ${Math.round(loop)} ms`)
  parts.push({
    id: 'saturation',
    label: 'Saturation',
    penalty: Math.min(HEALTH_WEIGHTS.saturation, sp),
    max: HEALTH_WEIGHTS.saturation,
    detail: sd.length ? sd.join(', ') : 'Pool and event loop fine'
  })

  // findings
  const f = i.findings ?? []
  const fp = f.reduce((a, x) => a + (x.tone === 'error' ? 10 : x.tone === 'warn' ? 5 : 2), 0)
  parts.push({
    id: 'findings',
    label: 'Findings',
    penalty: Math.min(HEALTH_WEIGHTS.findings, fp),
    max: HEALTH_WEIGHTS.findings,
    detail: f.length ? f.map((x) => x.text).join(', ') : 'None open'
  })

  const score = Math.max(0, Math.min(100, 100 - parts.reduce((a, p) => a + p.penalty, 0)))
  return {
    score,
    tone: score >= HEALTH_GOOD ? 'good' : score >= HEALTH_WARN ? 'warn' : 'bad',
    parts
  }
}

/** The breakdown as one line per part (for a data-tip). */
export function healthTip(h: Health): string {
  return [
    `Health ${h.score}/100`,
    ...h.parts.map((p) => `${p.label}: ${p.penalty ? `−${p.penalty}` : 'ok'} · ${p.detail}`)
  ].join('\n')
}
