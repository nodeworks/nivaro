import { afterEach, describe, expect, it } from 'vitest'
import { notifyJournalListeners } from '../../../services/journal-listeners.js'
import {
  isRealtimeRole,
  judgeRealtimeTier,
  processRole,
  socketsServed
} from '../../../services/process-role.js'
import { canaryLenient } from '../../../services/render-peer.js'
import {
  type SseEvent,
  startSseRemoteBridge,
  stopSseRemoteBridge,
  subscribeSse
} from '../../../services/sse-hub.js'

describe('process roles (post-mortem 3.3)', () => {
  it('reads NIVARO_ROLE trimmed and lower-cased', () => {
    expect(processRole({})).toBeNull()
    expect(processRole({ NIVARO_ROLE: ' Realtime ' })).toBe('realtime')
    expect(isRealtimeRole({ NIVARO_ROLE: 'realtime' })).toBe(true)
    expect(isRealtimeRole({ NIVARO_ROLE: 'web' })).toBe(false)
  })

  it('keeps sockets on unless SOCKETS=off (nothing set = unchanged)', () => {
    expect(socketsServed({})).toBe(true)
    expect(socketsServed({ NIVARO_ROLE: 'web' })).toBe(true)
    expect(socketsServed({ NIVARO_ROLE: 'web', SOCKETS: 'off' })).toBe(false)
    expect(socketsServed({ NIVARO_ROLE: 'worker', SOCKETS: ' OFF ' })).toBe(false)
    expect(socketsServed({ SOCKETS: 'on' })).toBe(true)
  })

  it('always serves sockets on a realtime process and in cloud mode', () => {
    expect(socketsServed({ NIVARO_ROLE: 'realtime', SOCKETS: 'off' })).toBe(true)
    expect(socketsServed({ SOCKETS: 'off', CLOUD_META_DB_URL: 'postgres://x' })).toBe(true)
  })
})

describe('judgeRealtimeTier', () => {
  const rt = (instance?: string) => ({ role: 'realtime', instance, version: '0.3.12' })
  const base = { served: false, redis: true, instance: 'production' }

  it('passes a process that serves sockets itself without reading the roster', () => {
    expect(judgeRealtimeTier({ ...base, served: true, roster: [] }).status).toBe('ok')
  })

  it('fails SOCKETS=off with no realtime process, or without Redis', () => {
    const none = judgeRealtimeTier({ ...base, roster: [{ role: 'web' }, { role: 'worker' }] })
    expect(none.status).toBe('fail')
    expect(none.summary).toMatch(/no realtime process/)
    expect(judgeRealtimeTier({ ...base, redis: false, roster: [rt(), rt()] }).status).toBe('fail')
  })

  it('warns with one realtime process and passes with two', () => {
    expect(judgeRealtimeTier({ ...base, roster: [rt('production')] }).status).toBe('warn')
    const two = judgeRealtimeTier({ ...base, roster: [rt('production'), rt()] })
    expect(two.status).toBe('ok')
    expect(two.realtime).toBe(2)
  })

  it('does not count another deployment slot sharing the Redis', () => {
    const v = judgeRealtimeTier({ ...base, roster: [rt('staging'), rt('staging')] })
    expect(v.status).toBe('fail')
  })

  it('only warns on a deploy canary', () => {
    const v = canaryLenient(judgeRealtimeTier({ ...base, roster: [] }), 'canary')
    expect(v.status).toBe('warn')
  })
})

describe('SSE remote bridge', () => {
  afterEach(() => stopSseRemoteBridge())

  it("hands other replicas' record changes to /events/stream listeners, never local ones twice", () => {
    const seen: SseEvent[] = []
    const off = subscribeSse((e) => seen.push(e))
    startSseRemoteBridge()
    const entry = {
      seq: 7,
      room: 'collection:projects',
      event: 'collection:update',
      payload: { collection: 'projects', item: 42, action: 'update', changed_fields: ['name'] }
    }
    notifyJournalListeners(entry, 'local')
    expect(seen).toHaveLength(0)
    notifyJournalListeners(entry, 'remote')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      collection: 'projects',
      item: 42,
      action: 'update',
      changed_fields: ['name'],
      tenant: ''
    })
    // Not a record change: ignored.
    notifyJournalListeners({ ...entry, room: 'user:1', event: 'notification:new' }, 'remote')
    expect(seen).toHaveLength(1)
    off()
  })
})
