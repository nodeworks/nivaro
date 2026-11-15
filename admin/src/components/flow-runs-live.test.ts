import { describe, expect, it } from 'vitest'
import {
  applyRunEvent,
  applyStepEvent,
  type LiveRuns,
  liveSummary,
  MAX_LIVE_RUNS
} from './flow-runs-live'

describe('flow run viewer live state (rt4 #16)', () => {
  it('lists steps under their run as they finish, then the run ends', () => {
    let s: LiveRuns = {}
    s = applyRunEvent(s, { run_id: 'r1', status: 'running' }, 1)
    expect(liveSummary(s)).toBe('Starting…')
    s = applyStepEvent(
      s,
      { run_id: 'r1', op: 'check', type: 'condition', status: 'resolve', ms: 3 },
      2
    )
    s = applyStepEvent(s, { run_id: 'r1', op: 'send', type: 'mail', status: 'reject', ms: 40 }, 3)
    expect(s.r1.steps.map((x) => x.op)).toEqual(['check', 'send'])
    expect(liveSummary(s)).toBe('send — failed')
    s = applyRunEvent(s, { run_id: 'r1', status: 'error', ms: 50 }, 4)
    expect(s.r1).toMatchObject({ status: 'error', ms: 50 })
    expect(s.r1.steps).toHaveLength(2)
    expect(liveSummary(s)).toBeNull()
  })

  it('a step before the start still lands; a late start never undoes the end', () => {
    let s: LiveRuns = applyStepEvent({}, { run_id: 'r2', op: 'a', status: 'resolve' }, 1)
    expect(s.r2.status).toBe('running')
    s = applyRunEvent(s, { run_id: 'r2', status: 'success', ms: 9 }, 2)
    s = applyRunEvent(s, { run_id: 'r2', status: 'running' }, 3)
    expect(s.r2.status).toBe('success')
  })

  it('ignores events without a run and keeps only the newest runs', () => {
    expect(applyStepEvent({}, { op: 'x' })).toEqual({})
    let s: LiveRuns = {}
    for (let i = 0; i < MAX_LIVE_RUNS + 5; i++) s = applyRunEvent(s, { run_id: `r${i}` }, i)
    expect(Object.keys(s)).toHaveLength(MAX_LIVE_RUNS)
    expect(s.r0).toBeUndefined()
    expect(s[`r${MAX_LIVE_RUNS + 4}`]).toBeDefined()
  })
})
