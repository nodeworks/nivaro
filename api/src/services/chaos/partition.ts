import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { journaledEmit } from '../event-journal.js'
import { getApp, getIo } from '../io-holder.js'
import { tenantScopedRoom } from '../tenant-rooms.js'
import { ChaosError } from './gate.js'
import {
  PARTITION_ROOM_PREFIX,
  partitionCatchUpStats,
  partitionDeliveries
} from './partition-point.js'
import { redisChaosStats } from './redis-hook.js'
import { CHAOS_NODE } from './registry.js'

/**
 * The partition probe (#2838): proof that a replica cut off from Redis pub/sub loses nothing
 * and doubles nothing. Started on a replica that is NOT cut off, it joins a socket (any replica
 * — the adapter carries the join, so start it before the partition) to a private room and sends
 * `count` journaled events into it, one every `interval_ms`, recording each event's journal seq
 * in Redis. Every replica records the seqs it sent to that room's sockets (`partition-point.ts`);
 * the check compares the two on the replica asked: lost = expected but never delivered there,
 * doubled = delivered more than once. Payloads carry the probe id and a counter only.
 */

const EXPECTED_TTL_S = 3600
const expectedKey = (id: string) => `nvr:chaos:partition:${id}`
const expectedHere = new Map<string, { at: number; seqs: number[]; done: boolean }>()

export interface ProbeStart {
  probe_id: string
  room: string
  count: number
  interval_ms: number
  node: string
}

function redis(): Redis | null {
  return (getApp()?.redis as Redis | undefined) ?? null
}

export async function startPartitionProbe(opts: {
  sid?: string | null
  count?: number
  interval_ms?: number
}): Promise<ProbeStart> {
  const io = getIo()
  if (!io) throw new ChaosError('no socket server on this replica', 503, 'CHAOS_NO_SOCKETS')
  const count = Math.min(500, Math.max(1, Math.round(Number(opts.count) || 30)))
  const interval = Math.min(10_000, Math.max(50, Math.round(Number(opts.interval_ms) || 500)))
  const id = randomUUID()
  const room = tenantScopedRoom(`${PARTITION_ROOM_PREFIX}${id}`)
  if (opts.sid) await io.in(String(opts.sid).slice(0, 64)).socketsJoin(room)
  const slot = { at: Date.now(), seqs: [] as number[], done: false }
  expectedHere.set(id, slot)
  if (expectedHere.size > 50) {
    const oldest = [...expectedHere.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) expectedHere.delete(oldest[0])
  }
  void (async () => {
    for (let n = 1; n <= count; n++) {
      try {
        const r = await journaledEmit(
          room,
          'chaos:partition',
          { probe: id, n },
          { roomScoped: true }
        )
        if (r.seq != null) {
          slot.seqs.push(r.seq)
          await redis()
            ?.multi()
            .rpush(expectedKey(id), String(r.seq))
            .expire(expectedKey(id), EXPECTED_TTL_S)
            .exec()
            .catch(() => null)
        }
      } catch {
        /* a failed emit is a gap the check will show */
      }
      if (n < count) await new Promise((res) => setTimeout(res, interval))
    }
    slot.done = true
    await redis()
      ?.set(`${expectedKey(id)}:done`, '1', 'EX', EXPECTED_TTL_S)
      .catch(() => null)
  })()
  return { probe_id: id, room, count, interval_ms: interval, node: CHAOS_NODE }
}

export interface PartitionComparison {
  lost: number[]
  doubled: number[]
  unexpected: number[]
}

/** Expected vs delivered seqs (pure). */
export function comparePartition(expected: number[], delivered: number[]): PartitionComparison {
  const seen = new Map<number, number>()
  for (const s of delivered) seen.set(s, (seen.get(s) ?? 0) + 1)
  const want = new Set(expected)
  return {
    lost: expected.filter((s) => !seen.has(s)),
    doubled: [...seen.entries()].filter(([, n]) => n > 1).map(([s]) => s),
    unexpected: [...seen.keys()].filter((s) => !want.has(s))
  }
}

export interface PartitionReport extends PartitionComparison {
  probe_id: string
  node: string
  /** False while the origin is still sending. */
  done: boolean
  expected: number
  delivered: number
  /** Sockets in the probe room on this replica (0 = nothing here to judge). */
  members_here: number
  /** True when this replica sent the events itself (its sockets got them locally, not by stream). */
  origin: boolean
  catch_up: ReturnType<typeof partitionCatchUpStats>
  pubsub: ReturnType<typeof redisChaosStats>
}

export async function partitionReport(probeId: string): Promise<PartitionReport> {
  const id = String(probeId).slice(0, 64)
  const local = expectedHere.get(id)
  let expected = local?.seqs ?? []
  let done = local?.done ?? false
  if (!local) {
    const r = redis()
    if (r) {
      try {
        expected = (await r.lrange(expectedKey(id), 0, -1)).map(Number).filter(Number.isFinite)
        done = (await r.get(`${expectedKey(id)}:done`)) === '1'
      } catch {
        /* Redis down: nothing to compare against */
      }
    }
  }
  const room = tenantScopedRoom(`${PARTITION_ROOM_PREFIX}${id}`)
  const io = getIo()
  const members = io?.of('/').adapter.rooms.get(room)?.size ?? 0
  // The origin emitted to its own sockets locally (journaledEmit), never through its reader.
  const delivered = local ? [...expected] : partitionDeliveries(id)
  return {
    probe_id: id,
    node: CHAOS_NODE,
    done,
    expected: expected.length,
    delivered: delivered.length,
    members_here: members,
    origin: !!local,
    ...comparePartition(expected, delivered),
    catch_up: partitionCatchUpStats(),
    pubsub: redisChaosStats()
  }
}

/** Tests only. */
export function _resetPartitionForTests(): void {
  expectedHere.clear()
}
