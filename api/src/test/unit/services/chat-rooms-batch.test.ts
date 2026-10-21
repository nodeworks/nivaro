import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/chat.js', () => ({ channels: vi.fn(), clearChatCaches: vi.fn() }))

import { idleSince, shouldSuggestArchive } from '../../../services/chat-archive.js'
import { cleanShortcode, sniffImageType } from '../../../services/chat-emoji.js'
import { historyItemsFor, toMembershipEvent } from '../../../services/chat-membership-history.js'

const U = 'aaaaaaaa-0000-0000-0000-000000000001'
const V = 'bbbbbbbb-0000-0000-0000-000000000002'
const now = new Date('2026-10-21T12:00:00Z')
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000)

describe('archive suggestions (#2485)', () => {
  const base = {
    isArchived: false,
    isDirect: false,
    createdBy: U,
    createdAt: daysAgo(400),
    lastPostAt: daysAgo(120),
    keptAt: null,
    suggestedAt: null
  }
  it('suggests a channel quiet for longer than the threshold', () => {
    expect(shouldSuggestArchive(base, 90, now)).toBe(true)
  })
  it('leaves an active channel alone', () => {
    expect(shouldSuggestArchive({ ...base, lastPostAt: daysAgo(10) }, 90, now)).toBe(false)
  })
  it('is off at zero days', () => {
    expect(shouldSuggestArchive(base, 0, now)).toBe(false)
  })
  it('skips archived, direct and already-suggested channels', () => {
    expect(shouldSuggestArchive({ ...base, isArchived: true }, 90, now)).toBe(false)
    expect(shouldSuggestArchive({ ...base, isDirect: true }, 90, now)).toBe(false)
    expect(shouldSuggestArchive({ ...base, suggestedAt: daysAgo(1) }, 90, now)).toBe(false)
  })
  it('a Keep restarts the idle clock', () => {
    expect(shouldSuggestArchive({ ...base, keptAt: daysAgo(30) }, 90, now)).toBe(false)
    expect(shouldSuggestArchive({ ...base, keptAt: daysAgo(100) }, 90, now)).toBe(true)
  })
  it('a channel that never had a post idles from its creation', () => {
    const c = { ...base, lastPostAt: null, createdAt: daysAgo(100) }
    expect(idleSince(c)).toBe(daysAgo(100).getTime())
    expect(shouldSuggestArchive(c, 90, now)).toBe(true)
    expect(shouldSuggestArchive({ ...c, createdAt: daysAgo(20) }, 90, now)).toBe(false)
  })
})

describe('membership history (#2784)', () => {
  const row = (action: string, comment: string | null, user: string | null) => ({
    id: 1,
    action,
    comment,
    timestamp: now,
    user,
    item: 'ops'
  })
  it('reads a self join and leave with the person as actor', () => {
    expect(toMembershipEvent(row('chat-channel-join', 'joined #ops', U))).toMatchObject({
      kind: 'joined',
      user_id: U,
      by_id: U
    })
    expect(toMembershipEvent(row('chat-channel-leave', 'left #ops', U))).toMatchObject({
      kind: 'left',
      user_id: U
    })
  })
  it('reads an add with the subject in the comment and the actor as user', () => {
    expect(
      toMembershipEvent(row('chat-channel-member-add', `${V} added to #ops`, U))
    ).toMatchObject({
      kind: 'added',
      user_id: V,
      by_id: U
    })
  })
  it('reads a remove by someone else', () => {
    expect(
      toMembershipEvent(row('chat-channel-member-remove', `${V} removed from #ops`, U))
    ).toMatchObject({ kind: 'removed', user_id: V, by_id: U })
  })
  it('reads a default-role join as having no actor', () => {
    expect(
      toMembershipEvent(row('chat-channel-member-add', `${V} joined #ops by default role`, null))
    ).toMatchObject({ kind: 'auto_joined', user_id: V, by_id: null })
  })
  it('reads a team add with its source note and a big-batch summary', () => {
    expect(
      toMembershipEvent(row('chat-channel-member-add', `${V} added to #ops from team Finance`, U))
    ).toMatchObject({ kind: 'added', note: 'from team Finance' })
    expect(
      toMembershipEvent(row('chat-channel-member-add', '300 added from role Buyers to #ops', U))
    ).toMatchObject({ kind: 'bulk_added', count: 300, note: 'role Buyers' })
  })
  it('ignores rows that are not membership changes', () => {
    expect(toMembershipEvent(row('chat-channel-member-add', 'something else', U))).toBeNull()
    expect(toMembershipEvent(row('chat-channel-member-remove', null, U))).toBeNull()
  })
})

describe('membership history scope (#2784)', () => {
  it('queries the channel key only, so a key equal to another channel id cannot collide', () => {
    expect(historyItemsFor({ key: 'ops' })).toEqual(['ops'])
    // channel id 42 keyed "ops" must not read rows of the channel keyed "42"
    expect(historyItemsFor({ key: 'ops' })).not.toContain('42')
  })
})

describe('custom emoji (#2459)', () => {
  it('normalises shortcodes', () => {
    expect(cleanShortcode(':Party Parrot:')).toBe('party_parrot')
    expect(cleanShortcode('  ship-it ')).toBe('ship-it')
  })
  it('sniffs the real image type and refuses everything else', () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
      'image/png'
    )
    expect(sniffImageType(Buffer.from('GIF89a....'))).toBe('image/gif')
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
  })
})
