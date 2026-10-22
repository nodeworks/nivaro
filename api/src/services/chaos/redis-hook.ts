import { CHAOS_CHANNEL, chaosNumber, chaosPoint } from './registry.js'

/**
 * The Redis fault seam (#2832, #2838): one `sendCommand` wrapper on the app's command clients
 * (`plugins/redis.ts`, the socket adapter's publisher) and one `emit` wrapper on the subscriber
 * connections (the socket adapter, the record-event channel). Nothing changes while no fault is
 * armed — every check is the registry's O(1) `chaosPoint`, which answers null at once.
 *
 *   redis.latency    every command waits `delay_ms` (± `jitter_ms`) before it is written
 *   redis.readonly   writes answer the `READONLY` error a replica gives during a failover
 *   redis.partition  this replica's pub/sub is cut: publishes are dropped, subscribers hear nothing
 *
 * READONLY is produced by Redis itself (the write is swapped for a script that returns that
 * error), so pipelines and MULTI keep their reply order and callers see the exact ReplyError
 * ioredis gives on a real failover. Keys under `nvr:chaos:` and the chaos channel are never
 * touched: Stop all must still reach every replica.
 */

/** Commands that write (a replica refuses these with READONLY). */
const WRITE_COMMANDS = new Set(
  [
    'set setex psetex setnx getset getdel getex mset msetnx append',
    'del unlink expire pexpire expireat pexpireat persist rename renamenx',
    'incr incrby incrbyfloat decr decrby hset hsetnx hmset hdel hincrby hincrbyfloat',
    'lpush rpush lpushx rpushx lpop rpop lset ltrim lrem linsert lmove sadd srem spop smove',
    'zadd zrem zincrby zremrangebyrank zremrangebyscore zpopmin zpopmax',
    'xadd xtrim xdel xack xgroup xclaim xautoclaim pfadd pfmerge restore copy',
    'flushdb flushall eval evalsha'
  ]
    .join(' ')
    .split(' ')
)

const SUBSCRIBER_EVENTS = new Set([
  'message',
  'messageBuffer',
  'pmessage',
  'pmessageBuffer',
  'smessage',
  'smessageBuffer'
])

const READONLY_MESSAGE = "READONLY You can't write against a read only replica."
const READONLY_SCRIPT = `return redis.error_reply("${READONLY_MESSAGE}")`
/** Inside MULTI, Redis must refuse at queue time (then EXECABORT), as a real replica does. */
const QUEUE_REFUSED = 'chaos-readonly'

const stats = {
  delayed: 0,
  readonly: 0,
  dropped_publishes: 0,
  dropped_messages: 0
}
/** Times (ms) of Redis errors this process saw: injected READONLY replies and client errors. */
const errorTimes: number[] = []

/** Count one Redis error (the `Redis errors/min` sampler reads it). */
export function noteRedisError(at = Date.now()): void {
  errorTimes.push(at)
  if (errorTimes.length > 5000) errorTimes.splice(0, errorTimes.length - 5000)
}

/** Redis errors in the last 60 s on this process. */
export function redisErrorsLastMinute(now = Date.now()): number {
  const cutoff = now - 60_000
  while (errorTimes.length && errorTimes[0] < cutoff) errorTimes.shift()
  return errorTimes.length
}

export function redisChaosStats(): typeof stats & { errors_last_minute: number } {
  return { ...stats, errors_last_minute: redisErrorsLastMinute() }
}

interface CommandLike {
  name?: string
  args?: unknown[]
  promise?: Promise<unknown>
}
type SendCommand = (cmd: CommandLike, ...rest: unknown[]) => unknown

const PATCHED = Symbol.for('nivaro.chaosRedisHook')
const PATCHED_SUB = Symbol.for('nivaro.chaosRedisSubscriber')

function keyText(v: unknown): string {
  if (typeof v === 'string') return v
  if (Buffer.isBuffer(v)) return v.toString('latin1', 0, 64)
  return ''
}

/** Is this command one the READONLY fault answers (a write, never the chaos keys)? Pure. */
export function refusedAsReadonly(name: string, args: unknown[] | undefined): boolean {
  if (!WRITE_COMMANDS.has(name)) return false
  // Scripts name their keys after the key count; everything else leads with its key.
  const first =
    name === 'eval' || name === 'evalsha'
      ? Number(keyText(args?.[1])) > 0
        ? keyText(args?.[2])
        : ''
      : keyText(args?.[0])
  return !first.startsWith('nvr:chaos:')
}

/** Is this a publish the partition drops (every channel but the chaos channel)? Pure. */
export function droppedByPartition(name: string, args: unknown[] | undefined): boolean {
  if (name !== 'publish' && name !== 'spublish') return false
  return !keyText(args?.[0]).startsWith(CHAOS_CHANNEL)
}

/**
 * Wrap a command client's `sendCommand` once. Safe to call on any object: one without a
 * `sendCommand` is left alone. The Traffic Map tap (`instrumentRedis`) may wrap it as well.
 */
export function chaosRedisClient(client: unknown): void {
  const c = client as Record<string | symbol, unknown> & { sendCommand?: SendCommand }
  if (!c || typeof c.sendCommand !== 'function' || c[PATCHED]) return
  const orig = c.sendCommand.bind(c) as SendCommand
  /** Pipeline streams that opened a MULTI (their writes must fail at queue time). */
  const multiStreams = new WeakSet<object>()
  c.sendCommand = (cmd: CommandLike, ...rest: unknown[]) => {
    const name = String(cmd?.name ?? '').toLowerCase()
    const stream = rest[0] && typeof rest[0] === 'object' ? (rest[0] as object) : null
    if (name === 'multi' && stream) multiStreams.add(stream)

    if (chaosPoint('redis.partition') && droppedByPartition(name, cmd?.args)) {
      stats.dropped_publishes++
      // Swapped for a script answering 0 ("no subscriber heard it"), never skipped: a skipped
      // command would leave a pipeline waiting for its reply forever.
      cmd.name = 'eval'
      cmd.args = ['return 0', '0']
    } else if (chaosPoint('redis.readonly') && refusedAsReadonly(name, cmd?.args)) {
      stats.readonly++
      noteRedisError()
      if (stream && multiStreams.has(stream)) {
        cmd.name = QUEUE_REFUSED
        cmd.args = []
      } else {
        cmd.name = 'eval'
        cmd.args = [READONLY_SCRIPT, '0']
      }
    }
    const delay = chaosNumber('redis.latency', 'delay_ms')
    if (delay > 0) {
      stats.delayed++
      // A pipeline's commands must keep their order: no jitter for them.
      const jitter = stream ? 0 : chaosNumber('redis.latency', 'jitter_ms')
      const wait = Math.max(0, Math.round(delay + (jitter ? (Math.random() * 2 - 1) * jitter : 0)))
      setTimeout(() => {
        try {
          orig(cmd, ...rest)
        } catch {
          /* ioredis rejects the command's own promise */
        }
      }, wait)
      return cmd.promise
    }
    return orig(cmd, ...rest)
  }
  c[PATCHED] = true
  const on = (c as { on?: (ev: string, fn: () => void) => void }).on
  if (typeof on === 'function') on.call(c, 'error', () => noteRedisError())
}

/**
 * Wrap a SUBSCRIBER connection's `emit` once: while a partition is armed on this replica, its
 * messages are swallowed (the connection stays up — the replica just stops hearing anyone).
 */
export function chaosRedisSubscriber(client: unknown): void {
  const c = client as Record<string | symbol, unknown> & {
    emit?: (event: string | symbol, ...args: unknown[]) => boolean
  }
  if (!c || typeof c.emit !== 'function' || c[PATCHED_SUB]) return
  const orig = c.emit.bind(c)
  c.emit = (event: string | symbol, ...args: unknown[]) => {
    if (
      typeof event === 'string' &&
      SUBSCRIBER_EVENTS.has(event) &&
      chaosPoint('redis.partition')
    ) {
      // Count each message once (ioredis emits the string and the Buffer form).
      if (!event.endsWith('Buffer')) stats.dropped_messages++
      return false
    }
    return orig(event, ...args)
  }
  c[PATCHED_SUB] = true
}

/** Tests only. */
export function _resetRedisHookStatsForTests(): void {
  stats.delayed = 0
  stats.readonly = 0
  stats.dropped_publishes = 0
  stats.dropped_messages = 0
  errorTimes.length = 0
}
