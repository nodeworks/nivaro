import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { trace } = vi.hoisted(() => ({
  trace: { url: null as string | null, user: null as string | null }
}))

vi.mock('./record-events.js', () => ({ emitToSignedIn: () => {} }))
vi.mock('./tenant-rooms.js', () => ({ currentTenantKey: () => '' }))
vi.mock('./request-trace.js', () => ({
  currentRequestHint: () => trace.url,
  currentTraceMeta: () => (trace.user ? { userId: trace.user } : null)
}))

import { DIRECTORY_SIGNAL_COLUMNS, peopleWriteKind } from '../db/people-signal.js'
import {
  notePeopleChanged,
  onDirectoryWrite,
  PEOPLE_IDS_MAX,
  peopleChangedPayload,
  personOfRequest,
  resetPeopleLiveForTests,
  setPeopleEmitterForTests,
  signInChangedDirectory
} from './people-live.js'

const U1 = '11111111-1111-1111-1111-111111111111'

let sent: Array<{ event: string; payload: Record<string, unknown> }> = []
beforeEach(() => {
  sent = []
  resetPeopleLiveForTests()
  setPeopleEmitterForTests((_t, event, payload) => sent.push({ event, payload }))
  trace.url = null
  trace.user = null
})
afterEach(() => {
  setPeopleEmitterForTests(null)
  vi.useRealTimers()
})

describe('peopleWriteKind (directory columns only)', () => {
  it('a new person, a name, title, photo or status change counts', () => {
    expect(peopleWriteKind('insert into [nivaro_users] ([email]) values (@p0)')).toBe('created')
    expect(peopleWriteKind('update [nivaro_users] set [first_name] = @p0 where [id] = @p1')).toBe(
      'changed'
    )
    expect(peopleWriteKind('update [nivaro_users] set [avatar] = @p0 where [id] = @p1')).toBe(
      'changed'
    )
    expect(
      peopleWriteKind('update [nivaro_users] set [is_out_of_office] = @p0 where [id] = @p1')
    ).toBe('changed')
  })

  it('credentials, preferences and bookkeeping never count', () => {
    for (const col of [
      'last_access',
      'preferences',
      'static_token',
      'password',
      'current_workspace'
    ])
      expect(
        peopleWriteKind(`update [nivaro_users] set [${col}] = @p0 where [id] = @p1`)
      ).toBeNull()
    // A WHERE on status is not a change to it.
    expect(
      peopleWriteKind("update [nivaro_users] set [last_access] = @p0 where [status] = 'active'")
    ).toBeNull()
    expect(peopleWriteKind('select * from [nivaro_users]')).toBeNull()
    expect(peopleWriteKind('update [nivaro_users_x] set [first_name] = @p0')).toBeNull()
  })

  it('the signal column list holds no credential column', () => {
    for (const col of DIRECTORY_SIGNAL_COLUMNS)
      expect(col).not.toMatch(/token|password|secret|hash|key|preferences|external_id/i)
  })
})

describe('people:changed payload has no credential fields', () => {
  it('carries only at, user ids and the created flag', () => {
    const p = peopleChangedPayload({ ids: [U1], any: false, created: true }, 5)
    expect(Object.keys(p).sort()).toEqual(['at', 'created', 'user_ids'])
    expect(p).toEqual({ at: 5, user_ids: [U1], created: true })
  })

  it('names nobody when any write in the window named nobody, or too many', () => {
    expect(peopleChangedPayload({ ids: [U1], any: true, created: false }, 1)).toEqual({ at: 1 })
    const many = Array.from({ length: PEOPLE_IDS_MAX + 1 }, (_, i) => `id-${i}`)
    expect(peopleChangedPayload({ ids: many, any: false, created: false }, 1)).toEqual({ at: 1 })
  })

  it('a burst is one coalesced notice to signed-in sockets', async () => {
    vi.useFakeTimers()
    notePeopleChanged(['a'])
    notePeopleChanged(['b'])
    notePeopleChanged(['A'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toHaveLength(1)
    expect(sent[0].event).toBe('people:changed')
    expect(sent[0].payload.user_ids).toEqual(['A', 'B'])
    for (const v of Object.values(sent[0].payload))
      expect(JSON.stringify(v)).not.toMatch(/token|password|email|@/i)
  })
})

describe('who a directory write is about', () => {
  it('reads the person from the request URL; /me is the caller', () => {
    expect(personOfRequest(`/api/users/${U1}`, null)).toBe(U1)
    expect(personOfRequest(`/api/items/nivaro_users/${U1}?fields=id`, null)).toBe(U1)
    expect(personOfRequest('/api/users/me/profile', U1)).toBe(U1)
    expect(personOfRequest('/api/users/bulk', U1)).toBeNull()
    expect(personOfRequest(null, U1)).toBeNull()
  })

  it('sign-in rewrites are left to the sign-in path; a cron write names anyone', async () => {
    vi.useFakeTimers()
    trace.url = '/api/auth/callback'
    onDirectoryWrite('changed')
    await vi.advanceTimersByTimeAsync(5000)
    expect(sent).toHaveLength(0)
    trace.url = null
    onDirectoryWrite('changed')
    await vi.advanceTimersByTimeAsync(5000)
    expect(sent).toHaveLength(1)
    expect(sent[0].payload.user_ids).toBeUndefined()
  })

  it('sign-in announces only a real change', () => {
    const before = { first_name: 'Ana', last_name: 'Lee', title: 'PM', avatar: 'x', role: 'R1' }
    expect(signInChangedDirectory(before, { first_name: 'Ana', last_access: new Date() })).toBe(
      false
    )
    expect(signInChangedDirectory(before, { title: 'Director' })).toBe(true)
    expect(signInChangedDirectory(before, { avatar: 'y' })).toBe(true)
    expect(signInChangedDirectory(before, { role: 'r1' })).toBe(false)
  })
})
