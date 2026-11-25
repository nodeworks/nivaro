import { describe, expect, it } from 'vitest'
import { buildMovePlan, HUDDLE_MAIL_SINCE, keepsEnvMail } from '../../../services/hub/move/plan.js'
import type { MovePlanInput, PlacementSide } from '../../../services/hub/move/types.js'
import type { SharedDeployment } from '../../../services/hub/shared/store.js'

// Hub gap `watch` (0.3.215): the plan stops warning HUDDLE_TURN for a target that uses each app's
// own saved media servers, and turns ENV_SMTP into ENV_SMTP_KEPT when both sides save the app's
// env mail settings at maintenance_on. Fixtures copied from hub-move-plan.test.ts.

const FP = 'a'.repeat(32)
/** Extension image pins (ruling P6-16: `<repo>@sha256:<64 hex>`). */
const PIN_A = `registry.example.com/ext-x@sha256:${'1'.repeat(64)}`

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
      files: { count: 40, bytes: 123456, local: 38, objects: {} },
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

const huddle = { code: 'HUDDLE_TURN' as const, level: 'warning' as const, detail: '1 TURN server' }
const smtp = { code: 'ENV_SMTP' as const, level: 'warning' as const, detail: 'env relay' }
const plan = (sv: string | null, tv: string | null) =>
  buildMovePlan(
    input({
      source: src({ version: sv, readiness: [huddle, smtp] }),
      target_facts: tgt({ version: tv })
    })
  )
const warned = (p: ReturnType<typeof plan>) =>
  p.warnings
    .map((w) => w.code)
    .filter((c) => ['HUDDLE_TURN', 'ENV_SMTP', 'ENV_SMTP_KEPT'].includes(c))

describe('hub gap watch: huddle and env mail on a shared target', () => {
  it('floor is 0.3.215', () => {
    expect(HUDDLE_MAIL_SINCE).toBe('0.3.215')
  })

  it('HUDDLE_TURN shows only for a target before 0.3.215 (or one the Hub cannot read)', () => {
    expect(warned(plan('0.3.214', '0.3.214'))).toContain('HUDDLE_TURN')
    expect(warned(plan('0.3.214', null))).toContain('HUDDLE_TURN')
    expect(warned(plan('0.3.214', '0.3.215-rc.1'))).toContain('HUDDLE_TURN')
    // the source's version does not matter: its saved settings live in its own database
    expect(warned(plan('0.3.214', '0.3.215'))).not.toContain('HUDDLE_TURN')
    expect(warned(plan('0.3.215', '0.4.0'))).not.toContain('HUDDLE_TURN')
  })

  it('ENV_SMTP becomes ENV_SMTP_KEPT only when both sides run 0.3.215 or later', () => {
    expect(warned(plan('0.3.214', '0.3.215'))).toEqual(['ENV_SMTP'])
    expect(warned(plan('0.3.215', '0.3.214'))).toEqual(['HUDDLE_TURN', 'ENV_SMTP'])
    expect(warned(plan('0.3.215', '0.3.215'))).toEqual(['ENV_SMTP_KEPT'])
    const p = plan('0.3.216', '0.3.216')
    expect(p.blockers).toEqual([])
    expect(p.warnings.find((w) => w.code === 'ENV_SMTP_KEPT')?.text).toMatch(
      /Settings → Email \(the password sealed with the app's key\)/
    )
  })

  it('keeps nothing when the app reports no env mail, or the move is not to shared', () => {
    const none = input({
      source: src({ version: '0.3.215', readiness: [] }),
      target_facts: tgt({ version: '0.3.215' })
    })
    expect(keepsEnvMail(none)).toBe(false)
    expect(warned(buildMovePlan(none))).toEqual([])
    const both = input({
      source: src({ version: '0.3.215', readiness: [smtp] }),
      target_facts: tgt({ version: '0.3.215' })
    })
    expect(keepsEnvMail(both)).toBe(true)
    expect(keepsEnvMail({ ...both, kind: 'to_dedicated' })).toBe(false)
  })
})
