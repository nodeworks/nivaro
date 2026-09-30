import { describe, expect, it } from 'vitest'
import {
  deriveRunbookState,
  dryRunGate,
  markerOf,
  parseRunbookLog,
  type RunbookRecord,
  type RunbookSummary,
  stepStates,
  validateTarget
} from '../../../services/runbook-runs.js'

const rec: RunbookRecord = {
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  extension: 'x',
  runbook: 'golive',
  mode: 'go',
  target: 'EFP_Staging',
  args: ['extensions/x/scripts/run.ts'],
  pid: 1,
  started_at: '2026-09-30T10:00:00Z',
  started_by: 'u'
}

describe('runbook runs', () => {
  it('reads the step list and events, and builds the track in order', () => {
    const log = [
      '@@steps ["a","b","c"]',
      '@@event {"step":"a","status":"start","at":"t1"}',
      'noise',
      '@@event {"step":"a","status":"ok","at":"t2","secs":4,"lines":["3 rows"]}',
      '@@event {"step":"b","status":"start","at":"t3"}'
    ].join('\n')
    const { steps, events } = parseRunbookLog(log)
    expect(steps).toEqual(['a', 'b', 'c'])
    const track = stepStates(steps, events, 'running')
    expect(track.map((s) => s.status)).toEqual(['ok', 'running', 'pending'])
    expect(track[0]).toMatchObject({ secs: 4, lines: ['3 rows'] })
    // A vanished process leaves the running step cancelled, never running forever.
    expect(stepStates(steps, events, 'lost')[1].status).toBe('cancelled')
  })

  it('derives the outcome from the markers', () => {
    expect(markerOf('x\n### DONE — conversions complete\n')).toEqual({
      outcome: 'done',
      summary: 'conversions complete'
    })
    expect(markerOf('### FAILED at forecast-new-model: exited 1')).toMatchObject({
      outcome: 'failed',
      failed_step: 'forecast-new-model',
      summary: 'exited 1'
    })
    expect(deriveRunbookState(rec, true, '').state).toBe('running')
    expect(deriveRunbookState(rec, false, '').state).toBe('lost')
    expect(deriveRunbookState({ ...rec, outcome: 'cancelled' }, true, '').state).toBe('cancelled')
  })

  it('a real run needs a finished dry run of the same target from the last day', () => {
    const now = Date.parse('2026-09-30T12:00:00Z')
    const dry = (over: Partial<RunbookSummary>): RunbookSummary => ({
      ...rec,
      mode: 'dry',
      state: 'done',
      finished_at: '2026-09-30T11:00:00Z',
      ...over
    })
    expect(dryRunGate([dry({})], 'x', 'golive', 'EFP_Staging', now)).not.toBeNull()
    expect(dryRunGate([dry({ target: 'EFP_Verify' })], 'x', 'golive', 'EFP_Staging', now)).toBeNull()
    expect(dryRunGate([dry({ state: 'failed' })], 'x', 'golive', 'EFP_Staging', now)).toBeNull()
    expect(
      dryRunGate([dry({ finished_at: '2026-09-29T10:00:00Z' })], 'x', 'golive', 'EFP_Staging', now)
    ).toBeNull()
  })

  it('refuses a target the runbook refuses, and odd names', () => {
    const decl = {
      key: 'golive',
      label: 'g',
      script: 'extensions/x/s.ts',
      dry_args: [],
      go_args: [],
      target_env: 'DB_DATABASE',
      refuse_targets: ['EFP_Development']
    }
    expect(validateTarget(decl, 'efp_development').ok).toBe(false)
    expect(validateTarget(decl, 'EFP;DROP').ok).toBe(false)
    expect(validateTarget(decl, 'EFP_Staging')).toEqual({ ok: true, target: 'EFP_Staging' })
    expect(validateTarget({ ...decl, target_env: undefined }, undefined)).toEqual({ ok: true, target: null })
  })
})
