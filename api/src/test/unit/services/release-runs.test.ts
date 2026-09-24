import { describe, expect, it } from 'vitest'
import {
  deriveState,
  markerOutcome,
  parseEvents,
  type RunRecord,
  readLogChunk,
  validateStartBody
} from '../../../services/release-runs.js'

const rec: RunRecord = {
  id: 'r1',
  mode: 'go',
  args: ['--go', '--events'],
  pid: 4242,
  started_at: '2026-09-24T20:00:00.000Z',
  started_by: 'user-1'
}

describe('parseEvents', () => {
  it('reads @@event and @@plan lines and ignores everything else', () => {
    const log = [
      'release-chain — 3 commit(s)',
      '@@plan {"commits":3,"lines":[]}',
      '@@event {"stage":"preflight","status":"start","at":"2026-09-24T20:00:01.000Z"}',
      '20:00:02  typecheck api',
      '@@event {"stage":"preflight","status":"ok","at":"2026-09-24T20:00:30.000Z"}',
      '@@event not json'
    ].join('\n')
    const r = parseEvents(log)
    expect(r.plan).toEqual({ commits: 3, lines: [] })
    expect(r.events.map((e) => `${e.stage}:${e.status}`)).toEqual([
      'preflight:start',
      'preflight:ok'
    ])
  })
})

describe('markerOutcome', () => {
  it('reads DONE with the version', () => {
    expect(markerOutcome('x\n### DONE — nivaro 0.1.341\n')).toEqual({
      outcome: 'done',
      version: '0.1.341'
    })
  })
  it('reads FAILED with the stage', () => {
    expect(markerOutcome('### FAILED at artifacts: image never became true\n')).toEqual({
      outcome: 'failed',
      failed_stage: 'artifacts'
    })
  })
  it('is null with no marker', () => {
    expect(markerOutcome('still going')).toBeNull()
  })
})

describe('deriveState', () => {
  it('alive pid is running regardless of the log', () => {
    expect(deriveState(rec, true, '### DONE — nivaro 0.1.341').state).toBe('running')
  })
  it('dead pid with DONE is done and carries the version', () => {
    const s = deriveState(rec, false, '### DONE — nivaro 0.1.341')
    expect(s.state).toBe('done')
    expect(s.version).toBe('0.1.341')
  })
  it('dead pid with FAILED is failed at that stage', () => {
    const s = deriveState(rec, false, '### FAILED at frontends: boom')
    expect(s.state).toBe('failed')
    expect(s.failed_stage).toBe('frontends')
  })
  it('dead pid with no marker is lost', () => {
    expect(deriveState(rec, false, 'partial output').state).toBe('lost')
  })
  it('a recorded cancelled outcome wins over the log', () => {
    expect(
      deriveState({ ...rec, outcome: 'cancelled' }, false, '### DONE — nivaro 0.1.341').state
    ).toBe('cancelled')
  })
})

describe('validateStartBody', () => {
  it('accepts the enum inputs and builds the fixed argument list', () => {
    const r = validateStartBody({ bump: 'minor', from: 'frontends', with_sdk: true })
    expect(r).toEqual({
      ok: true,
      args: ['--go', '--events', '--bump', 'minor', '--from', 'frontends', '--with-sdk']
    })
  })
  it('defaults to a patch bump', () => {
    expect(validateStartBody({})).toEqual({
      ok: true,
      args: ['--go', '--events', '--bump', 'patch']
    })
  })
  it('rejects anything outside the enums', () => {
    expect(validateStartBody({ bump: 'major; rm -rf /' }).ok).toBe(false)
    expect(validateStartBody({ from: 'nowhere' }).ok).toBe(false)
    expect(validateStartBody({ with_sdk: 'yes' }).ok).toBe(false)
  })
})

describe('readLogChunk', () => {
  it('returns the tail after the offset', () => {
    expect(readLogChunk('abcdef', 3)).toEqual({ chunk: 'def', next_offset: 6 })
  })
  it('an offset past the end returns from the start (log was recreated)', () => {
    expect(readLogChunk('abc', 10)).toEqual({ chunk: 'abc', next_offset: 3 })
  })
})
