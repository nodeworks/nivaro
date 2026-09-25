import { describe, expect, it } from 'vitest'
import {
  bumpOf,
  formatDuration,
  interruptionLine,
  outcomeSentence,
  runDuration,
  stageStates
} from './release-card'

describe('stageStates', () => {
  it('walks start → progress → ok, and a fail keeps its detail', () => {
    const s = stageStates([
      { stage: 'preflight', status: 'start', at: 'a' },
      { stage: 'preflight', status: 'ok', at: 'b' },
      { stage: 'artifacts', status: 'start', at: 'c' },
      { stage: 'artifacts', status: 'progress', detail: 'image — not yet (2/30)', at: 'd' },
      { stage: 'artifacts', status: 'fail', detail: 'image never became true', at: 'e' },
      { stage: 'frontends', status: 'skip', detail: 'nothing to pin', at: 'f' }
    ])
    expect(s.preflight.status).toBe('ok')
    expect(s.artifacts).toEqual({ status: 'failed', detail: 'image never became true' })
    expect(s.frontends.status).toBe('skipped')
    expect(s.verify.status).toBe('pending')
  })
})

describe('stageStates for an interrupted run', () => {
  const events = [
    { stage: 'preflight' as const, status: 'start' as const, at: 'a' },
    { stage: 'preflight' as const, status: 'ok' as const, at: 'b' },
    { stage: 'artifacts' as const, status: 'start' as const, at: 'c' }
  ]
  it('a cancelled run marks the stage it was in as cancelled, not running', () => {
    const s = stageStates(events, 'cancelled')
    expect(s.artifacts.status).toBe('cancelled')
    expect(s.preflight.status).toBe('ok')
    expect(stageStates(events, 'running').artifacts.status).toBe('running')
  })
  it('says a stage past publish may already have pushed', () => {
    expect(interruptionLine('cancelled', 'artifacts')).toBe(
      'Cancelled during artifacts — artifacts may already have pushed'
    )
    expect(interruptionLine('cancelled', 'release')).toBe('Cancelled during release')
    expect(interruptionLine('lost', 'verify')).toBe('Process ended without a result during verify')
    expect(interruptionLine('done', null)).toBeNull()
  })
})

describe('outcomeSentence', () => {
  const plan = {
    commits: 1,
    files: 1,
    last_tag: 'v0.1.340',
    sdk_changed: false,
    react_changed: true,
    migrations: [],
    dirty: [],
    versions: { app: '0.1.340', react: '0.1.291', sdk: '0.1.11' },
    lines: []
  }
  it('names the next versions for a patch', () => {
    expect(outcomeSentence(plan, 'patch')).toBe(
      'Cut nivaro 0.1.341 and react 0.1.292, push the mirror, then verify.'
    )
  })
  it('leaves react out when nothing shared changed', () => {
    expect(outcomeSentence({ ...plan, react_changed: false }, 'minor')).toBe(
      'Cut nivaro 0.2.0, push the mirror, then verify.'
    )
  })
  it('names the frontends and deployments the plan carries, and reuses a HEAD tag', () => {
    expect(
      outcomeSentence(
        { ...plan, head_tag: 'v0.1.341', frontends: ['web', 'portal'], deployments: ['stage'] },
        'patch'
      )
    ).toBe(
      'Reuse v0.1.341 (already tagged), push the mirror, bump and push web, portal, deploy stage, then verify.'
    )
  })
})

describe('formatDuration', () => {
  it('reads seconds, minutes and hours', () => {
    expect(formatDuration(42_400)).toBe('42s')
    expect(formatDuration(3 * 60_000 + 7_000)).toBe('3m 7s')
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000 + 30_000)).toBe('2h 5m')
    expect(formatDuration(-5)).toBe('0s')
  })
})

describe('runDuration and bumpOf', () => {
  const base = {
    id: 'r',
    mode: 'go' as const,
    args: ['--go', '--events', '--bump', 'minor'],
    started_at: '2026-09-24T10:00:00.000Z',
    started_by: 'u'
  }
  it('uses finished_at, elapsed while running, and a dash otherwise', () => {
    const now = Date.parse('2026-09-24T10:05:00.000Z')
    expect(
      runDuration({ ...base, state: 'done', finished_at: '2026-09-24T10:01:30.000Z' }, now)
    ).toBe('1m 30s')
    expect(runDuration({ ...base, state: 'running' }, now)).toBe('5m 0s')
    expect(runDuration({ ...base, state: 'lost' }, now)).toBe('—')
  })
  it('a resume repeats the failed run own bump', () => {
    expect(bumpOf({ ...base, state: 'failed' })).toBe('minor')
    expect(bumpOf({ ...base, args: ['--go'], state: 'failed' })).toBe('patch')
  })
})
