import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { type AccessReason, explainAccess } from '../services/access-explain.js'
import { logActivity } from '../services/activity.js'
import { notifyUser } from '../services/notification-channels.js'
import { type DigestSection, registerDigestSection } from '../services/daily-digest.js'
import { resolveFriendlyId } from '../services/workflow-transitions.js'
import { bustUserScopeCache, listScopeDimensions } from '../services/user-scopes.js'

/** What granting would DO for a request, from the reasons captured when it
 *  was made — the smallest change that opens the record. */
export interface GrantAction {
  type: 'scope' | 'policy' | 'manual'
  label: string
  dimension?: string
  /** scope: target ids to add to the requester's restrict values. */
  add_ids?: string[]
}

export function planGrant(collection: string, reasons: AccessReason[] | null): GrantAction[] {
  if (!reasons || reasons.length === 0) {
    return [
      { type: 'policy', label: `Give their role read access to ${collection.replace(/_/g, ' ')}` }
    ]
  }
  const out: GrantAction[] = []
  for (const r of reasons) {
    if (r.type === 'permission')
      out.push({
        type: 'policy',
        label: `Give their role read access to ${collection.replace(/_/g, ' ')}`
      })
    else if (r.type === 'scope' && r.dimension && (r.record_ids?.length ?? 0) > 0)
      out.push({
        type: 'scope',
        dimension: r.dimension,
        add_ids: r.record_ids,
        label: `Add ${(r.record_values?.length ? r.record_values : (r.record_ids ?? [])).join(', ')} to their ${r.dimension_label ?? r.dimension} filter`
      })
    else if (r.type === 'scope' || r.type === 'scope_strict')
      out.push({
        type: 'manual',
        dimension: r.dimension,
        label: `Their ${r.dimension_label ?? r.dimension ?? 'scope'} filter excludes it and the record's value could not be read — widen it on their user page`
      })
    else if (r.type === 'row_filter')
      out.push({
        type: 'manual',
        label: 'A row-level rule on their role hides this record — adjust it on the Roles page'
      })
    else if (r.type === 'not_found')
      out.push({ type: 'manual', label: 'The record no longer exists — nothing to grant' })
  }
  return out
}

const parseReasons = (v: unknown): AccessReason[] | null => {
  if (v == null) return null
  if (Array.isArray(v)) return v as AccessReason[]
  try {
    const parsed = JSON.parse(String(v))
    return Array.isArray(parsed) ? (parsed as AccessReason[]) : null
  } catch {
    return null
  }
}

/**
 * "Request access" — the access-denied panel explains WHY a record is hidden;
 * this closes the loop by notifying admins instead of ending in a side-channel
 * message. One request per user+record per day (the dedupe is the activity
 * log itself — no new table for a button).
 */
export async function accessRequestRoutes(app: FastifyInstance) {
  app.post<{ Body: { collection?: string; item?: string; note?: string } }>(
    '/access-requests',
    { preHandler: requireAuth },
    async (req, reply) => {
      const collection = String(req.body?.collection ?? '').trim()
      const item = String(req.body?.item ?? '').trim()
      const note = String(req.body?.note ?? '')
        .trim()
        .slice(0, 300)
      // item optional (#55): a bare collection request means "I can't see this
      // collection at all" — it lands in the grant queue.
      if (!collection || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection)) {
        return reply.code(400).send({ error: 'collection is required' })
      }
      if (/^nivaro_/i.test(collection)) {
        return reply.code(400).send({ error: 'Not a requestable collection' })
      }

      // Once per day per record — a stuck user clicking five times must not
      // page every admin five times.
      const since = new Date(Date.now() - 24 * 3600 * 1000)
      const dup = await db('nivaro_activity')
        .where({ action: 'access-request', user: req.user!.id, collection })
        .where('item', item || '')
        .where('timestamp', '>', since)
        .first('id')
      if (dup) {
        return reply.send({ data: { requested: true, already: true } })
      }

      await logActivity({
        action: 'access-request',
        user: req.user!.id,
        collection,
        item: item || undefined,
        comment: note || undefined,
        req
      })

      // Every request joins the admin grant queue (#55) — a pending row an
      // admin can grant or deny with one click. A record request also stores
      // WHY it was denied (evaluated as the requester, now), so the grant can
      // be the fitting one: widen the scope that excludes the record rather
      // than hand the role a blanket read policy it already has.
      let reasons: AccessReason[] | null = null
      if (item) {
        try {
          reasons = (await explainAccess(req.user!, !!req.isAdmin, collection, item)).reasons
          for (const r of reasons) delete r.trash_id
        } catch {
          reasons = null
        }
      }
      const pending = await db('nivaro_access_requests')
        .where({ user: req.user!.id, collection, status: 'pending' })
        .where('item', item || null)
        .first('id')
        .catch(() => undefined)
      if (!pending) {
        await db('nivaro_access_requests')
          .insert({
            user: req.user!.id,
            collection,
            item: item || null,
            note: note || null,
            reasons: reasons ? JSON.stringify(reasons) : null,
            status: 'pending',
            created_at: new Date()
          })
          .catch(() => {})
      }

      const requester =
        [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') ||
        req.user?.email ||
        'A user'
      const admins = (await db('nivaro_users as u')
        .join('nivaro_roles as r', 'r.id', 'u.role')
        .where('r.admin_access', true)
        .where((qb) => void qb.where('u.status', 'active').orWhereNull('u.status'))
        .limit(10)
        .select('u.id')) as Array<{ id: string }>
      const friendly = item ? await resolveFriendlyId(collection, item).catch(() => item) : null
      const why = reasons?.length ? ` Why: ${reasons.map((r) => r.message).join(' ')}` : ''
      for (const a of admins) {
        await notifyUser(app, String(a.id), {
          subject: `${requester} requested access to ${item ? `${collection}/${friendly ?? item}` : collection}`,
          message: `${note || 'They hit the access-denied panel and asked for help.'}${why} Grant or deny under System → Access Requests.`,
          sender: req.user?.id ?? null,
          collection,
          item
        }).catch(() => {})
      }

      return reply.send({ data: { requested: true, notified: admins.length } })
    }
  )

  /** Pending grant queue (#55) — admin list + one-click grant/deny. */
  app.get('/access-requests', { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { status?: string }
    const status = ['pending', 'granted', 'denied'].includes(String(q.status))
      ? String(q.status)
      : 'pending'
    const rows = (await db('nivaro_access_requests as r')
      .leftJoin('nivaro_users as u', 'u.id', 'r.user')
      .where('r.status', status)
      .orderBy('r.id', 'desc')
      .limit(200)
      .select(
        'r.*',
        db.raw(
          "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name,''), ' ', COALESCE(u.last_name,'')))) as user_name"
        ),
        'u.email as user_email',
        'u.role as user_role'
      )
      .catch(() => [])) as Array<Record<string, unknown>>
    const data = []
    for (const r of rows) {
      const reasons = parseReasons(r.reasons)
      const item = r.item == null ? null : String(r.item)
      data.push({
        ...r,
        item,
        reasons,
        item_label: item
          ? await resolveFriendlyId(String(r.collection), item).catch(() => item)
          : null,
        plan: r.status === 'pending' ? planGrant(String(r.collection), item ? reasons : null) : []
      })
    }
    return { data }
  })

  /** Grant: adds a READ policy for the requester's ROLE on the collection —
   *  the smallest change that satisfies the request, made by an explicit
   *  admin click. Wider grants stay a Roles-page decision. */
  app.post<{ Params: { id: string }; Body: { decision?: string } }>(
    '/access-requests/:id/resolve',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = (await db('nivaro_access_requests')
        .where({ id: req.params.id, status: 'pending' })
        .first()) as Record<string, unknown> | undefined
      if (!row) return reply.code(404).send({ error: 'Pending request not found' })
      const decision = req.body?.decision === 'grant' ? 'granted' : 'denied'
      const collection = String(row.collection)
      const item = row.item == null ? null : String(row.item)
      const requesterId = String(row.user)
      let policyAdded = false
      const done: string[] = []
      let remaining: AccessReason[] = []
      if (decision === 'granted') {
        const requester = (await db('nivaro_users').where({ id: requesterId }).first()) as
          | Record<string, unknown>
          | undefined
        if (!requester?.role) {
          return reply.code(400).send({ error: 'The requester has no role to grant against' })
        }
        const plan = planGrant(collection, item ? parseReasons(row.reasons) : null)
        for (const action of plan) {
          if (action.type === 'policy') {
            const existing = await db('nivaro_policies')
              .where({ role: requester.role, collection, action: 'read' })
              .first('id')
            if (!existing) {
              await db('nivaro_policies').insert({
                role: requester.role,
                collection,
                action: 'read'
              })
              policyAdded = true
              done.push(action.label)
            }
          } else if (action.type === 'scope' && action.dimension && action.add_ids?.length) {
            // Widen the requester's RESTRICT filter on that dimension by the
            // record's own values — a default (preference) row is left alone.
            const dim = (await listScopeDimensions(false)).find((d) => d.name === action.dimension)
            if (!dim) continue
            const where = { user: requesterId, dimension: dim.name, mode: 'restrict' }
            const existing = (await db('nivaro_user_scopes').where(where).first()) as
              | { id: number; values: unknown }
              | undefined
            let values: Array<string | number> = []
            try {
              values = existing
                ? (JSON.parse(String(existing.values)) as Array<string | number>)
                : []
            } catch {
              values = []
            }
            const have = new Set(values.map(String))
            const adds = action.add_ids.filter((v) => !have.has(String(v)))
            if (adds.length === 0) continue
            const next = [...values, ...adds.map((v) => (/^-?\d+$/.test(v) ? Number(v) : v))]
            if (existing)
              await db('nivaro_user_scopes')
                .where({ id: existing.id })
                .update({ values: JSON.stringify(next), updated_at: new Date() })
            else
              await db('nivaro_user_scopes').insert({
                ...where,
                values: JSON.stringify(next),
                updated_at: new Date()
              })
            bustUserScopeCache(requesterId)
            done.push(action.label)
          }
        }
        // Re-check as the requester: a request the plan could not fully clear
        // (a row-level rule, a strict dimension) stays pending with the rest
        // named, rather than telling them "granted" when it is not.
        if (item) {
          try {
            const check = await explainAccess(requester as never, false, collection, item)
            remaining = check.reasons
          } catch {
            remaining = []
          }
          if (remaining.length > 0) {
            await logActivity({
              action: 'access-request-grant',
              user: req.user?.id,
              collection,
              item,
              comment: `partial for user ${requesterId}: ${done.join('; ') || 'nothing to apply'} — still blocked: ${remaining.map((r) => r.message).join(' ')}`,
              req
            })
            return {
              data: { status: 'pending', applied: done, policy_added: policyAdded, remaining }
            }
          }
        }
      }
      await db('nivaro_access_requests')
        .where({ id: row.id })
        .update({ status: decision, resolved_by: req.user?.id ?? null, resolved_at: new Date() })
      await logActivity({
        action: decision === 'granted' ? 'access-request-grant' : 'access-request-deny',
        user: req.user?.id,
        collection,
        item: item ?? undefined,
        comment: `for user ${requesterId}${done.length ? ` (${done.join('; ')})` : ''}`,
        req
      })
      const friendly = item ? await resolveFriendlyId(collection, item).catch(() => item) : null
      const target = item
        ? `${collection.replace(/_/g, ' ')} ${friendly}`
        : collection.replace(/_/g, ' ')
      await notifyUser(app, requesterId, {
        subject:
          decision === 'granted'
            ? `Access granted: ${target}`
            : `Access request declined: ${target}`,
        message:
          decision === 'granted'
            ? `An administrator opened this up for you${done.length ? ` (${done.join('; ')})` : ''}. Reload and try again.`
            : 'An administrator reviewed and declined this request.',
        sender: req.user?.id ?? null,
        collection,
        item
      }).catch(() => {})
      return { data: { status: decision, applied: done, policy_added: policyAdded, remaining: [] } }
    }
  )
}

const EXPIRE_AFTER_DAYS = 14

/** Daily digest: "Access requests waiting on you" for admins. */
let digestRegistered = false
export function registerAccessRequestDigest(): void {
  if (digestRegistered) return
  digestRegistered = true
  registerDigestSection(async (userId): Promise<DigestSection | null> => {
    const me = (await db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('u.id', userId)
      .first('r.admin_access')) as { admin_access?: boolean } | undefined
    if (!me?.admin_access) return null
    const rows = (await db('nivaro_access_requests as a')
      .leftJoin('nivaro_users as u', 'u.id', 'a.user')
      .where('a.status', 'pending')
      .orderBy('a.id', 'desc')
      .limit(25)
      .select(
        'a.id',
        'a.collection',
        'a.item',
        'a.created_at',
        db.raw(
          "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name,''), ' ', COALESCE(u.last_name,'')))) as who"
        )
      )) as Array<Record<string, unknown>>
    if (rows.length === 0) return null
    const lines = []
    for (const r of rows) {
      const item = r.item == null ? null : String(r.item)
      const label = item
        ? await resolveFriendlyId(String(r.collection), item).catch(() => item)
        : null
      const days = Math.floor((Date.now() - new Date(String(r.created_at)).getTime()) / 86_400_000)
      lines.push({
        text: `${String(r.who || 'Someone')} → ${String(r.collection).replace(/_/g, ' ')}${label ? ` ${label}` : ''}`,
        sub: `waiting ${days} ${days === 1 ? 'day' : 'days'}`,
        url: '/access-requests'
      })
    }
    return { title: `Access requests waiting on you (${rows.length})`, lines }
  })
}

/** Pending requests older than 14 days close as 'expired' — the requester is
 *  told to ask again if it still matters, so the queue never silts up. */
export async function expireStaleAccessRequests(app: FastifyInstance): Promise<number> {
  const cutoff = new Date(Date.now() - EXPIRE_AFTER_DAYS * 86_400_000)
  const rows = (await db('nivaro_access_requests')
    .where('status', 'pending')
    .where('created_at', '<', cutoff)
    .select('id', 'user', 'collection', 'item')) as Array<Record<string, unknown>>
  for (const r of rows) {
    await db('nivaro_access_requests')
      .where({ id: r.id })
      .update({ status: 'expired', resolved_at: new Date() })
    const item = r.item == null ? null : String(r.item)
    const label = item
      ? await resolveFriendlyId(String(r.collection), item).catch(() => item)
      : null
    await notifyUser(app, String(r.user), {
      subject: `Access request expired: ${String(r.collection).replace(/_/g, ' ')}${label ? ` ${label}` : ''}`,
      message: `Nobody acted on your request within ${EXPIRE_AFTER_DAYS} days, so it was closed. If you still need it, open the record and request access again.`,
      collection: String(r.collection),
      item
    }).catch(() => {})
  }
  return rows.length
}
