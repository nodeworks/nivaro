import { describe, expect, it } from 'vitest'
import {
  drillSourceFor,
  liveSourcesFor,
  parseSlash,
  slashMatches,
  stripFollowUps
} from './ai-panel'

describe('stripFollowUps', () => {
  it('removes a complete trailing block', () => {
    expect(stripFollowUps('Answer.\n\n```followups\n["a?"]\n```')).toBe('Answer.')
  })
  it('hides a block still streaming in', () => {
    expect(stripFollowUps('Answer.\n\n```followups\n["a?", "b')).toBe('Answer.')
    expect(stripFollowUps('Answer.\n\n```fol')).toBe('Answer.')
  })
  it('keeps other fenced blocks', () => {
    const t = 'x\n```chart\n{"type":"bar"}\n```'
    expect(stripFollowUps(t)).toBe(t)
  })
})

describe('slash commands', () => {
  it('lists matches while typing', () => {
    expect(slashMatches('/').map((c) => c.name)).toHaveLength(5)
    expect(slashMatches('/ex').map((c) => c.name)).toEqual(['export', 'explain'])
    expect(slashMatches('/chart foo')).toEqual([])
  })
  it('parses a command and its question', () => {
    expect(parseSlash('/chart spend by zone')).toMatchObject({
      command: { name: 'chart' },
      rest: 'spend by zone'
    })
    expect(parseSlash('/nope x')).toBeNull()
    expect(parseSlash('/export')?.rest).toBe('')
  })
})

describe('drill + live sources', () => {
  const trace = [
    {
      tool: 'aggregate',
      input: { collection: 'ir', op: 'count', group_by: 'zone' },
      summary: 'count by zone: 3 group(s)'
    }
  ]
  it('finds the grouped aggregate behind a chart', () => {
    expect(drillSourceFor(trace, 3)).toMatchObject({ collection: 'ir', group_by: 'zone' })
    expect(drillSourceFor([{ ...trace[0], summary: 'error: x' }], 3)).toBeNull()
  })
  it('is live only for aggregate-only answers', () => {
    expect(liveSourcesFor(trace)).toHaveLength(1)
    expect(
      liveSourcesFor([...trace, { tool: 'query_items', input: {}, summary: '1 row(s)' }])
    ).toEqual([])
    expect(liveSourcesFor(undefined)).toEqual([])
  })
})
