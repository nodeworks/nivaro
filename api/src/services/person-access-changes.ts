import { db } from '../db/index.js'
import { collectionNouns } from './activity-sentence.js'
import { selectInChunks } from './db-batch.js'

/**
 * Access changes made TO a person (profile Activity feed, 2026-11-13). The audit rows for
 * them are written with the ADMINISTRATOR as `user`, so a feed of "rows this person wrote"
 * never showed a grant to its grantee. These are found by structured links only, each an
 * indexed read (no migration, no new rows — the granting admin's own feed is unchanged):
 *
 *  - access-request grant / partial grant / deny: the person's own access requests
 *    (nivaro_access_requests.user) name the records; the decision rows sit on those records
 *    (activity index collection + item) and name the person in their comment. Old decisions
 *    are found the same way.
 *  - User Scopes: nivaro_user_scopes rows are logged as `<userId>:<dimension>:<mode>`
 *    (a prefix seek on collection + item).
 *  - Role / status / first-access authorisation / copy-access: rows on nivaro_users/<id>
 *    written by someone else, kept only when the comment or the revision delta says the
 *    change touched access (role, status) — a name edit is not an access change.
 *
 * The feed is administrator-only, and every one of these rows is already readable to an
 * administrator in the activity log, so nothing here widens who learns what.
 */

export const ACCESS_CHANGE_CAP = 200
const GRANT_ACTIONS = ['access-request-grant', 'access-request-deny']
const ACCESS_FIELDS = ['role', 'status']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACCESS_COMMENT = /^(authorized:|Bulk: role →|Bulk: suspended|Bulk: reactivated)/i

function parseDelta(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  try {
    const d = JSON.parse(raw)
    return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function deltasFor(ids: number[]): Promise<Map<number, Record<string, unknown>>> {
  const out = new Map<number, Record<string, unknown>>()
  if (!ids.length) return out
  const rows = (await selectInChunks(ids, 500, (chunk) =>
    Promise.resolve(db('nivaro_revisions').whereIn('activity', chunk).select('activity', 'delta'))
  ).catch(() => [])) as Array<{ activity: number; delta: unknown }>
  for (const r of rows) {
    const d = parseDelta(r.delta)
    if (d) out.set(Number(r.activity), d)
  }
  return out
}

const notBy = (userId: string) => (w: import('knex').Knex.QueryBuilder) =>
  w.whereNull('user').orWhereNot('user', userId)

/** Activity ids of access changes made to `userId` by someone else, newest first (≤200). */
export async function accessChangeIds(userId: string): Promise<number[]> {
  if (!UUID_RE.test(userId)) return []
  const found = new Map<number, number>()
  const keep = (rows: Array<{ id: number; timestamp: unknown }>) => {
    for (const r of rows) found.set(Number(r.id), new Date(String(r.timestamp)).getTime() || 0)
  }

  const grants = async () => {
    const reqs = (await db('nivaro_access_requests')
      .where('user', userId)
      .orderBy('id', 'desc')
      .limit(100)
      .select('collection', 'item')) as Array<{ collection: string | null; item: string | null }>
    const pairs = new Map<string, { collection: string; item: string | null }>()
    for (const r of reqs)
      if (r.collection)
        pairs.set(`${r.collection}\u0000${r.item ?? ''}`, {
          collection: r.collection,
          item: r.item == null ? null : String(r.item)
        })
    if (pairs.size === 0) return
    keep(
      (await db('nivaro_activity')
        .whereIn('action', GRANT_ACTIONS)
        .where((w) => {
          for (const p of pairs.values())
            w.orWhere((x) => {
              x.where('collection', p.collection)
              if (p.item == null) x.whereNull('item')
              else x.where('item', p.item)
            })
        })
        .where('comment', 'like', `%for user ${userId}%`)
        .orderBy('timestamp', 'desc')
        .limit(ACCESS_CHANGE_CAP)
        .select('id', 'timestamp')) as Array<{ id: number; timestamp: unknown }>
    )
  }

  const scopes = async () => {
    keep(
      (await db('nivaro_activity')
        .where('collection', 'nivaro_user_scopes')
        .where('item', 'like', `${userId}:%`)
        .where(notBy(userId))
        .orderBy('timestamp', 'desc')
        .limit(ACCESS_CHANGE_CAP)
        .select('id', 'timestamp')) as Array<{ id: number; timestamp: unknown }>
    )
  }

  const userRow = async () => {
    const rows = (await db('nivaro_activity')
      .where({ collection: 'nivaro_users', item: userId })
      .whereIn('action', ['update', 'copy-access', 'set_role'])
      .where(notBy(userId))
      .orderBy('timestamp', 'desc')
      .limit(ACCESS_CHANGE_CAP)
      .select('id', 'action', 'comment', 'timestamp')) as Array<{
      id: number
      action: string
      comment: string | null
      timestamp: unknown
    }>
    const unclear = rows.filter(
      (r) => r.action === 'update' && !ACCESS_COMMENT.test(String(r.comment ?? ''))
    )
    const deltas = await deltasFor(unclear.map((r) => Number(r.id)))
    keep(
      rows.filter((r) => {
        if (r.action !== 'update' || ACCESS_COMMENT.test(String(r.comment ?? ''))) return true
        const d = deltas.get(Number(r.id))
        return !!d && ACCESS_FIELDS.some((f) => f in d)
      })
    )
  }

  // Each source on its own: one that cannot run (a table not migrated) loses only itself.
  await Promise.all([grants(), scopes(), userRow()].map((p) => p.catch(() => undefined)))
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])
    .slice(0, ACCESS_CHANGE_CAP)
    .map(([id]) => id)
}

// ─── Words ──────────────────────────────────────────────────────────────────

export interface AccessChangeRow {
  id: number
  action: string
  user: string | null
  timestamp: string | Date
  collection: string | null
  item: string | null
  comment: string | null
  record_label?: string | null
  collection_label?: string | null
}

export interface AccessChangeContext {
  /** Who made the change; null = no person (a job). */
  actor: string | null
  /** Upper-cased role id → name. */
  roleNames: Map<string, string>
  /** Scope dimension slug → label. */
  dimensionLabels: Map<string, string>
  /** The revision delta of an update on the person. */
  delta?: Record<string, unknown> | null
}

function titleWords(s: string): string {
  return s
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

function lower(s: string): string {
  return s
    .split(' ')
    .map((w) => (/[A-Z][^ ]*[A-Z]/.test(w) ? w : w.toLowerCase()))
    .join(' ')
}

/** "Workflow CM26-365984 · Splice", "a workflow record", "Workflows". */
function recordText(row: AccessChangeRow): string {
  const c = row.collection ?? ''
  const nouns = collectionNouns(
    c,
    row.collection_label ? { collections: { [c]: row.collection_label } } : null
  )
  if (!row.item) return nouns.plural
  const label = String(row.record_label ?? '').trim()
  if (!label || label === String(row.item) || UUID_RE.test(label))
    return `a ${lower(nouns.singular)} record`
  return label.toLowerCase().startsWith(nouns.singular.toLowerCase())
    ? label
    : `${nouns.singular} ${label}`
}

function pastTense(label: string): string {
  return label
    .trim()
    .replace(/^Add\b/, 'Added')
    .replace(/^Give\b/, 'Gave')
    .replace(/^Remove\b/, 'Removed')
}

const GRANT_RE = /^\s*(partial\s+)?for user [0-9a-f-]{36}(.*)$/is

/** One readable line for an access change made to the person; null = not an access change. */
export function describeAccessChange(
  row: AccessChangeRow,
  ctx: AccessChangeContext
): { summary: string; detail: string | null } | null {
  const by = ctx.actor ? `by ${ctx.actor}` : 'automatically'
  const comment = String(row.comment ?? '').trim()

  if (row.action === 'access-request-grant' || row.action === 'access-request-deny') {
    const what = recordText(row)
    if (row.action === 'access-request-deny')
      return { summary: `Access to ${what} declined ${by}`, detail: null }
    const m = GRANT_RE.exec(comment)
    const partial = !!m?.[1]
    let rest = (m?.[2] ?? '').trim()
    let blocked: string | null = null
    if (partial) {
      rest = rest.replace(/^:\s*/, '')
      const cut = rest.indexOf(' — still blocked:')
      if (cut >= 0) {
        blocked = rest
          .slice(cut + ' — still blocked:'.length)
          .trim()
          .slice(0, 200)
        rest = rest.slice(0, cut)
      }
    } else {
      rest = rest.replace(/^\(([\s\S]*)\)$/, '$1')
    }
    const applied = rest
      .split(/;\s*/)
      .map((s) => s.trim())
      .filter((s) => s && s !== 'nothing to apply')
      .map(pastTense)
    const parts = [...applied, ...(blocked ? [`Still blocked: ${blocked}`] : [])]
    return {
      summary: `Access ${partial ? 'partly granted' : 'granted'} to ${what} ${by}`,
      detail: parts.length ? parts.join(' · ') : null
    }
  }

  if (row.collection === 'nivaro_user_scopes') {
    const [, dim = '', mode = ''] = String(row.item ?? '').split(':')
    const label = ctx.dimensionLabels.get(dim) ?? (titleWords(dim) || 'Scope')
    return {
      summary: `${label} ${mode === 'default' ? 'default' : 'restriction'} changed ${by}`,
      // A save from the Scopes card logs what it added and removed (scopeChangeComment).
      detail: /^bulk\b/i.test(comment)
        ? 'Part of a bulk change'
        : /^(Added|Removed) /.test(comment)
          ? comment
          : null
    }
  }

  if (row.collection !== 'nivaro_users') return null
  if (row.action === 'copy-access') {
    const m = /^From (.+?):\s*(.*)$/s.exec(comment)
    return {
      summary: m ? `Access copied from ${m[1]} ${by}` : `Access copied from another person ${by}`,
      detail: m?.[2]?.trim() || null
    }
  }
  if (row.action === 'set_role') return { summary: `Role changed ${by}`, detail: null }
  const auth = /^authorized:\s*(.*)$/i.exec(comment)
  if (auth)
    return {
      summary: `Access authorized ${by}`,
      detail: auth[1] ? auth[1].charAt(0).toUpperCase() + auth[1].slice(1) : null
    }
  const bulkRole = /^Bulk: role →\s*(.+)$/i.exec(comment)
  if (bulkRole) return { summary: `Role changed to ${bulkRole[1].trim()} ${by}`, detail: null }
  const bulkStatus = /^Bulk: (suspended|reactivated)/i.exec(comment)
  if (bulkStatus)
    return {
      summary: `${bulkStatus[1].toLowerCase() === 'suspended' ? 'Suspended' : 'Reactivated'} ${by}`,
      detail: null
    }
  const d = ctx.delta
  if (!d) return null
  const status = 'status' in d ? String(d.status ?? '') : null
  const statusText = (s: string) =>
    s === 'suspended'
      ? `Suspended ${by}`
      : s === 'active'
        ? `Reactivated ${by}`
        : `Status set to ${s || 'none'} ${by}`
  if ('role' in d) {
    const name = d.role == null ? null : ctx.roleNames.get(String(d.role).toUpperCase())
    return {
      summary:
        d.role == null ? `Role removed ${by}` : `Role changed to ${name ?? 'another role'} ${by}`,
      detail: status != null ? `Status: ${status || 'none'}` : null
    }
  }
  if (status != null) return { summary: statusText(status), detail: null }
  return null
}

/** Lines for the rows that are access changes to `userId` (one batch of name reads). */
export async function describeAccessChanges(
  userId: string,
  rows: AccessChangeRow[],
  ids: Set<number>
): Promise<Map<number, { summary: string; detail: string | null; by: string | null }>> {
  const out = new Map<number, { summary: string; detail: string | null; by: string | null }>()
  const mine = rows.filter(
    (r) => ids.has(Number(r.id)) && String(r.user ?? '').toUpperCase() !== userId.toUpperCase()
  )
  if (mine.length === 0) return out
  const actorIds = [...new Set(mine.map((r) => r.user).filter((u): u is string => !!u))]
  const userUpdates = mine.filter((r) => r.collection === 'nivaro_users' && r.action === 'update')
  const [people, deltas, dims] = await Promise.all([
    actorIds.length
      ? (db('nivaro_users')
          .whereIn('id', actorIds)
          .select('id', 'first_name', 'last_name', 'email')
          .catch(() => []) as Promise<
          Array<{
            id: string
            first_name: string | null
            last_name: string | null
            email: string | null
          }>
        >)
      : Promise.resolve([]),
    deltasFor(userUpdates.map((r) => Number(r.id))),
    mine.some((r) => r.collection === 'nivaro_user_scopes')
      ? (db('nivaro_scope_dimensions')
          .select('name', 'label')
          .catch(() => []) as Promise<Array<{ name: string; label: string | null }>>)
      : Promise.resolve([])
  ])
  const roleIds = [...deltas.values()]
    .map((d) => d.role)
    .filter((r): r is string => typeof r === 'string' && !!r)
  const roles = roleIds.length
    ? ((await db('nivaro_roles')
        .whereIn('id', [...new Set(roleIds)])
        .select('id', 'name')
        .catch(() => [])) as Array<{ id: string; name: string | null }>)
    : []
  const names = new Map(
    people.map((p) => [
      String(p.id).toUpperCase(),
      [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || p.email || 'an administrator'
    ])
  )
  const roleNames = new Map(roles.map((r) => [String(r.id).toUpperCase(), r.name ?? 'a role']))
  const dimensionLabels = new Map(dims.map((d) => [d.name, d.label || titleWords(d.name)]))
  for (const r of mine) {
    const actor = r.user ? (names.get(String(r.user).toUpperCase()) ?? 'an administrator') : null
    const line = describeAccessChange(r, {
      actor,
      roleNames,
      dimensionLabels,
      delta: deltas.get(Number(r.id)) ?? null
    })
    if (line) out.set(Number(r.id), { ...line, by: actor })
  }
  return out
}

/**
 * What one User Scopes save changed, for its activity comment: "Added CHI, FLO · Removed
 * BSO" by the values' labels (an id with no label stays as written). Empty when nothing
 * changed. The person's Activity tab shows it under "Region restriction changed by …".
 */
export function scopeChangeComment(
  before: Array<string | number>,
  after: Array<string | number>,
  labels: Map<string, string>
): string {
  const had = new Set(before.map(String))
  const has = new Set(after.map(String))
  const name = (v: string | number) => labels.get(String(v)) ?? String(v)
  const added = after.filter((v) => !had.has(String(v))).map(name)
  const removed = before.filter((v) => !has.has(String(v))).map(name)
  const parts: string[] = []
  if (added.length) parts.push(`Added ${added.join(', ')}`)
  if (removed.length)
    parts.push(`Removed ${removed.join(', ')}${after.length === 0 ? ' (none left)' : ''}`)
  return parts.join(' · ')
}
