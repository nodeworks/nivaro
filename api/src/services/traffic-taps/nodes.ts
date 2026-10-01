// api/src/services/traffic-taps/nodes.ts
/**
 * Extension-declared downstream nodes (#1114): `ctx.integrations.registerTrafficNode({id, label,
 * match})` lets an extension name the business systems behind its partner calls (MDSi, MWF, a
 * warehouse), so the map reads "→ MDSi deployment requests" instead of "→ external API 7".
 *
 * A partner call goes to the FIRST declared node whose match accepts it (registration order),
 * else to its plain `ext:<apiId>` node. Node ids are `x:<extension>.<id>`.
 */
import { setOutboundNodeResolver, type TrafficOutboundEvent } from '../traffic-map.js'

/** What a declared node matches: external API names (case-insensitive), path prefix, verb. */
export interface TrafficNodeMatchSpec {
  api?: string | string[]
  /** A path prefix (`/api/deploymentRequests`) or a RegExp. */
  path?: string | RegExp
  method?: string
}
export interface TrafficNodeCall {
  apiId: number
  apiName: string
  method: string | null
  path: string | null
}
export interface TrafficNodeDef {
  /** Unique within the extension: [a-z0-9_-], up to 60. */
  id: string
  label: string
  match: TrafficNodeMatchSpec | ((call: TrafficNodeCall) => boolean)
  description?: string
}
interface Registered {
  nodeId: string
  extension: string
  def: TrafficNodeDef
  test: (call: TrafficNodeCall) => boolean
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/i
const nodes: Registered[] = []

export function trafficNodeId(extension: string, id: string): string {
  return `x:${extension}.${id}`
}

function compile(match: TrafficNodeDef['match']): (call: TrafficNodeCall) => boolean {
  if (typeof match === 'function') {
    return (call) => {
      try {
        return match(call) === true
      } catch {
        return false
      }
    }
  }
  const apis = (Array.isArray(match.api) ? match.api : match.api ? [match.api] : []).map((a) =>
    String(a).toLowerCase()
  )
  const method = match.method ? match.method.toUpperCase() : null
  const path = match.path ?? null
  if (!apis.length && !path && !method) return () => false
  return (call) => {
    if (apis.length && !apis.includes(call.apiName.toLowerCase())) return false
    if (method && (call.method ?? '').toUpperCase() !== method) return false
    if (path != null) {
      const p = call.path ?? ''
      if (path instanceof RegExp ? !path.test(p) : !p.startsWith(path)) return false
    }
    return true
  }
}

/** Register (or replace, by extension + id) a declared node. Throws on a malformed id. */
export function registerTrafficNode(extension: string, def: TrafficNodeDef): string {
  if (!def || !ID_RE.test(String(def.id ?? ''))) {
    throw new Error(`registerTrafficNode: id must match ${ID_RE} (got "${def?.id}")`)
  }
  const nodeId = trafficNodeId(extension, def.id)
  const entry: Registered = {
    nodeId,
    extension,
    def: { ...def, label: String(def.label || def.id).slice(0, 120) },
    test: compile(def.match)
  }
  const i = nodes.findIndex((n) => n.nodeId === nodeId)
  if (i >= 0) nodes[i] = entry
  else nodes.push(entry)
  setOutboundNodeResolver(resolveTrafficNode)
  return nodeId
}

/** Forget every node an extension declared (reload). */
export function clearTrafficNodes(extension: string): void {
  for (let i = nodes.length - 1; i >= 0; i--)
    if (nodes[i].extension === extension) nodes.splice(i, 1)
  if (!nodes.length) setOutboundNodeResolver(null)
}

export function resolveTrafficNode(ev: TrafficOutboundEvent): { id: string; label: string } | null {
  if (!nodes.length) return null
  const call: TrafficNodeCall = {
    apiId: ev.apiId,
    apiName: ev.apiName,
    method: ev.method ?? null,
    path: ev.path ?? null
  }
  for (const n of nodes) if (n.test(call)) return { id: n.nodeId, label: n.def.label }
  return null
}

/** For the inspector: the declared node behind an id, as plain data. */
export function describeTrafficNode(nodeId: string): {
  id: string
  extension: string
  label: string
  description: string | null
  match: string
} | null {
  const n = nodes.find((x) => x.nodeId === nodeId)
  if (!n) return null
  const m = n.def.match
  const match =
    typeof m === 'function'
      ? 'custom match'
      : [
          m.api ? `API ${(Array.isArray(m.api) ? m.api : [m.api]).join(', ')}` : null,
          m.method ? m.method.toUpperCase() : null,
          m.path ? `path ${m.path instanceof RegExp ? String(m.path) : `${m.path}…`}` : null
        ]
          .filter(Boolean)
          .join(' · ')
  return {
    id: n.nodeId,
    extension: n.extension,
    label: n.def.label,
    description: n.def.description ?? null,
    match
  }
}

/** Declared nodes matching a call spec — for the history route (api names + path test). */
export function trafficNodeTester(
  nodeId: string
): { apis: string[] | null; test: (call: TrafficNodeCall) => boolean } | null {
  const n = nodes.find((x) => x.nodeId === nodeId)
  if (!n) return null
  const m = n.def.match
  const apis =
    typeof m === 'function' ? null : m.api ? (Array.isArray(m.api) ? m.api : [m.api]) : null
  return { apis, test: n.test }
}

export function listTrafficNodes(): Array<{ id: string; extension: string; label: string }> {
  return nodes.map((n) => ({ id: n.nodeId, extension: n.extension, label: n.def.label }))
}
