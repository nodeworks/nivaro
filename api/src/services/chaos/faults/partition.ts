import { registerFault } from '../catalog.js'

/**
 * Replica partition (#2838): one replica loses Redis pub/sub — not the database — for the
 * window. Its publishes are dropped and its subscribers (socket adapter, record-event channel)
 * hear nothing (`redis-hook.ts`); with `stream: pause` its event-stream reader holds its offset
 * and catches up when the window ends (`partition-point.ts`). The chaos channel is never cut, so
 * Stop all still reaches it. Prove it with the partition probe:
 * `POST /api/chaos/partition/probe` on another replica, then `GET /api/chaos/checks/partition`
 * on the cut one.
 */

registerFault({
  key: 'redis_partition',
  label: 'Replica cut off from Redis pub/sub',
  area: 'redis',
  proves:
    'A replica cut off from Redis pub/sub loses no record event and doubles none: its stream reader catches up from its offset when the link returns, and presence and huddle rosters rebuild on the next change.',
  claim_keys: ['sockets.reconnect_catchup', 'realtime.partition_catch_up'],
  targets: ['node'],
  params: {
    stream: {
      type: 'enum',
      label: 'Event stream reader',
      options: ['pause', 'keep'],
      default: 'pause'
    }
  },
  max_seconds: 300,
  default_seconds: 30,
  points: ['redis.partition'],
  danger: 'high',
  apply_scope: 'every',
  async apply(fault) {
    const { CHAOS_NODE } = await import('../registry.js')
    if (fault.target.kind !== 'node' || fault.target.node !== CHAOS_NODE) return
    const { redisChaosStats } = await import('../redis-hook.js')
    const { partitionCatchUpStats } = await import('../partition-point.js')
    const before = redisChaosStats()
    const catchBefore = partitionCatchUpStats()
    return () => {
      if (!fault.run_id) return
      const runId = fault.run_id
      // Never awaited: Stop all must not wait for the note. The reader's first read after the
      // window lands within a moment of the release.
      setTimeout(() => {
        void (async () => {
          const after = redisChaosStats()
          const caught = partitionCatchUpStats()
          const { addRunEvent } = await import('../drill.js')
          await addRunEvent(runId, 'note', {
            partition_node: CHAOS_NODE,
            dropped_publishes: after.dropped_publishes - before.dropped_publishes,
            dropped_messages: after.dropped_messages - before.dropped_messages,
            stream_caught_up: caught.entries - catchBefore.entries
          })
        })().catch(() => null)
      }, 1500).unref?.()
    }
  }
})
