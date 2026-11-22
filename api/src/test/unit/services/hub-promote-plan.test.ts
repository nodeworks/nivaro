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
    expect(plan.lines.some((l) => l.includes('c0ffee1'))).toBe(true)
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
      'API: check that https://efp.example.com/api/version reports 0.3.10 twice in a row'
    )
    expect(plan.lines.join('\n')).not.toContain('secret')
  })

  it('writes the steps in plain words on a clean plan', () => {
    const lines = buildPromotionPlan(input()).lines
    expect(lines).toContain('Image 0.3.10 is on Docker Hub (both builds)')
    expect(lines).toContain('API: release commit c0ffee1 (chore: deploy nivaro 0.3.10 to staging)')
    expect(lines).toContain('API: merge it into production and record 0.3.10 as the version to run')
    expect(lines).toContain(
      'API: wait for build_extension, then run the production deploy job and wait for it'
    )
    expect(lines.some((l) => l.startsWith('Frontend: after the API deploy passes,'))).toBe(true)
    expect(lines.at(-1)).toBe(
      "The deploy jobs run their own health checks; production's current status does not stop a promotion"
    )
    expect(buildPromotionPlan(input({ slimDigest: null })).lines).toContain(
      'Image 0.3.10 is on Docker Hub'
    )
  })

  it('a refused plan lists facts only, with no step lines or ? gaps', () => {
    const plan = buildPromotionPlan(input({ sources: { 1: null }, frontendServed: { 2: null } }))
    expect(plan.ok).toBe(false)
    const text = plan.lines.join('\n')
    expect(text).not.toContain('?')
    expect(text).not.toMatch(/merge|deploy job|check that/)
    expect(plan.lines).toContain('API: no release commit on main names nivaro 0.3.10')
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
      // Every component of this version deployed here through the Hub.
      const done = { 1: ['f00d'], 2: ['abc1234'] }
      // same version re-stamped (extension-only change): source not on target → allowed
      expect(
        codes(
          buildPromotionPlan(
            input({ targetVersion: '0.3.10', sourceOnTarget: { 1: false }, recordedDeploys: done })
          )
        )
      ).toEqual([])
      // same version, source already on target → refused
      expect(
        codes(
          buildPromotionPlan(
            input({ targetVersion: '0.3.10', sourceOnTarget: { 1: true }, recordedDeploys: done })
          )
        )
      ).toEqual(['ALREADY_RUNS'])
      // not known → refused
      expect(
        codes(
          buildPromotionPlan(
            input({ targetVersion: '0.3.10', sourceOnTarget: {}, recordedDeploys: done })
          )
        )
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

    it('B5: a promotion stopped between components can be finished', () => {
      const pin = `0.3.10\n${DIGEST}\n${SLIM}\n`
      const same = {
        targetVersion: '0.3.10',
        sourceOnTarget: { 1: true },
        pinOnTarget: { 1: pin }
      }
      // The api deployed (recorded), the portal never did: not ALREADY_RUNS; the api has nothing to do.
      const plan = buildPromotionPlan(input({ ...same, recordedDeploys: { 1: ['f00d'] } }))
      expect(codes(plan)).toEqual([])
      const apiStep = plan.steps.find((st) => st.kind === 'api')
      const feStep = plan.steps.find((st) => st.kind === 'frontend')
      expect(apiStep?.noop).toBe(true)
      expect(feStep?.noop).toBeUndefined()
      expect(plan.lines).toContain(
        'API: production already holds the release commit and pins 0.3.10 — nothing to do'
      )
      expect(plan.lines.some((l) => l.startsWith('API: wait for'))).toBe(false)
      expect(plan.lines).toContain(
        'Frontend: wait for build_production, then run the production deploy job and wait for it'
      )
      // Both recorded, but the portal serves something else than either commit: still unfinished.
      const done = { 1: ['f00d'], 2: ['abc1234'] }
      expect(
        codes(
          buildPromotionPlan(
            input({ ...same, recordedDeploys: done, frontendOnTarget: { 2: 'dddddddd' } })
          )
        )
      ).toEqual([])
      // Serving the recorded deploy (a merge commit) or the planned commit: finished.
      for (const served of ['abc1234', 'abc12345'])
        expect(
          codes(
            buildPromotionPlan(
              input({ ...same, recordedDeploys: done, frontendOnTarget: { 2: served } })
            )
          )
        ).toEqual(['ALREADY_RUNS'])
      // A pin that differs is not a no-op (the pin commit lands, the api deploys).
      const other = buildPromotionPlan(
        input({ ...same, pinOnTarget: { 1: '0.3.10\n' }, recordedDeploys: { 1: ['f00d'] } })
      )
      expect(other.steps.find((st) => st.kind === 'api')?.noop).toBeUndefined()
      // A version the target does not answer yet is never a no-op (a deploy is still owed).
      const owed = buildPromotionPlan(input({ ...same, targetVersion: '0.3.9' }))
      expect(owed.steps.find((st) => st.kind === 'api')?.noop).toBeUndefined()
      expect(owed.lines).toContain(
        'API: production already holds the release commit — record 0.3.10 as the version to run'
      )
    })

    it('PIN_CHANGED: a same-version run never rewrites the pin of the running version', () => {
      const OLD = `sha256:${'c'.repeat(64)}`
      const plan = buildPromotionPlan(
        input({
          targetVersion: '0.3.10',
          sourceOnTarget: { 1: true },
          pinOnTarget: { 1: `0.3.10\n${OLD}\n` },
          recordedDeploys: { 1: ['f00d'] }
        })
      )
      expect(codes(plan)).toEqual(['PIN_CHANGED'])
      expect(plan.blockers[0].text).toBe(
        'api: the image for 0.3.10 changed since it was deployed — production pins 0.3.10 image cccccccccccc, the registry now has 0.3.10 image aaaaaaaaaaaa, slim image bbbbbbbbbbbb. The Hub never rewrites the pin of the version that is running'
      )
      // An identical pin stays a no-op; a pin of another version is a normal promotion.
      const same = buildPromotionPlan(
        input({
          targetVersion: '0.3.10',
          sourceOnTarget: { 1: true },
          pinOnTarget: { 1: `0.3.10\n${DIGEST}\n${SLIM}\n` },
          recordedDeploys: { 1: ['f00d'] }
        })
      )
      expect(codes(same)).toEqual([])
      expect(same.steps.find((st) => st.kind === 'api')?.noop).toBe(true)
      expect(codes(buildPromotionPlan(input({ pinOnTarget: { 1: `0.3.9\n${OLD}\n` } })))).toEqual(
        []
      )
    })

    it('a held frontend names the head it will deploy', () => {
      const plan = buildPromotionPlan(
        input({ frontendHeld: { 2: true }, frontendHead: { 2: 'feed00112233' } })
      )
      expect(plan.steps.find((st) => st.kind === 'frontend')?.expectHead).toBe('feed00112233')
      expect(plan.lines).toContain(
        "Frontend: production already holds abc1234 — deploy production's current head feed001"
      )
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
