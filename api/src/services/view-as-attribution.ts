/**
 * View-as attribution (Rob 2026-11-14).
 *
 * A View-as tab (Bearer nvm_, authenticate.ts) IS the person being viewed: same screens, same
 * permissions, same writes — every write is the person's. The administrator behind it is stored
 * beside the write (nivaro_activity.actor from migration 516 for record saves, comments, tasks,
 * tickets, uploads and approval decisions; nivaro_workflow_history.acting_admin from migration
 * 527 for pipeline moves; chat_messages.masquerade_admin from 367) and shown to ADMINISTRATORS ONLY, as
 * "Rob Lee as David Pry". Everyone else — the person included, and everyone a write notifies —
 * sees exactly what they would see had the person done it themselves: no "as" in sentences,
 * no extra field in any answer, no change to notifications, mail, webhooks or payloads.
 *
 * Write side: `viewAsColumns(table)` → `{ acting_admin }` while the current request is a View-as
 * and the column exists (feature-detected per tenant), else `{}` — spread it into the insert.
 * The request is the one handed in, else the one the current trace serves (GraphQL resolvers,
 * effects deferred inside the request), so services need no extra parameter.
 *
 * Read side: `hideViewAsActor` (activity / revision rows for a non-admin reader) and
 * `actingAdminNames` (admin readers: one users read for a page of rows).
 *
 * Run-as-key (nvq_) is NOT View-as: it also sets masqueradeAdminId, but it acts as a key and
 * stamps nothing here (its activity rows keep their existing actor).
 */
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { ActivityActor } from './activity-sentence.js'
import { currentTraceRequestObject } from './request-trace.js'

/** Tables with an acting_admin column (migration 527). Every other View-as write is attributed
 *  through its nivaro_activity row's actor (migration 516). */
export const ACTING_ADMIN_TABLES = ['nivaro_workflow_history'] as const
export type ActingAdminTable = (typeof ACTING_ADMIN_TABLES)[number]

interface ViewAsSource {
  authMethod?: string
  masqueradeAdminId?: string
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

/** Does this table carry acting_admin yet (migration 527)? Never throws. */
export async function hasActingAdmin(table: ActingAdminTable): Promise<boolean> {
  try {
    return await hasColumn(table, 'acting_admin')
  } catch {
    return false
  }
}

/**
 * `{ acting_admin }` for an insert made in a View-as request, else `{}`. Outside a View-as it
 * reads nothing (no probe), so ordinary writes pay nothing.
 */
export async function viewAsColumns(
  table: ActingAdminTable,
  req?: unknown
): Promise<{ acting_admin?: string }> {
  const admin = currentViewAsAdmin(req)
  if (!admin) return {}
  if (!(await hasActingAdmin(table))) return {}
  return { acting_admin: admin }
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
