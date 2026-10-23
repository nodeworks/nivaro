import { Server } from 'socket.io'
import { afterEach, describe, expect, it } from 'vitest'
import { notifyJournalListeners } from '../../../services/journal-listeners.js'
import {
  connectionHandlerCount,
  isRealtimeRole,
  judgeRealtimeTier,
  probeRealtimeRouting,
  processRole,
  refuseExtensionSocketHandlers,
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
  const rt = (instance = 'production', beat_at = new Date().toISOString()) => ({
    role: 'realtime',
    instance,
    version: '0.3.12',
    beat_at
  })
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
    expect(judgeRealtimeTier({ ...base, roster: [rt()] }).status).toBe('warn')
    const two = judgeRealtimeTier({ ...base, roster: [rt(), rt()], routed: true, stream: true })
    expect(two.status).toBe('ok')
    expect(two.realtime).toBe(2)
  })

  it('does not count another deployment slot, an entry with no slot, or a stale beat', () => {
    expect(judgeRealtimeTier({ ...base, roster: [rt('staging'), rt('staging')] }).status).toBe(
      'fail'
    )
    expect(
      judgeRealtimeTier({ ...base, roster: [{ role: 'realtime' }, { role: 'realtime' }] }).status
    ).toBe('fail')
    const old = new Date(Date.now() - 60_000).toISOString()
    expect(judgeRealtimeTier({ ...base, roster: [rt(), rt('production', old)] }).status).toBe(
      'warn'
    )
  })

  it('fails without the event stream, or when the proxy sends streams elsewhere', () => {
    const stream = judgeRealtimeTier({ ...base, roster: [rt(), rt()], stream: false })
    expect(stream.status).toBe('fail')
    expect(stream.summary).toMatch(/REALTIME_EVENT_STREAM=off/)
    const routed = judgeRealtimeTier({ ...base, roster: [rt(), rt()], routed: false })
    expect(routed.status).toBe('fail')
    expect(routed.summary).toMatch(/proxy/)
    // Not probed (no PUBLIC_URL, network error): judged on the roster alone.
    expect(judgeRealtimeTier({ ...base, roster: [rt(), rt()], routed: null }).status).toBe('ok')
  })

  it('probes the public stream path for the realtime role header', async () => {
    const answer = (role: string | null) =>
      (async () =>
        new Response('{}', {
          status: 401,
          headers: role ? { 'x-nivaro-role': role } : {}
        })) as unknown as typeof fetch
    expect(await probeRealtimeRouting('https://x.example', answer('realtime'))).toBe(true)
    expect(await probeRealtimeRouting('https://x.example', answer(null))).toBe(false)
    expect(await probeRealtimeRouting(undefined, answer('realtime'))).toBeNull()
    const down = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await probeRealtimeRouting('https://x.example', down)).toBeNull()
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

  it('turns a batched-mode entry into one event per record (or * when too many to list)', () => {
    const seen: SseEvent[] = []
    const off = subscribeSse((e) => seen.push(e))
    startSseRemoteBridge()
    notifyJournalListeners(
      {
        seq: 9,
        room: 't:acme:collection:readings',
        event: 'collection:update',
        payload: {
          collection: 'readings',
          item: null,
          items: [1, 2],
          many: false,
          count: 2,
          action: 'update',
          batched: true
        }
      },
      'remote'
    )
    notifyJournalListeners(
      {
        seq: 10,
        room: 'collection:readings',
        event: 'collection:update',
        payload: { collection: 'readings', item: null, items: null, many: true, batched: true }
      },
      'remote'
    )
    expect(seen.map((e) => [e.item, e.tenant, e.action])).toEqual([
      [1, 'acme', 'update'],
      [2, 'acme', 'update'],
      ['*', '', undefined]
    ])
    off()
  })
})

describe('journal entries sent by the adapter path', () => {
  it('reach the other processes as remote entries', async () => {
    const { wireJournalFallback, JOURNAL_FALLBACK_EVENT } = await import(
      '../../../services/event-journal.js'
    )
    const { onJournalEntry } = await import('../../../services/journal-listeners.js')
    const handlers = new Map<string, (e: unknown) => void>()
    wireJournalFallback({
      on: (ev: string, fn: (e: never) => void) => handlers.set(ev, fn as (e: unknown) => void)
    })
    const got: Array<[unknown, string]> = []
    const off = onJournalEntry((e, origin) => got.push([e.room, origin]))
    handlers.get(JOURNAL_FALLBACK_EVENT)?.({
      seq: 3,
      room: 'collection:projects',
      event: 'collection:update',
      payload: { collection: 'projects', item: 1 }
    })
    handlers.get(JOURNAL_FALLBACK_EVENT)?.({ nonsense: true })
    expect(got).toEqual([['collection:projects', 'remote']])
    off()
  })
})

describe('extension socket handlers with SOCKETS=off', () => {
  it('counts connection handlers on every namespace', () => {
    const io = new Server()
    const base = connectionHandlerCount(io as never)
    io.on('connection', () => {})
    io.of('/ext').on('connect', () => {})
    expect(connectionHandlerCount(io as never)).toBe(base + 2)
  })

  it('stops the boot when an extension adds one and sockets are off; allows it otherwise', () => {
    expect(() => refuseExtensionSocketHandlers(1, 2, false)).toThrow(/SOCKETS=off/)
    expect(() => refuseExtensionSocketHandlers(1, 2, true)).not.toThrow()
    expect(() => refuseExtensionSocketHandlers(1, 1, false)).not.toThrow()
  })
})
