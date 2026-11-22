import { describe, expect, it } from 'vitest'
import {
  isOverridable,
  openBlockers,
  overrideId,
  refusedPlanOf,
  runErrorText,
  type SharedUpgradePlan,
  stepStates,
  UPGRADE_COPY,
  upgradeCopy
} from './shared-upgrade-api'

const plan = (over: Partial<SharedUpgradePlan> = {}): SharedUpgradePlan => ({
  shared_id: 1,
  kind: 'upgrade',
  version: '0.4.0',
  from_version: '0.3.0',
  apps: [{ env_id: 12, tenant_id: 'a-e12', app: 'a', env: 'prod', blockers: ['ORDER', 'X'] }],
  blockers: [],
  warnings: [],
  plan_hash: 'h',
  ...over
})

describe('shared upgrade client (Task 5 contract)', () => {
  it('names an override CODE:env_id', () => {
    expect(overrideId({ env_id: 12 }, 'ORDER')).toBe('ORDER:12')
  })

  it('counts open blockers; only overridable codes clear with an override', () => {
    const p = plan()
    expect(openBlockers(p, new Set())).toBe(2)
    expect(openBlockers(p, new Set(['ORDER:12']))).toBe(1)
    expect(openBlockers(p, new Set(['ORDER:12', 'X:12']))).toBe(1)
    expect(isOverridable(plan({ overridable: ['ORDER'] }), 'PREFLIGHT_FAILING')).toBe(false)
    expect(isOverridable(plan(), 'PREFLIGHT_FAILING')).toBe(true)
  })

  it('reads the plan a PLAN_CHANGED / BLOCKED / APP_BLOCKED refusal carries, nothing else', () => {
    const p = plan()
    const err = (code: string) => ({ response: { status: 409, data: { code, plan: p } } })
    for (const code of ['PLAN_CHANGED', 'BLOCKED', 'APP_BLOCKED'])
      expect(refusedPlanOf(err(code))).toEqual({ code, plan: p })
    expect(refusedPlanOf(err('SHARED_BUSY'))).toBeNull()
    expect(refusedPlanOf(new Error('x'))).toBeNull()
  })

  it('has plain words with an action for every blocker and refusal Task 5 answers', () => {
    for (const code of [
      'SHARED_NOT_HUB_DEPLOYED',
      'BUSY',
      'VERSION_UNKNOWN',
      'AGENT_UNREACHABLE',
      'ORDER',
      'PREFLIGHT_FAILING',
      'HUB_URL_UNUSABLE',
      'AGENT_TOO_OLD',
      'REDIS_URL_MISSING',
      'REDIS_NOT_AVAILABLE',
      'SHARED_RETIRED',
      'BAD_VERSION',
      'NOT_DEPLOYED_BEFORE',
      'NO_DRIVER',
      'NO_STACK_NAME',
      'IMAGE_NOT_ALLOWED',
      'EXTENSION_NOT_ALLOWED',
      'EXTENSION_UNPINNED',
      'PATTERN_NOT_ALLOWED',
      'HOSTNAME_NOT_ALLOWED',
      'TOO_MANY_HOSTNAMES',
      'NO_ROUTE',
      'HOSTNAME_INVALID',
      'PUBLISH_PORT_NOT_ALLOWED',
      'PLAN_CHANGED',
      'BLOCKED',
      'APP_BLOCKED',
      'CONFIRM_MISMATCH',
      'BAD_PLAN_HASH',
      'BAD_OVERRIDES',
      'NOT_RUNNING'
    ]) {
      const c = UPGRADE_COPY[code]
      expect(c?.title, code).toBeTruthy()
      expect(c?.hint, code).toBeTruthy()
      // Setting names (HUB_URL, REDIS_URL) may be named; the code itself never is.
      expect(`${c?.title} ${c?.hint}`, code).not.toContain(code)
    }
  })

  it('drops the code in front of a run error, and never shows a code as copy', () => {
    expect(runErrorText('START_FAILED: The stack did not start.')).toBe('The stack did not start.')
    expect(runErrorText('acme-e7: migration failed')).toBe('acme-e7: migration failed')
    expect(upgradeCopy('SOMETHING_NEW').hint).toBeUndefined()
    expect(upgradeCopy('SOMETHING_NEW', 'Plain words.').title).toBe('Plain words.')
  })

  it('maps the run to step states', () => {
    expect(stepStates({ status: 'running', step: 'apply' })).toEqual([
      'done',
      'running',
      'pending',
      'pending',
      'pending'
    ])
    expect(stepStates({ status: 'failed', step: 'wait_schema' })[3]).toBe('failed')
    expect(stepStates({ status: 'success', step: 'verify' })).toEqual(Array(5).fill('done'))
  })
})
