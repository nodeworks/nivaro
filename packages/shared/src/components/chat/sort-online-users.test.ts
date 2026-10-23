import { describe, expect, it } from 'vitest'
import { sortOnlineUsers } from './chat-core'

describe('sortOnlineUsers', () => {
  it('sorts by name ignoring case, ties by id, unnamed last, without touching the input', () => {
    const list = [
      { user_id: 'b', display_name: 'ana' },
      { user_id: 'x', display_name: null },
      { user_id: 'a', display_name: 'Ana' },
      { user_id: 'c', display_name: 'Bob' }
    ]
    const out = sortOnlineUsers(list)
    expect(out.map((u) => u.user_id)).toEqual(['a', 'b', 'c', 'x'])
    expect(list[0].user_id).toBe('b')
  })
})
