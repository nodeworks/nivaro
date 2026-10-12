import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { broadcasts, roomEmits, owners } = vi.hoisted(() => ({
  broadcasts: [] as Array<{ collection: string; item: unknown; extra: unknown }>,
  roomEmits: [] as Array<{ room: string | null; event: string; payload: unknown }>,
  owners: { listener: null as (() => void) | null }
}))

vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => ({
    where: () => ({
      select: () => ({
        first: async () =>
          table === 'nivaro_addendums'
            ? { parent_collection: 'workflows', parent_id: '42' }
            : undefined
      }),
      first: async () =>
        table === 'nivaro_erp_submissions' ? { collection: 'workflows', item: '7' } : undefined
    })
  }))
}))
vi.mock('../../../db/owner-signal.js', () => ({
  onOwnersChanged: (fn: () => void) => {
    owners.listener = fn
    return () => {}
  }
}))
vi.mock('../../../services/realtime.js', () => ({
  broadcastCollectionUpdate: (_io: unknown, collection: string, item: unknown, extra: unknown) =>
    broadcasts.push({ collection, item, extra })
}))
vi.mock('../../../services/io-holder.js', () => ({
  getIo: () => ({
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => roomEmits.push({ room, event, payload })
    }),
    emit: (event: string, payload: unknown) => roomEmits.push({ room: null, event, payload })
  })
}))

import {
  ACCESS_ROUTES,
  announceAccessChanged,
  announceAddendumChange,
  announceAutomation,
  announceRecordAspect,
  announceSubmissionAspect,
  emitRecordEvent,
  flowRecordOf
} from '../../../services/record-events.js'

beforeEach(() => {
  broadcasts.length = 0
  roomEmits.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

describe('announceRecordAspect', () => {
  it('rides collection:update with no action and $-named fields only', () => {
    announceRecordAspect('workflows', 5, '$state')
    announceRecordAspect('workflows', '6', ['$tasks', '$comments'])
    expect(broadcasts).toEqual([
      { collection: 'workflows', item: 5, extra: { changed_fields: ['$state'] } },
      { collection: 'workflows', item: '6', extra: { changed_fields: ['$tasks', '$comments'] } }
    ])
  })

  it('ignores a missing collection or item', () => {
    announceRecordAspect(null, 5, '$state')
    announceRecordAspect('workflows', null, '$state')
    announceRecordAspect('workflows', '', '$state')
    expect(broadcasts).toHaveLength(0)
  })
})

describe('addendum + submission notices', () => {
  it('tells the addendum and its parent, looking the parent up when not given', async () => {
    await announceAddendumChange('a1')
    expect(broadcasts.map((b) => [b.collection, b.item])).toEqual([
      ['nivaro_addendums', 'a1'],
      ['workflows', '42']
    ])
  })

  it('uses the parent it is handed', async () => {
    await announceAddendumChange('a2', { collection: 'projects', id: 9 })
    expect(broadcasts.map((b) => [b.collection, b.item])).toEqual([
      ['nivaro_addendums', 'a2'],
      ['projects', 9]
    ])
  })

  it('resolves a submission to its record', async () => {
    await announceSubmissionAspect(3)
    expect(broadcasts).toEqual([
      { collection: 'workflows', item: '7', extra: { changed_fields: ['$integrations'] } }
    ])
  })
})

describe('record-room events', () => {
  it('emits ids and names only to the record room', () => {
    emitRecordEvent('workflows', 12, 'record:integrity')
    announceAutomation({ collection: 'workflows', item: '12' }, { id: 'f1', name: 'Sync' }, 'start')
    expect(roomEmits).toEqual([
      {
        room: 'record:workflows:12',
        event: 'record:integrity',
        payload: { collection: 'workflows', item: '12' }
      },
      {
        room: 'record:workflows:12',
        event: 'record:automation',
        payload: {
          flow_id: 'f1',
          flow_name: 'Sync',
          state: 'start',
          collection: 'workflows',
          item: '12'
        }
      }
    ])
  })
})

describe('flowRecordOf', () => {
  it('reads collection + item, keys[0], key or id', () => {
    expect(flowRecordOf({ collection: 'workflows', item: 4 })).toEqual({
      collection: 'workflows',
      item: '4'
    })
    expect(flowRecordOf({ collection: 'workflows', keys: ['9', '10'] })).toEqual({
      collection: 'workflows',
      item: '9'
    })
    expect(flowRecordOf({ collection: 'workflows', key: 'x' })?.item).toBe('x')
  })

  it('skips system collections and payloads without a record', () => {
    expect(flowRecordOf({ collection: 'nivaro_users', item: 1 })).toBeNull()
    expect(flowRecordOf({ collection: 'workflows' })).toBeNull()
    expect(flowRecordOf({ collection: 'workflows', item: { id: 1 } })).toBeNull()
    expect(flowRecordOf(null)).toBeNull()
  })
})

describe('coalesced broadcasts', () => {
  it('owners:changed fires once per window', () => {
    vi.useFakeTimers()
    owners.listener?.()
    owners.listener?.()
    owners.listener?.()
    expect(roomEmits).toHaveLength(0)
    vi.advanceTimersByTime(5000)
    expect(roomEmits.map((e) => [e.room, e.event])).toEqual([[null, 'owners:changed']])
  })

  it('access:changed fires once per window', () => {
    vi.useFakeTimers()
    announceAccessChanged()
    announceAccessChanged()
    vi.advanceTimersByTime(2000)
    expect(roomEmits.map((e) => [e.room, e.event])).toEqual([[null, 'access:changed']])
  })
})

describe('ACCESS_ROUTES', () => {
  it.each([
    '/api/roles/abc',
    '/api/roles/abc/policies',
    '/api/user-scopes/u1',
    '/api/scope-dimensions/3',
    '/api/tree-permissions/5',
    '/api/access-requests/9/resolve',
    '/api/users/bulk',
    '/api/users/me/scopes/zone',
    '/api/users/u1/copy-access',
    '/api/users/u1',
    '/api/users/u1?x=1'
  ])('matches %s', (url) => expect(ACCESS_ROUTES.test(url)).toBe(true))

  it.each([
    '/api/users/me',
    '/api/users/me/preferences',
    '/api/users/u1/token',
    '/api/items/workflows/1',
    '/api/access-requests'
  ])('ignores %s', (url) => expect(ACCESS_ROUTES.test(url)).toBe(false))
})
