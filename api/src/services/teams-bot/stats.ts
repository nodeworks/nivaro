import type { FastifyInstance } from 'fastify'

// Per-day send counters for the admin status strip. Redis when the app has it (shared by every
// replica), this process's memory otherwise. A UTC day, expiring after two.

type Kind = 'sent' | 'failed'
const mem = new Map<string, number>()
const TTL_S = 2 * 24 * 60 * 60

type RedisLike = {
  incr: (k: string) => Promise<number>
  expire: (k: string, s: number) => Promise<unknown>
  get: (k: string) => Promise<string | null>
}
const redisOf = (app: FastifyInstance) => (app as { redis?: RedisLike }).redis

const key = (kind: Kind) => `nvr:teams:stat:${new Date().toISOString().slice(0, 10)}:${kind}`

export async function bumpTeamsStat(app: FastifyInstance, kind: Kind): Promise<void> {
  const k = key(kind)
  const redis = redisOf(app)
  if (redis) {
    try {
      if ((await redis.incr(k)) === 1) await redis.expire(k, TTL_S)
      return
    } catch {
      // fall through to memory
    }
  }
  mem.set(k, (mem.get(k) ?? 0) + 1)
}

export async function readTeamsStat(app: FastifyInstance, kind: Kind): Promise<number> {
  const k = key(kind)
  const redis = redisOf(app)
  if (redis) {
    try {
      return Number(await redis.get(k)) || 0
    } catch {
      // fall through to memory
    }
  }
  return mem.get(k) ?? 0
}
