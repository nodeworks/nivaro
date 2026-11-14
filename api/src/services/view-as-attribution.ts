/**
 * View-as attribution (Rob 2026-11-14).
 *
 * A View-as tab (Bearer nvm_, authenticate.ts) IS the person being viewed: same screens, same
 * permissions, same writes — every write is the person's. The administrator behind it is kept
 * on the activity log only — no schema change: nivaro_activity.actor (migration 516) =
 * {kind:'view_as', id:<admin>, on_behalf_of:<person>} — and shown to ADMINISTRATORS ONLY, as
 * "Rob Lee as David Pry". Everyone else — the person included, and everyone a write notifies —
 * sees exactly what they would see had the person done it themselves: no "as" in sentences,
 * no extra field in any answer, no change to notifications, mail, webhooks or payloads.
 *
 * Write side. Record saves, comments, tasks, tickets, uploads and approval decisions already log
 * an activity row (logActivity stamps the actor from the request). A pipeline move writes only a
 * nivaro_workflow_history row, so every history insert calls `noteViewAsHistory(...)` after it:
 * outside a View-as that is one synchronous check and nothing else; under View-as it logs ONE
 * activity row `view-as-move` on (nivaro_workflow_history, <history id>), comment JSON
 * {collection, item, from, to} (the record + state keys). Fire-and-forget: never awaited, so a
 * caller inside a transaction never waits on it (its reads wait for the transaction instead).
 * Those rows are left out of every activity list (activityListSource) — the move itself is what
 * people see; the row only names the admin behind it.
 *
 * Read side: `hideViewAsActor` (activity / revision rows for a non-admin reader),
 * `viewAsMovesFor` (admin readers of pipeline history, one read per page of moves) and
 * `viewAsCreators` (admin readers of comments).
 *
 * Run-as-key (nvq_) is NOT View-as: it also sets masqueradeAdminId, but it acts as a key and
 * logs nothing here (its activity rows keep their existing actor).
 */
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { logActivity } from './activity.js'
import { VIEW_AS_MOVE_ACTION } from './activity-filters.js'
import type { ActivityActor } from './activity-sentence.js'
import { currentTraceRequestObject } from './request-trace.js'

/** The activity action of a View-as pipeline move's attribution row (activity lists skip it). */
export { VIEW_AS_MOVE_ACTION } from './activity-filters.js'
/** Its collection: the row names the history row (item = history id), never the record, so no
 *  record feed (timeline, history, recently edited) ever lists it as a second "moved" entry. */
export const VIEW_AS_MOVE_COLLECTION = 'nivaro_workflow_history'

interface ViewAsSource {
  authMethod?: string
  masqueradeAdminId?: string
  user?: { id?: unknown } | null
}

/** The administrator behind this View-as request (nvm_ only), else null. */
export function viewAsAdminOf(req: unknown): string | null {
  const r = req as ViewAsSource | null | undefined
  if (!r || typeof r !== 'object') return null
  if (r.authMethod !== 'masquerade') return null
  return r.masqueradeAdminId ? String(r.masqueradeAdminId) : null
}

/** The administrator behind the request being served now (handed in, else the trace's). */
export function currentViewAsAdmin(req?: unknown): string | null {
  return viewAsAdminOf(req ?? currentTraceRequestObject())
}

export interface ViewAsHistoryInput {
  /** The workflow instance the history row belongs to. */
  instance: string | number | null | undefined
  from_state?: string | null
  to_state?: string | null
  /** The history row's id when the insert returned it; else the newest matching row is read. */
  history_id?: string | number | null
}

/**
 * Call right after every nivaro_workflow_history insert (guard test). Outside a View-as: one
 * synchronous check, no I/O. Under View-as: logs the attribution row in the background.
 */
export function noteViewAsHistory(input: ViewAsHistoryInput, req?: unknown): void {
  const source = req ?? currentTraceRequestObject()
  if (!viewAsAdminOf(source) || input.instance == null) return
  void recordViewAsHistory(input, source).catch(() => {})
}

/** The attribution row itself (exported for tests; callers use noteViewAsHistory). */
export async function recordViewAsHistory(
  input: ViewAsHistoryInput,
  req: unknown
): Promise<number | null> {
  if (!viewAsAdminOf(req) || input.instance == null) return null
  const person = (req as ViewAsSource).user?.id
  let historyId = input.history_id ?? null
  if (historyId == null) {
    const q = db('nivaro_workflow_history').where('instance', input.instance)
    if (input.to_state) q.where('to_state', input.to_state)
    if (person) q.where('user', String(person))
    const row = (await q.orderBy('id', 'desc').first('id')) as { id?: number } | undefined
    historyId = row?.id ?? null
  }
  if (historyId == null) return null
  const [inst, states] = await Promise.all([
    db('nivaro_workflow_instances')
      .where('id', input.instance)
      .first('collection', 'item') as Promise<
      { collection?: string; item?: string | number } | undefined
    >,
    stateKeys([input.from_state, input.to_state])
  ])
  return logActivity({
    action: VIEW_AS_MOVE_ACTION,
    user: person ? String(person) : null,
    collection: VIEW_AS_MOVE_COLLECTION,
    item: String(historyId),
    comment: JSON.stringify({
      collection: inst?.collection ?? null,
      item: inst?.item != null ? String(inst.item) : null,
      from: input.from_state ? (states.get(String(input.from_state)) ?? null) : null,
      to: input.to_state ? (states.get(String(input.to_state)) ?? null) : null
    }),
    req: req as Parameters<typeof logActivity>[0]['req']
  })
}

async function stateKeys(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((v): v is string => !!v).map(String))]
  const out = new Map<string, string>()
  if (want.length === 0) return out
  const rows = (await db('nivaro_workflow_states')
    .whereIn('id', want)
    .select('id', 'key')
    .catch(() => [])) as Array<{ id: string; key: string | null }>
  for (const r of rows) if (r.key) out.set(String(r.id), r.key)
  return out
}

/**
 * For an ADMINISTRATOR reader of pipeline history: which of these history rows a View-as tab
 * wrote, and the administrator behind each. One activity read (item IN the ids) + one users read.
 * Never throws; any failure answers an empty map (the person alone, as everyone else sees it).
 */
export async function viewAsMovesFor(
  historyIds: Array<string | number | null | undefined>
): Promise<Map<string, { id: string; name: string }>> {
  const ids = [...new Set(historyIds.filter((v) => v != null).map((v) => String(v)))]
  return viewAsCreators(VIEW_AS_MOVE_COLLECTION, ids, VIEW_AS_MOVE_ACTION)
}

/**
 * An activity / revision row as a NON-administrator reads it: a View-as write reads exactly like
 * the person's own (actor → the person, the credential marker gone). Other actors (API key,
 * assistant, import…) are untouched. Mutates nothing; returns the row itself when unchanged.
 */
export function hideViewAsActor<T extends Record<string, unknown>>(row: T): T {
  const kind = actorKindOf(row.actor)
  const masq = row.auth_method === 'masquerade'
  if (kind !== 'view_as' && !masq) return row
  const out: Record<string, unknown> = { ...row }
  if (masq) delete out.auth_method
  if (kind === 'view_as') {
    const person = (row.user ?? row.user_id ?? null) as string | null
    out.actor = person
      ? ({ kind: 'person', id: String(person), name: null, on_behalf_of: null } as ActivityActor)
      : null
  }
  return out as T
}

/** The kind of a stored (JSON text) or derived (object) actor, else null. */
function actorKindOf(actor: unknown): string | null {
  if (actor && typeof actor === 'object') return String((actor as { kind?: unknown }).kind ?? '')
  if (typeof actor === 'string' && actor) {
    try {
      return String((JSON.parse(actor) as { kind?: unknown }).kind ?? '')
    } catch {
      return null
    }
  }
  return null
}

/** id (upper-cased) → "First Last" for the admins a page of rows names. One read. */
export async function actingAdminNames(
  ids: Array<string | null | undefined>
): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((v): v is string => !!v).map((v) => v.toUpperCase()))]
  const out = new Map<string, string>()
  if (want.length === 0) return out
  try {
    const rows = (await db('nivaro_users')
      .whereIn('id', want.slice(0, 500))
      .select('id', 'first_name', 'last_name', 'email')) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      email: string | null
    }>
    for (const r of rows) {
      const name =
        [r.first_name, r.last_name].filter(Boolean).join(' ').trim() ||
        r.email ||
        'An administrator'
      out.set(String(r.id).toUpperCase(), name)
    }
  } catch {
    /* names are a nicety: the id alone still says an admin did it */
  }
  return out
}

/** `{ id, name }` for an admin reader, from a row's acting_admin; null when there is none. */
export function actingAdminOf(
  value: unknown,
  names: Map<string, string>
): { id: string; name: string } | null {
  if (!value) return null
  const id = String(value)
  return { id, name: names.get(id.toUpperCase()) ?? 'An administrator' }
}

/**
 * For an ADMINISTRATOR reader: which of these rows a View-as tab created, read from each row's
 * own create activity entry (nivaro_activity.actor kind view_as, or auth_method 'masquerade' on
 * a row from before migration 516). Map: row id (upper-cased) → the administrator. One read,
 * column-probed; any failure answers an empty map (the person alone, as everyone else sees it).
 */
export async function viewAsCreators(
  collection: string,
  ids: Array<string | number>,
  action = 'create'
): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>()
  const want = [...new Set(ids.map((v) => String(v)).filter(Boolean))].slice(0, 500)
  if (want.length === 0) return out
  try {
    const [hasActor, hasAuth] = await Promise.all([
      hasColumn('nivaro_activity', 'actor').catch(() => false),
      hasColumn('nivaro_activity', 'auth_method').catch(() => false)
    ])
    if (!hasActor && !hasAuth) return out
    const rows = (await db('nivaro_activity')
      .where({ collection, action })
      .whereIn('item', want)
      .where((q) => {
        if (hasActor) q.orWhere('actor', 'like', '%"kind":"view_as"%')
        if (hasAuth) q.orWhere('auth_method', 'masquerade')
      })
      .select('item', ...(hasActor ? ['actor'] : []))) as Array<{
      item: string
      actor?: string | null
    }>
    const adminOf = new Map<string, string | null>()
    for (const r of rows) {
      let admin: string | null = null
      try {
        const a = r.actor ? (JSON.parse(r.actor) as { kind?: string; id?: string }) : null
        if (a?.kind === 'view_as' && a.id) admin = String(a.id)
      } catch {
        /* unreadable actor: still a View-as row (auth_method), admin unknown */
      }
      adminOf.set(String(r.item).toUpperCase(), admin)
    }
    const names = await actingAdminNames([...adminOf.values()])
    for (const [item, admin] of adminOf) {
      out.set(
        item,
        admin
          ? (actingAdminOf(admin, names) ?? { id: admin, name: 'An administrator' })
          : { id: '', name: 'An administrator' }
      )
    }
  } catch {
    /* attribution is a nicety for admins: never fails the read */
  }
  return out
}
