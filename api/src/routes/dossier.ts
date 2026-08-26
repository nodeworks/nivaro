import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { loadFormLayout } from '../services/form-layout.js'
import { ForbiddenError, ItemNotFoundError, readOne } from '../services/items.js'
import { htmlToPdf } from '../services/pdf-layout.js'
import { getLabels } from '../services/queues.js'

/**
 * Record dossier export (#641) — one PDF telling a record's whole story:
 * current field values (active grouped layout's sections), the activity
 * timeline, workflow history, comments and tasks. Built for audits and
 * hand-offs ("print me everything about this request").
 *
 * Configurable per layout (Rob's explicit ask): the collection's ACTIVE
 * grouped layout must have `dossier_enabled` on (migration 278, default OFF)
 * or the route answers 404 — the button simply doesn't exist for that
 * collection. Record access = readOne as the caller (RBAC/RLS/scopes bind).
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function stripTags(v: unknown): string {
  return String(v ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function fmtVal(v: unknown): string {
  if (v == null || v === '') return '—'
  if (v === true || v === 1) return 'Yes'
  if (v === false || v === 0) return 'No'
  if (v instanceof Date) return v.toLocaleString('en-US')
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) return d.toLocaleString('en-US')
  }
  if (s.startsWith('<')) return stripTags(s).slice(0, 500) || '—'
  if (s.startsWith('{') || s.startsWith('[')) return s.slice(0, 200)
  return s.slice(0, 500)
}

function fmtWhen(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US')
}

export async function dossierRoutes(app: FastifyInstance) {
  app.get<{ Params: { collection: string; id: string } }>(
    '/:collection/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!IDENT_RE.test(collection) || /^(nivaro|directus)_/i.test(collection)) {
        return reply.code(400).send({ error: 'Business collections only' })
      }

      // Gate: the active grouped layout must opt in.
      const layout = (await db('nivaro_collection_layouts')
        .where({ collection, layout_type: 'grouped', is_active: true })
        .first('id', 'name', 'dossier_enabled')) as
        | { id: number; name: string; dossier_enabled?: boolean | number }
        | undefined
      if (!layout || !(layout.dossier_enabled === true || layout.dossier_enabled === 1)) {
        return reply.code(404).send({ error: 'Dossier export is not enabled for this collection' })
      }

      let record: Record<string, unknown>
      try {
        record = (await readOne(
          req.user!,
          collection,
          id,
          req.workspaceId ?? undefined
        )) as Record<string, unknown>
      } catch (err) {
        if (err instanceof ForbiddenError) return reply.code(403).send({ error: 'Forbidden' })
        if (err instanceof ItemNotFoundError) return reply.code(404).send({ error: 'Not found' })
        throw err
      }

      const structure = await loadFormLayout(layout.id, collection, { includeReadonly: true })

      const [activity, comments, tasks, instances, colMeta] = await Promise.all([
        db('nivaro_activity')
          .where({ collection, item: id })
          .orderBy('timestamp', 'desc')
          .limit(40)
          .select('action', 'user', 'timestamp', 'comment')
          .catch(() => []),
        db('nivaro_comments')
          .where({ collection, item: id })
          .orderBy('created_at', 'asc')
          .limit(30)
          .select('user', 'text', 'created_at')
          .catch(() => []),
        db('nivaro_tasks')
          .where({ collection, item: id })
          .orderBy('created_at', 'asc')
          .limit(30)
          .select('title', 'status', 'assignee', 'created_at', 'completed_at')
          .catch(() => []),
        db('nivaro_workflow_instances')
          .where({ collection, item: id })
          .select('id')
          .catch(() => []),
        db('nivaro_collections').where({ collection }).first('display_name')
      ])

      const history =
        instances.length > 0
          ? ((await db('nivaro_workflow_history as h')
              .leftJoin('nivaro_workflow_states as fs', 'fs.id', 'h.from_state')
              .leftJoin('nivaro_workflow_states as ts', 'ts.id', 'h.to_state')
              .whereIn(
                'h.instance',
                instances.map((i: { id: string }) => i.id)
              )
              .orderBy('h.timestamp', 'asc')
              .limit(60)
              .select(
                'h.timestamp',
                'h.user',
                'h.comment',
                'fs.label as from_label',
                'ts.label as to_label'
              )
              .catch(() => [])) as Array<Record<string, unknown>>)
          : []

      // People: resolve every user id across sections in one batch.
      const userIds = new Set<string>()
      for (const rows of [activity, comments, tasks, history] as Array<
        Array<Record<string, unknown>>
      >) {
        for (const r of rows) {
          for (const k of ['user', 'assignee']) if (r[k]) userIds.add(String(r[k]))
        }
      }
      const userMap = new Map<string, string>()
      if (userIds.size > 0) {
        const users = (await db('nivaro_users')
          .whereIn('id', [...userIds].slice(0, 500))
          .select('id', 'first_name', 'last_name', 'email')
          .catch(() => [])) as Array<Record<string, unknown>>
        for (const u of users) {
          userMap.set(
            String(u.id),
            [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || String(u.email ?? '')
          )
        }
      }
      const who = (uid: unknown): string => (uid ? (userMap.get(String(uid)) ?? 'System') : 'System')

      // M2O labels: FK relations on this collection, resolved via getLabels.
      const rels = (await db('nivaro_relations')
        .where({ many_collection: collection })
        .whereNull('junction_field')
        .whereNotNull('one_collection')
        .select('many_field', 'one_collection')
        .catch(() => [])) as Array<{ many_field: string; one_collection: string }>
      const labelWants = new Map<string, Set<string>>()
      const fkTargets = new Map<string, string>()
      for (const r of rels) {
        const v = record[r.many_field]
        if (v == null || v === '' || /^(nivaro|directus)_/i.test(r.one_collection)) continue
        fkTargets.set(r.many_field, r.one_collection)
        const set = labelWants.get(r.one_collection) ?? new Set<string>()
        set.add(String(v))
        labelWants.set(r.one_collection, set)
      }
      const fkLabels = labelWants.size
        ? await getLabels(labelWants).catch(() => ({}) as Record<string, string>)
        : ({} as Record<string, string>)
      const valFor = (field: string): string => {
        const target = fkTargets.get(field)
        if (target && record[field] != null) {
          const label = (fkLabels as Record<string, string>)[`${target}:${record[field]}`]
          if (label) return label
        }
        return fmtVal(record[field])
      }

      const collectionLabel = (colMeta?.display_name as string | null) ?? collection
      const recordLabel = String(
        record.workflow_id ?? record.name ?? record.title ?? record.label ?? record.subject ?? id
      )

      const sectionsHtml = (structure?.sections ?? [])
        .map((sec) => {
          const rows = sec.fields
            .map(
              (f) =>
                `<div class="fld"><div class="k">${esc(f.label)}</div><div class="v">${esc(valFor(f.path))}</div></div>`
            )
            .join('')
          if (!rows) return ''
          return `<section><h2>${esc(sec.label ?? 'Details')}</h2><div class="grid">${rows}</div></section>`
        })
        .join('')

      const historyHtml = history.length
        ? `<section><h2>Workflow history</h2><table><tr><th>When</th><th>Transition</th><th>By</th><th>Comment</th></tr>${history
            .map(
              (h) =>
                `<tr><td>${esc(fmtWhen(h.timestamp))}</td><td>${esc(h.from_label ? `${h.from_label} → ${h.to_label}` : (h.to_label ?? ''))}</td><td>${esc(who(h.user))}</td><td>${esc(stripTags(h.comment).slice(0, 300))}</td></tr>`
            )
            .join('')}</table></section>`
        : ''

      const commentsHtml = comments.length
        ? `<section><h2>Comments</h2>${(comments as Array<Record<string, unknown>>)
            .map(
              (c) =>
                `<div class="note"><span class="meta">${esc(who(c.user))} · ${esc(fmtWhen(c.created_at))}</span><p>${esc(stripTags(c.text).slice(0, 600))}</p></div>`
            )
            .join('')}</section>`
        : ''

      const tasksHtml = tasks.length
        ? `<section><h2>Tasks</h2><table><tr><th>Task</th><th>Assignee</th><th>Status</th><th>Completed</th></tr>${(
            tasks as Array<Record<string, unknown>>
          )
            .map(
              (t) =>
                `<tr><td>${esc(t.title)}</td><td>${esc(who(t.assignee))}</td><td>${esc(t.status)}</td><td>${esc(t.completed_at ? fmtWhen(t.completed_at) : '—')}</td></tr>`
            )
            .join('')}</table></section>`
        : ''

      const activityHtml = activity.length
        ? `<section><h2>Recent activity</h2><table><tr><th>When</th><th>Action</th><th>By</th><th>Note</th></tr>${(
            activity as Array<Record<string, unknown>>
          )
            .map(
              (a) =>
                `<tr><td>${esc(fmtWhen(a.timestamp))}</td><td>${esc(a.action)}</td><td>${esc(who(a.user))}</td><td>${esc(stripTags(a.comment).slice(0, 200))}</td></tr>`
            )
            .join('')}</table></section>`
        : ''

      const generatedBy = req.user?.first_name
        ? `${req.user.first_name} ${req.user.last_name ?? ''}`.trim()
        : (req.user?.email ?? 'System')

      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1e293b;margin:0;padding:32px 40px;font-size:11px}
        header{border-bottom:3px solid #172940;padding-bottom:12px;margin-bottom:20px}
        header h1{margin:0;font-size:20px;color:#172940}
        header .sub{margin-top:3px;color:#64748b;font-size:10.5px}
        h2{font-size:12px;color:#172940;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e2e8f0;padding-bottom:4px;margin:22px 0 10px}
        .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 18px}
        .fld .k{font-size:8.5px;text-transform:uppercase;letter-spacing:.04em;color:#94a3b8}
        .fld .v{margin-top:1px;word-break:break-word}
        table{width:100%;border-collapse:collapse;font-size:10px}
        th{text-align:left;font-size:8.5px;text-transform:uppercase;letter-spacing:.04em;color:#94a3b8;padding:3px 6px;border-bottom:1px solid #e2e8f0}
        td{padding:4px 6px;border-bottom:1px solid #f1f5f9;vertical-align:top}
        .note{margin-bottom:8px;padding:6px 8px;background:#f8fafc;border-radius:4px}
        .note .meta{font-size:9px;color:#94a3b8}
        .note p{margin:2px 0 0}
        footer{margin-top:28px;padding-top:8px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:9px}
        section{break-inside:avoid-page}
      </style></head><body>
        <header>
          <h1>${esc(collectionLabel)} — ${esc(recordLabel)}</h1>
          <div class="sub">Record dossier · generated ${esc(new Date().toLocaleString('en-US'))} by ${esc(generatedBy)}</div>
        </header>
        ${sectionsHtml}${historyHtml}${tasksHtml}${commentsHtml}${activityHtml}
        <footer>Complete record dossier for ${esc(collection)}/${esc(id)} — field values are current as of generation; history and comments are capped at the most recent entries.</footer>
      </body></html>`

      const pdf = await htmlToPdf(html)
      await logActivity({
        action: 'dossier-export',
        user: req.user?.id,
        collection,
        item: String(id),
        req
      })
      return reply
        .header('Content-Type', 'application/pdf')
        .header(
          'Content-Disposition',
          `attachment; filename="dossier-${collection}-${String(id).replace(/[^A-Za-z0-9_-]/g, '')}.pdf"`
        )
        .send(pdf)
    }
  )
}
