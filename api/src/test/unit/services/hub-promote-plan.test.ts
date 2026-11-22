import { describe, expect, it } from 'vitest'
import { buildPromotionPlan, compareVersions } from '../../../services/hub/promote-plan.js'
import type {
  HubComponent,
  HubEnvironmentRow,
  PlanInput,
  StackFacts
} from '../../../services/hub/promote-types.js'

const DIGEST = `sha256:${'a'.repeat(64)}`
const SLIM = `sha256:${'b'.repeat(64)}`

function env(over: Partial<HubEnvironmentRow>): HubEnvironmentRow {
  return {
    id: 2,
    app_id: 1,
    key: 'production',
    position: 2,
    status: 'active',
    base_url: 'https://efp.example.com',
    hostnames: [],
    placement_id: 5,
    version_pin: null,
    hub_token: null,
    hub_managed: true,
    ...over
  }
}

const apiComp: HubComponent = {
  id: 11,
  placement_id: 5,
  position: 1,
  name: 'api',
  kind: 'api',
  driver_id: 7,
  source_branch: 'main',
  target_branch: null,
  before_job: 'build_extension',
  deploy_job: null,
  verify_url: 'https://efp.example.com/api/version',
  verify_field: 'version'
}

const feComp: HubComponent = {
  id: 12,
  placement_id: 5,
  position: 2,
  name: 'frontend',
  kind: 'frontend',
  driver_id: 8,
  source_branch: 'main',
  target_branch: 'production',
  before_job: 'build_production',
  deploy_job: 'deploy_production',
  verify_url: 'https://efp.example.com/version.json',
  verify_field: 'version'
}

/** EFP production, shaped like promote-production.mjs: api on efp-nivaro, then the portal. */
function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    app: { id: 1, key: 'efp', name: 'EFP', signin_mode: 'direct', adopted: true, extensions: [] },
    target: env({}),
    previous: env({ id: 1, key: 'staging', position: 1, base_url: 'https://staging.example.com' }),
    components: [feComp, apiComp],
    kind: 'promote',
    version: '0.3.10',
    targetVersion: '0.3.9',
    previousVersion: '0.3.10',
    previousDeployedVersions: ['0.3.9', '0.3.10'],
    targetDeployedVersions: ['0.3.8', '0.3.9'],
    sources: { 1: { sha: 'c0ffee1234567890', subject: 'chore: deploy nivaro 0.3.10 to staging' } },
    frontendServed: { 2: 'abc1234' },
    frontendOnSource: { 2: true },
    sourceOnTarget: { 1: false },
    digest: DIGEST,
    slimDigest: SLIM,
    running: false,
    targetState: 'ok',
    drivers: {
      7: { branch: 'production', deploy_job: 'deploy_production', pin_file: 'NIVARO_VERSION' },
      8: { branch: 'main', deploy_job: 'deploy_main', pin_file: 'unused' }
    },
    ...over
  }
}

const codes = (p: ReturnType<typeof buildPromotionPlan>) => p.blockers.map((b) => b.code)

describe('hub promotion planner', () => {
  it('plans a clean EFP promotion: api then frontend, three-line pin', () => {
    const plan = buildPromotionPlan(input())
    expect(plan.ok).toBe(true)
    expect(plan.blockers).toEqual([])
    expect(plan.steps).toHaveLength(2)
    const [api, fe] = plan.steps
    expect(api).toMatchObject({
      position: 1,
      component: 'api',
      kind: 'api',
      sourceSha: 'c0ffee1234567890',
      targetBranch: 'production',
      beforeJob: 'build_extension',
      deployJob: 'deploy_production',
      verifyUrl: 'https://efp.example.com/api/version',
      want: '0.3.10',
      pinFile: 'NIVARO_VERSION',
      driverId: 7
    })
    expect(api.pinText).toBe(`0.3.10\n${DIGEST}\n${SLIM}\n`)
    expect(api.pinText?.split('\n').filter(Boolean)).toHaveLength(3)
    expect(fe).toMatchObject({
      position: 2,
      component: 'frontend',
      kind: 'frontend',
      sourceSha: 'abc1234',
      targetBranch: 'production',
      pinText: null,
      pinFile: null,
      beforeJob: 'build_production',
      deployJob: 'deploy_production',
      want: 'abc1234',
      driverId: 8
    })
    expect(plan.lines.some((l) => l.includes('c0ffee12'))).toBe(true)
  })

  it('pins two lines when the slim image has no digest', () => {
    const plan = buildPromotionPlan(input({ slimDigest: null }))
    expect(plan.ok).toBe(true)
    expect(plan.steps[0].pinText).toBe(`0.3.10\n${DIGEST}\n`)
  })

  it("names the target's current state as a line, never a blocker", () => {
    const plan = buildPromotionPlan(input({ targetState: 'degraded' }))
    expect(plan.ok).toBe(true)
    expect(plan.lines).toContain('production is currently Running with warnings (runs 0.3.9)')
    const down = buildPromotionPlan(input({ targetState: 'unreachable', targetVersion: null }))
    expect(down.ok).toBe(true)
    expect(down.lines.some((l) => l.startsWith('production is currently not answering'))).toBe(true)
  })

  it('prints a verify URL as origin + path, never its query string', () => {
    const plan = buildPromotionPlan(
      input({
        components: [{ ...apiComp, verify_url: 'https://efp.example.com/api/version?key=secret' }]
      })
    )
    expect(plan.lines).toContain(
      'api: verify https://efp.example.com/api/version answers version = 0.3.10 twice'
    )
    expect(plan.lines.join('\n')).not.toContain('secret')
  })

  it('compares versions numerically', () => {
    expect(compareVersions('0.3.10', '0.3.9')).toBeGreaterThan(0)
    expect(compareVersions('0.3.9', '0.3.10')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareVersions('0.3.9', '0.3.9')).toBe(0)
    // 0.3.10 over 0.3.9 is a promotion, not an older version
    expect(codes(buildPromotionPlan(input()))).not.toContain('OLDER_THAN_CURRENT')
  })

  describe('blockers', () => {
    it('NOT_HUB_MANAGED', () => {
      expect(codes(buildPromotionPlan(input({ target: env({ hub_managed: false }) })))).toEqual([
        'NOT_HUB_MANAGED'
      ])
    })

    it('PROMOTION_RUNNING', () => {
      expect(codes(buildPromotionPlan(input({ running: true })))).toEqual(['PROMOTION_RUNNING'])
    })

    it('NO_PREVIOUS_ENVIRONMENT on a promote into position 1', () => {
      const plan = buildPromotionPlan(input({ target: env({ position: 1 }), previous: null }))
      expect(codes(plan)).toEqual(['NO_PREVIOUS_ENVIRONMENT'])
      expect(plan.ok).toBe(false)
    })

    it('PREVIOUS_NEVER_RAN when the previous env neither runs nor deployed the version', () => {
      const plan = buildPromotionPlan(
        input({ previousVersion: '0.3.9', previousDeployedVersions: ['0.3.9'] })
      )
      expect(codes(plan)).toEqual(['PREVIOUS_NEVER_RAN'])
      // a past successful deploy is enough
      expect(
        codes(
          buildPromotionPlan(
            input({ previousVersion: '0.3.11', previousDeployedVersions: ['0.3.10'] })
          )
        )
      ).toEqual([])
    })

    it('ALREADY_RUNS only when the api source commit is already on the target branch', () => {
      // same version re-stamped (extension-only change): source not on target → allowed
      expect(
        codes(buildPromotionPlan(input({ targetVersion: '0.3.10', sourceOnTarget: { 1: false } })))
      ).toEqual([])
      // same version, source already on target → refused
      expect(
        codes(buildPromotionPlan(input({ targetVersion: '0.3.10', sourceOnTarget: { 1: true } })))
      ).toEqual(['ALREADY_RUNS'])
      // not known → refused
      expect(
        codes(buildPromotionPlan(input({ targetVersion: '0.3.10', sourceOnTarget: {} })))
      ).toEqual(['ALREADY_RUNS'])
      // rollback unchanged: the version it runs is always ALREADY_RUNS
      expect(
        codes(
          buildPromotionPlan(
            input({
              kind: 'rollback',
              version: '0.3.9',
              targetVersion: '0.3.9',
              previous: null,
              sourceOnTarget: { 1: false }
            })
          )
        )
      ).toEqual(['ALREADY_RUNS'])
    })

    it('OLDER_THAN_CURRENT on a promote of an older version', () => {
      const plan = buildPromotionPlan(input({ targetVersion: '0.3.11' }))
      expect(codes(plan)).toEqual(['OLDER_THAN_CURRENT'])
      expect(plan.blockers[0].text).toMatch(/roll back/i)
    })

    it('NOT_DEPLOYED_BEFORE on a rollback to a version never deployed here', () => {
      const ok = buildPromotionPlan(
        input({ kind: 'rollback', version: '0.3.8', targetVersion: '0.3.9', previous: null })
      )
      expect(codes(ok)).toEqual([])
      const plan = buildPromotionPlan(
        input({ kind: 'rollback', version: '0.3.7', targetVersion: '0.3.9', previous: null })
      )
      expect(codes(plan)).toEqual(['NOT_DEPLOYED_BEFORE'])
    })

    it('NO_SOURCE_COMMIT for an api component', () => {
      expect(codes(buildPromotionPlan(input({ sources: { 1: null } })))).toEqual([
        'NO_SOURCE_COMMIT'
      ])
    })

    it('FRONTEND_UNKNOWN when the previous env serves nothing readable', () => {
      expect(codes(buildPromotionPlan(input({ frontendServed: { 2: null } })))).toEqual([
        'FRONTEND_UNKNOWN'
      ])
    })

    it('FRONTEND_NOT_ON_SOURCE when the served commit is not on the source branch', () => {
      const plan = buildPromotionPlan(input({ frontendOnSource: { 2: false } }))
      expect(codes(plan)).toEqual(['FRONTEND_NOT_ON_SOURCE'])
      expect(plan.blockers[0].text).toBe('staging serves abc1234, which is not on main')
      // not known → refused
      expect(codes(buildPromotionPlan(input({ frontendOnSource: {} })))).toEqual([
        'FRONTEND_NOT_ON_SOURCE'
      ])
      // on the source branch → no blocker
      expect(codes(buildPromotionPlan(input({ frontendOnSource: { 2: true } })))).toEqual([])
    })

    it('IMAGE_MISSING', () => {
      expect(codes(buildPromotionPlan(input({ digest: null })))).toEqual(['IMAGE_MISSING'])
    })

    it('IMAGE_NO_DIGEST', () => {
      expect(codes(buildPromotionPlan(input({ digest: 'present' })))).toEqual(['IMAGE_NO_DIGEST'])
    })

    it('the image is not needed without an api component', () => {
      expect(codes(buildPromotionPlan(input({ components: [feComp], digest: null })))).toEqual([])
    })

    it('NO_COMPONENTS', () => {
      const plan = buildPromotionPlan(input({ components: [] }))
      expect(codes(plan)).toEqual(['NO_COMPONENTS'])
      expect(plan.steps).toEqual([])
    })

    it('BAD_VERSION', () => {
      const plan = buildPromotionPlan(input({ version: '0.3' }))
      expect(codes(plan)).toContain('BAD_VERSION')
      expect(codes(plan)).not.toContain('OLDER_THAN_CURRENT')
      expect(codes(buildPromotionPlan(input({ version: 'v0.3.10' })))).toContain('BAD_VERSION')
    })

    it('NO_DRIVER when a component names a driver the plan was not given', () => {
      expect(codes(buildPromotionPlan(input({ drivers: { 7: input().drivers[7] } })))).toEqual([
        'NO_DRIVER'
      ])
    })

    it('every blocker carries readable text', () => {
      const plan = buildPromotionPlan(
        input({
          running: true,
          digest: null,
          sources: { 1: null },
          target: env({ hub_managed: false })
        })
      )
      expect(plan.ok).toBe(false)
      for (const b of plan.blockers) expect(b.text.length).toBeGreaterThan(10)
    })
  })
})

// ---------------------------------------------------------------------------------------------
// phase 4: stack components (Docker placements through the Hub agent)

const EXT_PIN = `nodeworks/efp-ops@sha256:${'c'.repeat(64)}`

const stackComp: HubComponent = {
  id: null,
  placement_id: 9,
  position: 1,
  name: 'stack',
  kind: 'stack',
  driver_id: 20,
  source_branch: '',
  target_branch: null,
  before_job: null,
  deploy_job: null,
  verify_url: null,
  verify_field: 'version',
  implicit: true
}

function facts(over: Partial<StackFacts> = {}): StackFacts {
  return {
    stackName: 'acme-prod',
    agent: 'ok',
    imageAllowed: true,
    imageRepo: 'nodeworks/nivaro',
    disallowedExtensions: [],
    settingsMissing: [],
    hostnameProblems: [],
    hostnameTaken: [],
    edge: 'traefik',
    publishPortProblem: null,
    renderProblem: null,
    stackState: 'hub',
    size: 'medium',
    roles: [
      { role: 'web', replicas: 2, cpus: 2, memory_mb: 3072 },
      { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 }
    ],
    extensions: { 'efp-ops': EXT_PIN },
    extensionsUnreadable: null,
    missingExtensions: [],
    agentOrigin: 'https://agent.example.com',
    ...over
  }
}

const dockerDriver = (dns: 'automatic' | 'manual' = 'automatic') => ({
  kind: 'docker' as const,
  branch: '',
  deploy_job: '',
  pin_file: '',
  dns_mode: dns
})

/** acme: staging → production, both Docker stacks. */
function stackInput(over: Partial<PlanInput> = {}, f: Partial<StackFacts> = {}): PlanInput {
  return input({
    app: {
      id: 1,
      key: 'acme',
      name: 'Acme',
      signin_mode: 'direct',
      adopted: false,
      extensions: []
    },
    target: env({ base_url: 'https://acme.apps.example.com' }),
    previous: env({
      id: 1,
      key: 'staging',
      position: 1,
      base_url: 'https://acme-stg.apps.example.com'
    }),
    components: [stackComp],
    sources: {},
    frontendServed: {},
    frontendOnSource: {},
    sourceOnTarget: {},
    drivers: { 20: dockerDriver() },
    stacks: { 1: facts(f) },
    ...over
  })
}

describe('hub promotion planner — stack components (phase 4)', () => {
  it('plans a clean docker promotion as one docker step', () => {
    const plan = buildPromotionPlan(stackInput())
    expect(plan.blockers).toEqual([])
    expect(plan.ok).toBe(true)
    expect(plan.steps).toEqual([
      {
        position: 1,
        component: 'stack',
        kind: 'stack',
        driverId: 20,
        driver: 'docker',
        sourceSha: null,
        targetBranch: '',
        pinText: null,
        pinFile: null,
        beforeJob: null,
        deployJob: '',
        verifyUrl: 'https://acme.apps.example.com/api/version',
        verifyField: 'version',
        want: '0.3.10',
        stack: {
          name: 'acme-prod',
          image: `nodeworks/nivaro@${DIGEST}`,
          size: 'medium',
          extensions: { 'efp-ops': EXT_PIN },
          agentOrigin: 'https://agent.example.com'
        }
      }
    ])
    expect(plan.lines).toContain(
      `stack acme-prod: deploy nivaro 0.3.10 (${DIGEST.slice(0, 19)}…) as medium: web ×2, worker ×1 through the agent at https://agent.example.com`
    )
    expect(plan.lines).toContain(`extension efp-ops: nodeworks/efp-ops@${'c'.repeat(12)}`)
    expect(plan.lines).toContain(
      'stack acme-prod: verify https://acme.apps.example.com/api/version answers version = 0.3.10 twice, then the preflight must not fail'
    )
    // No GitLab merge / job lines for a stack.
    expect(plan.lines.some((l) => l.includes('merge') || l.includes('run ?'))).toBe(false)
    expect(plan.lines.some((l) => l.includes('waiting for the name'))).toBe(false)
  })

  it('a manual-DNS driver says the name may not serve yet', () => {
    const plan = buildPromotionPlan(stackInput({ drivers: { 20: dockerDriver('manual') } }))
    expect(plan.ok).toBe(true)
    expect(plan.lines).toContain(
      'the name may not serve yet — the deploy then ends waiting for the name'
    )
  })

  it('the first environment of an all-stack app takes a published release (Decision 11)', () => {
    const first = (over: Partial<PlanInput>) =>
      buildPromotionPlan(
        stackInput({
          previous: null,
          previousVersion: null,
          previousDeployedVersions: [],
          registryVersions: ['0.3.11', '0.3.10', '0.3.9'],
          ...over
        })
      )
    const ok = first({})
    expect(ok.blockers).toEqual([])
    expect(ok.steps).toHaveLength(1)
    expect(ok.steps[0].driver).toBe('docker')
    // Not a published release: IMAGE_MISSING, never NO_PREVIOUS_ENVIRONMENT / PREVIOUS_NEVER_RAN.
    expect(codes(first({ registryVersions: ['0.3.9'] }))).toEqual(['IMAGE_MISSING'])
    expect(codes(first({ registryVersions: undefined }))).toEqual(['IMAGE_MISSING'])
    // A tag with no real digest is refused like phase 2's pin.
    expect(codes(first({ digest: 'present' }))).toEqual(['IMAGE_NO_DIGEST'])
    expect(codes(first({ digest: null }))).toEqual(['IMAGE_MISSING'])
  })

  it('a docker environment after another one needs the previous environment to have run it', () => {
    const plan = buildPromotionPlan(
      stackInput({ previousVersion: '0.3.9', previousDeployedVersions: ['0.3.9'] })
    )
    expect(codes(plan)).toEqual(['PREVIOUS_NEVER_RAN'])
  })

  it('the image digest is needed for a stack: IMAGE_MISSING / IMAGE_NO_DIGEST', () => {
    expect(codes(buildPromotionPlan(stackInput({ digest: null })))).toEqual(['IMAGE_MISSING'])
    expect(codes(buildPromotionPlan(stackInput({ digest: 'present' })))).toEqual([
      'IMAGE_NO_DIGEST'
    ])
  })

  it('a first environment that is not all-stack keeps NO_PREVIOUS_ENVIRONMENT', () => {
    const plan = buildPromotionPlan(
      input({ previous: null, previousVersion: null, registryVersions: ['0.3.10'] })
    )
    expect(codes(plan)).toEqual(['NO_PREVIOUS_ENVIRONMENT'])
  })

  const one = (f: Partial<StackFacts>, over: Partial<PlanInput> = {}) =>
    codes(buildPromotionPlan(stackInput(over, f)))

  it.each([
    [{ agent: 'unreachable' as const }, 'AGENT_UNREACHABLE'],
    [{ agent: 'refused' as const }, 'AGENT_REFUSED'],
    [{ agent: 'incompatible' as const }, 'AGENT_INCOMPATIBLE'],
    [{ imageAllowed: false }, 'IMAGE_NOT_ALLOWED'],
    [{ disallowedExtensions: ['efp-ops'] }, 'EXTENSION_NOT_ALLOWED'],
    [{ missingExtensions: ['efp-ops'] }, 'EXTENSION_UNPINNED'],
    [{ settingsMissing: ['DB_HOST', 'DB_PASSWORD'] }, 'STACK_SETTINGS_MISSING'],
    [{ settingsMissing: ['(no settings)'] }, 'STACK_SETTINGS_MISSING'],
    [
      { hostnameProblems: ['x.example.org is outside the agent’s domains'] },
      'HOSTNAME_NOT_ALLOWED'
    ],
    [{ hostnameTaken: ['acme.apps.example.com already belongs to another'] }, 'HOSTNAME_TAKEN'],
    [{ publishPortProblem: 'publish_port 9000 is outside 8000–8010' }, 'PUBLISH_PORT_NOT_ALLOWED'],
    [{ renderProblem: { code: 'TEMPLATE_NONE', text: 'No stack template' } }, 'TEMPLATE_NONE'],
    [{ renderProblem: { code: 'ENV_SECRET_CLASH', text: 'clash' } }, 'STACK_SETTINGS_INVALID'],
    [{ stackState: 'not_hub' as const }, 'STACK_NOT_HUB'],
    [{ stackState: 'other_owner' as const }, 'STACK_NOT_HUB'],
    [{ stackName: null }, 'NO_STACK_NAME']
  ])('%o → %s', (f, code) => {
    expect(one(f)).toEqual([code])
  })

  it('fix 1: unreadable stored pins are EXTENSION_UNPINNED with the reason', () => {
    const plan = buildPromotionPlan(
      stackInput(
        { kind: 'rollback', version: '0.3.8' },
        {
          extensions: {},
          extensionsUnreadable: "the stored plan of the 0.3.8 deploy can't be read"
        }
      )
    )
    expect(plan.blockers).toEqual([
      { code: 'EXTENSION_UNPINNED', text: "the stored plan of the 0.3.8 deploy can't be read" }
    ])
  })

  it('fix 1: agent ok but the stack state unknown is a warning line, not a blocker', () => {
    const plan = buildPromotionPlan(stackInput({}, { stackState: 'unknown' }))
    expect(plan.ok).toBe(true)
    expect(plan.lines).toContain(
      'stack acme-prod: the agent could not say what runs under this name now — the deploy may be refused'
    )
  })

  it('fix 1: a stack not gathered because the version is bad says BAD_VERSION only', () => {
    expect(codes(buildPromotionPlan(stackInput({ version: '', stacks: {} })))).toEqual([
      'BAD_VERSION'
    ])
  })

  it('an unreachable agent hides the checks only the agent can answer', () => {
    expect(
      one({ agent: 'unreachable', imageAllowed: false, stackState: 'unknown', settingsMissing: [] })
    ).toEqual(['AGENT_UNREACHABLE'])
  })

  it('names the missing settings — names only', () => {
    const plan = buildPromotionPlan(stackInput({}, { settingsMissing: ['DB_HOST', 'DB_PASSWORD'] }))
    expect(plan.blockers[0].text).toBe(
      "production's stack settings are missing DB_HOST, DB_PASSWORD"
    )
  })

  it('KIND_DRIVER_MISMATCH: a stack on a GitLab driver, an api on a Docker one', () => {
    const stackOnGitlab = buildPromotionPlan(
      stackInput({
        drivers: { 20: { branch: 'production', deploy_job: 'deploy', pin_file: 'PIN' } }
      })
    )
    expect(codes(stackOnGitlab)).toEqual(['KIND_DRIVER_MISMATCH'])
    const apiOnDocker = buildPromotionPlan(
      input({ drivers: { 7: dockerDriver(), 8: input().drivers[8] } })
    )
    expect(codes(apiOnDocker)).toContain('KIND_DRIVER_MISMATCH')
  })

  it('a stack the agent was not asked about is not deployable', () => {
    expect(codes(buildPromotionPlan(stackInput({ stacks: {} })))).toEqual(['AGENT_UNREACHABLE'])
  })

  it('rollback of a docker environment needs a successful deploy of that version there', () => {
    const back = (over: Partial<PlanInput>) =>
      buildPromotionPlan(stackInput({ kind: 'rollback', version: '0.3.8', ...over }))
    expect(back({}).blockers).toEqual([])
    expect(back({}).steps[0].stack?.extensions).toEqual({ 'efp-ops': EXT_PIN })
    expect(codes(back({ targetDeployedVersions: ['0.3.9'] }))).toEqual(['NOT_DEPLOYED_BEFORE'])
  })

  it('a phase-2 plan carries no docker fields', () => {
    const plan = buildPromotionPlan(input())
    for (const s of plan.steps) {
      expect(s.driver).toBeUndefined()
      expect(s.stack).toBeUndefined()
    }
  })
})
