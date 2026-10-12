import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetRecordOutboxForTests,
  bindRecordOutbox,
  claimRecordOutbox,
  clearRecordOutbox,
  clearRecordOutboxFor,
  disableRecordOutbox,
  enqueueRecordSave,
  findRecordOutboxEntry,
  getRecordOutbox,
  isOfflineSaveError,
  midairCollisionOf,
  onRecordOutboxEvent,
  onRecordOutboxRetry,
  RECORD_OUTBOX_TTL_MS,
  type RecordOutboxEvent,
  replayRecordOutbox,
  settleRecordOutbox,
  sweepExpiredRecordOutbox
} from './record-outbox'

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

/** A fake client: `routes` answers by "METHOD path"; every call is recorded. */
function fakeClient(routes: Record<string, (cmd: Cmd) => unknown>) {
  const calls: Cmd[] = []
  return {
    calls,
    request: async <T>(command: unknown): Promise<T> => {
      const cmd = command as Cmd
      calls.push(cmd)
      const key = `${cmd._method} ${cmd._path}`
      const handler = routes[key]
      if (!handler) throw Object.assign(new Error('Not found'), { status: 404, response: {} })
      return (await handler(cmd)) as T
    }
  }
}

const offline = () => {
  throw new TypeError('Failed to fetch')
}
const me = (id: string) => () => ({ data: { id } })

async function queue(over: Partial<Parameters<typeof enqueueRecordSave>[0]> = {}) {
  return enqueueRecordSave({
    collection: 'projects',
    item: '7',
    payload: { name: 'New name', _base_revision: 41 },
    before: { name: 'Old name' },
    baseRevision: 41,
    ...over
  })
}

beforeEach(() => {
  __resetRecordOutboxForTests({ memory: true })
})
afterEach(() => {
  vi.useRealTimers()
  __resetRecordOutboxForTests({ memory: true })
})

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('network classification', () => {
  it('treats a thrown fetch and gateway errors as offline, never a 4xx', () => {
    expect(isOfflineSaveError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isOfflineSaveError({ status: 503, response: {} })).toBe(true)
    expect(isOfflineSaveError({ status: 502 })).toBe(true)
    expect(isOfflineSaveError({ status: 409, response: { code: 'MIDAIR_COLLISION' } })).toBe(false)
    expect(isOfflineSaveError({ status: 422, response: {} })).toBe(false)
    expect(isOfflineSaveError({ response: { status: 504 } })).toBe(true)
  })

  it('reads a mid-air collision from either client error shape', () => {
    const body = {
      code: 'MIDAIR_COLLISION',
      conflicts: [{ field: 'name', current_value: 'Theirs' }],
      latest_revision: 50
    }
    expect(midairCollisionOf({ status: 409, response: body })).toEqual({
      conflicts: body.conflicts,
      latest: 50
    })
    expect(midairCollisionOf({ response: { status: 409, data: body } })?.latest).toBe(50)
    expect(midairCollisionOf({ status: 409, response: { code: 'OTHER' } })).toBeNull()
  })
})

describe('enqueue', () => {
  it('stores nothing until a person is bound', async () => {
    expect(await queue()).toBeNull()
  })

  it('keeps one entry per record; a covering re-save takes its base', async () => {
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'u1')
    await queue()
    await queue({
      payload: { name: 'Newer', budget: 5 },
      before: { name: 'Merged base', budget: 1 },
      baseRevision: 45
    })
    const all = getRecordOutbox()
    expect(all).toHaveLength(1)
    expect(all[0].payload).toEqual({ name: 'Newer', budget: 5 })
    expect(all[0].base_revision).toBe(45)
    expect(all[0].before).toEqual({ name: 'Merged base', budget: 1 })
    expect(Object.keys(all[0].payload).some((k) => k.startsWith('_'))).toBe(false)
  })

  it('a partial re-save keeps the older base and the first before-values', async () => {
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'u1')
    await queue()
    await queue({ payload: { budget: 5 }, before: { budget: 1 }, baseRevision: 45 })
    const e = getRecordOutbox()[0]
    expect(e.payload).toEqual({ name: 'New name', budget: 5 })
    expect(e.base_revision).toBe(41)
    expect(e.before).toEqual({ name: 'Old name', budget: 1 })
    await queue({ payload: { owner: 'x' }, before: { owner: null }, baseRevision: null })
    expect(getRecordOutbox()[0].base_revision).toBeNull()
  })

  it('never shows another person their entries', async () => {
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'u1')
    await queue()
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'u2')
    await new Promise((r) => setTimeout(r, 0))
    expect(getRecordOutbox()).toHaveLength(0)
    expect(findRecordOutboxEntry('projects', '7')).toBeNull()
  })
})

describe('replay', () => {
  it('sends the change against its base revision and drops it on success', async () => {
    const client = fakeClient({ 'GET /auth/me': me('u1'), 'PATCH /items/projects/7': () => ({}) })
    bindRecordOutbox(client, 'u1')
    await queue({ changeReason: 'Fix typo' })
    const events: RecordOutboxEvent[] = []
    onRecordOutboxEvent((e) => events.push(e))
    await replayRecordOutbox()
    const sent = client.calls.find((c) => c._method === 'PATCH')
    expect(sent?._body).toEqual({
      name: 'New name',
      _base_revision: 41,
      _change_reason: 'Fix typo'
    })
    expect(getRecordOutbox()).toHaveLength(0)
    expect(events.map((e) => e.type)).toEqual(['replayed'])
  })

  it('replays nothing when the session is now someone else', async () => {
    const client = fakeClient({ 'GET /auth/me': me('u2'), 'PATCH /items/projects/7': () => ({}) })
    bindRecordOutbox(client, 'u1')
    await queue()
    await replayRecordOutbox()
    expect(client.calls.some((c) => c._method === 'PATCH')).toBe(false)
    expect(getRecordOutbox()).toHaveLength(1)
  })

  it('stays queued while the API is still unreachable', async () => {
    const client = fakeClient({ 'GET /auth/me': offline })
    bindRecordOutbox(client, 'u1')
    await queue()
    await replayRecordOutbox()
    expect(getRecordOutbox()[0].status).toBe('queued')
  })

  it('turns a mid-air collision into a conflict for the merge dialog', async () => {
    const client = fakeClient({
      'GET /auth/me': me('u1'),
      'PATCH /items/projects/7': () => {
        throw Object.assign(new Error('Conflict'), {
          status: 409,
          response: {
            code: 'MIDAIR_COLLISION',
            conflicts: [{ field: 'name', current_value: 'Theirs' }],
            latest_revision: 52
          }
        })
      }
    })
    bindRecordOutbox(client, 'u1')
    await queue()
    const events: RecordOutboxEvent[] = []
    onRecordOutboxEvent((e) => events.push(e))
    await replayRecordOutbox()
    const e = getRecordOutbox()[0]
    expect(e.status).toBe('conflict')
    expect(e.conflicts).toEqual([{ field: 'name', current_value: 'Theirs' }])
    expect(e.latest_revision).toBe(52)
    expect(events.map((x) => x.type)).toEqual(['conflict'])
  })

  it('counts a "conflict" that already holds this person\'s value as saved', async () => {
    const client = fakeClient({
      'GET /auth/me': me('u1'),
      'PATCH /items/projects/7': () => {
        throw Object.assign(new Error('Conflict'), {
          status: 409,
          response: {
            code: 'MIDAIR_COLLISION',
            conflicts: [{ field: 'name', current_value: 'New name' }],
            latest_revision: 42
          }
        })
      }
    })
    bindRecordOutbox(client, 'u1')
    await queue()
    await replayRecordOutbox()
    expect(getRecordOutbox()).toHaveLength(0)
  })

  it('without a base revision, compares the fields before sending', async () => {
    const changed = fakeClient({
      'GET /auth/me': me('u1'),
      'GET /items/projects/7': () => ({ data: { name: 'Someone else' } }),
      'GET /revisions': () => ({ data: { latest: 60 } }),
      'PATCH /items/projects/7': () => ({})
    })
    bindRecordOutbox(changed, 'u1')
    await queue({ payload: { name: 'New name' }, baseRevision: null })
    await replayRecordOutbox()
    expect(changed.calls.some((c) => c._method === 'PATCH')).toBe(false)
    expect(getRecordOutbox()[0]).toMatchObject({ status: 'conflict', latest_revision: 60 })

    __resetRecordOutboxForTests({ memory: true })
    const same = fakeClient({
      'GET /auth/me': me('u1'),
      'GET /items/projects/7': () => ({ data: { name: 'Old name' } }),
      'GET /revisions': () => ({ data: { latest: 60 } }),
      'PATCH /items/projects/7': () => ({})
    })
    bindRecordOutbox(same, 'u1')
    await queue({ payload: { name: 'New name' }, baseRevision: null })
    await replayRecordOutbox()
    expect(same.calls.find((c) => c._method === 'PATCH')?._body).toEqual({
      name: 'New name',
      _base_revision: 60
    })
    expect(getRecordOutbox()).toHaveLength(0)
  })

  it('leaves an entry a form holds to that form, and tells it to retry', async () => {
    const client = fakeClient({ 'GET /auth/me': me('u1'), 'PATCH /items/projects/7': () => ({}) })
    bindRecordOutbox(client, 'u1')
    await queue()
    const release = claimRecordOutbox('projects', '7')
    const retry = vi.fn()
    onRecordOutboxRetry(retry)
    await replayRecordOutbox()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(client.calls.some((c) => c._method === 'PATCH')).toBe(false)
    release()
    await replayRecordOutbox()
    expect(client.calls.some((c) => c._method === 'PATCH')).toBe(true)
  })
})

describe('settle + clear', () => {
  it('a form save settles the fields it carried or took over; the rest stay', async () => {
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'u1')
    await queue({ payload: { name: 'A', budget: 3 }, before: { name: 'x', budget: 1 } })
    await settleRecordOutbox('projects', '7', ['name'])
    expect(getRecordOutbox()[0].payload).toEqual({ budget: 3 })
    await settleRecordOutbox('projects', '7', ['budget'])
    expect(getRecordOutbox()).toHaveLength(0)
  })

  it('sign-out clears every entry', async () => {
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'u1')
    await queue()
    await clearRecordOutbox()
    expect(getRecordOutbox()).toHaveLength(0)
  })
})

describe('shared devices', () => {
  it('signing in as someone else drops every entry that is not theirs', async () => {
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'u1')
    await queue()
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'u2')
    await settle()
    await queue({ item: '9' })
    // u1 back on this browser: their earlier entry is gone for good, and
    // u2's went the moment u1 signed in.
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'u1')
    await settle()
    expect(getRecordOutbox()).toHaveLength(0)
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'u2')
    await settle()
    expect(getRecordOutbox()).toHaveLength(0)
  })

  it('drops an entry a week after it was queued, telling its owner once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T09:00:00Z'))
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'u1')
    await queue()
    await queue({ item: '8' })
    // A later re-save of record 8 does not restart its week.
    vi.setSystemTime(new Date('2026-10-07T09:00:00Z'))
    await queue({ item: '8', payload: { name: 'Again' } })
    const events: RecordOutboxEvent[] = []
    onRecordOutboxEvent((e) => events.push(e))
    vi.setSystemTime(
      new Date(new Date('2026-10-01T09:00:00Z').getTime() + RECORD_OUTBOX_TTL_MS + 1)
    )
    await sweepExpiredRecordOutbox()
    await sweepExpiredRecordOutbox()
    expect(getRecordOutbox()).toHaveLength(0)
    expect(events.map((e) => [e.type, e.entry.item])).toEqual([
      ['expired', '7'],
      ['expired', '8']
    ])
  })

  it('nobody else is told about an expired entry — it is purged at sign-in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T09:00:00Z'))
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'u1')
    await queue()
    vi.setSystemTime(new Date('2026-10-20T09:00:00Z'))
    const events: RecordOutboxEvent[] = []
    onRecordOutboxEvent((e) => events.push(e))
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'u2')
    await settle()
    await sweepExpiredRecordOutbox()
    expect(events).toHaveLength(0)
  })
})

describe('View as', () => {
  it('a disabled outbox queues nothing, so the save shows its normal error', async () => {
    disableRecordOutbox()
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'u1')
    expect(await queue()).toBeNull()
    expect(getRecordOutbox()).toHaveLength(0)
  })

  it('a disabled tab neither binds nor purges anyone', async () => {
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'admin')
    await queue()
    __resetRecordOutboxForTests({ memory: true, keepStore: true })
    disableRecordOutbox()
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'viewed-user')
    await settle()
    __resetRecordOutboxForTests({ memory: true, keepStore: true })
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'admin')
    await settle()
    expect(getRecordOutbox()).toHaveLength(1)
  })

  it('leaving View as clears what is stored under the viewed person only', async () => {
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'viewed-user')
    await queue()
    __resetRecordOutboxForTests({ memory: true, keepStore: true })
    await clearRecordOutboxFor('admin')
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'viewed-user')
    await settle()
    expect(getRecordOutbox()).toHaveLength(1)

    __resetRecordOutboxForTests({ memory: true, keepStore: true })
    await clearRecordOutboxFor('viewed-user')
    bindRecordOutbox(fakeClient({ 'GET /auth/me': offline }), 'viewed-user')
    await settle()
    expect(getRecordOutbox()).toHaveLength(0)
  })
})
