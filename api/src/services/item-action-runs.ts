import { currentTenantKey } from './tenant-rooms.js'

/**
 * One run of an item action per record at a time (2026-11-09: two Push to Fusion presses 63 ms
 * apart both reached the partner — a double click, or two tabs). Held in this process and, when
 * Redis is there, across replicas; the Redis key expires on its own so a crashed run never
 * blocks the record for good.
 */
export interface RunLockRedis {
  set(key: string, value: string, mode: 'EX', ttl: number, nx: 'NX'): Promise<string | null>
  del(key: string): Promise<number>
}

const local = new Set<string>()
const TTL_S = 600

export function itemActionRunKey(actionId: string, collection: string, itemId: string | number) {
  return `nvr:item-action-run:${currentTenantKey() || '-'}:${actionId}:${collection}:${String(itemId)}`
}

/** True = this caller holds the run; false = one is already in flight. */
export async function claimItemActionRun(
  key: string,
  redis: RunLockRedis | null | undefined,
  owner: string
): Promise<boolean> {
  if (local.has(key)) return false
  local.add(key)
  if (redis) {
    try {
      if ((await redis.set(key, owner, 'EX', TTL_S, 'NX')) === null) {
        local.delete(key)
        return false
      }
    } catch {
      /* Redis trouble: the in-process claim still holds on this replica */
    }
  }
  return true
}

export async function releaseItemActionRun(
  key: string,
  redis: RunLockRedis | null | undefined
): Promise<void> {
  local.delete(key)
  await redis?.del(key).catch(() => 0)
}
