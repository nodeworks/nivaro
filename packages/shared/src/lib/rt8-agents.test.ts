import { describe, expect, it } from 'vitest'
import { configReachText } from '../components/ConfigReachNote'
import { agentSentence, agentsFromPayload } from './agent-presence'

describe('agent presence (rt8 #21)', () => {
  it('reads a record:agents payload on this tab’s clock, writers first', () => {
    const list = agentsFromPayload(
      [
        { key: 'b', name: 'Zed', for: { id: 'U2', name: 'Beth' }, mode: 'reading', ttl_ms: 5000 },
        {
          key: 'a',
          name: 'Claude',
          for: { id: 'U1', name: 'Rob' },
          mode: 'updating',
          ttl_ms: 9000
        },
        { key: 'x', name: '', ttl_ms: 1000 },
        { key: 'y', name: 'Late', ttl_ms: 0 },
        null
      ],
      100
    )
    expect(list.map((a) => a.key)).toEqual(['a', 'b'])
    expect(list[0].until).toBe(9100)
    expect(agentsFromPayload('nope', 0)).toEqual([])
  })

  it('says who it works for, “you” for the viewer’s own', () => {
    const [a] = agentsFromPayload(
      [{ key: 'a', name: 'Claude', for: { id: 'u1', name: 'Rob' }, mode: 'updating', ttl_ms: 1 }],
      0
    )
    expect(agentSentence(a)).toBe('Claude (for Rob) is updating this record')
    expect(agentSentence(a, 'U1')).toBe('Claude (for you) is updating this record')
    expect(agentSentence({ ...a, mode: 'reading' }, null, true)).toBe('Claude is reading')
  })
})

describe('configReachText (rt8 #25)', () => {
  it('reads the reach as a sentence', () => {
    expect(configReachText({ forms: 34, people: 12 })).toBe(
      'This reaches 34 open forms, 12 people right now'
    )
    expect(configReachText({ forms: 1, people: 1 })).toBe(
      'This reaches 1 open form, 1 person right now'
    )
    expect(configReachText({ forms: 0, people: 0 })).toMatch(/Nobody else/)
  })
})
