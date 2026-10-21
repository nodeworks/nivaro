import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { mayBroadcastMention } from '../../../services/chat.js'

const OWNER = 'aaaaaaaa-0000-0000-0000-000000000001'
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000002'

describe('mayBroadcastMention (#2483)', () => {
  it('defaults to the owner and admins', () => {
    const ch = { created_by: OWNER, mention_policy: null }
    expect(mayBroadcastMention(ch, { id: OWNER })).toBe(true)
    expect(mayBroadcastMention(ch, { id: OWNER.toUpperCase() })).toBe(true)
    expect(mayBroadcastMention(ch, { id: OTHER })).toBe(false)
    expect(mayBroadcastMention(ch, { id: OTHER, isAdmin: true })).toBe(true)
  })
  it('members policy lets everyone in', () => {
    expect(
      mayBroadcastMention({ created_by: OWNER, mention_policy: 'members' }, { id: OTHER })
    ).toBe(true)
  })
  it('admins policy shuts out the owner but not admins', () => {
    const ch = { created_by: OWNER, mention_policy: 'admins' as const }
    expect(mayBroadcastMention(ch, { id: OWNER })).toBe(false)
    expect(mayBroadcastMention(ch, { id: OWNER, isAdmin: true })).toBe(true)
  })
  it('a channel without an owner falls to admins', () => {
    expect(mayBroadcastMention({ created_by: null, mention_policy: null }, { id: OTHER })).toBe(
      false
    )
  })
})
