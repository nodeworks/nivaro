import { db } from '../db/index.js'
import { onOwnersChanged } from '../db/owner-signal.js'
import { getIo } from './io-holder.js'
import { broadcastCollectionUpdate } from './realtime.js'

/**
 * Record-page live signals (rt-record). Everything here is a NOTICE — ids and
 * aspect names, never values — and best-effort: a failed emit never affects
 * the write that caused it. Clients refetch through their own
 * permission-checked queries (packages/shared lib/live.ts).
 *
 * Two shapes:
 * - `announceRecordAspect(c, id, '$state')` rides the existing
 *   `collection:update` contract with NO action and a `$`-named
 *   changed_fields entry, so list rows (CBV, queues) and open records both
 *   hear it, while the traffic map / GraphQL subscriptions (which key on
 *   `action`) do not count it as a write. Aspects: `$state` (pipeline moved),
 *   `$addendums`, `$comments`, `$tasks`, `$integrations`.
 * - `emitRecordEvent(c, id, 'record:integrity')` goes only to the record
 *   room (`record:<c>:<id>` — joined after a `can(read)` check), for signals
 *   nobody outside the open record needs.
 */

export type RecordAspect = '$state' | '$addendums' | '$comments' | '$tasks' | '$integrations'

export function announceRecordAspect(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  aspects: RecordAspect | RecordAspect[]
): void {
  if (!collection || item == null || item === '') return
  try {
    broadcastCollectionUpdate(undefined, collection, item, {
      changed_fields: Array.isArray(aspects) ? aspects : [aspects]
    })
  } catch {
    /* best-effort */
  }
}

export function emitRecordEvent(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  event: string,
  extra: Record<string, unknown> = {}
): void {
  if (!collection || item == null || item === '') return
  try {
    getIo()
      ?.to(`record:${collection}:${String(item)}`)
      .emit(event, { ...extra, collection, item: String(item) })
  } catch {
    /* best-effort */
  }
}

/**
 * An addendum moved: its own pipeline subject (`nivaro_addendums:<id>`) and
 * the parent record (whose addendum view, totals and list badges show it).
 */
export async function announceAddendumChange(
  addendumId: string | null | undefined,
  parent?: { collection?: string | null; id?: string | number | null }
): Promise<void> {
  if (!addendumId) return
  try {
    let pc = parent?.collection ?? null
    let pid = parent?.id ?? null
    if (!pc || pid == null) {
      const row = (await db('nivaro_addendums')
        .where({ id: addendumId })
        .select('parent_collection', 'parent_id')
        .first()) as { parent_collection?: string; parent_id?: string } | undefined
      pc = row?.parent_collection ?? null
      pid = row?.parent_id ?? null
    }
    announceRecordAspect('nivaro_addendums', addendumId, '$addendums')
    if (pc && pid != null) announceRecordAspect(pc, pid, '$addendums')
  } catch {
    /* best-effort */
  }
}

/** #1825: a partner submission row changed — tell its record's viewers. */
export async function announceSubmissionAspect(submissionId: number | string): Promise<void> {
  try {
    const row = (await db('nivaro_erp_submissions')
      .where({ id: submissionId })
      .first('collection', 'item')) as { collection?: string; item?: string } | undefined
    announceRecordAspect(row?.collection, row?.item, '$integrations')
  } catch {
    /* best-effort */
  }
}

/**
 * #2079: the record a flow run is working on — its trigger payload's
 * `collection` + `item` (`keys[0]` / `key` / `id` for item-event flows).
 * System collections are skipped: nobody has one open as a record page.
 */
export function flowRecordOf(payload: unknown): { collection: string; item: string } | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const collection = typeof p.collection === 'string' ? p.collection : null
  if (!collection || collection.startsWith('nivaro_') || collection.startsWith('directus_'))
    return null
  const keys = Array.isArray(p.keys) ? p.keys : null
  const raw = p.item ?? keys?.[0] ?? p.key ?? p.id
  if (raw == null || raw === '' || typeof raw === 'object') return null
  return { collection, item: String(raw) }
}

export function announceAutomation(
  record: { collection: string; item: string },
  flow: { id: string; name?: string | null },
  state: 'start' | 'end'
): void {
  emitRecordEvent(record.collection, record.item, 'record:automation', {
    flow_id: flow.id,
    flow_name: flow.name ?? null,
    state
  })
}

/**
 * #1870: who owns records changed (owner matrix, delegation, out-of-office,
 * team membership — the in-process owner signal). One payload-free
 * `owners:changed` to every socket, coalesced over 5s (the signal also rises
 * on every transition, which already tells its own record through `$state`);
 * open records refetch their owners chip and approval chain. With the Redis
 * adapter the emit reaches every replica's sockets; each process only
 * announces its own writes.
 */
let ownersTimer: ReturnType<typeof setTimeout> | null = null
onOwnersChanged(() => {
  if (ownersTimer) return
  ownersTimer = setTimeout(() => {
    ownersTimer = null
    try {
      getIo()?.emit('owners:changed', { at: Date.now() })
    } catch {
      /* best-effort */
    }
  }, 5000)
  ownersTimer.unref?.()
})

/**
 * #1925: a role, policy, row filter, scope or subtree grant changed — any open
 * record might now be hidden from its viewer. One payload-free
 * `access:changed` to every socket, coalesced over 2s; open records re-read
 * themselves (as the viewer) and say "You no longer have access" on a 403/404.
 * Called from the access-route onResponse hook (routes/index.ts).
 */
let accessTimer: ReturnType<typeof setTimeout> | null = null
export function announceAccessChanged(): void {
  if (accessTimer) return
  accessTimer = setTimeout(() => {
    accessTimer = null
    try {
      getIo()?.emit('access:changed', { at: Date.now() })
    } catch {
      /* best-effort */
    }
  }, 2000)
  accessTimer.unref?.()
}

/** Write routes whose success may change who can read which records. */
export const ACCESS_ROUTES =
  /^\/api\/(roles|user-scopes|scope-dimensions|tree-permissions|access-requests\/[^/?]+\/resolve|users\/(bulk|me\/scopes|[^/?]+\/copy-access)|users\/(?!me\b)[^/?]+(?:[?]|$))/
