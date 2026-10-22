/**
 * #2841 Simulate down — the overlay model (pure): which map nodes to shade, and how strongly,
 * when a dependency is simulated down. The server's answer (recorded traffic over the window)
 * is merged with what the map itself shows right now (live, rewound or a frozen snapshot), so the
 * shading also covers what the window did not record.
 *
 *   target   the simulated node
 *   direct   calls the node itself (an entity whose requests reach it, the lane holding it)
 *   indirect reaches it through another node (a caller or job using a direct entity, a partner
 *            or channel only those entities feed)
 */

export type Strength = 'direct' | 'indirect'
export type SimWindow = '1h' | '6h' | '24h' | '7d'
export const SIM_WINDOWS: Array<[SimWindow, string]> = [
  ['1h', '1h'],
  ['6h', '6h'],
  ['24h', '24h'],
  ['7d', '7d']
]

export interface SimClaim {
  effect: 'fails' | 'degrades' | 'keeps'
  area: 'feature' | 'job' | 'channel' | 'session'
  text: string
  source: string
}
/** GET /traffic-map/blast-radius?node=&window= (api/src/services/traffic-actions/simulate-down.ts). */
export interface SimResult {
  node: string
  label: string
  kind: string
  window: SimWindow
  window_h: number
  from: string
  to: string
  routes: Array<{
    route: string
    entity: string
    calls: number
    per_min: number
    errors: number
    strength: Strength
    why: string
    share?: number
  }>
  entities: Array<{ key: string; strength: Strength; calls: number }>
  screens: Array<{ screen: string; calls: number; entities: string[] }>
  jobs: Array<{
    id: string
    strength: Strength
    why: string
    runs: number
    failed: number
    calls: number
  }>
  callers: Array<{ key: string; strength: Strength; calls: number }>
  downstream: Array<{ id: string; strength: Strength; calls: number }>
  claims: { fails: SimClaim[]; degrades: SimClaim[]; keeps: SimClaim[] }
  totals: {
    routes: number
    calls: number
    per_min: number
    share_of_calls: number | null
    screens: number
    jobs: number
    channels: number
    entities: number
  }
  sources: string[]
  notes: string[]
  truncated: boolean
  computed_at: string
}

/** What a simulation can be run on (mirrors parseDependencyNode on the server). */
export function isDependency(id: string): boolean {
  return (
    /^(db|redis|store|mail|sms|push|teams|signin|ai)$/.test(id) ||
    /^ai:[a-z0-9-]{1,40}$/.test(id) ||
    /^ext:\d{1,9}$/.test(id) ||
    /^x:[A-Za-z0-9_.-]{1,120}$/.test(id) ||
    /^webhook:[A-Za-z0-9_.-]{1,80}$/.test(id)
  )
}

/** A downstream id is (part of) the simulated node: `ai` covers every `ai:*`. */
export function isTarget(target: string, id: string): boolean {
  return id === target || (target === 'ai' && id.startsWith('ai:'))
}

/** The map, as far as the overlay reads it (the TrafficModel satisfies this). */
export interface OverlayModel {
  entityKeys(): string[]
  entityMeta(
    key: string
  ): { down?: Record<string, number>; callers?: Array<{ key: string; n: number }> } | null
  downIds(): string[]
}

export interface Overlay {
  target: string
  ents: Map<string, Strength>
  lanes: Map<string, Strength>
  callers: Map<string, Strength>
  downs: Map<string, Strength | 'target'>
}

const laneOf = (key: string) => key.slice(0, Math.max(0, key.indexOf('/')))

function raise(m: Map<string, Strength>, k: string, s: Strength): void {
  if (m.get(k) !== 'direct') m.set(k, s)
}

/** The nodes to shade for `target` (pure). `result` may be null while the server answers. */
export function overlayFrom(
  target: string,
  result: SimResult | null,
  model: OverlayModel | null
): Overlay {
  const ents = new Map<string, Strength>()
  const lanes = new Map<string, Strength>()
  const callers = new Map<string, Strength>()
  const downs = new Map<string, Strength | 'target'>()
  const fromServer = result && result.node === target ? result : null
  for (const e of fromServer?.entities ?? []) raise(ents, e.key, e.strength)
  // What the map shows: an entity whose requests reached the node is direct. Redis edges on the
  // map are cache hits, which fall back to SQL — a degradation, not a failure, so not shaded.
  if (model && target !== 'redis')
    for (const key of model.entityKeys()) {
      const down = model.entityMeta(key)?.down
      if (!down) continue
      for (const [id, n] of Object.entries(down))
        if (n > 0 && isTarget(target, id)) {
          raise(ents, key, 'direct')
          break
        }
    }
  for (const [key, s] of ents) raise(lanes, laneOf(key), s)
  for (const c of fromServer?.callers ?? []) raise(callers, c.key, c.strength)
  if (model)
    for (const key of ents.keys())
      for (const c of model.entityMeta(key)?.callers ?? [])
        if (c.n > 0) raise(callers, c.key, 'indirect')
  if (model) for (const id of model.downIds()) if (isTarget(target, id)) downs.set(id, 'target')
  downs.set(target, 'target')
  for (const d of fromServer?.downstream ?? []) if (!downs.has(d.id)) downs.set(d.id, d.strength)
  return { target, ents, lanes, callers, downs }
}

/** "34%" / "<1%" / "—" for a 0–1 share. */
export function pct(share: number | null | undefined): string {
  if (share == null || !Number.isFinite(share)) return '—'
  if (share > 0 && share < 0.01) return '<1%'
  return `${Math.round(share * 100)}%`
}

/** Calls per minute as "12/min", "0.4/min", "<0.1/min". */
export function perMinText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0/min'
  if (n < 0.1) return '<0.1/min'
  if (n < 10) return `${Math.round(n * 10) / 10}/min`
  return `${Math.round(n).toLocaleString()}/min`
}
