import { describe, expect, it } from 'vitest'
import { type AiStreamStep, applyStepStatus } from './ai-steps'

// #1839: the tool steps above a streamed answer — a start line per tool,
// completed in place by the matching `done` event.

function run(events: Array<Record<string, unknown>>): AiStreamStep[] {
  return events.reduce<AiStreamStep[]>((acc, e) => applyStepStatus(acc, e), [])
}

describe('applyStepStatus', () => {
  it('pairs a start with its done by round + step and keeps the result', () => {
    const steps = run([
      { text: 'Reading workflows…', round: 0, step: 0, tool: 'query_items' },
      { text: 'Counting lines…', round: 0, step: 1, tool: 'aggregate' },
      { text: 'Reading workflows…', round: 0, step: 0, done: true, result: '42 found' },
      { text: 'Counting lines…', round: 0, step: 1, done: true, failed: true }
    ])
    expect(steps.map((s) => [s.text, s.state, s.result])).toEqual([
      ['Reading workflows…', 'done', '42 found'],
      ['Counting lines…', 'failed', undefined]
    ])
  })

  it('keeps steps of later rounds apart from earlier ones', () => {
    const steps = run([
      { text: 'Reading workflows…', round: 0, step: 0 },
      { text: 'Reading workflows…', round: 0, step: 0, done: true, result: '3 found' },
      { text: 'Reading workflows…', round: 1, step: 0 }
    ])
    expect(steps).toHaveLength(2)
    expect(steps[1].state).toBe('running')
  })

  it('an older server (no step index, no done) still lists every step', () => {
    const steps = run([
      { text: 'Reading workflows…', round: 0 },
      { text: 'Counting lines…', round: 1 }
    ])
    expect(steps.map((s) => s.state)).toEqual(['done', 'running'])
  })

  it('ignores an empty status', () => {
    expect(run([{ text: '', round: 0 }])).toEqual([])
  })
})
