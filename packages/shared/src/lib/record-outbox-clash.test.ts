import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetRecordOutboxForTests,
  bindRecordOutbox,
  enqueueRecordSave,
  getRecordOutbox,
  onRecordOutboxEvent,
  type RecordOutboxEvent,
  replayRecordOutbox,
  resolveRecordOutboxField
} from './record-outbox'

/**
 * Offline edits reviewed on reconnect (realtime round 8, item 3): the clash check runs as the
 * viewer before anything is sent, the fields nobody else touched go out on their own, and a
 * clashing field is never sent until the person decided it (Keep mine / Take theirs / Merge).
 */

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }
type Routes = Record<string, (cmd: Cmd) => unknown>

function fakeClient(routes: Routes) {
  const calls: Cmd[] = []
  return {
    calls,
    request: async <T>(command: unknown): Promise<T> => {
      const cmd = command as Cmd
      calls.push(cmd)
      const handler = routes[`${cmd._method} ${cmd._path}`]
      if (!handler) throw Object.assign(new Error('Not found'), { status: 404, response: {} })
      return (await handler(cmd)) as T
    }
  }
}

const me = (id: string) => () => ({ data: { id } })
const patchesOf = (client: { calls: Cmd[] }) =>
  client.calls.filter((c) => c._method === 'PATCH').map((c) => c._body)

const twoFields = () =>
  enqueueRecordSave({
    collection: 'projects',
    item: '7',
    payload: { name: 'Mine', budget: 500 },
    before: { name: 'Old name', budget: 100 },
    baseRevision: 41
  })

beforeEach(() => __resetRecordOutboxForTests({ memory: true }))
afterEach(() => __resetRecordOutboxForTests({ memory: true }))

describe('the clash check before sending', () => {
  it('sends the fields nobody else touched and holds the clashing one', async () => {
    const client = fakeClient({
      'GET /auth/me': me('u1'),
      'GET /revisions': () => ({ data: { latest: 44 } }),
      'GET /items/projects/7': () => ({ data: { name: 'Beth name', budget: 100 } }),
      'GET /revisions/field-touch': () => ({
        data: { name: { who: 'Beth Ray', at: '2026-11-15T10:00:00Z' } }
      }),
      'PATCH /items/projects/7': () => ({})
    })
    bindRecordOutbox(client, 'u1')
    await twoFields()
    const events: RecordOutboxEvent[] = []
    onRecordOutboxEvent((e) => events.push(e))
    await replayRecordOutbox()
    // Only the non-clashing field went, against the save's own base.
    expect(patchesOf(client)).toEqual([{ budget: 500, _base_revision: 41 }])
    const e = getRecordOutbox()[0]
    expect(e.status).toBe('conflict')
    expect(e.payload).toEqual({ name: 'Mine' })
    expect(e.sent_fields).toEqual(['budget'])
    expect(e.latest_revision).toBe(44)
    expect(e.conflicts).toEqual([
      { field: 'name', current_value: 'Beth name', by: 'Beth Ray', at: '2026-11-15T10:00:00Z' }
    ])
    expect(events.map((x) => x.type)).toEqual(['conflict'])
  })

  it('reads as the viewer: a field left out of their read is not judged by the check', async () => {
    const client = fakeClient({
      'GET /auth/me': me('u1'),
      'GET /revisions': () => ({ data: { latest: 44 } }),
      // `name` is not readable for this person — their read leaves it out.
      'GET /items/projects/7': (cmd) => {
        expect(cmd._params?.fields).toBe('name,budget')
        return { data: { budget: 100 } }
      },
      'PATCH /items/projects/7': () => ({})
    })
    bindRecordOutbox(client, 'u1')
    await twoFields()
    await replayRecordOutbox()
    // Nothing clashed in what they may read: the save goes; the server's own check guards it.
    expect(patchesOf(client)).toEqual([{ name: 'Mine', budget: 500, _base_revision: 41 }])
    expect(getRecordOutbox()).toHaveLength(0)
  })

  it('a server collision on a field the viewer may not read shows no value', async () => {
    let n = 0
    const client = fakeClient({
      'GET /auth/me': me('u1'),
      'GET /revisions': () => ({ data: { latest: 44 } }),
      'GET /items/projects/7': () => ({ data: { budget: 100 } }),
      'PATCH /items/projects/7': () => {
        n++
        if (n === 1)
          throw Object.assign(new Error('Conflict'), {
            status: 409,
            response: {
              code: 'MIDAIR_COLLISION',
              conflicts: [{ field: 'name', current_value: 'Secret value' }],
              latest_revision: 44
            }
          })
        return {}
      }
    })
    bindRecordOutbox(client, 'u1')
    await twoFields()
    await replayRecordOutbox()
    const e = getRecordOutbox()[0]
    expect(e.conflicts).toEqual([{ field: 'name', current_value: null, hidden: true }])
    expect(JSON.stringify(e)).not.toContain('Secret value')
    // The non-clashing field went on the second try.
    expect(patchesOf(client).at(-1)).toEqual({ budget: 500, _base_revision: 41 })
    expect(e.sent_fields).toEqual(['budget'])
  })

  it('no revision newer than the base: sends at once with no field read', async () => {
    const client = fakeClient({
      'GET /auth/me': me('u1'),
      'GET /revisions': () => ({ data: { latest: 41 } }),
      'PATCH /items/projects/7': () => ({})
    })
    bindRecordOutbox(client, 'u1')
    await twoFields()
    await replayRecordOutbox()
    expect(client.calls.some((c) => c._method === 'GET' && c._path === '/items/projects/7')).toBe(
      false
    )
    expect(getRecordOutbox()).toHaveLength(0)
  })
})

describe('deciding the clashes', () => {
  /** Both fields clash; `state` is what the server holds now (changed between steps). */
  async function clashed() {
    const state = {
      latest: 44,
      row: { name: 'Beth name', budget: 'Beth budget' } as Record<string, unknown>
    }
    const client = fakeClient({
      'GET /auth/me': me('u1'),
      'GET /revisions': () => ({ data: { latest: state.latest } }),
      'GET /items/projects/7': () => ({ data: state.row }),
      'PATCH /items/projects/7': () => ({})
    })
    bindRecordOutbox(client, 'u1')
    await enqueueRecordSave({
      collection: 'projects',
      item: '7',
      payload: { name: 'Mine', budget: 'My budget' },
      before: { name: 'Old name', budget: 'Old budget' },
      baseRevision: 41
    })
    await replayRecordOutbox()
    expect(getRecordOutbox()[0].status).toBe('conflict')
    return { client, state }
  }

  it('never sends a clashing field before every clash is decided', async () => {
    const { client } = await clashed()
    expect(patchesOf(client)).toEqual([])
    await resolveRecordOutboxField('projects', '7', 'name', 'mine')
    await replayRecordOutbox()
    expect(patchesOf(client)).toEqual([])
    expect(getRecordOutbox()[0].conflicts?.map((c) => c.field)).toEqual(['budget'])
  })

  it('Keep mine + Take theirs: sends only what was kept, against the reviewed revision', async () => {
    const { client } = await clashed()
    await resolveRecordOutboxField('projects', '7', 'name', 'mine')
    await resolveRecordOutboxField('projects', '7', 'budget', 'theirs')
    const e = getRecordOutbox()[0]
    expect(e).toMatchObject({ status: 'queued', payload: { name: 'Mine' }, base_revision: 44 })
    // Judged against the other person's value from now on.
    expect(e.before).toEqual({ name: 'Beth name' })
    await replayRecordOutbox()
    expect(patchesOf(client)).toEqual([{ name: 'Mine', _base_revision: 44 }])
    expect(getRecordOutbox()).toHaveLength(0)
  })

  it('a further change after the review clashes again instead of being overwritten', async () => {
    const { client, state } = await clashed()
    await resolveRecordOutboxField('projects', '7', 'name', { merged: 'Merged name' })
    await resolveRecordOutboxField('projects', '7', 'budget', 'theirs')
    state.latest = 46
    state.row = { name: 'Cara name', budget: 'Beth budget' }
    await replayRecordOutbox()
    expect(patchesOf(client)).toEqual([])
    expect(getRecordOutbox()[0]).toMatchObject({
      status: 'conflict',
      payload: { name: 'Merged name' },
      conflicts: [{ field: 'name', current_value: 'Cara name' }]
    })
  })

  it('Take theirs on every field drops the save and says so', async () => {
    const { client } = await clashed()
    const events: RecordOutboxEvent[] = []
    onRecordOutboxEvent((e) => events.push(e))
    await resolveRecordOutboxField('projects', '7', 'name', 'theirs')
    await resolveRecordOutboxField('projects', '7', 'budget', 'theirs')
    expect(getRecordOutbox()).toHaveLength(0)
    expect(patchesOf(client)).toEqual([])
    expect(events.map((e) => e.type)).toEqual(['resolved'])
  })
})
