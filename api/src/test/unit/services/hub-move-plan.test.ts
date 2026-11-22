import { describe, expect, it } from 'vitest'
import { buildMovePlan, MANUAL_MOVE_STEPS, MOVE_STEPS } from '../../../services/hub/move/plan.js'
import type {
  MoveBlockerCode,
  MovePlanInput,
  PlacementSide
} from '../../../services/hub/move/types.js'
import type { SharedDeployment } from '../../../services/hub/shared/store.js'
import { SHARED_READINESS_BLOCKERS } from '../../../services/hub-link/shared-readiness.js'

// Nivaro Hub phase 6, Task 15: the move plan is pure. Every blocker fires from its own fixture
// input and the plain fixture has none; warnings, steps, checklist and the plan hash follow the
// plan's rules (B8 adds the manual step order).

const FP = 'a'.repeat(32)
/** Extension image pins (ruling P6-16: `<repo>@sha256:<64 hex>`). */
const PIN_A = `registry.example.com/ext-x@sha256:${'1'.repeat(64)}`
const PIN_B = `registry.example.com/ext-x@sha256:${'2'.repeat(64)}`

function shared(o: Partial<SharedDeployment> = {}): SharedDeployment {
  return {
    id: 7,
    key: 'pool-a',
    name: 'Pool A',
    mode: 'docker',
    driver_id: 1,
    stack: 'pool-a',
    version_pin: '0.3.210',
    extensions: ['x'],
    extension_pins: { x: PIN_A },
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

const dockerSide = (o: { edge?: 'traefik' | 'publish' | null } = {}): PlacementSide => ({
  kind: 'docker',
  placement: { id: 3, kind: 'dedicated', driver_id: 1, target: { stack: 'shop-prod' } },
  driverId: 1,
  stack: 'shop-prod',
  edge: o.edge === undefined ? 'traefik' : o.edge
})
const sharedSide = (o: Partial<SharedDeployment> = {}): PlacementSide => ({
  kind: 'shared',
  shared: shared(o),
  edge: 'traefik'
})
const gitlabSide = (): PlacementSide => ({
  kind: 'gitlab',
  placement: { id: 4, kind: 'dedicated', driver_id: 9, target: { branch: 'deploy/prod' } },
  components: []
})

/** A to_shared move with nothing wrong. */
function input(o: Partial<MovePlanInput> = {}): MovePlanInput {
  return {
    kind: 'to_shared',
    app: { id: 1, key: 'shop', signin_mode: 'direct', extensions: ['x'] },
    env: { id: 11, key: 'prod', hub_linked: true, version_pin: '0.3.210' },
    from: dockerSide(),
    to: sharedSide(),
    target: { kind: 'shared', shared_id: 7, pool_max: 5 },
    names: ['shop.apps.example.com'],
    names_taken: [],
    database: { id: 21, ready: true },
    app_key: { known: true, fp: FP },
    locks: {
      env: null,
      open_move: false,
      shared: [{ id: 7, key: 'pool-a', holder: null, upgrading: false }]
    },
    source: {
      reachable: true,
      error: null,
      version: '0.3.210',
      key_fp: FP,
      oidc: { issuer_host: 'login.microsoftonline.com', tenant: 'corp-tenant' },
      signin_hub: false,
      db_identity: 'pg|10.0.0.5|5432|shop',
      files: { count: 40, bytes: 123456, local: 38 },
      extensions: { x: '1.2.0' },
      extension_pins: { x: PIN_A },
      readiness: [],
      storage_provider: 'local',
      redis: 'r-source'
    },
    target_facts: {
      reachable: true,
      error: null,
      version: '0.3.210',
      oidc: { issuer_host: 'login.microsoftonline.com', tenant: 'corp-tenant' },
      extensions: ['x'],
      extension_pins: { x: PIN_A },
      db: { reachable: true, identity: 'pg|10.0.0.5|5432|shop', error: null },
      identity_shared_with: [],
      pool: { used: 10, budget: 60, asked: 5 },
      siblings: [],
      storage_provider: 'local',
      redis: 'r-target',
      multi_node: null,
      stack_key_fp: null,
      in_use_by: null,
      identity_unchecked: 0
    },
    driver_problem: null,
    gather_failed: [],
    ...o
  }
}

const src = (o: Partial<MovePlanInput['source']>) => ({ ...input().source, ...o })
const tgt = (o: Partial<MovePlanInput['target_facts']>) => ({ ...input().target_facts, ...o })
const codes = (p: { blockers: { code: string }[] }) => p.blockers.map((b) => b.code)

describe('buildMovePlan — a clean move', () => {
  it('has no blockers', () => {
    expect(buildMovePlan(input()).blockers).toEqual([])
  })
})

describe('buildMovePlan — one test per blocker', () => {
  const cases: Array<[MoveBlockerCode, MovePlanInput]> = [
    [
      'SAME_PLACEMENT',
      input({
        kind: 'between_shared',
        from: sharedSide(),
        to: sharedSide(),
        source: src({ readiness: [] })
      })
    ],
    ['NOT_HUB_LINKED', input({ env: { ...input().env, hub_linked: false } })],
    ['LINK_UNREACHABLE', input({ source: src({ reachable: false, error: 'UNREACHABLE' }) })],
    ['VERSION_DIFFERS', input({ target_facts: tgt({ version: '0.3.211' }) })],
    ['EXTENSION_NOT_ALLOWED', input({ target_facts: tgt({ extensions: [] }) })],
    ['EXTENSION_VERSION_DIFFERS', input({ target_facts: tgt({ extension_pins: { x: PIN_B } }) })],
    ['NO_DATABASE_RECORD', input({ database: null })],
    ['APP_KEY_UNKNOWN', input({ app_key: { known: false, fp: null } })],
    ['APP_KEY_MISMATCH', input({ source: src({ key_fp: 'b'.repeat(32) }) })],
    ['SIGNIN_VIA_HUB', input({ app: { ...input().app, signin_mode: 'hub' } })],
    [
      'ISSUER_DIFFERS',
      input({
        target_facts: tgt({ oidc: { issuer_host: 'login.microsoftonline.com', tenant: 'other' } })
      })
    ],
    ['POOL_BUDGET', input({ target_facts: tgt({ pool: { used: 58, budget: 60, asked: 5 } }) })],
    [
      'POOL_TOO_SMALL',
      input({
        target: { kind: 'shared', shared_id: 7, pool_max: 1 },
        target_facts: tgt({ pool: { used: 0, budget: 60, asked: 1 } })
      })
    ],
    ['BUSY', input({ locks: { ...input().locks, env: 'promotion' } })],
    [
      'SHARED_BUSY',
      input({
        locks: {
          ...input().locks,
          shared: [{ id: 7, key: 'pool-a', holder: 'shared', upgrading: false }]
        }
      })
    ],
    ['SHARED_NOT_ACTIVE', input({ to: sharedSide({ status: 'retired' }) })],
    [
      'TARGET_UNREACHABLE',
      input({ target_facts: tgt({ reachable: false, error: 'LINK_UNREACHABLE' }) })
    ],
    [
      'TARGET_IN_USE',
      input({
        kind: 'to_dedicated',
        from: sharedSide(),
        to: dockerSide(),
        target: { kind: 'dedicated', placement_id: 3 },
        target_facts: tgt({ version: null, db: null, pool: null, in_use_by: 'shop/staging' })
      })
    ],
    [
      'DB_UNREACHABLE_FROM_TARGET',
      input({ target_facts: tgt({ db: { reachable: false, identity: null, error: 'timeout' } }) })
    ],
    [
      'DATABASE_DIFFERS',
      input({
        target_facts: tgt({
          db: { reachable: true, identity: 'pg|10.9.9.9|5432|shop', error: null }
        })
      })
    ],
    ['DB_IDENTITY_SHARED', input({ target_facts: tgt({ identity_shared_with: ['crm/prod'] }) })],
    ['REDIS_SHARED', input({ target_facts: tgt({ redis: 'r-source' }) })],
    ['HOSTNAME_TAKEN', input({ names_taken: ['shop.apps.example.com'] })],
    ['DRIVER_UNSUPPORTED', input({ driver_problem: 'The placement has no Docker stack name.' })],
    ['ENV_OBJECT_STORAGE', input({ target_facts: tgt({ storage_provider: 's3' }) })]
  ]

  for (const [code, fixture] of cases) {
    it(`${code}`, () => {
      expect(codes(buildMovePlan(fixture))).toContain(code)
    })
  }

  it('source 0.3.210 vs shared 0.3.211 → VERSION_DIFFERS naming both', () => {
    const p = buildMovePlan(input({ target_facts: tgt({ version: '0.3.211' }) }))
    const b = p.blockers.find((x) => x.code === 'VERSION_DIFFERS')
    expect(b?.text).toContain('0.3.210')
    expect(b?.text).toContain('0.3.211')
  })

  it("the app's extension x not allowed → EXTENSION_NOT_ALLOWED naming x", () => {
    const p = buildMovePlan(input({ target_facts: tgt({ extensions: ['y'] }) }))
    expect(p.blockers.find((b) => b.code === 'EXTENSION_NOT_ALLOWED')?.text).toMatch(/\bx\b/)
  })

  it('an extension the source loads but the app record does not list still counts', () => {
    const p = buildMovePlan(
      input({ source: src({ extensions: { x: '1.2.0', z: '2.0.0' } }), target_facts: tgt({}) })
    )
    expect(p.blockers.find((b) => b.code === 'EXTENSION_NOT_ALLOWED')?.text).toMatch(/\bz\b/)
  })

  it('a key entry the Hub cannot open → APP_KEY_UNKNOWN saying so, not "does not know" (M-9)', () => {
    const p = buildMovePlan(input({ app_key: { known: false, fp: null, unreadable: true } }))
    expect(p.blockers.find((b) => b.code === 'APP_KEY_UNKNOWN')?.text).toMatch(/cannot open/i)
  })

  it('extension builds are compared as image pins; a source whose pins are unknown → EXTENSION_PIN_UNVERIFIED + item (P6-16)', () => {
    const same = buildMovePlan(input())
    expect(codes(same)).not.toContain('EXTENSION_VERSION_DIFFERS')
    expect(same.warnings.map((w) => w.code)).not.toContain('EXTENSION_PIN_UNVERIFIED')
    const unknown = buildMovePlan(input({ source: src({ extension_pins: null }) }))
    expect(codes(unknown)).toEqual([])
    expect(unknown.warnings.find((w) => w.code === 'EXTENSION_PIN_UNVERIFIED')?.text).toMatch(
      /\bx\b/
    )
    expect(unknown.checklist.find((c) => c.id === 'extension_builds_same')?.required).toBe(true)
    const missing = buildMovePlan(input({ source: src({ extension_pins: {} }) }))
    expect(missing.warnings.map((w) => w.code)).toContain('EXTENSION_PIN_UNVERIFIED')
    // The text never shows a digest.
    const differs = buildMovePlan(input({ target_facts: tgt({ extension_pins: { x: PIN_B } }) }))
    expect(JSON.stringify(differs)).not.toContain('1'.repeat(64))
    expect(JSON.stringify(differs)).not.toContain('2'.repeat(64))
  })

  it('a registered target that allows x but pins no build → EXTENSION_PIN_UNVERIFIED + item (I-A)', () => {
    const p = buildMovePlan(
      input({
        to: sharedSide({ mode: 'registered', driver_id: null, extension_pins: {} }),
        target_facts: tgt({ extension_pins: {} })
      })
    )
    expect(codes(p)).toEqual([])
    expect(p.warnings.find((w) => w.code === 'EXTENSION_PIN_UNVERIFIED')?.text).toMatch(
      /pool-a.*\bx\b|\bx\b.*pool-a/
    )
    expect(p.checklist.find((c) => c.id === 'extension_builds_same')?.required).toBe(true)
  })

  it('key_fp differs → APP_KEY_MISMATCH', () => {
    expect(codes(buildMovePlan(input({ source: src({ key_fp: 'c'.repeat(32) }) })))).toEqual([
      'APP_KEY_MISMATCH'
    ])
  })

  it('a source that reports no key at all → APP_KEY_MISMATCH (its sealed values would not open)', () => {
    expect(codes(buildMovePlan(input({ source: src({ key_fp: null }) })))).toContain(
      'APP_KEY_MISMATCH'
    )
  })

  it("a Docker target's stack settings holding another key → APP_KEY_MISMATCH (R9)", () => {
    const p = buildMovePlan(
      input({
        kind: 'to_dedicated',
        from: sharedSide(),
        to: dockerSide(),
        target: { kind: 'dedicated', placement_id: 3 },
        target_facts: tgt({ version: null, db: null, pool: null, stack_key_fp: 'd'.repeat(32) })
      })
    )
    expect(codes(p)).toContain('APP_KEY_MISMATCH')
  })

  it('a readiness blocker ROW_SCHEDULES → a blocker with its detail', () => {
    const p = buildMovePlan(
      input({
        source: src({
          readiness: [
            { code: 'ROW_SCHEDULES', level: 'blocker', detail: '3 scheduled reports' },
            { code: 'TEAMS_BOT', level: 'warning', detail: 'The Teams bot is on' }
          ]
        })
      })
    )
    const b = p.blockers.find((x) => x.code === 'ROW_SCHEDULES')
    expect(b?.text).toContain('3 scheduled reports')
    expect(p.warnings.find((w) => w.code === 'TEAMS_BOT')?.text).toContain('The Teams bot is on')
    expect(codes(p)).not.toContain('TEAMS_BOT')
  })

  it('every one of the six readiness blockers becomes a plan blocker', () => {
    expect(SHARED_READINESS_BLOCKERS).toHaveLength(6)
    for (const code of SHARED_READINESS_BLOCKERS) {
      const p = buildMovePlan(
        input({ source: src({ readiness: [{ code, level: 'blocker', detail: 'counted' }] }) })
      )
      expect(codes(p)).toContain(code)
    }
  })

  it('a readiness code the app marks as a blocker counts as one whatever its level says', () => {
    const p = buildMovePlan(
      input({
        source: src({ readiness: [{ code: 'SQLITE', level: 'warning', detail: 'SQLite' }] })
      })
    )
    expect(codes(p)).toContain('SQLITE')
  })

  it('an identity that cannot be read on either side → DATABASE_DIFFERS (nothing proves the same database)', () => {
    expect(codes(buildMovePlan(input({ source: src({ db_identity: null }) })))).toContain(
      'DATABASE_DIFFERS'
    )
    expect(
      codes(
        buildMovePlan(
          input({ target_facts: tgt({ db: { reachable: true, identity: null, error: null } }) })
        )
      )
    ).toContain('DATABASE_DIFFERS')
  })

  it('a ready record the target was never asked about (no db check) → DB_UNREACHABLE_FROM_TARGET (I-2)', () => {
    const p = buildMovePlan(input({ target_facts: tgt({ db: null }) }))
    expect(codes(p)).toContain('DB_UNREACHABLE_FROM_TARGET')
  })

  it('a record whose connection the Hub cannot open → DB_UNREACHABLE_FROM_TARGET naming that', () => {
    const p = buildMovePlan(
      input({
        target_facts: tgt({
          db: { reachable: false, identity: null, error: 'CONNECTION_UNREADABLE' }
        })
      })
    )
    expect(p.blockers.find((b) => b.code === 'DB_UNREACHABLE_FROM_TARGET')?.text).toMatch(
      /could not open/i
    )
  })

  it('a docker deployment the Hub never deployed (new) → SHARED_NOT_ACTIVE; a registered new one is judged live (M-4)', () => {
    expect(codes(buildMovePlan(input({ to: sharedSide({ status: 'new' }) })))).toContain(
      'SHARED_NOT_ACTIVE'
    )
    expect(
      codes(
        buildMovePlan(
          input({ to: sharedSide({ status: 'new', mode: 'registered', driver_id: null }) })
        )
      )
    ).not.toContain('SHARED_NOT_ACTIVE')
  })

  it('a move into a shared deployment being upgraded → SHARED_BUSY', () => {
    const p = buildMovePlan(
      input({
        locks: {
          ...input().locks,
          shared: [{ id: 7, key: 'pool-a', holder: null, upgrading: true }]
        }
      })
    )
    expect(codes(p)).toContain('SHARED_BUSY')
  })

  it('an open move of the environment → BUSY even with no lock held', () => {
    expect(codes(buildMovePlan(input({ locks: { ...input().locks, open_move: true } })))).toContain(
      'BUSY'
    )
  })

  it('a lock the Hub could not read → BUSY saying so (M-1)', () => {
    const p = buildMovePlan(input({ locks: { ...input().locks, env: 'unreadable' } }))
    expect(p.blockers.find((b) => b.code === 'BUSY')?.text).toMatch(/could not read/i)
    const q = buildMovePlan(
      input({
        locks: {
          ...input().locks,
          shared: [{ id: 7, key: 'pool-a', holder: 'unreadable', upgrading: false }]
        }
      })
    )
    expect(q.blockers.find((b) => b.code === 'SHARED_BUSY')?.text).toMatch(/could not read/i)
  })

  it('BUSY names the real holder (lockHolderRefusal)', () => {
    const p = buildMovePlan(input({ locks: { ...input().locks, env: 'creation' } }))
    expect(p.blockers.find((b) => b.code === 'BUSY')?.text).toMatch(/creation/i)
  })

  it('a dedicated target is never judged on version, extensions or pool', () => {
    const p = buildMovePlan(
      input({
        kind: 'to_dedicated',
        from: sharedSide(),
        to: dockerSide(),
        target: { kind: 'dedicated', placement_id: 3 },
        target_facts: tgt({ version: null, extensions: [], db: null, pool: null, oidc: null })
      })
    )
    expect(p.blockers).toEqual([])
  })
})

describe('buildMovePlan — a check that could not run is never a pass (P6-15)', () => {
  it('a part of the gather that failed → GATHER_FAILED naming it', () => {
    const p = buildMovePlan(input({ gather_failed: ['the tenant list of pool-a'] }))
    expect(p.blockers.find((b) => b.code === 'GATHER_FAILED')?.text).toContain(
      'the tenant list of pool-a'
    )
  })

  it('other apps not compared → DB_IDENTITY_UNCHECKED naming how many, and a required checklist item', () => {
    const p = buildMovePlan(input({ target_facts: tgt({ identity_unchecked: 3 }) }))
    expect(p.warnings.find((w) => w.code === 'DB_IDENTITY_UNCHECKED')?.text).toMatch(/\b3\b/)
    expect(p.checklist.find((c) => c.id === 'db_identity_checked')?.required).toBe(true)
    expect(codes(p)).toEqual([])
  })

  it('a Redis the Hub cannot see → REDIS_UNVERIFIED and the required item redis_separate', () => {
    const p = buildMovePlan(input({ source: src({ redis: null }) }))
    expect(p.warnings.find((w) => w.code === 'REDIS_UNVERIFIED')?.text).toMatch(/source/i)
    expect(p.checklist.find((c) => c.id === 'redis_separate')?.required).toBe(true)
    expect(codes(p)).toEqual([])
  })

  it('storage the Hub cannot see → STORAGE_UNVERIFIED and the required item storage_local', () => {
    const p = buildMovePlan(input({ target_facts: tgt({ storage_provider: null }) }))
    expect(p.warnings.find((w) => w.code === 'STORAGE_UNVERIFIED')?.text).toMatch(/pool-a/)
    expect(p.checklist.find((c) => c.id === 'storage_local')?.required).toBe(true)
  })

  it('a source issuer the Hub could not read → ISSUER_UNVERIFIED and the item issuer_same (M-10)', () => {
    const p = buildMovePlan(
      input({
        kind: 'between_shared',
        from: sharedSide({ id: 6, key: 'pool-old' }),
        source: src({ oidc: null, oidc_unread: true })
      })
    )
    expect(p.warnings.map((w) => w.code)).toContain('ISSUER_UNVERIFIED')
    expect(p.checklist.find((c) => c.id === 'issuer_same')?.required).toBe(true)
  })

  it('a target agent the Hub could not read → MULTI_NODE_UNVERIFIED and the item volumes_one_node (N-2)', () => {
    const p = buildMovePlan(input({ target_facts: tgt({ multi_node_unread: true }) }))
    expect(p.warnings.find((w) => w.code === 'MULTI_NODE_UNVERIFIED')?.text).toMatch(/pool-a/)
    expect(p.checklist.find((c) => c.id === 'volumes_one_node')?.required).toBe(true)
    expect(codes(p)).toEqual([])
  })

  it('every other app compared → no such warning or item', () => {
    const p = buildMovePlan(input())
    expect(p.warnings.map((w) => w.code)).not.toContain('DB_IDENTITY_UNCHECKED')
    expect(p.checklist.map((c) => c.id)).not.toContain('db_identity_checked')
  })
})

describe('buildMovePlan — warnings', () => {
  it('SIGN_IN_AGAIN always appears on to_shared', () => {
    expect(buildMovePlan(input()).warnings.map((x) => x.code)).toContain('SIGN_IN_AGAIN')
  })

  it('SAME_APP_ON_DEPLOYMENT is absent when no other environment of the app is there (Decision 8)', () => {
    expect(buildMovePlan(input()).warnings.map((x) => x.code)).not.toContain(
      'SAME_APP_ON_DEPLOYMENT'
    )
  })

  it('SAME_APP_ON_DEPLOYMENT names the other environments of the app already there', () => {
    const p = buildMovePlan(input({ target_facts: tgt({ siblings: ['staging', 'dev'] }) }))
    const w = p.warnings.find((x) => x.code === 'SAME_APP_ON_DEPLOYMENT')
    expect(w?.text).toContain('staging')
    expect(w?.text).toContain('dev')
  })

  it('SIGN_IN_AGAIN names phone and MCP sign-ins', () => {
    const w = buildMovePlan(input()).warnings.find((x) => x.code === 'SIGN_IN_AGAIN')
    expect(w?.text).toMatch(/phone/i)
    expect(w?.text).toMatch(/MCP/)
  })

  it('SIGNED_LINKS_RESET on every kind (the session secret differs)', () => {
    for (const p of [
      buildMovePlan(input()),
      buildMovePlan(
        input({
          kind: 'to_dedicated',
          from: sharedSide(),
          to: dockerSide(),
          target: { kind: 'dedicated', placement_id: 3 },
          target_facts: tgt({ version: null, db: null, pool: null })
        })
      )
    ]) {
      const w = p.warnings.find((x) => x.code === 'SIGNED_LINKS_RESET')
      expect(w?.text).toMatch(/90/)
    }
  })

  it('REPLAYS_NOT_MOVED always', () => {
    expect(buildMovePlan(input()).warnings.map((w) => w.code)).toContain('REPLAYS_NOT_MOVED')
  })

  it('MANUAL_ROUTE + OLD_STACK_STOP from a GitLab source', () => {
    const w = buildMovePlan(input({ from: gitlabSide() })).warnings.map((x) => x.code)
    expect(w).toContain('MANUAL_ROUTE')
    expect(w).toContain('OLD_STACK_STOP')
  })

  it('MULTI_NODE_VOLUMES when the target has local volumes on several nodes', () => {
    const p = buildMovePlan(input({ target_facts: tgt({ multi_node: 3 }) }))
    expect(p.warnings.find((w) => w.code === 'MULTI_NODE_VOLUMES')?.text).toContain('3')
  })
})

describe('buildMovePlan — steps, route, checklist', () => {
  it('the steps per kind (automatic)', () => {
    // The plan's list with place_on_target first: the target's file pull serves listed apps only.
    expect(buildMovePlan(input()).steps).toEqual([
      'check',
      'place_on_target',
      'files_warm',
      'maintenance_on',
      'wait_idle',
      'files_delta',
      'target_ready',
      'route',
      'verify',
      'release',
      'retire_source',
      'done'
    ])
    expect(MOVE_STEPS.to_dedicated).toEqual([
      'check',
      'maintenance_on',
      'wait_idle',
      'deploy_target',
      'target_ready',
      'files_full',
      'route',
      'verify',
      'release',
      'retire_source',
      'done'
    ])
    expect(MOVE_STEPS.between_shared).toEqual(MOVE_STEPS.to_shared)
    const back = buildMovePlan(
      input({
        kind: 'to_dedicated',
        from: sharedSide(),
        to: dockerSide(),
        target: { kind: 'dedicated', placement_id: 3 },
        target_facts: tgt({ version: null, db: null, pool: null })
      })
    )
    expect(back.routing).toBe('automatic')
    expect(back.steps).toEqual(MOVE_STEPS.to_dedicated)
  })

  it('manual routing (B8): the target is prepared and the route verified while the source serves', () => {
    const p = buildMovePlan(input({ from: gitlabSide() }))
    expect(p.routing).toBe('manual')
    expect(p.steps).toEqual(MANUAL_MOVE_STEPS.to_shared)
    expect(MANUAL_MOVE_STEPS.to_shared).toEqual([
      'check',
      'place_on_target',
      'files_warm',
      'route',
      'verify',
      'maintenance_on',
      'wait_idle',
      'files_delta',
      'target_ready',
      'release',
      'retire_source',
      'done'
    ])
    expect(MANUAL_MOVE_STEPS.to_dedicated).toEqual([
      'check',
      'deploy_target',
      'files_warm',
      'route',
      'verify',
      'maintenance_on',
      'wait_idle',
      'files_delta',
      'target_ready',
      'release',
      'retire_source',
      'done'
    ])
    expect(MANUAL_MOVE_STEPS.between_shared).toEqual(MANUAL_MOVE_STEPS.to_shared)
    expect(p.manual_request).toBeTruthy()
  })

  it('the checklist: callbacks always to shared, old stack for gitlab (not required), route ticket when manual', () => {
    const auto = buildMovePlan(input({ names: ['shop.apps.example.com', 'shop.example.org'] }))
    const cb = auto.checklist.find((c) => c.id === 'callbacks_registered')
    expect(cb?.required).toBe(true)
    expect(cb?.text).toContain('https://shop.apps.example.com/api/auth/callback')
    expect(cb?.text).toContain('https://shop.example.org/api/auth/callback')
    expect(auto.checklist.map((c) => c.id)).toEqual(['callbacks_registered'])

    const manual = buildMovePlan(input({ from: gitlabSide() }))
    expect(manual.checklist.find((c) => c.id === 'old_stack_stopped')?.required).toBe(false)
    expect(manual.checklist.find((c) => c.id === 'route_ticket')?.required).toBe(true)

    const back = buildMovePlan(
      input({
        kind: 'to_dedicated',
        from: sharedSide(),
        to: dockerSide(),
        target: { kind: 'dedicated', placement_id: 3 },
        target_facts: tgt({ version: null, db: null, pool: null })
      })
    )
    expect(back.checklist.map((c) => c.id)).not.toContain('callbacks_registered')
  })

  it('files: the local count, every byte, and the first pull is full (T10 carry)', () => {
    expect(buildMovePlan(input()).files).toEqual({ count: 38, bytes: 123456, first_pull: 'full' })
  })

  it('the version is the source version (a move never changes it)', () => {
    expect(buildMovePlan(input()).version).toBe('0.3.210')
    expect(buildMovePlan(input({ source: src({ reachable: false, version: null }) })).version).toBe(
      '0.3.210'
    )
  })
})

describe('buildMovePlan — plan hash', () => {
  it('is stable for the same input', () => {
    expect(buildMovePlan(input()).plan_hash).toBe(buildMovePlan(input()).plan_hash)
    expect(buildMovePlan(input()).plan_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('names are normalized before hashing (case, spaces, duplicates) (M-5)', () => {
    const p = buildMovePlan(input({ names: [' Shop.Apps.Example.com', 'shop.apps.example.com'] }))
    expect(p.plan_hash).toBe(buildMovePlan(input()).plan_hash)
    expect(p.hostnames).toEqual(['shop.apps.example.com'])
  })

  it('changes when the set of unverified extensions grows (M-A)', () => {
    const two = {
      app: { ...input().app, extensions: ['x', 'y'] },
      target_facts: tgt({ extensions: ['x', 'y'], extension_pins: { x: PIN_A, y: PIN_B } })
    }
    const oneUnknown = buildMovePlan(
      input({ ...two, source: src({ extension_pins: { x: PIN_A } }) })
    )
    const twoUnknown = buildMovePlan(input({ ...two, source: src({ extension_pins: {} }) }))
    expect(oneUnknown.warnings.map((w) => w.code)).toContain('EXTENSION_PIN_UNVERIFIED')
    expect(twoUnknown.warnings.map((w) => w.code)).toContain('EXTENSION_PIN_UNVERIFIED')
    expect(oneUnknown.plan_hash).not.toBe(twoUnknown.plan_hash)
  })

  it('changes when the set of differing extensions grows (M-A)', () => {
    const two = {
      app: { ...input().app, extensions: ['x', 'y'] },
      target_facts: tgt({ extensions: ['x', 'y'], extension_pins: { x: PIN_B, y: PIN_B } })
    }
    const one = buildMovePlan(
      input({ ...two, source: src({ extension_pins: { x: PIN_A, y: PIN_B } }) })
    )
    const both = buildMovePlan(
      input({ ...two, source: src({ extension_pins: { x: PIN_A, y: PIN_A } }) })
    )
    expect(one.plan_hash).not.toBe(both.plan_hash)
  })

  it('changes when a hostname changes', () => {
    expect(buildMovePlan(input({ names: ['shop2.apps.example.com'] })).plan_hash).not.toBe(
      buildMovePlan(input()).plan_hash
    )
  })

  it('changes with the target, the version, a blocker or a warning; not with a text-only fact', () => {
    const base = buildMovePlan(input()).plan_hash
    expect(buildMovePlan(input({ to: sharedSide({ id: 8 }) })).plan_hash).not.toBe(base)
    expect(buildMovePlan(input({ source: src({ version: '0.3.209' }) })).plan_hash).not.toBe(base)
    expect(buildMovePlan(input({ names_taken: ['shop.apps.example.com'] })).plan_hash).not.toBe(
      base
    )
    expect(buildMovePlan(input({ target_facts: tgt({ multi_node: 2 }) })).plan_hash).not.toBe(base)
    expect(
      buildMovePlan(input({ source: src({ files: { count: 41, bytes: 1, local: 39 } }) })).plan_hash
    ).toBe(base)
  })
})

describe('buildMovePlan — nothing identifying leaks into the plan text', () => {
  // The input carries no token, key or connection by design (the gather test proves that on the
  // real path). What it does carry — the key fingerprint, database identities, Redis hashes and
  // the target's own db error — must not reach the plan either (M-6).
  it('never shows a key fingerprint, a database identity, a Redis hash or a db error', () => {
    const otherFp = 'b'.repeat(32)
    const p = buildMovePlan(
      input({
        source: src({ key_fp: otherFp, db_identity: 'pg|10.0.0.5|5432|shop', redis: 'r-same' }),
        target_facts: tgt({
          db: { reachable: true, identity: 'pg|10.9.9.9|5432|shop', error: null },
          redis: 'r-same'
        })
      })
    )
    expect(p.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['APP_KEY_MISMATCH', 'DATABASE_DIFFERS', 'REDIS_SHARED'])
    )
    const text = JSON.stringify(p)
    for (const s of [FP, otherFp, '10.0.0.5', '10.9.9.9', 'r-same']) expect(text).not.toContain(s)
    const q = JSON.stringify(
      buildMovePlan(
        input({
          target_facts: tgt({ db: { reachable: false, identity: null, error: 'pw=hunter2' } })
        })
      )
    )
    expect(q).not.toContain('hunter2')
  })
})

// Ruling P6-20 (Task 16 owns this plan change): a GitLab target whose deploy job cannot be proven
// to forward HUB_BOOT_MAINTENANCE gets a warning, a required checklist item and a plan hash of
// its own.
describe('GITLAB_BOOT_WINDOW', () => {
  const gl = (boot: 'forwarded' | 'unproven' | undefined) =>
    buildMovePlan(
      input({
        kind: 'to_dedicated',
        from: sharedSide(),
        to: gitlabSide(),
        target: { kind: 'dedicated', placement_id: 9 },
        target_facts: tgt({ boot_maintenance: boot })
      })
    )

  it('an unproven template → warning plus a required item naming the risk; part of the hash', () => {
    const p = gl('unproven')
    expect(p.warnings.map((w) => w.code)).toContain('GITLAB_BOOT_WINDOW')
    const item = p.checklist.find((c) => c.id === 'gitlab_boot_window')
    expect(item).toMatchObject({ required: true })
    expect(item?.text).toMatch(/without maintenance/)
    expect(gl('forwarded').plan_hash).not.toBe(p.plan_hash)
  })

  it('a template that forwards it (or a non-GitLab target) → neither', () => {
    for (const p of [gl('forwarded'), gl(undefined)]) {
      expect(p.warnings.map((w) => w.code)).not.toContain('GITLAB_BOOT_WINDOW')
      expect(p.checklist.find((c) => c.id === 'gitlab_boot_window')).toBeUndefined()
    }
  })
})
