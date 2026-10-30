import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { User } from '../../types.js'
import { currentTenantKey } from '../tenant-rooms.js'

/**
 * CC-30 — nudge the people who own a record's current step: "can you look at this?". The caller
 * must be able to open the record (else 404, the same answer as a record that does not exist);
 * one nudge per person per record per NUDGE_WINDOW_S (429 with the wait); the owners are the
 * resolved owners of the open instance's current state (owner groups, manual owners, delegates —
 * the queues' resolver); each is notified through notifyUser (inbox, push, their rules) and the
 * nudge is logged as activity on the record.
 */
export const NUDGE_WINDOW_S = 30 * 60
export const NUDGE_MESSAGE_MAX = 500
/** One person may send at most this many nudges an hour, across all records. */
export const NUDGE_SENDER_PER_HOUR = 20
export const NUDGE_SENDER_WINDOW_S = 3600
/** At most this many owners are notified by one nudge. */
export const NUDGE_MAX_OWNERS = 25

export interface NudgeStore {
  /** Set `key` for `ttlS` unless present; true = it was free (now taken). */
  claim(key: string, ttlS: number): Promise<boolean>
  /** Seconds left on `key`, 0 = free. */
  ttl(key: string): Promise<number>
  release(key: string): Promise<void>
  /** Count one use of `key` (window of `ttlS` from the first); returns the count so far. */
  bump(key: string, ttlS: number): Promise<number>
}

/** Redis-backed when the app has Redis, else a process-local map (single process dev). */
export function nudgeStore(redis: unknown): NudgeStore {
  const r = redis as {
    set?: (...a: unknown[]) => Promise<unknown>
    ttl?: (k: string) => Promise<number>
    del?: (k: string) => Promise<unknown>
    incr?: (k: string) => Promise<number>
    expire?: (k: string, s: number) => Promise<unknown>
  } | null
  if (r?.set && r.ttl && r.del && r.incr && r.expire) {
    return {
      bump: async (k, ttl) => {
        const n = Number(await r.incr!(k))
        if (n === 1) await r.expire!(k, ttl)
        return n
      },
      claim: async (k, ttl) => (await r.set!(k, '1', 'EX', ttl, 'NX')) === 'OK',
      ttl: async (k) => Math.max(0, Number(await r.ttl!(k))),
      release: async (k) => {
        await r.del!(k)
      }
    }
  }
  return memoryNudgeStore()
}

export function memoryNudgeStore(now: () => number = Date.now): NudgeStore {
  const m = new Map<string, number>()
  const counts = new Map<string, { n: number; until: number }>()
  const left = (k: string) =>
    Math.max(0, Math.ceil((Math.max(m.get(k) ?? 0, counts.get(k)?.until ?? 0) - now()) / 1000))
  return {
    bump: async (k, ttl) => {
      const c = counts.get(k)
      if (!c || c.until <= now()) {
        counts.set(k, { n: 1, until: now() + ttl * 1000 })
        return 1
      }
      c.n++
      return c.n
    },
    claim: async (k, ttl) => {
      if (left(k) > 0) return false
      m.set(k, now() + ttl * 1000)
      return true
    },
    ttl: async (k) => left(k),
    release: async (k) => {
      m.delete(k)
    }
  }
}

export interface NudgeDeps {
  canSee: (user: User, collection: string, id: string, isAdmin: boolean) => Promise<boolean>
  owners: (collection: string, id: string) => Promise<Array<{ id: string; name: string }>>
  label: (collection: string, id: string) => Promise<string>
  notify: (
    userId: string,
    opts: { subject: string; message: string; collection: string; item: string; sender: string }
  ) => Promise<unknown>
  log: (opts: { collection: string; item: string; comment: string }) => Promise<unknown>
  store: NudgeStore
  tenant?: string
}

export type NudgeResult =
  | { status: 200; body: { data: { notified: number; names: string[] } } }
  | { status: 400 | 404 | 409; body: { error: string } }
  | { status: 429; body: { error: string; retry_after_s: number } }

const NAME = /^[A-Za-z0-9_]{1,64}$/
const ID = /^[A-Za-z0-9_-]{1,64}$/

export function nudgeKey(tenant: string, userId: string, collection: string, id: string): string {
  return `nvr:cc:nudge:${tenant || '-'}:${userId.toUpperCase()}:${collection}:${id.toUpperCase()}`
}

export function nudgeSenderKey(tenant: string, userId: string): string {
  return `nvr:cc:nudge-sender:${tenant || '-'}:${userId.toUpperCase()}`
}

const displayName = (u: User) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Someone'

export async function runNudge(
  user: User,
  isAdmin: boolean,
  body: unknown,
  deps: NudgeDeps
): Promise<NudgeResult> {
  const b = (body ?? {}) as { collection?: unknown; item?: unknown; message?: unknown }
  const collection = typeof b.collection === 'string' ? b.collection : ''
  const id = b.item == null ? '' : String(b.item)
  if (!NAME.test(collection) || /^(nivaro_|directus_)/i.test(collection) || !ID.test(id))
    return { status: 400, body: { error: 'Say which record to nudge about' } }
  const message = typeof b.message === 'string' ? b.message.trim().slice(0, NUDGE_MESSAGE_MAX) : ''

  if (!(await deps.canSee(user, collection, id, isAdmin)))
    return { status: 404, body: { error: 'Record not found' } }

  const key = nudgeKey(deps.tenant ?? '', String(user.id), collection, id)
  if (!(await deps.store.claim(key, NUDGE_WINDOW_S))) {
    const wait = await deps.store.ttl(key)
    const mins = Math.max(1, Math.ceil(wait / 60))
    return {
      status: 429,
      body: {
        error: `You already nudged about this record. You can nudge again in ${mins} minute${mins === 1 ? '' : 's'}.`,
        retry_after_s: wait
      }
    }
  }
  try {
    const owners = (await deps.owners(collection, id))
      .filter((o) => o.id.toUpperCase() !== String(user.id).toUpperCase())
      .slice(0, NUDGE_MAX_OWNERS)
    if (owners.length === 0) {
      await deps.store.release(key)
      return { status: 409, body: { error: 'Nobody else owns this step right now' } }
    }
    // A person's own hourly allowance, whatever the records (a script cannot flood inboxes).
    const senderKey = nudgeSenderKey(deps.tenant ?? '', String(user.id))
    const sent = await deps.store.bump(senderKey, NUDGE_SENDER_WINDOW_S)
    if (sent > NUDGE_SENDER_PER_HOUR) {
      await deps.store.release(key)
      const wait = await deps.store.ttl(senderKey)
      return {
        status: 429,
        body: {
          error: `You have sent ${NUDGE_SENDER_PER_HOUR} nudges in the last hour. Please wait before sending more.`,
          retry_after_s: wait
        }
      }
    }
    const label = await deps.label(collection, id)
    const who = displayName(user)
    for (const o of owners)
      await deps.notify(o.id, {
        subject: `${who} asked you to look at ${label}`,
        message: message || `${who} is waiting on ${label}. It is with you right now.`,
        collection,
        item: id,
        sender: String(user.id)
      })
    await deps.log({
      collection,
      item: id,
      comment:
        `Nudged ${owners.map((o) => o.name).join(', ')}${message ? `: ${message}` : ''}`.slice(
          0,
          1000
        )
    })
    return {
      status: 200,
      body: { data: { notified: owners.length, names: owners.map((o) => o.name) } }
    }
  } catch (err) {
    await deps.store.release(key).catch(() => {})
    throw err
  }
}

/** The real dependencies for one request. */
export function liveNudgeDeps(app: FastifyInstance, req: FastifyRequest): NudgeDeps {
  return {
    tenant: currentTenantKey(),
    store: nudgeStore((app as unknown as { redis?: unknown }).redis ?? null),
    canSee: async (user, collection, id, isAdmin) => {
      const { canSeeRecord } = await import('../sla-visibility.js')
      return canSeeRecord(user, collection, id, { isAdmin })
    },
    owners: async (collection, id) => {
      const { findRecordInstance } = await import('../branch-instances.js')
      const inst = (await findRecordInstance(collection, id)) as
        | { id: string; current_state: string | null; completed_at: Date | null }
        | undefined
      if (!inst?.current_state || inst.completed_at) return []
      const { resolveStateOwnersBatch } = await import('../pipeline-engine.js')
      const map = await resolveStateOwnersBatch([
        {
          key: 'nudge',
          stateId: String(inst.current_state),
          instanceId: String(inst.id),
          collection,
          itemId: id
        }
      ])
      return (map.get('nudge') ?? []).map((o) => ({
        id: String(o.id),
        name: [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
      }))
    },
    label: async (collection, id) => {
      try {
        const { getLabels } = await import('../queues.js')
        const labels = await getLabels(new Map([[collection, new Set([id])]]))
        const hit = Object.entries(labels).find(
          ([k]) => k.toUpperCase() === `${collection}:${id}`.toUpperCase()
        )
        return hit?.[1] ?? `#${id}`
      } catch {
        return `#${id}`
      }
    },
    notify: async (userId, opts) => {
      const { notifyUser } = await import('../notification-channels.js')
      return notifyUser(app, userId, {
        ...opts,
        category: 'workflow',
        why: 'You own the current step of this record.',
        source: { kind: 'command-center-nudge', label: 'Command Center' }
      })
    },
    log: async (opts) => {
      const { logActivity } = await import('../activity.js')
      return logActivity({ action: 'nudge', user: String(req.user!.id), req, ...opts })
    }
  }
}
