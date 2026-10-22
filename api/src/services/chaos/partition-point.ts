import { chaosPoint } from './registry.js'

/**
 * The replica-partition drill's hooks inside the realtime path (#2838), kept in a leaf module
 * so `event-stream.ts` can ask them without importing the journal. The pub/sub half of the
 * partition lives in `redis-hook.ts` (publishes dropped, subscriber messages swallowed); this
 * is the stream half: while a partition with `stream: pause` is armed on this replica, its
 * stream reader stops reading and keeps its offset, so when the window ends it catches up on
 * everything written meanwhile — the path a replica back from a network blip takes.
 */

export const PARTITION_ROOM_PREFIX = 'chaos-partition:'

/** True while this replica's stream reader must hold (a partition armed here, stream paused). */
export function streamPausedByPartition(): boolean {
  const f = chaosPoint('redis.partition')
  return !!f && f.params.stream !== 'keep'
}

const deliveries = new Map<string, { at: number; seqs: number[] }>()
const catchUp = { reads: 0, entries: 0, last_at: null as string | null }

/** The probe id of a partition-probe room, or null (the room may carry a tenant prefix). */
export function probeIdOfRoom(room: string): string | null {
  const i = room.indexOf(PARTITION_ROOM_PREFIX)
  return i < 0 ? null : room.slice(i + PARTITION_ROOM_PREFIX.length) || null
}

/** Record that this replica sent a probe-room event (seq) to its sockets. Cheap for other rooms. */
export function notePartitionDelivery(room: string, seq: number | null | undefined): void {
  if (seq == null || !room.includes(PARTITION_ROOM_PREFIX)) return
  const id = probeIdOfRoom(room)
  if (!id) return
  let slot = deliveries.get(id)
  if (!slot) {
    slot = { at: Date.now(), seqs: [] }
    deliveries.set(id, slot)
    if (deliveries.size > 50) {
      const oldest = [...deliveries.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) deliveries.delete(oldest[0])
    }
  }
  if (slot.seqs.length < 10_000) slot.seqs.push(seq)
}

/** The probe-room seqs this replica delivered, in delivery order (duplicates kept). */
export function partitionDeliveries(probeId: string): number[] {
  return [...(deliveries.get(probeId)?.seqs ?? [])]
}

/** The stream reader's first read after a partition pause: how many entries it caught up on. */
export function notePartitionCatchUp(entries: number): void {
  catchUp.reads++
  catchUp.entries += entries
  catchUp.last_at = new Date().toISOString()
}

export function partitionCatchUpStats(): typeof catchUp {
  return { ...catchUp }
}

/** Tests only. */
export function _resetPartitionPointForTests(): void {
  deliveries.clear()
  catchUp.reads = 0
  catchUp.entries = 0
  catchUp.last_at = null
}
