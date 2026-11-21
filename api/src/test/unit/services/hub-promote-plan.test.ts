import { describe, expect, it } from 'vitest'
import { buildPromotionPlan, compareVersions } from '../../../services/hub/promote-plan.js'
import type {
  HubComponent,
  HubEnvironmentRow,
  PlanInput
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

    it('ALREADY_RUNS', () => {
      expect(codes(buildPromotionPlan(input({ targetVersion: '0.3.10' })))).toEqual([
        'ALREADY_RUNS'
      ])
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
