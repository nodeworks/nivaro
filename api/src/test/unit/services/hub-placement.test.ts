import { describe, expect, it } from 'vitest'
import { buildMovePlan, MANUAL_MOVE_STEPS, MOVE_STEPS } from '../../../services/hub/move/plan.js'
import type { MovePlanInput, PlacementSide } from '../../../services/hub/move/types.js'
import {
  type ChargebackReport,
  chargebackCsv,
  chargebackRefusal,
  costOf,
  normalizeChargeback,
  usageFromSamples
} from '../../../services/hub/placement/chargeback.js'
import { overlapConnections, overlapMath } from '../../../services/hub/placement/connections.js'
import {
  parseFleet,
  parseSelf,
  peerOrigin,
  rebuildRow,
  safeText,
  tokenShapeOk
} from '../../../services/hub/placement/federation.js'
import type { ScaleTarget } from '../../../services/hub/scale/target.js'

// Hub placement (ideas 48–50), the pure parts: the move between two Docker stacks (plan), the
// two-stacks connection check (the scaling math), the chargeback figures and CSV, and how a
// peer Hub's answers are checked and rebuilt.

const FP = 'a'.repeat(32)

const docker = (id: number, driverId: number, edge: 'traefik' | 'publish' = 'traefik') =>
  ({
    kind: 'docker',
    placement: { id, kind: 'dedicated', driver_id: driverId, target: { stack: `shop-${id}` } },
    driverId,
    driverName: `host-${driverId}`,
    stack: `shop-${id}`,
    edge
  }) satisfies PlacementSide

/** A move of a Docker stack to a stack on another host, with nothing wrong. */
function input(o: Partial<MovePlanInput> = {}): MovePlanInput {
  return {
    kind: 'between_stacks',
    app: { id: 1, key: 'shop', signin_mode: 'direct', extensions: [] },
    env: { id: 11, key: 'prod', hub_linked: true, version_pin: '0.3.215' },
    from: docker(3, 1, 'publish'),
    to: docker(4, 2),
    target: { kind: 'dedicated', placement_id: 4 },
    names: ['shop.example.com'],
    names_taken: [],
    database: { id: 21, ready: true },
    app_key: { known: true, fp: FP },
    locks: { env: null, open_move: false, shared: [] },
    source: {
      reachable: true,
      error: null,
      version: '0.3.215',
      key_fp: FP,
      oidc: null,
      signin_hub: false,
      db_identity: 'pg|10.0.0.5|5432|shop',
      files: { count: 4, bytes: 100, local: 4, objects: {} },
      extensions: {},
      extension_pins: {},
      readiness: [],
      storage_provider: 'local',
      redis: 'r-a'
    },
    target_facts: {
      reachable: true,
      error: null,
      version: null,
      oidc: null,
      extensions: [],
      extension_pins: {},
      db: null,
      identity_shared_with: [],
      pool: null,
      siblings: [],
      storage_provider: 'local',
      redis: 'r-b',
      multi_node: null,
      stack_key_fp: FP,
      in_use_by: null,
      identity_unchecked: 0
    },
    driver_problem: null,
    gather_failed: [],
    host_connections: { refusal: null, warning: null },
    ...o
  }
}

const codes = (p: { blockers: { code: string }[] }) => p.blockers.map((b) => b.code)

describe('move between two Docker stacks (between_stacks)', () => {
  it('follows the to_dedicated step lists exactly', () => {
    expect(MOVE_STEPS.between_stacks).toEqual(MOVE_STEPS.to_dedicated)
    expect(MANUAL_MOVE_STEPS.between_stacks).toEqual(MANUAL_MOVE_STEPS.to_dedicated)
  })

  it('plans with no blocker when the source answers on an address of its own', () => {
    const p = buildMovePlan(input())
    expect(p.blockers).toEqual([])
    // Two hosts are two edges: the route is changed by hand.
    expect(p.routing).toBe('manual')
    expect(p.steps).toEqual(MANUAL_MOVE_STEPS.to_dedicated)
    expect(p.warnings.map((w) => w.code)).toContain('MANUAL_ROUTE')
    expect(p.checklist.map((c) => c.id)).toContain('route_ticket')
  })

  it('is automatic between two stacks on the same host', () => {
    const p = buildMovePlan(input({ from: docker(3, 1), to: docker(4, 1) }))
    expect(p.routing).toBe('automatic')
    expect(p.steps).toEqual(MOVE_STEPS.to_dedicated)
    expect(p.route).toEqual([
      { side: 'source', op: 'drop_host', host: 'shop.example.com' },
      { side: 'target', op: 'apply_stack' }
    ])
  })

  it('refuses a traefik-only source with a manual route (never an app with no home)', () => {
    const p = buildMovePlan(input({ from: docker(3, 1, 'traefik') }))
    expect(codes(p)).toContain('SOURCE_UNREACHABLE')
  })

  it('refuses the same placement, a missing hub link and an unread source', () => {
    expect(codes(buildMovePlan(input({ to: docker(3, 1) })))).toContain('SAME_PLACEMENT')
    const unlinked = buildMovePlan(
      input({
        env: { ...input().env, hub_linked: false },
        source: { ...input().source, reachable: false, error: 'NO_HUB_TOKEN' }
      })
    )
    expect(codes(unlinked)).toContain('NOT_HUB_LINKED')
    expect(codes(unlinked)).not.toContain('LINK_UNREACHABLE')
  })

  it('refuses a shared Redis (both stacks hold the same hub token)', () => {
    const p = buildMovePlan(input({ target_facts: { ...input().target_facts, redis: 'r-a' } }))
    expect(codes(p)).toContain('REDIS_SHARED')
  })

  it('takes the two-stacks connection check into the plan and its hash', () => {
    const over = buildMovePlan(
      input({ host_connections: { refusal: 'Too many connections.', warning: null } })
    )
    expect(codes(over)).toEqual(['DB_CONNECTIONS'])
    const blind = buildMovePlan(
      input({ host_connections: { refusal: null, warning: 'No limit on record.' } })
    )
    expect(blind.blockers).toEqual([])
    expect(blind.warnings.map((w) => w.code)).toContain('DB_LIMIT_UNKNOWN')
    expect(blind.plan_hash).not.toBe(buildMovePlan(input()).plan_hash)
  })

  it('needs an app that reports its move marker (0.3.215+, review C1)', () => {
    const old = buildMovePlan(
      input({
        source: { ...input().source, version: '0.3.214' },
        env: { ...input().env, version_pin: '0.3.214' }
      })
    )
    expect(codes(old)).toContain('MOVE_TARGET_MARKER')
    expect(codes(buildMovePlan(input()))).not.toContain('MOVE_TARGET_MARKER')
  })

  it('one publish-edge host: the new stack needs another published port (review M1)', () => {
    const same = {
      from: docker(3, 1, 'publish'),
      to: docker(4, 1, 'publish'),
      target_facts: { ...input().target_facts, stack_publish_port: 8080 }
    }
    expect(codes(buildMovePlan(input(same)))).toContain('PORT_IN_USE')
    const sameAgain = buildMovePlan(
      input({ ...same, target: { kind: 'dedicated', placement_id: 4, publish_port: 8080 } })
    )
    expect(codes(sameAgain)).toContain('PORT_IN_USE')
    const other = buildMovePlan(
      input({ ...same, target: { kind: 'dedicated', placement_id: 4, publish_port: 8081 } })
    )
    expect(codes(other)).not.toContain('PORT_IN_USE')
    expect(other.plan_hash).not.toBe(
      buildMovePlan(
        input({ ...same, target: { kind: 'dedicated', placement_id: 4, publish_port: 8082 } })
      ).plan_hash
    )
    // Another host: its own port space.
    expect(codes(buildMovePlan(input()))).not.toContain('PORT_IN_USE')
  })

  it('does not apply the shared-deployment rules to it', () => {
    const p = buildMovePlan(input({ database: null }))
    expect(codes(p)).not.toContain('NO_DATABASE_RECORD')
    expect(p.warnings.map((w) => w.code)).not.toContain('INSTANCE_SETTINGS_STAY')
  })
})

// ─── the two-stacks connection check ────────────────────────────────────────

const target = (o: Partial<ScaleTarget> = {}): ScaleTarget => ({
  kind: 'environment',
  id: 11,
  key: 'shop/prod',
  label: 'Shop · prod',
  confirm: 'prod',
  app_ids: [1],
  env_ids: [11],
  production: true,
  stack: 'shop-3',
  driver: null,
  size: 'small',
  version: '0.3.215',
  deployed: true,
  template: [],
  shape: null,
  roles: [{ role: 'web', replicas: 2 } as never, { role: 'worker', replicas: 1 } as never],
  sqlite: false,
  pools: { main: 20, background: 5 },
  server: { id: 9, name: 'sql-1', max_connections: 200, others: 0 },
  unusable: null,
  ...o
})

describe('two-stacks connection check (the scaling math)', () => {
  it('doubles the stack: 3 processes × (20 + 5 + 1) = 78, twice = 156', () => {
    const m = overlapMath(target(), 30)
    expect(m.total).toEqual({ from: 78, to: 156 })
    expect(m.servers[0]).toMatchObject({ others: 30, after: 186, fits: true })
  })

  it('refuses past the server limit, counting the other stacks', async () => {
    const out = await overlapConnections(11, {
      target: async () => target(),
      others: async () => new Map([[9, 60]])
    })
    expect(out.refusal).toMatch(/both stacks are up \(78 connections each\)/)
    expect(out.refusal).toMatch(/sql-1 allows 200/)
    expect(out.warning).toBeNull()
  })

  it('warns when the limit is not on record, or the database is unknown', async () => {
    const blind = await overlapConnections(11, {
      target: async () =>
        target({ server: { id: 9, name: 'sql-1', max_connections: null, others: 0 } }),
      others: async () => new Map()
    })
    expect(blind.refusal).toBeNull()
    expect(blind.warning).toMatch(/no connection limit on record/)
    const none = await overlapConnections(11, {
      target: async () => target({ server: null }),
      others: async () => {
        throw new Error('not asked')
      }
    })
    expect(none.warning).toMatch(/no record of this environment’s database server/)
  })

  it('passes when it fits', async () => {
    expect(
      await overlapConnections(11, {
        target: async () => target(),
        others: async () => new Map([[9, 10]])
      })
    ).toEqual({ refusal: null, warning: null })
  })
})

// ─── chargeback ─────────────────────────────────────────────────────────────

const rates = {
  cpu_core_month: 20,
  memory_gb_month: 4,
  storage_gb_month: 0.1,
  database_gb_month: 0.5,
  environment_month: 10
}

describe('chargeback figures', () => {
  it('prices one environment and applies the region factor last', () => {
    const c = costOf({ cpu_cores: 0.5, memory_gb: 2, storage_gb: 10, database_gb: 4 }, rates, 150)
    expect(c).toMatchObject({ cpu: 10, memory: 8, storage: 1, database: 2, environment: 10 })
    expect(c.subtotal).toBe(31)
    expect(c.total).toBe(46.5)
  })

  it('charges an unknown figure as nothing', () => {
    const c = costOf(
      { cpu_cores: null, memory_gb: null, storage_gb: null, database_gb: null },
      rates
    )
    expect(c.total).toBe(10)
  })

  it('takes means for dedicated stacks and splits a shared deployment by answering time', () => {
    const at = new Date('2026-11-20T00:00:00Z')
    const base = {
      sampled_at: at,
      error: null,
      storage_bytes: null,
      memory_mb: null,
      cpu_pct: null,
      busy_ms_per_min: null,
      shared_deployment_id: null,
      environment_id: null
    }
    const u = usageFromSamples(
      [
        { ...base, scope: 'environment', environment_id: 1, cpu_pct: 50, memory_mb: 1024 },
        {
          ...base,
          scope: 'environment',
          environment_id: 1,
          cpu_pct: 150,
          memory_mb: 3072,
          storage_bytes: 2 * 1024 ** 3
        },
        // a failed read is never a zero
        { ...base, scope: 'environment', environment_id: 1, cpu_pct: 0, error: 'UNREACHABLE' },
        {
          ...base,
          scope: 'shared',
          shared_deployment_id: 5,
          memory_mb: 4096,
          busy_ms_per_min: 100
        },
        {
          ...base,
          scope: 'environment',
          environment_id: 2,
          shared_deployment_id: 5,
          cpu_pct: 30,
          busy_ms_per_min: 25
        },
        {
          ...base,
          scope: 'environment',
          environment_id: 3,
          shared_deployment_id: 5,
          busy_ms_per_min: 75
        }
      ],
      [1, 2, 3, 4],
      new Map([
        [2, 5],
        [3, 5]
      ]),
      new Map([[5, 2]]),
      new Map([[1, 1024 ** 3]])
    )
    expect(u.get(1)).toEqual({ cpu_cores: 1, memory_gb: 2, storage_gb: 2, database_gb: 1 })
    expect(u.get(2)).toMatchObject({ cpu_cores: 0.3, memory_gb: 1 })
    expect(u.get(3)).toMatchObject({ cpu_cores: null, memory_gb: 3 })
    expect(u.get(4)).toEqual({
      cpu_cores: null,
      memory_gb: null,
      storage_gb: null,
      database_gb: null
    })
  })

  it('keeps settings in bounds and refuses a bad value', () => {
    expect(normalizeChargeback({ currency: 'eur', rates: { cpu_core_month: -1 } })).toMatchObject({
      currency: 'EUR',
      rates: { cpu_core_month: 0 },
      window_days: 30
    })
    expect(chargebackRefusal({ rates: { cpu_core_month: -1 } })).toMatch(/0–/)
    expect(chargebackRefusal({ rates: { gold: 1 } })).toMatch(/Unknown rate/)
    expect(chargebackRefusal({ currency: 'dollars' })).toMatch(/three-letter/)
    expect(chargebackRefusal({ window_days: 90 })).toMatch(/7–31/)
    expect(chargebackRefusal({ currency: 'GBP', rates: { cpu_core_month: 3 } })).toBeNull()
  })

  it('writes a formula-safe CSV', () => {
    const report: ChargebackReport = {
      generated_at: '2026-11-25T00:00:00.000Z',
      window_days: 30,
      currency: 'USD',
      rates,
      apps: [
        {
          app_id: 1,
          app_key: 'shop',
          app_name: '=HYPERLINK("http://evil")',
          department: '+Finance',
          cost_center: '@cc',
          owners: [{ user_id: 'u', name: '-Mallory' }],
          environments: [
            {
              env_id: 1,
              env_key: 'prod',
              runs_on: 'host-a',
              region: 'EU',
              usage: { cpu_cores: 1, memory_gb: 2, storage_gb: 3, database_gb: null },
              cost: costOf({ cpu_cores: 1, memory_gb: 2, storage_gb: 3, database_gb: null }, rates),
              gaps: ['database size']
            }
          ],
          total: 38.3
        }
      ],
      departments: [],
      owners: [],
      total: 38.3,
      unrated: false
    }
    const csv = chargebackCsv(report)
    const line = csv.split('\r\n')[1]
    expect(line).toContain(`"'=HYPERLINK(""http://evil"")"`)
    expect(line).toContain(`"'+Finance"`)
    expect(line).toContain(`"'@cc"`)
    expect(line).toContain(`"'-Mallory"`)
    expect(line).toContain('"38.30"')
    expect(csv.split('\r\n')[0]).toMatch(/^"App","App key","Department"/)
  })
})

// ─── federation: what a peer answers is checked and rebuilt ─────────────────

describe('peer answers', () => {
  it('takes only an https origin (http only to localhost outside production)', () => {
    expect(peerOrigin('https://hub.other.example/')).toBe('https://hub.other.example')
    expect(peerOrigin('https://hub.other.example/path')).toBeNull()
    expect(peerOrigin('https://user:pw@hub.other.example')).toBeNull()
    expect(peerOrigin('ftp://hub.other.example')).toBeNull()
    expect(peerOrigin('http://hub.other.example')).toBeNull()
    expect(peerOrigin('http://localhost:4000')).toBe('http://localhost:4000')
    expect(tokenShapeOk('nvk_' + 'a'.repeat(30))).toBe(true)
    expect(tokenShapeOk('has a space in it and is long')).toBe(false)
  })

  it('accepts only a named API key with hub:read, never hub:write', () => {
    expect(parseSelf({ auth: 'api_key', key_scope: 'read', version: '0.3.215' })).toMatchObject({
      key_scope: 'read',
      version: '0.3.215'
    })
    expect(() => parseSelf({ auth: 'api_key', key_scope: 'write' })).toThrow(/hub:read only/)
    expect(() => parseSelf({ auth: 'api_key', key_scope: 'none' })).toThrow(/no hub:read/)
    expect(() => parseSelf({ auth: 'session', key_scope: null })).toThrow(/named API key/)
    expect(() => parseSelf('nope')).toThrow()
  })

  it('rebuilds each row from plain types; no HTML-bearing link, no remote URL', () => {
    const r = rebuildRow({
      app_id: 7,
      app_key: 'crm',
      app_name: '<img src=x onerror=alert(1)>‮CRM\u0007',
      environment_id: 70,
      env_key: 'production',
      env_status: 'active',
      base_url: 'https://crm.other.example/some/path?x=1',
      placement: 'dedicated',
      version: '0.3.214',
      behind: 1,
      state: 'ok',
      up: true,
      uptime_30d: 99.95,
      open_issues: 2,
      alerts: [{}, {}],
      checked_at: '2026-11-25T10:00:00Z',
      deployed_at: 'yesterday',
      link: 'javascript:alert(1)',
      extra: { a: 1 }
    })
    expect(r).toEqual({
      app_id: 7,
      app_key: 'crm',
      app_name: '<img src=x onerror=alert(1)>CRM',
      environment_id: 70,
      env_key: 'production',
      env_status: 'active',
      host: 'crm.other.example',
      placement: 'dedicated',
      version: '0.3.214',
      behind: 1,
      state: 'ok',
      up: true,
      uptime_30d: 99.95,
      open_issues: 2,
      alerts: 2,
      checked_at: '2026-11-25T10:00:00.000Z',
      deployed_at: null,
      path: '/hub?app=7'
    })
    // React renders the name as text; the only link is built here, host-relative.
    expect(Object.keys(r ?? {})).not.toContain('link')
    expect(rebuildRow({ app_id: '7', app_key: 'crm', environment_id: 1, env_key: 'p' })).toBeNull()
    expect(rebuildRow({ app_id: 7, app_key: 'CRM!', environment_id: 1, env_key: 'p' })).toBeNull()
    expect(
      rebuildRow({
        app_id: 7,
        app_key: 'crm',
        environment_id: 1,
        env_key: 'p',
        base_url: 'javascript:alert(1)',
        state: 'pwned',
        version: '<b>1</b>',
        uptime_30d: 900
      })
    ).toMatchObject({ host: null, state: null, version: null, uptime_30d: null })
    expect(safeText('  a⁦b\u0000 ', 10)).toBe('ab')
  })

  it('drops rows that are not rows and refuses a fleet without rows', () => {
    expect(parseFleet({ rows: [null, 'x', { app_id: 1 }], newest: '0.3.215' })).toEqual({
      rows: [],
      newest: '0.3.215'
    })
    expect(() => parseFleet({ apps: [] })).toThrow()
  })
})
