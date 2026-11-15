import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { runStepAlerts } from './alerts.js'
import { peopleWith } from './flags.js'
import { addPin, pinKey, removePin, type WatchListPrefs } from './store.js'
import { updateWatchList } from './user-store.js'

/**
 * What the watch list does when a record comes to rest on a step (rt6 #5, #6) — called from
 * workflow-transitions.ts where the move's event fires (the last hop of an automatic chain only,
 * and a record started straight onto a step):
 *
 *   - step alert rules for that step fire (alerts.ts)
 *   - auto-add: people who own the new step and turned "add records that land on my step" on
 *     get it pinned (marked `auto`) — only when they can open it, never past the 50 cap
 *   - auto-remove: people who turned "remove them when they leave my step" on and no longer own
 *     it lose the pin, but only a pin that was added automatically (a pin they made stays)
 *
 * A finished record (terminal step) waits on nobody: nothing is added for it.
 */

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase()

/** Who gets the record added and who loses it. Pure. */
export function autoPinPlan(
  people: Map<string, WatchListPrefs>,
  args: { collection: string; item: string; ownerIds: string[]; terminal: boolean }
): { add: string[]; remove: string[] } {
  const k = pinKey(args.collection, args.item)
  const owns = (u: string) => !args.terminal && args.ownerIds.some((o) => sameId(o, u))
  const add: string[] = []
  const remove: string[] = []
  for (const [user, list] of people) {
    const pin = list.pins.find((p) => pinKey(p.c, p.id) === k)
    if (owns(user)) {
      if (list.settings.auto_add && !pin) add.push(user)
    } else if (pin?.auto && list.settings.auto_remove) {
      remove.push(user)
    }
  }
  return { add, remove }
}

/** Add the auto pin (null = nothing to do: already pinned, list full, or turned off). Pure. */
export function withAutoPin(
  list: WatchListPrefs,
  collection: string,
  item: string,
  now: Date
): WatchListPrefs | null {
  if (!list.settings.auto_add) return null
  const res = addPin(list, collection, item, now, { auto: true })
  return res.ok && res.changed ? res.list : null
}

/** Remove the pin only while it is still an automatic one. Pure. */
export function withoutAutoPin(
  list: WatchListPrefs,
  collection: string,
  item: string
): WatchListPrefs | null {
  if (!list.settings.auto_remove) return null
  const pin = list.pins.find((p) => pinKey(p.c, p.id) === pinKey(collection, item))
  if (!pin?.auto) return null
  const res = removePin(list, collection, item)
  return res.changed ? res.list : null
}

async function mayOpen(userId: string, collection: string, item: string): Promise<boolean> {
  const user = (await db('nivaro_users')
    .where({ id: userId })
    .first()
    .catch(() => undefined)) as (User & Record<string, unknown>) | undefined
  if (!user || (user.status && String(user.status) !== 'active') || user.is_redacted) return false
  try {
    const { canSeeRecord } = await import('../sla-visibility.js')
    return await canSeeRecord(user, collection, item)
  } catch {
    return false
  }
}

export async function applyAutoPins(args: {
  collection: string
  item: string
  ownerIds: string[]
  terminal: boolean
  now?: Date
}): Promise<{ added: string[]; removed: string[] }> {
  const people = await peopleWith('wl_auto')
  const done = { added: [] as string[], removed: [] as string[] }
  if (people.size === 0) return done
  const plan = autoPinPlan(people, args)
  const now = args.now ?? new Date()
  for (const u of plan.add) {
    if (!(await mayOpen(u, args.collection, args.item))) continue
    const saved = await updateWatchList(u, (l) =>
      withAutoPin(l, args.collection, args.item, now)
    ).catch(() => null)
    if (saved) done.added.push(u)
  }
  for (const u of plan.remove) {
    const saved = await updateWatchList(u, (l) =>
      withoutAutoPin(l, args.collection, args.item)
    ).catch(() => null)
    if (saved) done.removed.push(u)
  }
  return done
}

/** The move's event payload (buildTransitionEventPayload) → alerts + auto pins. Never throws. */
export async function onWatchTransition(payload: Record<string, unknown>): Promise<void> {
  try {
    const collection = String(payload.subject_collection ?? payload.collection ?? '')
    const item = String(payload.subject_item ?? payload.item ?? '')
    if (!collection || !item || /^(nivaro_|directus_)/i.test(collection)) return
    const to = payload.to_state as { key?: string; label?: string; is_terminal?: boolean } | null
    const owners = (payload.owners ?? []) as Array<{ id?: unknown }>
    const actorId = typeof payload.user_id === 'string' ? payload.user_id : null
    const { getApp } = await import('../io-holder.js')
    const app = getApp() as FastifyInstance | null
    await runStepAlerts(app, {
      collection,
      item,
      stateKey: to?.key ?? null,
      stateLabel: to?.label ?? null,
      actorId
    }).catch(() => 0)
    await applyAutoPins({
      collection,
      item,
      ownerIds: owners.map((o) => String(o.id ?? '')).filter(Boolean),
      terminal: !!to?.is_terminal
    }).catch(() => null)
  } catch {
    /* the watch list is decoration on a move */
  }
}
