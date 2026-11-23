import { describe, expect, it } from 'vitest'
import { heldByPlan, logLineWords, restatesTitle, UPGRADE_COPY } from './shared-upgrade-api'

// Design review P6-29 (S6, S7, S8): the run log in plain words, one clear sentence per planner
// row, and an app a plan-wide BUSY holds is not "Ready".

describe('S6: run log lines in plain words', () => {
  it('a stop line loses its code; a step key becomes the step name', () => {
    expect(
      logLineWords('failed: SWARM_ROLLED_BACK: Swarm rolled shared-east back to its previous spec.')
    ).toBe('Failed: Swarm rolled shared-east back to its previous spec.')
    expect(logLineWords('cancelled: CANCELLED: Cancelled. The pins are unchanged.')).toBe(
      'Cancelled: Cancelled. The pins are unchanged.'
    )
    expect(logLineWords('render: shared-east at 0.3.208')).toBe(
      'Write the stack: shared-east at 0.3.208'
    )
    expect(logLineWords('wait_version: 2 of 3 replicas run 0.3.208')).toBe(
      'Every replica runs the version: 2 of 3 replicas run 0.3.208'
    )
    // Lines the run writes in words already stay as they are.
    expect(logLineWords('3. waiting for every replica to run 0.3.208 (≤ 30 min)')).toBe(
      '3. waiting for every replica to run 0.3.208 (≤ 30 min)'
    )
  })
})

describe('S7: one clear sentence per planner row', () => {
  it('drops a planner sentence that only restates the title, keeps one that adds a name', () => {
    expect(restatesTitle('The Hub agent did not answer', 'The Hub agent does not answer.')).toBe(
      true
    )
    expect(restatesTitle('The Hub agent did not answer', 'The agent did not answer.')).toBe(true)
    expect(
      restatesTitle(
        'Something else holds this deployment or one of its apps',
        'acme/prod: a promotion holds this environment.'
      )
    ).toBe(false)
  })

  it("BUSY's hint does not name a holder the planner's sentence may contradict", () => {
    expect(UPGRADE_COPY.BUSY.hint).toBe('Wait for it to finish, then plan again.')
  })
})

describe('S8: an app a plan-wide BUSY holds', () => {
  it('is found by its app/env prefix in the BUSY or LOCK_UNAVAILABLE sentence', () => {
    const blockers = [
      { code: 'BUSY', text: 'beta/uat: a move holds this environment.' },
      {
        code: 'LOCK_UNAVAILABLE',
        text: 'The Hub could not read the lock of beta/prod — try again.'
      },
      { code: 'BUSY', text: 'The shared deployment is held by an upgrade.' }
    ]
    expect(heldByPlan(blockers, { app: 'beta', env: 'uat' })).toBe(true)
    expect(heldByPlan(blockers, { app: 'beta', env: 'prod' })).toBe(true)
    expect(heldByPlan(blockers, { app: 'beta', env: 'dev' })).toBe(false)
    // Not a prefix of a longer key.
    expect(heldByPlan(blockers, { app: 'beta', env: 'u' })).toBe(false)
  })
})
