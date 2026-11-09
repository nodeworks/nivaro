import { describe, expect, it } from 'vitest'
import { groupTransitions } from './QueueBulkMove'

describe('groupTransitions (queue bulk Move / Send Back)', () => {
  it('one choice per label; Send Back keeps every from-state and its targets', () => {
    const g = groupTransitions([
      { id: 'a', label: 'Send Back', to_state: 'started', comment_mode: 'required' },
      { id: 'b', label: 'Send Back', to_state: 'started' },
      { id: 'c', label: 'Send Back', to_state: 'level1' },
      { id: 'd', label: 'Approve', to_state: 'level2' }
    ])
    expect(g.map((x) => x.label)).toEqual(['Send Back', 'Approve'])
    const back = g[0]
    expect(back.ids).toEqual(['a', 'b', 'c'])
    expect(back.noteRequired).toBe(true)
    expect(back.targets.get('started')).toEqual(['a', 'b'])
    expect(back.targets.get('level1')).toEqual(['c'])
  })
})
