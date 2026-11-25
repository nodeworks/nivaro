import { createHash, randomUUID } from 'node:crypto'
import { getApp } from '../io-holder.js'
import type { PromotionBlocker } from './promote-types.js'

/**
 * One promotion per environment (phase 2): the lock nvr:hub:promote:<envId> (SET NX PX 5 min,
 * renewed every 60 s by its runner, compare-and-delete on release) and the cancel flag
 * nvr:hub:promote-cancel:<deployId>. A `running` deploy row belongs to whoever holds its
 * environment's lock: a row whose lock key is gone is stale (its process died). Hub mode is
 * refused in cloud mode, so the keys carry no tenant (as the phase-1 nvr:hub:* keys).
 */

/** A refusal with its HTTP status; a 409 from the planner carries every blocker. */
export class PromotionError extends Error {
  code: string
  status: number
  blockers?: PromotionBlocker[]
  /** PLAN_CHANGED: the plan as it stands now (answered so the person can check it again). */
  plan?: unknown
  constructor(
    code: string,
    message: string,
    status = 400,
    blockers?: PromotionBlocker[],
    plan?: unknown
  ) {
    super(message)
    this.name = 'PromotionError'
    this.code = code
    this.status = status
    if (blockers) this.blockers = blockers
    if (plan !== undefined) this.plan = plan
  }
}

/** Short, so a crashed process blocks its environment for minutes; a live runner renews it. */
export const LOCK_TTL_MS = 5 * 60_000
/** A cancel must outlive the longest step (a 60 min deploy) to land at its boundary. */
export const CANCEL_TTL_MS = 2 * 60 * 60_000
export const LOCK_RENEW_MS = 60_000

export function hubPromoteLockKey(envId: number | string): string {
  return `nvr:hub:promote:${envId}`
}

export function hubPromoteCancelKey(deployId: number | string): string {
  return `nvr:hub:promote-cancel:${deployId}`
}

/**
 * Who holds an environment's lock (ruling X-6b): the lock value starts with it
 * (`<holder>:<uuid>`), so a refusal names the real holder. Creation legs, promotions (and Apply
 * now, a promotion run), Docker stack actions (restart, remove) and Hub deletes take the same
 * per-environment lock. Phase 6: a move of the environment (`move`) and an upgrade of the shared
 * deployment it is placed on (`shared`) take it too.
 */
export type LockHolder =
  | 'creation'
  | 'promotion'
  | 'stack'
  | 'delete'
  | 'move'
  | 'shared'
  // Phase 6: an app-key entry being checked and saved (seconds; routes/hub-shared.ts).
  | 'app-key'
  // Phase 6 (P6-32): a database record being attached to or detached from the environment.
  | 'database'
  // Hub data care: an environment refresh (or its rollback) replacing this environment's database.
  | 'data'
  // Hub config promotion (idea 30): config being applied to (or undone on) this environment.
  | 'config'
const HOLDERS: readonly LockHolder[] = [
  'creation',
  'promotion',
  'stack',
  'delete',
  'move',
  'shared',
  'app-key',
  'database',
  'data',
  'config'
]

const tokenFor = (holder: LockHolder | undefined) => `${holder ?? 'promotion'}:${randomUUID()}`

/** The holder a lock value names; null for a value that names none (an older process's lock). */
export function holderOf(value: string | null | undefined): LockHolder | null {
  const kind = String(value ?? '').split(':', 1)[0]
  return (HOLDERS as readonly string[]).includes(kind) ? (kind as LockHolder) : null
}

/**
 * The refusal for a lock someone else holds, naming the real holder; `fallback` (the caller's own
 * code and words, as before) when the holder is the caller's own kind (`own`), a delete, or
 * cannot be told.
 */
export function lockHolderRefusal(
  holder: LockHolder | null,
  fallback: { code: string; message: string },
  own?: LockHolder
): { code: string; message: string } {
  if (holder === own) return fallback
  if (holder === 'creation')
    return {
      code: 'CREATION_RUNNING',
      message: 'A creation step is running on this environment — wait for it or cancel it.'
    }
  if (holder === 'promotion')
    return {
      code: 'PROMOTION_RUNNING',
      message: 'A promotion of this environment is running — wait for it to end.'
    }
  if (holder === 'stack')
    return {
      code: 'STACK_BUSY',
      message:
        'A stack action (restart or remove) is running on this environment — wait for it to end.'
    }
  if (holder === 'move')
    return {
      code: 'MOVE_RUNNING',
      message: 'A move of this environment is running — wait for it to end or roll it back.'
    }
  if (holder === 'app-key')
    return {
      code: 'APP_KEY_BUSY',
      message: "This environment's encryption key is being saved — try again in a moment."
    }
  if (holder === 'database')
    return {
      code: 'DATABASE_BUSY',
      message:
        "This environment's database record is being attached or detached — try again in a moment."
    }
  if (holder === 'data')
    return {
      code: 'REFRESH_RUNNING',
      message: "This environment's database is being refreshed or rolled back — wait for it to end."
    }
  if (holder === 'config')
    return {
      code: 'CONFIG_PROMOTION_RUNNING',
      message: 'Configuration is being promoted to this environment — wait for it to end.'
    }
  if (holder === 'shared')
    return {
      code: 'SHARED_UPGRADE_RUNNING',
      message:
        'The shared deployment this environment runs on is being upgraded — wait for it to end.'
    }
  return fallback
}

/**
 * A lock holder read that failed (Redis down): 503 LOCK_UNAVAILABLE. holder() throws this rather
 * than answer null, which every caller reads as "nobody holds it".
 */
export function lockUnreadable(): PromotionError {
  return new PromotionError(
    'LOCK_UNAVAILABLE',
    'The Hub cannot reach Redis to tell who holds this lock — try again shortly',
    503
  )
}

/** The slice of ioredis the lock needs. */
export interface PromoteRedis {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>
  get(key: string): Promise<string | null>
  del(...keys: string[]): Promise<unknown>
  exists(key: string): Promise<number>
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
}

export interface PromoteLock {
  /**
   * A token when this caller now holds the environment's lock; null when someone else does.
   * `holder` is recorded in the lock value (default 'promotion').
   */
  take(envId: number, holder?: LockHolder): Promise<string | null>
  /**
   * Who holds the environment's lock now; null when no one (or an older value that names no
   * holder). A Redis error throws PromotionError LOCK_UNAVAILABLE (503): never read as free.
   */
  holder?(envId: number): Promise<LockHolder | null>
  /** Extends the lock while `token` still holds it; false when it no longer does. */
  renew(envId: number, token: string): Promise<boolean>
  /**
   * Phase 6 (move run, R2-M-5): as renew, but a Redis error answers false (lost) instead of
   * "held". Optional: a lock without it is renewed with renew.
   */
  renewStrict?(envId: number, token: string): Promise<boolean>
  /** Deletes the lock only while `token` still holds it. */
  release(envId: number, token: string): Promise<void>
  /** Someone holds the environment's lock; 'unknown' when it cannot be read (never stolen then). */
  held(envId: number): Promise<boolean | 'unknown'>
  requestCancel(deployId: number): Promise<void>
  cancelRequested(deployId: number): Promise<boolean>
  clearCancel(deployId: number): Promise<void>
}

// Redis EVAL of two fixed Lua scripts (compare-and-pexpire, compare-and-delete), never input.
const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

/**
 * The lock on Redis. A Redis that fails while taking it refuses the start (503 LOCK_UNAVAILABLE):
 * a promotion never runs without knowing it is the only one.
 */
export function redisPromoteLock(redis: PromoteRedis): PromoteLock {
  return {
    async take(envId, holder) {
      const token = tokenFor(holder)
      let ok: unknown
      try {
        ok = await redis.set(hubPromoteLockKey(envId), token, 'PX', LOCK_TTL_MS, 'NX')
      } catch {
        throw new PromotionError(
          'LOCK_UNAVAILABLE',
          'The Hub cannot reach Redis to make sure only one promotion runs — try again shortly',
          503
        )
      }
      return ok === 'OK' ? token : null
    },
    async renew(envId, token) {
      try {
        return (
          Number(
            await redis.eval(RENEW_SCRIPT, 1, hubPromoteLockKey(envId), token, LOCK_TTL_MS)
          ) === 1
        )
      } catch {
        return true // a Redis blink is not a lost lock; the next renewal tries again
      }
    },
    async renewStrict(envId, token) {
      try {
        return (
          Number(
            await redis.eval(RENEW_SCRIPT, 1, hubPromoteLockKey(envId), token, LOCK_TTL_MS)
          ) === 1
        )
      } catch {
        return false
      }
    },
    async release(envId, token) {
      await Promise.resolve(redis.eval(RELEASE_SCRIPT, 1, hubPromoteLockKey(envId), token)).catch(
        () => undefined
      )
    },
    async held(envId) {
      try {
        return (await redis.exists(hubPromoteLockKey(envId))) > 0
      } catch {
        return 'unknown'
      }
    },
    async holder(envId) {
      let value: string | null
      try {
        value = await redis.get(hubPromoteLockKey(envId))
      } catch {
        // Never null ("free"): a holder that cannot be read refuses (T15 round 2).
        throw lockUnreadable()
      }
      return holderOf(value)
    },
    async requestCancel(deployId) {
      await Promise.resolve(
        redis.set(hubPromoteCancelKey(deployId), '1', 'PX', CANCEL_TTL_MS)
      ).catch(() => undefined)
    },
    async cancelRequested(deployId) {
      try {
        return (await redis.get(hubPromoteCancelKey(deployId))) != null
      } catch {
        return false
      }
    },
    async clearCancel(deployId) {
      await Promise.resolve(redis.del(hubPromoteCancelKey(deployId))).catch(() => undefined)
    }
  }
}

/** No Redis (a single-process dev Hub): the same lock in this process only. */
const memLocks = new Map<string, { token: string; until: number }>()
const memCancels = new Set<number>()
export const memoryPromoteLock: PromoteLock = {
  async take(envId, holder) {
    const key = hubPromoteLockKey(envId)
    const held = memLocks.get(key)
    if (held && held.until > Date.now()) return null
    const token = tokenFor(holder)
    memLocks.set(key, { token, until: Date.now() + LOCK_TTL_MS })
    return token
  },
  async renew(envId, token) {
    const held = memLocks.get(hubPromoteLockKey(envId))
    if (held?.token !== token) return false
    held.until = Date.now() + LOCK_TTL_MS
    return true
  },
  async release(envId, token) {
    const key = hubPromoteLockKey(envId)
    if (memLocks.get(key)?.token === token) memLocks.delete(key)
  },
  async held(envId) {
    const held = memLocks.get(hubPromoteLockKey(envId))
    return !!held && held.until > Date.now()
  },
  async holder(envId) {
    const held = memLocks.get(hubPromoteLockKey(envId))
    return held && held.until > Date.now() ? holderOf(held.token) : null
  },
  async requestCancel(deployId) {
    memCancels.add(deployId)
  },
  async cancelRequested(deployId) {
    return memCancels.has(deployId)
  },
  async clearCancel(deployId) {
    memCancels.delete(deployId)
  }
}

export function appPromoteRedis(): PromoteRedis | null {
  return (getApp()?.redis as PromoteRedis | undefined) ?? null
}

export function defaultPromoteLock(): PromoteLock {
  const redis = appPromoteRedis()
  return redis ? redisPromoteLock(redis) : memoryPromoteLock
}

/**
 * Phase 6 (preflight R10): one lock per shared deployment, nvr:hub:shared:<id>. A move holds the
 * lock of every shared deployment it touches (`move`), a shared upgrade or rollback its own
 * (`shared`), and placing a new environment on a shared deployment takes it briefly (`place`), as
 * does deleting or retiring the deployment (`delete`, ruling P6-2).
 * Same shape as the environment lock: SET NX PX, renewed by its runner, compare-and-pexpire and
 * compare-and-delete with the same two fixed scripts, the holder named in the value.
 */
export type SharedLockHolder = 'move' | 'shared' | 'place' | 'delete' | 'app-key'
const SHARED_HOLDERS: readonly SharedLockHolder[] = ['move', 'shared', 'place', 'delete', 'app-key']

export function hubSharedLockKey(sharedId: number | string): string {
  return `nvr:hub:shared:${sharedId}`
}

/** The holder a shared lock value names; null for none. */
export function sharedHolderOf(value: string | null | undefined): SharedLockHolder | null {
  const kind = String(value ?? '').split(':', 1)[0]
  return (SHARED_HOLDERS as readonly string[]).includes(kind) ? (kind as SharedLockHolder) : null
}

/** The refusal for a shared deployment someone else holds (409 SHARED_BUSY), naming why. */
export function sharedLockRefusal(holder: SharedLockHolder | null): {
  code: 'SHARED_BUSY'
  message: string
} {
  const why =
    holder === 'shared'
      ? 'an upgrade or rollback of this shared deployment is running'
      : holder === 'move'
        ? 'a move into or out of this shared deployment is running'
        : holder === 'place'
          ? 'an environment is being placed on this shared deployment'
          : holder === 'delete'
            ? 'this shared deployment is being deleted or retired'
            : holder === 'app-key'
              ? "an app's encryption key is being saved"
              : 'another action holds this shared deployment'
  return {
    code: 'SHARED_BUSY',
    message: `The shared deployment is busy: ${why} — wait for it to end.`
  }
}

export interface SharedLock {
  /** A token when this caller now holds the deployment's lock; null when someone else does. */
  take(sharedId: number, holder: SharedLockHolder): Promise<string | null>
  /** Who holds the deployment's lock now; null when no one. A Redis error throws
   *  PromotionError LOCK_UNAVAILABLE (503): never read as free. */
  holder(sharedId: number): Promise<SharedLockHolder | null>
  /** Extends the lock while `token` still holds it; false when it no longer does. */
  renew(sharedId: number, token: string): Promise<boolean>
  /** As renew, but a Redis error answers false (lost) instead of "held" (move run, R2-M-5). */
  renewStrict?(sharedId: number, token: string): Promise<boolean>
  /** Deletes the lock only while `token` still holds it. */
  release(sharedId: number, token: string): Promise<void>
}

const memShared = new Map<string, { token: string; until: number }>()

/**
 * The shared lock on Redis, or in this process only when there is no Redis (a single-process dev
 * Hub). A Redis that fails while taking it refuses (503 LOCK_UNAVAILABLE), as the environment lock.
 */
export function sharedLock(redis: PromoteRedis | null): SharedLock {
  const tokenOf = (holder: SharedLockHolder) => `${holder}:${randomUUID()}`
  if (!redis)
    return {
      async take(id, holder) {
        const key = hubSharedLockKey(id)
        const held = memShared.get(key)
        if (held && held.until > Date.now()) return null
        const token = tokenOf(holder)
        memShared.set(key, { token, until: Date.now() + LOCK_TTL_MS })
        return token
      },
      async holder(id) {
        const held = memShared.get(hubSharedLockKey(id))
        return held && held.until > Date.now() ? sharedHolderOf(held.token) : null
      },
      async renew(id, token) {
        const held = memShared.get(hubSharedLockKey(id))
        if (held?.token !== token) return false
        held.until = Date.now() + LOCK_TTL_MS
        return true
      },
      async release(id, token) {
        const key = hubSharedLockKey(id)
        if (memShared.get(key)?.token === token) memShared.delete(key)
      }
    }
  return {
    async take(id, holder) {
      const token = tokenOf(holder)
      let ok: unknown
      try {
        ok = await redis.set(hubSharedLockKey(id), token, 'PX', LOCK_TTL_MS, 'NX')
      } catch {
        throw new PromotionError(
          'LOCK_UNAVAILABLE',
          'The Hub cannot reach Redis to make sure only one action runs on this shared deployment — try again shortly',
          503
        )
      }
      return ok === 'OK' ? token : null
    },
    async holder(id) {
      let value: string | null
      try {
        value = await redis.get(hubSharedLockKey(id))
      } catch {
        // Never null ("free"): a holder that cannot be read refuses (T15 round 2).
        throw lockUnreadable()
      }
      return sharedHolderOf(value)
    },
    async renew(id, token) {
      try {
        return (
          Number(await redis.eval(RENEW_SCRIPT, 1, hubSharedLockKey(id), token, LOCK_TTL_MS)) === 1
        )
      } catch {
        return true // a Redis blink is not a lost lock; the next renewal tries again
      }
    },
    async renewStrict(id, token) {
      try {
        return (
          Number(await redis.eval(RENEW_SCRIPT, 1, hubSharedLockKey(id), token, LOCK_TTL_MS)) === 1
        )
      } catch {
        return false
      }
    },
    async release(id, token) {
      await Promise.resolve(redis.eval(RELEASE_SCRIPT, 1, hubSharedLockKey(id), token)).catch(
        () => undefined
      )
    }
  }
}

export function defaultSharedLock(): SharedLock {
  return sharedLock(appPromoteRedis())
}

/**
 * One writer per GitLab branch (review H1): nvr:hub:branch:<sha256 of repository identity +
 * branch, 32 hex>. Every Hub run that merges onto, pins on or deploys from a GitLab branch holds
 * it for the whole run: a promotion (each GitLab step's target branch), a shared deployment's
 * upgrade through GitLab and a move's GitLab deploy leg. Same shape as the other locks (SET NX PX,
 * renewed by its runner, compare-and-delete); the holder is named in the value. A held lock is
 * never stolen; a Redis error refuses (503 LOCK_UNAVAILABLE).
 */
export type BranchLockHolder = 'promotion' | 'shared' | 'move'
const BRANCH_HOLDERS: readonly BranchLockHolder[] = ['promotion', 'shared', 'move']

export interface BranchRef {
  /** repositoryIdentity(api, project) of the driver. */
  identity: string
  branch: string
}

export function hubBranchLockKey(ref: BranchRef): string {
  const h = createHash('sha256').update(`${ref.identity}\n${ref.branch}`).digest('hex')
  return `nvr:hub:branch:${h.slice(0, 32)}`
}

export interface BranchLock {
  take(ref: BranchRef, holder: BranchLockHolder): Promise<string | null>
  /** Who holds it now; null when no one. A Redis error throws LOCK_UNAVAILABLE (never free). */
  holder(ref: BranchRef): Promise<BranchLockHolder | null>
  /** Strict: a Redis error is a lost lock. */
  renew(ref: BranchRef, token: string): Promise<boolean>
  release(ref: BranchRef, token: string): Promise<void>
}

const branchHolderOf = (v: string | null | undefined): BranchLockHolder | null => {
  const kind = String(v ?? '').split(':', 1)[0]
  return (BRANCH_HOLDERS as readonly string[]).includes(kind) ? (kind as BranchLockHolder) : null
}

const memBranch = new Map<string, { token: string; until: number }>()

/** The branch lock on Redis, or in this process only with no Redis (a single-process dev Hub). */
export function branchLock(redis: PromoteRedis | null): BranchLock {
  const tokenOf = (holder: BranchLockHolder) => `${holder}:${randomUUID()}`
  if (!redis)
    return {
      async take(ref, holder) {
        const key = hubBranchLockKey(ref)
        const held = memBranch.get(key)
        if (held && held.until > Date.now()) return null
        const token = tokenOf(holder)
        memBranch.set(key, { token, until: Date.now() + LOCK_TTL_MS })
        return token
      },
      async holder(ref) {
        const held = memBranch.get(hubBranchLockKey(ref))
        return held && held.until > Date.now() ? branchHolderOf(held.token) : null
      },
      async renew(ref, token) {
        const held = memBranch.get(hubBranchLockKey(ref))
        if (held?.token !== token) return false
        held.until = Date.now() + LOCK_TTL_MS
        return true
      },
      async release(ref, token) {
        const key = hubBranchLockKey(ref)
        if (memBranch.get(key)?.token === token) memBranch.delete(key)
      }
    }
  return {
    async take(ref, holder) {
      const token = tokenOf(holder)
      let ok: unknown
      try {
        ok = await redis.set(hubBranchLockKey(ref), token, 'PX', LOCK_TTL_MS, 'NX')
      } catch {
        throw new PromotionError(
          'LOCK_UNAVAILABLE',
          'The Hub cannot reach Redis to make sure only one run deploys this GitLab branch — try again shortly',
          503
        )
      }
      return ok === 'OK' ? token : null
    },
    async holder(ref) {
      let value: string | null
      try {
        value = await redis.get(hubBranchLockKey(ref))
      } catch {
        throw lockUnreadable()
      }
      return branchHolderOf(value)
    },
    async renew(ref, token) {
      try {
        return (
          Number(await redis.eval(RENEW_SCRIPT, 1, hubBranchLockKey(ref), token, LOCK_TTL_MS)) === 1
        )
      } catch {
        return false
      }
    },
    async release(ref, token) {
      await Promise.resolve(redis.eval(RELEASE_SCRIPT, 1, hubBranchLockKey(ref), token)).catch(
        () => undefined
      )
    }
  }
}

export function defaultBranchLock(): BranchLock {
  return branchLock(appPromoteRedis())
}

/** The refusal for a GitLab branch another run deploys (409 BRANCH_BUSY), naming the holder. */
export function branchLockRefusal(ref: BranchRef, holder: BranchLockHolder | null): PromotionError {
  const who =
    holder === 'promotion'
      ? 'a promotion'
      : holder === 'shared'
        ? 'a shared deployment upgrade'
        : holder === 'move'
          ? 'a move'
          : 'another Hub run'
  return new PromotionError(
    'BRANCH_BUSY',
    `${ref.branch} is being deployed by ${who} — wait for it to end.`,
    409
  )
}

/** Branches held for one run: renewed every LOCK_RENEW_MS until released. */
export interface BranchHold {
  /** A renewal failed: another run may hold the branch now. */
  lost(): boolean
  release(): Promise<void>
}

/**
 * Takes the lock of every distinct branch in `refs` (in a fixed order, so two runs never take
 * them crosswise) and keeps them renewed. Throws BRANCH_BUSY (nothing kept) when one is held.
 */
export async function holdBranches(
  lock: BranchLock,
  refs: BranchRef[],
  holder: BranchLockHolder,
  renewMs = LOCK_RENEW_MS
): Promise<BranchHold> {
  const unique = [...new Map(refs.map((r) => [hubBranchLockKey(r), r])).entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )
  const held: Array<{ ref: BranchRef; token: string }> = []
  try {
    for (const [, ref] of unique) {
      const token = await lock.take(ref, holder)
      if (!token) throw branchLockRefusal(ref, await lock.holder(ref).catch(() => null))
      held.push({ ref, token })
    }
  } catch (err) {
    for (const h of held) await lock.release(h.ref, h.token)
    throw err
  }
  let lost = false
  const timer = held.length
    ? setInterval(() => {
        void Promise.all(
          held.map(async (h) => {
            if (!(await lock.renew(h.ref, h.token).catch(() => false))) lost = true
          })
        )
      }, renewMs)
    : null
  timer?.unref?.()
  return {
    lost: () => lost,
    async release() {
      if (timer) clearInterval(timer)
      for (const h of held) await lock.release(h.ref, h.token).catch(() => undefined)
    }
  }
}
