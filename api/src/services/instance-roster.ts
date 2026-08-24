import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { NIVARO_VERSION } from '../version.js'

/**
 * Instance roster (#297): every API process registers itself in Redis
 * (`nvr:instance:<id>`, 90s TTL refreshed every 30s), so /ops-runtime/roster
 * can answer "which processes are serving, on what version, up how long" —
 * the question behind every rolling-deploy 'is the old one still running'.
 * No Redis = no roster (reported, not fabricated).
 */

const INSTANCE_ID = randomUUID().slice(0, 8)
let redisRef: Redis | null = null
let timer: ReturnType<typeof setInterval> | null = null

async function beat(): Promise<void> {
  if (!redisRef) return
  try {
    await redisRef.set(
      `nvr:instance:${INSTANCE_ID}`,
      JSON.stringify({
        id: INSTANCE_ID,
        host: hostname(),
        pid: process.pid,
        version: NIVARO_VERSION,
        node: process.version,
        started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        uptime_seconds: Math.round(process.uptime()),
        memory_rss_mb: Math.round(process.memoryUsage.rss() / 1_048_576),
        beat_at: new Date().toISOString()
      }),
      'EX',
      90
    )
  } catch {
    /* transient redis failure — next beat retries */
  }
}

export function startInstanceRoster(redis: Redis): void {
  redisRef = redis
  void beat()
  if (!timer) {
    timer = setInterval(() => void beat(), 30_000)
    timer.unref()
  }
}

export async function listInstances(): Promise<Array<Record<string, unknown>>> {
  if (!redisRef) return []
  try {
    const keys: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = await redisRef.scan(cursor, 'MATCH', 'nvr:instance:*', 'COUNT', 100)
      cursor = next
      keys.push(...batch)
    } while (cursor !== '0' && keys.length < 200)
    if (keys.length === 0) return []
    const vals = await redisRef.mget(keys)
    return vals
      .filter((v): v is string => !!v)
      .map((v) => {
        try {
          return JSON.parse(v) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((v): v is Record<string, unknown> => !!v)
      .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
  } catch {
    return []
  }
}
