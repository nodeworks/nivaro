import { describe, expect, it } from 'vitest'
import type { EventPath, PathNode } from '../types.js'
import { ancestorsOf, flattenVisible, formatOffset, summarySentence } from './pathModel.js'

const n = (key: string, kind: PathNode['kind'], extra: Partial<PathNode> = {}): PathNode => ({
  key,
  parent: null,
  kind,
  at: '2026-09-24T10:00:00.000Z',
  offset_ms: 0,
  summary: key,
  children: [],
  ...extra
})

const tree = n('request:c', 'request', {
  children: [
    n('activity:1', 'write', { record: { collection: 'workflows', item: '1' } }),
    n('history:2', 'transition', {
      children: [
        n('submission:3', 'push', {
          summary: 'Push to MWF · failed',
          failed: true,
          detail: { type: 'push', status: 'failed', submission_id: 3 }
        })
      ]
    }),
    n('group:x', 'group', {
      members: [
        n('activity:5', 'write', { record: { collection: 'workflow_line_items', item: '5' } }),
        n('activity:6', 'write', { record: { collection: 'workflow_line_items', item: '6' } })
      ]
    })
  ]
})
const path: EventPath = {
  root: tree,
  mode: 'exact',
  truncated: false,
  step_count: 5,
  first_failure: 'submission:3',
  replay_of: null,
  replayed_as: [],
  warnings: []
}

describe('summarySentence', () => {
  it('names who, what record, how many records changed and pushes', () => {
    expect(summarySentence(path, { label: 'LinX', item_label: 'CM26-79811' })).toBe(
      'LinX · CM26-79811 · 3 records changed · 1 push (1 failed)'
    )
  })
})

describe('flattenVisible', () => {
  it('shows children of expanded nodes only, with depth', () => {
    const rows = flattenVisible(tree, new Set(['request:c']))
    expect(rows.map((r) => [r.node.key, r.depth])).toEqual([
      ['request:c', 0],
      ['activity:1', 1],
      ['history:2', 1],
      ['group:x', 1]
    ])
    const deeper = flattenVisible(tree, new Set(['request:c', 'history:2']))
    expect(deeper.map((r) => r.node.key)).toContain('submission:3')
  })
})

describe('ancestorsOf', () => {
  it('returns the keys to expand to reveal a step', () => {
    expect(ancestorsOf(tree, 'submission:3')).toEqual(['request:c', 'history:2'])
    expect(ancestorsOf(tree, 'nope')).toEqual([])
  })
})

describe('formatOffset', () => {
  it('formats ms and seconds', () => {
    expect(formatOffset(0)).toBe('+0 ms')
    expect(formatOffset(420)).toBe('+420 ms')
    expect(formatOffset(1500)).toBe('+1.5 s')
    expect(formatOffset(125_000)).toBe('+2m 5s')
  })
  it('never prints 60 seconds', () => {
    expect(formatOffset(59_990)).toBe('+1m 0s')
    expect(formatOffset(119_999)).toBe('+2m 0s')
  })
})
