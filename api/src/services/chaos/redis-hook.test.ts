import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { _resetCatalogForTests } from './catalog.js'
import {
  _resetRedisHookStatsForTests,
  chaosRedisClient,
  chaosRedisSubscriber,
  droppedByPartition,
  redisChaosStats,
  refusedAsReadonly
} from './redis-hook.js'
import { _resetRegistryForTests, armFault, CHAOS_CHANNEL, CHAOS_NODE, stopAll } from './registry.js'

interface Sent {
  name: string
  args: unknown[]
  stream: unknown
  at: number
}

/** A client whose sendCommand records what would go on the wire. */
function fakeClient() {
  const sent: Sent[] = []
  const client = {
    sendCommand(
      cmd: { name: string; args: unknown[]; promise?: Promise<unknown> },
      stream?: unknown
    ) {
      sent.push({ name: cmd.name, args: [...cmd.args], stream, at: Date.now() })
      return cmd.promise
    },
    on() {}
  }
  chaosRedisClient(client)
  return { client, sent }
}

const cmd = (name: string, ...args: unknown[]) => ({ name, args, promise: Promise.resolve('x') })

beforeAll(async () => {
  _resetCatalogForTests()
  await import('./faults/redis.js')
  await import('./faults/partition.js')
})

afterEach(async () => {
  vi.useRealTimers()
  await stopAll('test')
  await _resetRegistryForTests()
  _resetRedisHookStatsForTests()
})

describe('redis fault seam (#2832, #2838)', () => {
  it('unarmed: every command goes out unchanged, at once', () => {
    const { client, sent } = fakeClient()
    client.sendCommand(cmd('set', 'cq:a', '1'))
    client.sendCommand(cmd('publish', 'nvr:item-events', 'm'))
    expect(sent.map((s) => s.name)).toEqual(['set', 'publish'])
    expect(sent[0].args).toEqual(['cq:a', '1'])
    expect(redisChaosStats()).toMatchObject({ delayed: 0, readonly: 0, dropped_publishes: 0 })
  })

  it('latency: commands wait the delay; pipelines keep their order', async () => {
    vi.useFakeTimers()
    await armFault({
      fault_key: 'redis_latency',
      params: { delay_ms: 200, jitter_ms: 0 },
      seconds: 30
    })
    const { client, sent } = fakeClient()
    const stream = { isPipeline: true }
    client.sendCommand(cmd('get', 'a'))
    client.sendCommand(cmd('multi'), stream)
    client.sendCommand(cmd('set', 'b', '1'), stream)
    client.sendCommand(cmd('exec'), stream)
    expect(sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(199)
    expect(sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(sent.map((s) => s.name)).toEqual(['get', 'multi', 'set', 'exec'])
  })

  it('READONLY: writes answer the replica error, reads and chaos keys pass', async () => {
    await armFault({ fault_key: 'redis_readonly', seconds: 30 })
    const { client, sent } = fakeClient()
    client.sendCommand(cmd('get', 'sess:1'))
    client.sendCommand(cmd('setex', 'sess:1', 60, 'v'))
    client.sendCommand(cmd('hset', 'nvr:chaos:armed', 'id', 'v'))
    expect(sent[0].name).toBe('get')
    expect(sent[1].name).toBe('eval')
    expect(String(sent[1].args[0])).toContain('READONLY')
    expect(sent[2].name).toBe('hset')
    expect(redisChaosStats().readonly).toBe(1)
    expect(redisChaosStats().errors_last_minute).toBe(1)
  })

  it('READONLY inside MULTI is refused at queue time (EXECABORT on exec, as a replica does)', async () => {
    await armFault({ fault_key: 'redis_readonly', seconds: 30 })
    const { client, sent } = fakeClient()
    const stream = { isPipeline: true }
    client.sendCommand(cmd('multi'), stream)
    client.sendCommand(cmd('del', 'sess:1'), stream)
    client.sendCommand(cmd('exec'), stream)
    expect(sent.map((s) => s.name)).toEqual(['multi', 'chaos-readonly', 'exec'])
  })

  it('scripts are judged by their first key', () => {
    expect(refusedAsReadonly('eval', ['return 1', '1', 'nvr:cron:leader', 'x'])).toBe(true)
    expect(refusedAsReadonly('eval', ['return 1', '1', 'nvr:chaos:armed'])).toBe(false)
    expect(refusedAsReadonly('get', ['a'])).toBe(false)
  })

  it('partition: publishes are swapped for a no-op, never the chaos channel', async () => {
    await armFault({
      fault_key: 'redis_partition',
      target: { kind: 'node', node: CHAOS_NODE },
      seconds: 30
    })
    const { client, sent } = fakeClient()
    client.sendCommand(cmd('publish', 'nvr:item-events', 'm'))
    client.sendCommand(cmd('publish', CHAOS_CHANNEL, 'stop'))
    expect(sent[0]).toMatchObject({ name: 'eval', args: ['return 0', '0'] })
    expect(sent[1].name).toBe('publish')
    expect(droppedByPartition('publish', [CHAOS_CHANNEL])).toBe(false)
    expect(redisChaosStats().dropped_publishes).toBe(1)
  })

  it('partition aimed at another replica changes nothing here', async () => {
    await armFault({
      fault_key: 'redis_partition',
      target: { kind: 'node', node: 'other·1' },
      seconds: 30
    })
    const { client, sent } = fakeClient()
    client.sendCommand(cmd('publish', 'nvr:item-events', 'm'))
    expect(sent[0].name).toBe('publish')
  })

  it('partition: the subscriber hears nothing while armed, everything after Stop all', async () => {
    const heard: string[] = []
    const sub = {
      emit(event: string, ...args: unknown[]) {
        heard.push(`${event}:${args[1]}`)
        return true
      }
    }
    chaosRedisSubscriber(sub)
    sub.emit('message', 'ch', 'a')
    await armFault({
      fault_key: 'redis_partition',
      target: { kind: 'node', node: CHAOS_NODE },
      seconds: 30
    })
    sub.emit('message', 'ch', 'b')
    sub.emit('messageBuffer', 'ch', 'b')
    sub.emit('ready', null, 'r')
    await stopAll('test')
    sub.emit('message', 'ch', 'c')
    expect(heard).toEqual(['message:a', 'ready:r', 'message:c'])
    expect(redisChaosStats().dropped_messages).toBe(1)
  })

  it('every fault ends with its window', async () => {
    vi.useFakeTimers()
    await armFault({ fault_key: 'redis_readonly', seconds: 5 })
    const { client, sent } = fakeClient()
    client.sendCommand(cmd('set', 'a', '1'))
    await vi.advanceTimersByTimeAsync(5001)
    client.sendCommand(cmd('set', 'a', '1'))
    expect(sent.map((s) => s.name)).toEqual(['eval', 'set'])
  })

  it('caps: latency and the window are clamped to the catalog caps', async () => {
    const f = await armFault({
      fault_key: 'redis_latency',
      params: { delay_ms: 60_000 },
      seconds: 99_999
    })
    expect(f.params.delay_ms).toBe(2000)
    expect(f.ends_at - f.started_at).toBe(300_000)
  })
})
