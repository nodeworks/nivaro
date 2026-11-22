import type { PlacementSide, RouteAction } from './types.js'

/**
 * Nivaro Hub phase 6 (Task 15): which route changes a move needs, and whether the Hub can make
 * them all itself (the decision table of the plan).
 *
 * A side is the Hub's to route when it is driven through a Docker agent on the traefik edge by
 * name: a dedicated Docker placement, or a shared deployment in `docker` mode. A GitLab placement,
 * a `registered` shared deployment, a publish edge (a port, no names) or an agent the Hub could
 * not read are not. Routing is `automatic` only when both sides are the Hub's AND on the same
 * driver (one edge: a name moves between two routers of one Traefik). Otherwise it is `manual`:
 * `manualRequest` says which names must reach which target, and that each needs TLS there.
 *
 * Per side, whatever the routing (the Hub always does its own half):
 * - a dedicated Docker source drops every name (`drop_host`: its stack is applied without them);
 * - a shared source drops each name it routes explicitly (a name under its pattern needs nothing:
 *   the app leaves its tenant list instead);
 * - a dedicated Docker target is applied with its names (`apply_stack`; an explicit Host rule
 *   outranks any pattern router on the same edge);
 * - a shared target adds each name outside its pattern (`add_host`).
 *
 * Order (what the run does with it):
 * - automatic: source actions first, then target ones — a name is never routed by two equal Host
 *   rules on one edge at once (the move is inside maintenance then);
 * - manual: target actions first (the target answers the name before anyone re-routes it), then
 *   source ones, which the run does once the name verifies on the target.
 * `remove_stack` is never emitted here: a Docker source stack is removed at `retire_source`.
 */

/** One DNS label in front of the pattern's suffix (the agent's patternRule: `*.apps.corp`
 *  matches `x.apps.corp`, never `a.b.apps.corp` or `apps.corp`). */
export function underPattern(pattern: string | null | undefined, name: string): boolean {
  if (!pattern?.startsWith('*.')) return false
  const suffix = `.${pattern.slice(2).toLowerCase()}`
  const n = name.toLowerCase()
  if (!n.endsWith(suffix)) return false
  return /^[a-z0-9-]+$/.test(n.slice(0, n.length - suffix.length))
}

/** The Docker driver a side is routed through by name, or null when the Hub does not route it. */
function hubRoutedDriver(side: PlacementSide): number | null {
  if (side.kind === 'docker') return side.edge === 'traefik' ? side.driverId : null
  if (side.kind === 'shared') {
    const s = side.shared
    return s.mode === 'docker' && s.driver_id != null && side.edge === 'traefik'
      ? s.driver_id
      : null
  }
  return null
}

function sourceActions(side: PlacementSide, names: string[]): RouteAction[] {
  if (hubRoutedDriver(side) === null) return []
  if (side.kind === 'docker')
    return names.map((host) => ({ side: 'source', op: 'drop_host', host }))
  if (side.kind === 'shared')
    return names
      .filter((n) => !underPattern(side.shared.host_pattern, n))
      .map((host) => ({ side: 'source', op: 'drop_host', host }))
  return []
}

/**
 * A shared target adds a name outside its pattern; and also one its pattern covers when the
 * source is a shared deployment whose pattern covers it too (M-2): two equal priority-1 pattern
 * routers would otherwise both match it, while an explicit Host rule outranks them.
 */
function targetActions(side: PlacementSide, from: PlacementSide, names: string[]): RouteAction[] {
  if (hubRoutedDriver(side) === null) return []
  if (side.kind === 'docker') return [{ side: 'target', op: 'apply_stack' }]
  if (side.kind === 'shared') {
    const sourcePattern = from.kind === 'shared' ? from.shared.host_pattern : null
    return names
      .filter((n) => !underPattern(side.shared.host_pattern, n) || underPattern(sourcePattern, n))
      .map((host) => ({ side: 'target', op: 'add_host', host }))
  }
  return []
}

/** Where the names must point, in words (no secret: link addresses are origins). */
function describeTarget(side: PlacementSide): string {
  if (side.kind === 'shared') {
    const s = side.shared
    const how =
      s.mode === 'registered'
        ? 'run outside the Hub'
        : side.edge === 'publish'
          ? 'published on a port by its Docker agent'
          : side.edge === 'traefik'
            ? `behind the Traefik edge of Docker driver #${s.driver_id}`
            : `on Docker driver #${s.driver_id}, whose agent the Hub could not read`
    return `the shared deployment ${s.key} (${how}; its link address is ${s.link_url})`
  }
  if (side.kind === 'docker') {
    const how =
      side.edge === 'publish'
        ? 'published on a port by its Docker agent'
        : side.edge === 'traefik'
          ? 'behind its Traefik edge'
          : 'whose agent the Hub could not read'
    return `the Docker stack ${side.stack} on driver #${side.driverId} (${how})`
  }
  return `the GitLab placement #${side.placement.id} (the deployment its own pipeline runs)`
}

function describeSource(side: PlacementSide): string {
  if (side.kind === 'shared') return `the shared deployment ${side.shared.key}`
  if (side.kind === 'docker') return `the Docker stack ${side.stack} on driver #${side.driverId}`
  return `the GitLab placement #${side.placement.id}`
}

function whyManual(from: PlacementSide, to: PlacementSide): string {
  const parts: string[] = []
  for (const side of [from, to]) {
    if (side.kind === 'gitlab') parts.push('a GitLab placement routes its names itself')
    else if (side.kind === 'shared' && side.shared.mode === 'registered')
      parts.push(`${side.shared.key} is run outside the Hub`)
    else if (side.edge === 'publish') parts.push('a published port has no name routing')
    else if (side.edge !== 'traefik') parts.push('the Hub could not read a Docker agent')
  }
  const a = hubRoutedDriver(from)
  const b = hubRoutedDriver(to)
  if (a !== null && b !== null && a !== b) parts.push('the two sides sit behind different edges')
  return [...new Set(parts)].join('; ')
}

export function routeActions(
  from: PlacementSide,
  to: PlacementSide,
  names: string[]
): { routing: 'automatic' | 'manual'; actions: RouteAction[]; manualRequest: string | null } {
  const hosts = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))]
  const a = hubRoutedDriver(from)
  const b = hubRoutedDriver(to)
  const src = sourceActions(from, hosts)
  const tgt = targetActions(to, from, hosts)
  if (a !== null && b !== null && a === b)
    return { routing: 'automatic', actions: [...src, ...tgt], manualRequest: null }

  const list = hosts.length ? hosts.join(', ') : '(no names)'
  const one = hosts.length === 1
  const manualRequest =
    `Route ${list} to ${describeTarget(to)}, with a TLS certificate for ${one ? 'that name' : 'each name'} there. ` +
    (a !== null
      ? `The Hub stops routing ${one ? 'it' : 'them'} to ${describeSource(from)} itself once ${one ? 'it answers' : 'they answer'} from the new placement. `
      : `Then stop routing ${one ? 'it' : 'them'} to ${describeSource(from)}. `) +
    `The Hub cannot do this itself: ${whyManual(from, to)}.`
  return { routing: 'manual', actions: [...tgt, ...src], manualRequest }
}
