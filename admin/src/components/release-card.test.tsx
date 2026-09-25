import { describe, expect, it } from 'vitest'
import { outcomeSentence, stageStates } from './release-card'

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
      'Cut nivaro 0.1.341 and react 0.1.292, push the mirror, bump and push the frontends, deploy and verify staging.'
    )
  })
  it('leaves react out when nothing shared changed', () => {
    expect(outcomeSentence({ ...plan, react_changed: false }, 'minor')).toBe(
      'Cut nivaro 0.2.0, push the mirror, bump and push the frontends, deploy and verify staging.'
    )
  })
})
