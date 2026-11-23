import { describe, expect, it } from 'vitest'
import type { HubPlacementRow } from '../../../services/hub/drivers.js'
import { routeActions, underPattern } from '../../../services/hub/move/route-actions.js'
import type { PlacementSide } from '../../../services/hub/move/types.js'
import type { SharedDeployment } from '../../../services/hub/shared/store.js'

// Nivaro Hub phase 6, Task 15: who changes which route in a move (the decision table). Automatic
// only when every change is the Hub's: both sides Docker on the same driver, traefik edge, and
// the shared side(s) Hub-deployed (`docker` mode).

function shared(o: Partial<SharedDeployment> = {}): SharedDeployment {
  return {
    id: 7,
    key: 'pool-a',
    name: 'Pool A',
    mode: 'docker',
    driver_id: 1,
    stack: 'pool-a',
    version_pin: '0.3.211',
    extensions: [],
    extension_pins: {},
    host_pattern: '*.apps.example.com',
    link_url: 'https://pool-a.internal.example.com',
    pool_budget: 60,
    status: 'active',
    settings: {},
    token: null,
    last_seen_at: null,
    created_at: null,
    updated_at: null,
    ...o
  }
}

const sharedSide = (
  o: Partial<SharedDeployment> = {},
  edge: 'traefik' | 'publish' | null = 'traefik'
): PlacementSide => ({
  kind: 'shared',
  shared: shared(o),
  edge
})

const dedicated = (id: number, driverId: number): HubPlacementRow => ({
  id,
  kind: 'dedicated',
  driver_id: driverId,
  target: { stack: 'app-prod' }
})

const docker = (
  o: { driverId?: number; edge?: 'traefik' | 'publish' | null } = {}
): PlacementSide => ({
  kind: 'docker',
  placement: dedicated(3, o.driverId ?? 1),
  driverId: o.driverId ?? 1,
  stack: 'app-prod',
  edge: o.edge === undefined ? 'traefik' : o.edge
})

const gitlab = (): PlacementSide => ({
  kind: 'gitlab',
  placement: dedicated(4, 9),
  components: []
})

describe('underPattern', () => {
  it('matches exactly one label in front of the pattern suffix', () => {
    expect(underPattern('*.apps.example.com', 'shop.apps.example.com')).toBe(true)
    expect(underPattern('*.apps.example.com', 'a.b.apps.example.com')).toBe(false)
    expect(underPattern('*.apps.example.com', 'apps.example.com')).toBe(false)
    expect(underPattern('*.apps.example.com', 'shop.apps.example.com.evil.com')).toBe(false)
    expect(underPattern(null, 'shop.apps.example.com')).toBe(false)
  })
})

describe('routeActions — the decision table', () => {
  it('docker dedicated → docker shared, name under the pattern: source drop_host only', () => {
    const r = routeActions(docker(), sharedSide(), ['shop.apps.example.com'])
    expect(r.routing).toBe('automatic')
    expect(r.manualRequest).toBeNull()
    expect(r.actions).toEqual([{ side: 'source', op: 'drop_host', host: 'shop.apps.example.com' }])
  })

  it('docker dedicated → docker shared, name outside the pattern: source drop_host, target add_host', () => {
    const r = routeActions(docker(), sharedSide(), ['shop.example.org'])
    expect(r.routing).toBe('automatic')
    expect(r.actions).toEqual([
      { side: 'source', op: 'drop_host', host: 'shop.example.org' },
      { side: 'target', op: 'add_host', host: 'shop.example.org' }
    ])
  })

  it('a name under the target pattern never gets an add_host, the others do', () => {
    const r = routeActions(docker(), sharedSide(), ['shop.apps.example.com', 'shop.example.org'])
    expect(r.actions.filter((a) => a.op === 'add_host')).toEqual([
      { side: 'target', op: 'add_host', host: 'shop.example.org' }
    ])
    expect(r.actions.filter((a) => a.op === 'drop_host').map((a) => a.host)).toEqual([
      'shop.apps.example.com',
      'shop.example.org'
    ])
  })

  it('docker shared → docker dedicated (same driver): drop only explicit names, then apply_stack', () => {
    const r = routeActions(sharedSide(), docker(), ['shop.apps.example.com', 'shop.example.org'])
    expect(r.routing).toBe('automatic')
    expect(r.actions).toEqual([
      { side: 'source', op: 'drop_host', host: 'shop.example.org' },
      { side: 'target', op: 'apply_stack' }
    ])
  })

  it('docker shared A → docker shared B (same driver): drop explicit on A, add unless under B', () => {
    const a = sharedSide({ id: 7, key: 'pool-a', host_pattern: '*.a.example.com' })
    const b = sharedSide({ id: 8, key: 'pool-b', host_pattern: '*.b.example.com' })
    const r = routeActions(a, b, ['shop.a.example.com', 'shop.b.example.com', 'shop.example.org'])
    expect(r.routing).toBe('automatic')
    expect(r.actions).toEqual([
      { side: 'source', op: 'drop_host', host: 'shop.b.example.com' },
      { side: 'source', op: 'drop_host', host: 'shop.example.org' },
      { side: 'target', op: 'add_host', host: 'shop.a.example.com' },
      { side: 'target', op: 'add_host', host: 'shop.example.org' }
    ])
  })

  it('shared A → shared B with the same pattern: the name gets an explicit route on B (M-2)', () => {
    const a = sharedSide({ id: 7, key: 'pool-a', host_pattern: '*.apps.example.com' })
    const b = sharedSide({ id: 8, key: 'pool-b', host_pattern: '*.apps.example.com' })
    const r = routeActions(a, b, ['shop.apps.example.com'])
    expect(r.routing).toBe('automatic')
    expect(r.actions).toEqual([{ side: 'target', op: 'add_host', host: 'shop.apps.example.com' }])
  })

  it('gitlab source → manual with a request naming the host, the target and TLS', () => {
    const r = routeActions(gitlab(), sharedSide(), ['shop.example.org'])
    expect(r.routing).toBe('manual')
    expect(r.manualRequest).toBeTruthy()
    expect(r.manualRequest).toContain('shop.example.org')
    expect(r.manualRequest).toContain('pool-a')
    expect(r.manualRequest).toContain('https://pool-a.internal.example.com')
    expect(r.manualRequest).toMatch(/TLS/)
  })

  it('gitlab target → manual with a non-empty request', () => {
    const r = routeActions(sharedSide(), gitlab(), ['shop.example.org'])
    expect(r.routing).toBe('manual')
    expect(r.manualRequest).toContain('shop.example.org')
    expect(r.manualRequest).toMatch(/GitLab/)
  })

  it('a registered shared deployment → manual', () => {
    const r = routeActions(docker(), sharedSide({ mode: 'registered', driver_id: null }, null), [
      'shop.example.org'
    ])
    expect(r.routing).toBe('manual')
    expect(r.manualRequest).toContain('shop.example.org')
    // The Hub still does its own half: the dedicated source stops routing the name.
    expect(r.actions).toEqual([{ side: 'source', op: 'drop_host', host: 'shop.example.org' }])
  })

  it('manual: the request asks a person only for the halves the Hub cannot do (M-3)', () => {
    const hubSource = routeActions(
      docker(),
      sharedSide({ mode: 'registered', driver_id: null }, null),
      ['shop.example.org']
    )
    expect(hubSource.manualRequest).toMatch(/The Hub stops routing/)
    expect(hubSource.manualRequest).not.toMatch(/Then stop routing/)
    const gl = routeActions(gitlab(), sharedSide(), ['shop.example.org'])
    expect(gl.manualRequest).toMatch(/Then stop routing/)
  })

  it('a publish edge → manual', () => {
    const r = routeActions(docker({ edge: 'publish' }), sharedSide(), ['shop.example.org'])
    expect(r.routing).toBe('manual')
    expect(r.manualRequest).toMatch(/TLS/)
  })

  it('another driver → manual', () => {
    const r = routeActions(docker({ driverId: 2 }), sharedSide(), ['shop.example.org'])
    expect(r.routing).toBe('manual')
    expect(r.manualRequest).toContain('shop.example.org')
  })

  it('an agent the Hub could not read (edge unknown) → manual', () => {
    const r = routeActions(docker({ edge: null }), sharedSide(), ['shop.example.org'])
    expect(r.routing).toBe('manual')
  })

  it('manual: the target-side actions come first (the target answers before anyone re-routes)', () => {
    const r = routeActions(sharedSide({ mode: 'registered', driver_id: null }, null), docker(), [
      'shop.example.org'
    ])
    expect(r.routing).toBe('manual')
    expect(r.actions).toEqual([{ side: 'target', op: 'apply_stack' }])
  })

  it('never emits remove_stack (the source stack goes at retire_source)', () => {
    for (const [from, to] of [
      [docker(), sharedSide()],
      [sharedSide(), docker()],
      [gitlab(), sharedSide()]
    ] as Array<[PlacementSide, PlacementSide]>) {
      expect(routeActions(from, to, ['shop.example.org']).actions.map((a) => a.op)).not.toContain(
        'remove_stack'
      )
    }
  })
})

// Design S9: the route request goes to another team; it names drivers by name, never by id.
describe('route request wording (design S9)', () => {
  it('names the Docker driver by its name, never "driver #<id>"', () => {
    const src: PlacementSide = {
      kind: 'docker',
      placement: dedicated(3, 1),
      driverId: 1,
      driverName: 'Docker east',
      stack: 'app-prod',
      edge: 'publish'
    }
    const to = sharedSide({ driver_id: 2 }, 'traefik')
    const r = routeActions(src, { ...to, driverName: 'Docker west' } as PlacementSide, [
      'shop.example.org'
    ])
    expect(r.manualRequest).toContain('Docker east')
    expect(r.manualRequest).toContain('Docker west')
    expect(r.manualRequest).not.toMatch(/#\d/)
  })
})
