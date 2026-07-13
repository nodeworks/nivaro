import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'

/**
 * Record timeline — one chronological feed per record, merging what today
 * lives in seven separate panels: activity, revision deltas, workflow
 * transitions, comments, tasks, and addendums. Read-only composition; no
 * new tables.
 */

interface TimelineEvent {
  id: string
  type: 'activity' | 'revision' | 'workflow' | 'comment' | 'task' | 'addendum'
  timestamp: string
  user: { id: string; name: string } | null
  title: string
  detail: string | null
}

const CAP = 300

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v !== 'string') return v as T
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

export async function timelineRoutes(app: FastifyInstance) {
  app.get(
    '/:collection/:item',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, item } = req.params as { collection: string; item: string }
      if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const [activity, revisions, instances, comments, tasks, addendums] = await Promise.all([
        db('nivaro_activity')
          .where({ collection, item })
          .orderBy('timestamp', 'desc')
          .limit(CAP)
          .select('id', 'action', 'user', 'timestamp', 'comment'),
        db('nivaro_revisions as r')
          .join('nivaro_activity as a', 'a.id', 'r.activity')
          .where({ 'r.collection': collection, 'r.item': item })
          .orderBy('a.timestamp', 'desc')
          .limit(CAP)
          .select('r.id', 'r.delta', 'a.timestamp', 'a.user', 'a.action'),
        db('nivaro_workflow_instances').where({ collection, item }).select('id'),
        db('nivaro_comments')
          .where({ collection, item })
          .orderBy('created_at', 'desc')
          .limit(CAP)
          .select('id', 'user', 'text', 'created_at'),
        db('nivaro_tasks')
          .where({ collection, item })
          .orderBy('created_at', 'desc')
          .limit(CAP)
          .select('id', 'title', 'status', 'assignee', 'created_at', 'completed_at', 'created_by'),
        db('nivaro_addendums')
          .where({ parent_collection: collection, parent_id: item })
          .orderBy('created_at', 'desc')
          .limit(CAP)
          .select('id', 'title', 'status', 'created_by', 'approved_by', 'created_at', 'updated_at')
          .catch(() => [])
      ])

      const history =
        instances.length > 0
          ? await db('nivaro_workflow_history as h')
              .leftJoin('nivaro_workflow_states as fs', 'h.from_state', 'fs.id')
              .leftJoin('nivaro_workflow_states as ts', 'h.to_state', 'ts.id')
              .whereIn(
                'h.instance',
                instances.map((i: { id: string }) => i.id)
              )
              .orderBy('h.timestamp', 'desc')
              .limit(CAP)
              .select(
                'h.id',
                'h.user',
                'h.timestamp',
                'h.comment',
                'fs.label as from_label',
                'ts.label as to_label',
                'ts.color as to_color'
              )
          : []

      const events: TimelineEvent[] = []
      // Revision rows share their activity row's timestamp+action — suppress the
      // bare activity duplicate when a revision covers it.
      const revisionActivityKeys = new Set(
        (revisions as Array<{ timestamp: Date; action: string }>).map(
          (r) => `${new Date(r.timestamp).getTime()}:${r.action}`
        )
      )

      for (const a of activity as Array<Record<string, unknown>>) {
        const key = `${new Date(a.timestamp as string).getTime()}:${String(a.action)}`
        if ((a.action === 'update' || a.action === 'create') && revisionActivityKeys.has(key)) continue
        events.push({
          id: `a-${a.id}`,
          type: 'activity',
          timestamp: new Date(a.timestamp as string).toISOString(),
          user: a.user ? { id: String(a.user), name: '' } : null,
          title: String(a.action),
          detail: a.comment ? String(a.comment) : null
        })
      }
      for (const r of revisions as Array<Record<string, unknown>>) {
        const delta = parseJson<Record<string, unknown>>(r.delta)
        const changed = delta ? Object.keys(delta).filter((k) => k !== 'id') : []
        events.push({
          id: `r-${r.id}`,
          type: 'revision',
          timestamp: new Date(r.timestamp as string).toISOString(),
          user: r.user ? { id: String(r.user), name: '' } : null,
          title: r.action === 'create' ? 'Record created' : 'Fields changed',
          detail: changed.length > 0 ? changed.slice(0, 12).join(', ') : null
        })
      }
      for (const h of history as Array<Record<string, unknown>>) {
        events.push({
          id: `w-${h.id}`,
          type: 'workflow',
          timestamp: new Date(h.timestamp as string).toISOString(),
          user: h.user ? { id: String(h.user), name: '' } : null,
          title: h.from_label
            ? `${String(h.from_label)} → ${String(h.to_label ?? '?')}`
            : `Started in ${String(h.to_label ?? '?')}`,
          detail: h.comment ? String(h.comment) : null
        })
      }
      for (const c of comments as Array<Record<string, unknown>>) {
        events.push({
          id: `c-${c.id}`,
          type: 'comment',
          timestamp: new Date(c.created_at as string).toISOString(),
          user: c.user ? { id: String(c.user), name: '' } : null,
          title: 'Comment',
          detail: String(c.text ?? '').slice(0, 300)
        })
      }
      for (const t of tasks as Array<Record<string, unknown>>) {
        events.push({
          id: `t-${t.id}`,
          type: 'task',
          timestamp: new Date(t.created_at as string).toISOString(),
          user: t.assignee ? { id: String(t.assignee), name: '' } : null,
          title: `Task created: ${String(t.title)}`,
          detail: null
        })
        if (t.completed_at) {
          events.push({
            id: `t-${t.id}-done`,
            type: 'task',
            timestamp: new Date(t.completed_at as string).toISOString(),
            user: t.assignee ? { id: String(t.assignee), name: '' } : null,
            title: `Task completed: ${String(t.title)}`,
            detail: null
          })
        }
      }
      for (const ad of addendums as Array<Record<string, unknown>>) {
        events.push({
          id: `ad-${ad.id}`,
          type: 'addendum',
          timestamp: new Date(ad.created_at as string).toISOString(),
          user: ad.created_by ? { id: String(ad.created_by), name: '' } : null,
          title: `Addendum: ${String(ad.title)}`,
          detail: `status: ${String(ad.status)}`
        })
      }

      // Resolve user names in one batch
      const userIds = [...new Set(events.map((e) => e.user?.id).filter(Boolean))] as string[]
      if (userIds.length > 0) {
        const users = (await db('nivaro_users')
          .whereIn('id', userIds)
          .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
        const nameById = new Map(
          users.map((u) => [
            String(u.id),
            ([u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.email ?? '')) as string
          ])
        )
        for (const e of events) {
          if (e.user) e.user.name = nameById.get(e.user.id) ?? e.user.id.slice(0, 8)
        }
      }

      events.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      return reply.send({ data: events.slice(0, CAP) })
    }
  )
}
