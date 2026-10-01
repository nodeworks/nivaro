// api/src/services/traffic-taps/ext-ownership.ts
/**
 * Traffic Map tap `ext-ownership` (#1173) — how much of each node's load is Nivaro core versus
 * each extension. "Load" is wall time:
 *   • a request on an extension route belongs wholly to that extension;
 *   • any other request is split by the time extension hooks ran inside it (request-trace's
 *     per-request `extensionMs`, fed by the hook registry); the rest is core;
 *   • a partner call belongs to the extension whose route or cron made it (an `ext:<id>:` cron
 *     job id, or an extension-declared `x:<ext>.<node>` down node), else to core.
 * Cron sources (`cron:ext:<id>:<job>`) are read off their id by the client — no counting needed.
 * Memory only, one MinuteSlots per (node, owner).
 */
import { requestMeasure } from '../request-trace.js'
import { currentTrafficSource } from '../traffic-source.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { boundedGet, MinuteSlots } from './minute-slots.js'

export const EXT_OWNERSHIP_TAP = 'ext-ownership'
export const CORE_OWNER = 'core'
const NODE_CAP = 800
const OWNERS_PER_NODE = 12

interface State {
  /** node id (`<lane>/<entity>` or a down id) → owner → [ms, requests] */
  nodes: Map<string, Map<string, MinuteSlots>>
}
const state = () => tapState<State>(EXT_OWNERSHIP_TAP, () => ({ nodes: new Map() }))

function add(node: string, owner: string, ms: number, sec: number): void {
  if (!(ms > 0)) return
  const owners = boundedGet(state().nodes, node, NODE_CAP, () => new Map<string, MinuteSlots>())
  if (!owners) return
  const slots = boundedGet(owners, owner, OWNERS_PER_NODE, () => new MinuteSlots(2))
  if (!slots) return
  slots.add(sec, 0, ms)
  slots.add(sec, 1, 1)
}

/** The extension a cron job id belongs to (`ext:<id>:<job>`), else null. */
export function extensionOfJob(jobId: string): string | null {
  const m = /^ext:([^:]+):/.exec(jobId)
  return m ? m[1] : null
}
/** The extension a source id belongs to (`cron:ext:<id>:<job>`), else null. */
export function extensionOfSource(sourceId: string | null | undefined): string | null {
  if (!sourceId?.startsWith('cron:')) return null
  return extensionOfJob(sourceId.slice(5))
}
/** The extension an extension-declared down node belongs to (`x:<ext>.<node>`), else null. */
export function extensionOfDown(downId: string): string | null {
  if (!downId.startsWith('x:')) return null
  const dot = downId.indexOf('.')
  return dot > 2 ? downId.slice(2, dot) : null
}

/**
 * Split one request's wall time: an extension route → all of it to that extension; else each
 * extension's hook time (capped so the parts never exceed the total) and the rest to core.
 */
export function splitRequest(
  latencyMs: number,
  extensionRoute: string | null,
  extensionMs: ReadonlyMap<string, number> | null | undefined
): Array<[string, number]> {
  const total = Math.max(0, Number(latencyMs) || 0)
  if (total === 0) return []
  if (extensionRoute) return [[extensionRoute, total]]
  if (!extensionMs || extensionMs.size === 0) return [[CORE_OWNER, total]]
  let sum = 0
  for (const v of extensionMs.values()) sum += Math.max(0, v)
  const k = sum > total && sum > 0 ? total / sum : 1
  const out: Array<[string, number]> = []
  let ext = 0
  for (const [id, v] of extensionMs) {
    const ms = Math.max(0, v) * k
    if (ms <= 0) continue
    out.push([id, ms])
    ext += ms
  }
  if (total - ext > 0.0001) out.push([CORE_OWNER, total - ext])
  return out
}

export interface NodeOwnership {
  /** Wall ms per owner (`core` or an extension id) over the window. */
  ms: Record<string, number>
  /** Requests / calls per owner. */
  n: Record<string, number>
  total_ms: number
}
export interface OwnershipFigures {
  window_s: number
  nodes: Record<string, NodeOwnership>
  /** Every extension that owns load somewhere in the window. */
  extensions: string[]
}

function figuresOf(
  owners: Map<string, MinuteSlots>,
  windowS: number,
  sec: number
): (NodeOwnership & { ext: boolean }) | null {
  const ms: Record<string, number> = {}
  const n: Record<string, number> = {}
  let total = 0
  let ext = false
  for (const [owner, slots] of owners) {
    const [m, c] = slots.sum(windowS, sec)
    if (!(m > 0)) continue
    ms[owner] = Math.round(m * 10) / 10
    n[owner] = c
    total += m
    if (owner !== CORE_OWNER) ext = true
  }
  return total > 0 ? { ms, n, total_ms: Math.round(total * 10) / 10, ext } : null
}

/** Per-node ownership over the window; nodes whose only owner is core are left out. */
export function ownershipFigures(
  windowS: number,
  sec: number,
  includeCoreOnly = false
): OwnershipFigures {
  const out: OwnershipFigures = { window_s: windowS, nodes: {}, extensions: [] }
  const exts = new Set<string>()
  for (const [node, owners] of state().nodes) {
    const f = figuresOf(owners, windowS, sec)
    if (!f || (!f.ext && !includeCoreOnly)) continue
    const { ext: _ext, ...fig } = f
    out.nodes[node] = fig
    for (const o of Object.keys(fig.ms)) if (o !== CORE_OWNER) exts.add(o)
  }
  out.extensions = [...exts].sort()
  return out
}

export const extOwnershipTap: TrafficTap = {
  id: EXT_OWNERSHIP_TAP,
  onRequest(c) {
    const extRoute = c.lane === 'extension' ? c.entity : null
    const measure = extRoute ? null : requestMeasure(c.ev.req)
    for (const [owner, ms] of splitRequest(c.ev.latencyMs, extRoute, measure?.extensionMs))
      add(c.entityKey, owner, ms, c.sec)
  },
  onOutbound(c) {
    const fromEntity = c.entityKey.startsWith('extension/')
      ? c.entityKey.slice('extension/'.length)
      : null
    const owner =
      extensionOfDown(c.downId) ??
      fromEntity ??
      extensionOfSource(currentTrafficSource()?.id) ??
      CORE_OWNER
    add(c.downId, owner, Math.max(0, c.ev.durationMs) || 0.001, c.sec)
  },
  entitySnapshot(entityKey, windowS, sec) {
    const owners = state().nodes.get(entityKey)
    if (!owners) return undefined
    const f = figuresOf(owners, windowS, sec)
    if (!f?.ext) return undefined
    const { ext: _ext, ...fig } = f
    return fig
  },
  sweep(sec) {
    for (const [node, owners] of state().nodes) {
      for (const [owner, slots] of owners) if (slots.idle(sec)) owners.delete(owner)
      if (owners.size === 0) state().nodes.delete(node)
    }
  }
}

registerTrafficTap(extOwnershipTap)
