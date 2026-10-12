import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetChatCommands,
  listChatCommands,
  registerChatCommand
} from '../../../services/chat-commands.js'
import { cleanPollOptions, pollSummaryLine, validateVote } from '../../../services/chat-polls.js'
import { embeddableText, rankByMeaning } from '../../../services/chat-semantic.js'

describe('poll helpers', () => {
  it('cleans, dedupes and caps options', () => {
    expect(cleanPollOptions([' Yes ', 'yes', '', 'No'])).toEqual(['Yes', 'No'])
    expect(cleanPollOptions(Array.from({ length: 20 }, (_, i) => `o${i}`))).toHaveLength(10)
    expect(cleanPollOptions('x')).toEqual([])
  })
  it('validates votes against choice mode', () => {
    expect(validateVote([0, 1], 3, false).ok).toBe(false)
    expect(validateVote([1, 0], 3, true)).toEqual({ ok: true, picks: [0, 1] })
    expect(validateVote([3], 3, true).ok).toBe(false)
    expect(validateVote([], 3, false)).toEqual({ ok: true, picks: [] })
  })
  it('summarises a closed poll', () => {
    const o = [
      { label: 'A', count: 2 },
      { label: 'B', count: 1 }
    ]
    expect(pollSummaryLine('Q?', o, 3)).toContain('A won')
    expect(
      pollSummaryLine(
        'Q?',
        [
          { label: 'A', count: 1 },
          { label: 'B', count: 1 }
        ],
        2
      )
    ).toContain('Tie')
    expect(pollSummaryLine('Q?', o, 0)).toContain('no votes')
  })
})

describe('semantic search helpers', () => {
  it('skips short and system lines', () => {
    expect(embeddableText('ok')).toBeNull()
    expect(embeddableText('The warehouse door sticks again')).toContain('warehouse')
  })
  it('ranks by similarity and honours exclude', () => {
    const rows = [
      { message_id: 1, embedding: JSON.stringify([1, 0]) },
      { message_id: 2, embedding: JSON.stringify([0.9, 0.1]) },
      { message_id: 3, embedding: JSON.stringify([0, 1]) }
    ]
    const r = rankByMeaning([1, 0], rows, { threshold: 0.5, limit: 5, exclude: new Set([1]) })
    expect(r.map((x) => x.id)).toEqual([2])
  })
})

describe('chat command registry', () => {
  beforeEach(() => _resetChatCommands())
  const def = (name: string) => ({ name, description: 'd', run: () => undefined })
  it('rejects built-in names and bad names', () => {
    expect(registerChatCommand('x', def('poll'))).toBe(false)
    expect(registerChatCommand('x', def('Bad Name'))).toBe(false)
  })
  it('lists registered commands and blocks cross-extension collisions', () => {
    expect(registerChatCommand('a', def('standup'))).toBe(true)
    expect(registerChatCommand('b', def('standup'))).toBe(false)
    expect(registerChatCommand('a', def('standup'))).toBe(true)
    expect(listChatCommands().map((c) => c.name)).toEqual(['standup'])
  })
})
