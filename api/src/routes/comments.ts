import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { ensureAutoWatch } from '../services/auto-watch.js'
import { requireAuth } from '../middleware/authenticate.js'
import { emitNotification } from '../plugins/socketio.js'
import { logActivity } from '../services/activity.js'
import { sendTeamsNotification } from '../services/microsoft.js'
import { can } from '../services/permissions.js'
import { resolveStateOwners } from '../services/pipeline-engine.js'

/** How a child row identifies itself, for "which forecast was this about". */
const CHILD_LABEL_FIELDS = ['year', 'name', 'title', 'label', 'period', 'month', 'key', 'code']

function childRowLabel(row: Record<string, unknown>): string | null {
  for (const f of CHILD_LABEL_FIELDS) {
    const v = row[f]
    if (v !== null && v !== undefined && String(v).trim() !== '') {
      const text = String(v).trim()
      return text.length > 40 ? `${text.slice(0, 40)}…` : text
    }
  }
  return row.id != null ? `#${row.id}` : null
}

/** The columns a revision actually changed — "february, total" says more about
 *  a forecast edit than the row's name does. */
function changedFieldNames(delta: unknown): string | null {
  let parsed: unknown = delta
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const keys = Object.keys(parsed as Record<string, unknown>).filter((k) => !k.startsWith('_'))
  if (keys.length === 0) return null
  const shown = keys.slice(0, 4).map((k) => k.replace(/_/g, ' '))
  return keys.length > 4 ? `${shown.join(', ')} +${keys.length - 4} more` : shown.join(', ')
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
})

/** What the amendment proposed, in money terms. */
function amountChange(previous: unknown, next: unknown, impact: unknown): string | null {
  const p = Number(previous)
  const n = Number(next)
  if (Number.isFinite(p) && Number.isFinite(n) && p !== n) {
    const diff = n - p
    return `${usd.format(p)} → ${usd.format(n)} (${diff >= 0 ? '+' : '−'}${usd.format(Math.abs(diff))})`
  }
  const i = Number(impact)
  if (Number.isFinite(i) && i !== 0) return `${i >= 0 ? '+' : '−'}${usd.format(Math.abs(i))}`
  return null
}


/**
 * Comment strings written by MACHINERY, not people: the legacy import stamped
 * every row it carried across, the reforecast proc marks its own writes, and
 * the forecast-revision converter tags absorbed rows. They are provenance, and
 * putting them in a notes thread buries the handful of real notes under
 * hundreds of identical markers.
 */
const MACHINE_COMMENT_EXACT = new Set(['legacy-import', 'reforecast', 'legacy-state-sync'])
const MACHINE_COMMENT_PREFIXES = ['forecast-import:', 'invoice-decision:']

function isHumanNote(text: string | null | undefined): boolean {
  const t = String(text ?? '').trim()
  if (t === '') return false
  if (MACHINE_COMMENT_EXACT.has(t.toLowerCase())) return false
  return !MACHINE_COMMENT_PREFIXES.some((p) => t.toLowerCase().startsWith(p))
}


/** Addendum reasons are rich text; the thread shows plain prose. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}


// ─── Types ──────────────────────────────────────────────────────────────────

interface CommentRow {
  id: string
  collection: string
  item: string
  user: string
  text: string
  created_at: Date
  updated_at: Date
}

interface MentionUserRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

const MENTION_RE = /(@[a-zA-Z0-9._-]+)/g

/** "@owners" in a comment fans out to whoever CURRENTLY resolves as the
 *  record's pipeline owners — the author doesn't have to know their names. */
const OWNERS_MENTION_RE = /(^|\s)@owners\b/i

async function resolveOwnerMentions(
  collection: string,
  item: string
): Promise<MentionUserRow[]> {
  const instance = (await db('nivaro_workflow_instances')
    .where({ collection, item: String(item) })
    .whereNull('completed_at')
    .orderBy('started_at', 'desc')
    .first('id', 'current_state')) as { id: string; current_state: string } | undefined
  if (!instance?.current_state) return []
  const owners = await resolveStateOwners(instance.current_state, instance.id, collection, String(item))
  return owners.map((o) => ({
    id: o.id,
    first_name: o.first_name,
    last_name: o.last_name,
    email: o.email
  }))
}

// Resolve @mentions in text to nivaro_users by email prefix or first_name match.
async function resolveMentions(text: string): Promise<MentionUserRow[]> {
  const matches = text.match(MENTION_RE)
  if (!matches || matches.length === 0) return []

  const handles = Array.from(new Set(matches.map((m) => m.slice(1).toLowerCase())))
  const found = new Map<string, MentionUserRow>()

  for (const handle of handles) {
    const users = (await db('nivaro_users')
      .where('status', 'active')
      .andWhere((qb) => {
        qb.whereRaw('LOWER(email) LIKE ?', [`${handle}@%`]).orWhereRaw('LOWER(first_name) = ?', [
          handle
        ])
      })
      .select('id', 'first_name', 'last_name', 'email')) as MentionUserRow[]
    for (const u of users) found.set(u.id, u)

    // Role mentions (#441): "@finance-approvers" (role name, spaces as
    // hyphens) fans the mention to every ACTIVE member of that role. The
    // client autocomplete inserts this form; a handle matching both a person
    // and a role notifies both — mentioning is deliberately generous.
    if (users.length === 0 || handle.includes('-')) {
      // User-group mentions (#682): the handle's hyphenated form IS a group
      // slug ("@field-techs"). Groups are tried FIRST — a group is more
      // specific than a role name — and only a miss falls through to roles.
      let groupMatched = false
      const group = (await db('nivaro_user_groups')
        .whereRaw('LOWER(slug) = ?', [handle])
        .first('id')
        .catch(() => undefined)) as { id: number } | undefined
      if (group) {
        const groupMembers = (await db('nivaro_user_group_members as m')
          .join('nivaro_users as u', 'u.id', 'm.user')
          .where('m.group_id', group.id)
          .where('u.status', 'active')
          .where('u.is_redacted', false)
          .limit(100)
          .select('u.id', 'u.first_name', 'u.last_name', 'u.email')) as MentionUserRow[]
        for (const u of groupMembers) found.set(u.id, u)
        groupMatched = true
      }

      if (!groupMatched) {
        const roleName = handle.replace(/-/g, ' ')
        const role = (await db('nivaro_roles')
          .whereRaw('LOWER(name) = ?', [roleName])
          .first('id')) as { id: string } | undefined
        if (role) {
          const members = (await db('nivaro_users')
            .where({ role: role.id, status: 'active' })
            .where('is_redacted', false)
            .limit(100)
            .select('id', 'first_name', 'last_name', 'email')) as MentionUserRow[]
          for (const u of members) found.set(u.id, u)
        }
      }
    }
  }

  return Array.from(found.values())
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function commentsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // List comments for a record
  app.get<{ Querystring: { collection?: string; item?: string } }>('/', async (req, reply) => {
    const { collection, item } = req.query
    if (!collection || !item) {
      return reply.code(400).send({ error: 'collection and item are required' })
    }

    // Gate on read permission for the parent collection.
    if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const comments = (await db('nivaro_comments as c')
      .leftJoin('nivaro_users as u', 'c.user', 'u.id')
      .where({ 'c.collection': collection, 'c.item': item })
      .orderBy('c.created_at', 'asc')
      .select(
        'c.id',
        'c.collection',
        'c.item',
        'c.user',
        'c.text',
        'c.created_at',
        'c.updated_at',
        'u.first_name',
        'u.last_name',
        'u.email'
      )) as Array<
      CommentRow & {
        first_name: string | null
        last_name: string | null
        email: string | null
      }
    >

    const ids = comments.map((c) => c.id)
    const mentions = ids.length
      ? ((await db('nivaro_comment_mentions as m')
          .leftJoin('nivaro_users as u', 'm.user', 'u.id')
          .whereIn('m.comment', ids)
          .select(
            'm.id',
            'm.comment',
            'm.user',
            'u.first_name',
            'u.last_name',
            'u.email'
          )) as Array<{
          id: number
          comment: string
          user: string
          first_name: string | null
          last_name: string | null
          email: string | null
        }>)
      : []

    const mentionsByComment = new Map<string, typeof mentions>()
    for (const m of mentions) {
      const arr = mentionsByComment.get(m.comment) ?? []
      arr.push(m)
      mentionsByComment.set(m.comment, arr)
    }

    // Reactions, aggregated per comment: [{emoji, count, mine}].
    const reactionRows = ids.length
      ? ((await db('nivaro_comment_reactions')
          .whereIn('comment', ids)
          .select('comment', 'user', 'emoji')
          .catch(() => [])) as Array<{ comment: string; user: string; emoji: string }>)
      : []
    const reactionsByComment = new Map<string, Array<{ emoji: string; count: number; mine: boolean }>>()
    for (const r of reactionRows) {
      const list = reactionsByComment.get(r.comment) ?? []
      let agg = list.find((a) => a.emoji === r.emoji)
      if (!agg) {
        agg = { emoji: r.emoji, count: 0, mine: false }
        list.push(agg)
      }
      agg.count++
      if (String(r.user).toUpperCase() === String(req.user!.id).toUpperCase()) agg.mine = true
      reactionsByComment.set(r.comment, list)
    }

    const data = comments.map((c) => ({
      id: c.id,
      collection: c.collection,
      item: c.item,
      user: c.user
        ? {
            id: c.user,
            first_name: c.first_name,
            last_name: c.last_name,
            email: c.email
          }
        : null,
      text: c.text,
      created_at: c.created_at,
      updated_at: c.updated_at,
      mentions: (mentionsByComment.get(c.id) ?? []).map((m) => ({
        id: m.user,
        first_name: m.first_name,
        last_name: m.last_name,
        email: m.email
      })),
      reactions: reactionsByComment.get(c.id) ?? []
    }))

    return { data }
  })

  // Create comment
  /**
   * Read-only note-like entries from elsewhere on the record, so the notes
   * thread shows everything anyone wrote about this item in one place rather
   * than scattering it across the pipeline panel, the addendum list and the
   * change history.
   *
   * Three sources, all things a PERSON typed:
   *  - the comment on a workflow transition
   *  - a change reason (migration 189) on this record or on a child row that
   *    requires one — a forecast's justification belongs on the workflow it
   *    is forecasting, not only on the forecast row
   *  - the reason written on an addendum
   *
   * Never editable: these belong to the thing that recorded them. Gated on
   * read permission for the parent collection, same as the comments list.
   */
  app.get<{ Querystring: { collection?: string; item?: string } }>(
    '/related',
    async (req, reply) => {
      const { collection, item } = req.query
      if (!collection || !item) {
        return reply.code(400).send({ error: 'collection and item are required' })
      }
      if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const CAP = 200
      type Entry = {
        id: string
        source: 'transition' | 'change_reason' | 'addendum' | 'note'
        label: string
        text: string
        user: string | null
        created_at: string | Date
        context: string | null
        link?: { collection: string; item_id: string }
        comment_id?: string
        reactions?: Array<{ emoji: string; count: number; mine: boolean }>
      }

      const instances = (await db('nivaro_workflow_instances')
        .where({ collection, item: String(item) })
        .select('id')) as Array<{ id: string }>

      const [transitions, ownReasons, addendums] = await Promise.all([
        instances.length
          ? (db('nivaro_workflow_history as h')
              .leftJoin('nivaro_workflow_states as fs', 'h.from_state', 'fs.id')
              .leftJoin('nivaro_workflow_states as ts', 'h.to_state', 'ts.id')
              .whereIn('h.instance', instances.map((i) => i.id))
              .whereNotNull('h.comment')
              .orderBy('h.timestamp', 'desc')
              .limit(CAP)
              .select('h.id', 'h.user', 'h.timestamp', 'h.comment', 'fs.label as from_label', 'ts.label as to_label')
              .catch(() => []) as Promise<Array<Record<string, unknown>>>)
          : Promise.resolve([]),
        db('nivaro_activity')
          .where({ collection, item: String(item) })
          .whereNotNull('comment')
          .orderBy('timestamp', 'desc')
          .limit(CAP)
          .select('id', 'user', 'timestamp', 'comment', 'action')
          .catch(() => []) as Promise<Array<Record<string, unknown>>>,
        // `description` IS the addendum's reason text — there is no `reason`
        // column; rejection_reason is a different thing entirely.
        db('nivaro_addendums')
          .where({ parent_collection: collection, parent_id: String(item) })
          .whereNotNull('description')
          .orderBy('created_at', 'desc')
          .limit(CAP)
          .select(
            'id',
            'title',
            'description',
            'status',
            'created_by',
            'created_at',
            'cost_impact',
            'previous_amount',
            'new_amount'
          )
          .catch(() => [] as Array<Record<string, unknown>>) as Promise<
          Array<Record<string, unknown>>
        >
      ])

      // What the record's own reasoned changes actually touched.
      const ownChanged = new Map<string, string>()
      if (ownReasons.length > 0) {
        const revs = (await db('nivaro_revisions')
          .whereIn(
            'activity',
            ownReasons.map((a) => a.id as number)
          )
          .select('activity', 'delta')
          .catch(() => [])) as Array<Record<string, unknown>>
        for (const rev of revs) {
          const fields = changedFieldNames(rev.delta)
          if (fields) ownChanged.set(String(rev.activity), fields)
        }
      }

      // Change reasons written on CHILD rows (a forecast's justification, say).
      // Only collections that actually require a reason are considered, so this
      // is a couple of cheap queries rather than a sweep of every relation.
      const childReasons: Array<Record<string, unknown>> = []
      try {
        const reasonCollections = (await db('nivaro_collections')
          .whereNotNull('change_reason_config')
          .select('collection')) as Array<{ collection: string }>
        for (const rc of reasonCollections) {
          if (rc.collection === collection) continue
          const rels = (await db('nivaro_relations')
            .where({ many_collection: rc.collection, one_collection: collection })
            .select('many_field')) as Array<{ many_field: string }>
          if (rels.length === 0) continue
          const childRows = (await db(rc.collection)
            .where((qb) => {
              for (const r of rels) void qb.orWhere(r.many_field, item)
            })
            .limit(1000)
            .select('*')) as Array<Record<string, unknown>>
          if (childRows.length === 0) continue
          // "Forecasts" alone does not say WHICH forecast — carry whatever the
          // row identifies itself by so a reader can place the note.
          const labelByChildId = new Map(
            childRows.map((r) => [String(r.id), childRowLabel(r)])
          )
          const rows = (await db('nivaro_activity')
            .where({ collection: rc.collection })
            .whereIn('item', [...labelByChildId.keys()])
            .whereNotNull('comment')
            .orderBy('timestamp', 'desc')
            .limit(CAP)
            .select('id', 'user', 'timestamp', 'comment', 'item')) as Array<Record<string, unknown>>
          // What actually changed, from the revision delta written alongside.
          const changedByActivity = new Map<string, string>()
          if (rows.length > 0) {
            const revs = (await db('nivaro_revisions')
              .whereIn(
                'activity',
                rows.map((r) => r.id as number)
              )
              .select('activity', 'delta')
              .catch(() => [])) as Array<Record<string, unknown>>
            for (const rev of revs) {
              const fields = changedFieldNames(rev.delta)
              if (fields) changedByActivity.set(String(rev.activity), fields)
            }
          }
          for (const r of rows) {
            childReasons.push({
              ...r,
              child: rc.collection,
              child_label: labelByChildId.get(String(r.item)) ?? null,
              changed: changedByActivity.get(String(r.id)) ?? null
            })
          }
        }
      } catch {
        // A missing child table or relation must not take down the thread.
      }

      // Note tables. Some deployments keep human notes as their own child
      // collection rather than in nivaro_comments — those are notes about this
      // record by any reasonable definition, and a thread that ignored them
      // showed nothing while the record plainly had commentary on it.
      // Recognised by CONVENTION, not by a hardcoded name: a child collection
      // called notes/comments (singular or plural) carrying a text column.
      const noteRows: Array<Record<string, unknown>> = []
      try {
        const rels = (await db('nivaro_relations')
          .where({ one_collection: collection })
          .whereNotNull('many_collection')
          .select('many_collection', 'many_field')) as Array<{
          many_collection: string
          many_field: string
        }>
        const noteRels = rels.filter(
          (r) => /(^|_)(notes?|comments?)$/i.test(r.many_collection) && !!r.many_field
        )
        for (const rel of noteRels) {
          const cols = (await db('information_schema.columns')
            .where({ table_name: rel.many_collection })
            .select('column_name')) as Array<{ column_name: string }>
          const names = new Set(cols.map((c) => String(c.column_name).toLowerCase()))
          const textCol = ['text', 'note', 'notes', 'comment', 'body', 'message'].find((c) =>
            names.has(c)
          )
          if (!textCol) continue
          const userCol = ['creator', 'user_created', 'created_by', 'user'].find((c) =>
            names.has(c)
          )
          const dateCol = ['created', 'date_created', 'created_at', 'timestamp'].find((c) =>
            names.has(c)
          )
          const rows = (await db(rel.many_collection)
            .where(rel.many_field, item)
            .orderBy(dateCol ?? 'id', 'desc')
            .limit(CAP)
            .select('*')) as Array<Record<string, unknown>>
          for (const r of rows) {
            const text = r[textCol]
            if (text === null || text === undefined || String(text).trim() === '') continue
            noteRows.push({
              id: `note:${rel.many_collection}:${String(r.id)}`,
              text: String(text),
              user: userCol ? (r[userCol] ?? null) : null,
              created_at: dateCol ? r[dateCol] : null,
              // A note stamped with the state it was written in says more than
              // "Note" alone.
              context: r.type ? titleCase(String(r.type)) : null
            })
          }
        }
      } catch {
        // Same posture as the rest of this route: a missing table or column
        // must never take the whole thread down.
      }

      // Comments posted ON CHILD ROWS of this record (line-item comments):
      // "line 7: wrong CIFA" belongs in the record's thread too, with the
      // line named. Only child collections that actually hold comments are
      // walked — one probe query keeps this cheap.
      const lineComments: Array<Record<string, unknown>> = []
      try {
        const childRels = (await db('nivaro_relations')
          .where({ one_collection: collection })
          .whereNotNull('many_collection')
          .select('many_collection', 'many_field')) as Array<{
          many_collection: string
          many_field: string
        }>
        const childCollections = [...new Set(childRels.map((r) => r.many_collection))]
        const commented = childCollections.length
          ? ((await db('nivaro_comments')
              .whereIn('collection', childCollections)
              .distinct('collection')) as Array<{ collection: string }>)
          : []
        for (const cc of commented) {
          const rels = childRels.filter((r) => r.many_collection === cc.collection)
          const childRows = (await db(cc.collection)
            .where((qb) => {
              for (const r of rels) void qb.orWhere(r.many_field, item)
            })
            .limit(1000)
            .select('*')) as Array<Record<string, unknown>>
          if (childRows.length === 0) continue
          const labelByChildId = new Map(childRows.map((r) => [String(r.id), childRowLabel(r)]))
          const rows = (await db('nivaro_comments')
            .where({ collection: cc.collection })
            .whereIn('item', [...labelByChildId.keys()])
            .orderBy('created_at', 'desc')
            .limit(CAP)
            .select('id', 'user', 'text', 'item', 'created_at')) as Array<Record<string, unknown>>
          // Human labels: the collection's display_template first ("CR26-76773 ·
          // Line 7"), the row's own name-ish column second — a bare internal id
          // identifies nothing to a reader.
          let templateLabels: Record<string, string> = {}
          if (rows.length > 0) {
            try {
              const { getLabels } = await import('../services/queues.js')
              templateLabels = await getLabels(
                new Map([[cc.collection, new Set(rows.map((r) => String(r.item)))]])
              )
            } catch {
              /* fall through to the name-column label */
            }
          }
          // Display templates with DOTTED tokens render those tokens empty
          // here (renderTemplateLabels resolves direct columns only), leaving
          // dangling separators ("· Line 4") — trim them.
          const cleanLabel = (v: string | null | undefined): string | null => {
            if (!v) return null
            const cleaned = v
              .replace(/\s*[·\-–|]\s*(?=[·\-–|])/g, '')
              .replace(/^\s*[·\-–|]\s*/, '')
              .replace(/\s*[·\-–|]\s*$/, '')
              .trim()
            return cleaned || null
          }
          // Reactions ride along: a line comment is a real comment, and the
          // thread must offer the same chips the child grid's popover does.
          const reactionRows = rows.length
            ? ((await db('nivaro_comment_reactions')
                .whereIn('comment', rows.map((r) => String(r.id)))
                .select('comment', 'user', 'emoji')
                .catch(() => [])) as Array<{ comment: string; user: string; emoji: string }>)
            : []
          const reactionsFor = (id: string) => {
            const list: Array<{ emoji: string; count: number; mine: boolean }> = []
            for (const rr of reactionRows) {
              if (String(rr.comment).toUpperCase() !== id.toUpperCase()) continue
              let agg = list.find((a) => a.emoji === rr.emoji)
              if (!agg) {
                agg = { emoji: rr.emoji, count: 0, mine: false }
                list.push(agg)
              }
              agg.count++
              if (String(rr.user).toUpperCase() === String(req.user!.id).toUpperCase()) agg.mine = true
            }
            return list
          }
          for (const r of rows) {
            lineComments.push({
              ...r,
              child: cc.collection,
              child_label:
                cleanLabel(templateLabels[`${cc.collection}:${r.item}`]) ??
                labelByChildId.get(String(r.item)) ??
                null,
              reactions: reactionsFor(String(r.id)) as Array<{ emoji: string; count: number; mine: boolean }>
            })
          }
        }
      } catch {
        // Same posture: a broken child table never takes the thread down.
      }

      const entries: Entry[] = [
        ...lineComments.map((r) => ({
          id: `linecomment:${r.id}`,
          source: 'note' as const,
          label: 'Line comment',
          text: String(r.text ?? ''),
          user: (r.user as string) ?? null,
          created_at: r.created_at as string,
          context: [titleCase(String(r.child)), r.child_label].filter(Boolean).join(' · ') || null,
          link: { collection: String(r.child), item_id: String(r.item) },
          comment_id: String(r.id),
          reactions: r.reactions as Array<{ emoji: string; count: number; mine: boolean }> | undefined
        })),
        ...transitions.map((h) => ({
          id: `transition:${h.id}`,
          source: 'transition' as const,
          label: 'State change',
          text: String(h.comment ?? ''),
          user: (h.user as string) ?? null,
          created_at: h.timestamp as string,
          context: [h.from_label, h.to_label].filter(Boolean).join(' → ') || null
        })),
        // A transition writes its own activity row ("A → B via Approve"); the
        // transition entry above already says that, better.
        ...ownReasons
          .filter((a) => !String(a.action ?? '').toLowerCase().includes('transition'))
          .map((a) => ({
          id: `reason:${a.id}`,
          source: 'change_reason' as const,
          label: 'Change reason',
          text: String(a.comment ?? ''),
          user: (a.user as string) ?? null,
          created_at: a.timestamp as string,
          context: ownChanged.get(String(a.id)) ?? null
        })),
        ...childReasons.map((a) => ({
          id: `reason:${a.child}:${a.id}`,
          source: 'change_reason' as const,
          label: 'Change reason',
          text: String(a.comment ?? ''),
          user: (a.user as string) ?? null,
          created_at: a.timestamp as string,
          context: [titleCase(String(a.child)), a.child_label, a.changed]
            .filter(Boolean)
            .join(' · ')
        })),
        ...addendums.map((ad) => ({
          id: `addendum:${ad.id}`,
          source: 'addendum' as const,
          label: 'Addendum',
          text: stripHtml(String(ad.description ?? '')),
          user: (ad.created_by as string) ?? null,
          created_at: ad.created_at as string,
          context:
            [
              String(ad.title ?? '').trim() === stripHtml(String(ad.description ?? '')).trim()
                ? null
                : ad.title,
              ad.status,
              amountChange(ad.previous_amount, ad.new_amount, ad.cost_impact)
            ]
              .filter(Boolean)
              .join(' · ') || null
        })),
        ...noteRows.map((n) => ({
          id: String(n.id),
          source: 'note' as const,
          label: 'Note',
          // These are stored as rich text; the thread renders plain text.
          text: stripHtml(String(n.text ?? '')),
          user: (n.user as string) ?? null,
          created_at: (n.created_at as string) ?? new Date(0).toISOString(),
          context: (n.context as string) ?? null
        }))
      ].filter((e) => isHumanNote(e.text))

      // Saving a child with a reason can also stamp the parent with the same
      // text (an edit that changed nothing on the parent row still records the
      // reason). That leaves the same sentence twice — once saying what it was
      // about and once saying nothing. Keep the one that carries context.
      const contextfulKeys = new Set(
        entries
          .filter((e) => !!e.context)
          .map((e) => `${e.user ?? ''}|${e.text.trim()}|${new Date(e.created_at).toISOString().slice(0, 16)}`)
      )
      const deduped = entries.filter(
        (e) =>
          !!e.context ||
          !contextfulKeys.has(
            `${e.user ?? ''}|${e.text.trim()}|${new Date(e.created_at).toISOString().slice(0, 16)}`
          )
      )

      // Entry reactions: every recorded note is reactable, not just real
      // comments — fetch this record's entry reactions and attach per entry.
      try {
        const entryReactions = (await db('nivaro_entry_reactions')
          .where({ collection, item: String(item) })
          .select('entry_key', 'user', 'emoji')) as Array<{
          entry_key: string
          user: string
          emoji: string
        }>
        if (entryReactions.length > 0) {
          const byKey = new Map<string, Array<{ emoji: string; count: number; mine: boolean }>>()
          for (const er of entryReactions) {
            const list = byKey.get(er.entry_key) ?? []
            let agg = list.find((a) => a.emoji === er.emoji)
            if (!agg) {
              agg = { emoji: er.emoji, count: 0, mine: false }
              list.push(agg)
            }
            agg.count++
            if (String(er.user).toUpperCase() === String(req.user!.id).toUpperCase()) agg.mine = true
            byKey.set(er.entry_key, list)
          }
          for (const e of deduped) {
            // Line comments already carry comment-FK reactions — don't clobber.
            if (!e.reactions || e.reactions.length === 0) {
              const list = byKey.get(e.id)
              if (list) e.reactions = list
            }
          }
        }
      } catch {
        /* reactions must never take the thread down */
      }

      const userIds = [...new Set(deduped.map((e) => e.user).filter((u): u is string => !!u))]
      const users = userIds.length
        ? ((await db('nivaro_users')
            .whereIn('id', userIds)
            .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>)
        : []
      const byUser = new Map(users.map((u) => [String(u.id).toUpperCase(), u]))

      deduped.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

      return reply.send({
        data: deduped.map((e) => {
          const u = e.user ? byUser.get(e.user.toUpperCase()) : null
          return {
            ...e,
            user_name: u
              ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email ?? '')
              : null
          }
        })
      })
    }
  )

  /** Per-row comment counts for a grid's badge column — one call per grid. */
  app.get<{ Querystring: { collection?: string; ids?: string } }>('/counts', async (req, reply) => {
    const { collection } = req.query
    const ids = String(req.query.ids ?? '').split(',').map((v) => v.trim()).filter(Boolean).slice(0, 500)
    if (!collection || ids.length === 0) {
      return reply.code(400).send({ error: 'collection and ids are required' })
    }
    if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const rows = (await db('nivaro_comments')
      .where({ collection })
      .whereIn('item', ids)
      .groupBy('item')
      .select('item')
      .count({ c: '*' })) as Array<{ item: string; c: number }>
    const data: Record<string, number> = {}
    for (const r of rows) data[String(r.item)] = Number(r.c)
    return { data }
  })

  /** Toggle a reaction (chat's fixed palette). Any reader of the collection. */
  app.post<{ Params: { id: string }; Body: { emoji?: string } }>(
    '/:id/reactions',
    async (req, reply) => {
      const REACTION_EMOJI = new Set(['👍', '✅', '👀', '🎉', '❤️', '😂'])
      const emoji = String(req.body?.emoji ?? '')
      if (!REACTION_EMOJI.has(emoji)) return reply.code(400).send({ error: 'Unknown reaction' })
      const comment = (await db('nivaro_comments').where('id', req.params.id).first(
        'id',
        'collection'
      )) as { id: string; collection: string } | undefined
      if (!comment) return reply.code(404).send({ error: 'Comment not found' })
      if (!req.isAdmin && !(await can(req.user!, 'read', comment.collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const existing = await db('nivaro_comment_reactions')
        .where({ comment: comment.id, user: req.user!.id, emoji })
        .first('id')
      if (existing) {
        await db('nivaro_comment_reactions').where('id', existing.id).del()
        return { data: { reacted: false } }
      }
      await db('nivaro_comment_reactions')
        .insert({ comment: comment.id, user: req.user!.id, emoji, created_at: new Date() })
        .catch(() => {}) // unique race — a double-click is one reaction
      return { data: { reacted: true } }
    }
  )

  /** Toggle a reaction on a RECORDED note (transition comment, change
   *  reason, legacy note) — keyed by the thread entry id. */
  app.post<{ Body: { collection?: string; item?: string; entry_key?: string; emoji?: string } }>(
    '/entry-reactions',
    async (req, reply) => {
      const REACTION_EMOJI = new Set(['👍', '✅', '👀', '🎉', '❤️', '😂'])
      const { collection, item, entry_key } = req.body ?? {}
      const emoji = String(req.body?.emoji ?? '')
      if (!collection || !item || !entry_key) {
        return reply.code(400).send({ error: 'collection, item and entry_key are required' })
      }
      if (!REACTION_EMOJI.has(emoji)) return reply.code(400).send({ error: 'Unknown reaction' })
      if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const existing = await db('nivaro_entry_reactions')
        .where({ entry_key: String(entry_key).slice(0, 200), user: req.user!.id, emoji })
        .first('id')
      if (existing) {
        await db('nivaro_entry_reactions').where('id', existing.id).del()
        return { data: { reacted: false } }
      }
      await db('nivaro_entry_reactions')
        .insert({
          collection,
          item: String(item),
          entry_key: String(entry_key).slice(0, 200),
          user: req.user!.id,
          emoji,
          created_at: new Date()
        })
        .catch(() => {})
      return { data: { reacted: true } }
    }
  )

  app.post<{ Body: { collection: string; item: string; text: string } }>(
    '/',
    async (req, reply) => {
      const body = req.body
      if (!body?.collection || !body?.item || !body?.text) {
        return reply.code(400).send({ error: 'collection, item and text are required' })
      }

      // Gate on create permission for the parent collection. History
      // annotations (#372) comment ON a revision row — gated by READ access
      // to the revision's own record collection instead (you can annotate
      // history you're allowed to see).
      if (body.collection === 'nivaro_revisions') {
        const rev = (await db('nivaro_revisions')
          .where({ id: Number(body.item) })
          .first('collection')) as { collection?: string } | undefined
        if (!rev) return reply.code(404).send({ error: 'Revision not found' })
        if (!req.isAdmin && !(await can(req.user!, 'read', rev.collection ?? '')))
          return reply.code(403).send({ error: 'Forbidden' })
      } else if (!req.isAdmin && !(await can(req.user!, 'create', body.collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const userId = req.user!.id
      const id = randomUUID()
      const now = new Date()

      await db('nivaro_comments').insert({
        id,
        collection: body.collection,
        item: body.item,
        user: userId,
        text: body.text,
        created_at: now,
        updated_at: now
      })
      // Auto-watch (#400): commenting subscribes the commenter when their
      // preference says so — fire-and-forget.
      void ensureAutoWatch(userId, body.collection, body.item, 'commented')
      // Live comments (#280): co-viewers' threads update the moment this
      // lands — record-room broadcast, clients invalidate the comments query.
      app.io
        ?.to(`record:${body.collection}:${body.item}`)
        .emit('record:comment', { collection: body.collection, item: body.item, user: userId })

      // Resolve and persist mentions. "@owners" expands to the record's
      // current pipeline owners (resolved server-side, so the set is always
      // the live one — never a stale name list); resolution failures degrade
      // to no extra recipients rather than blocking the comment.
      const mentioned = await resolveMentions(body.text)
      // @watchers (#374): one token notifying everyone watching the record —
      // field-watch subscribers + notification subscribers on this collection.
      if (/@\[?watchers\]?\b/i.test(body.text)) {
        try {
          const watcherRows = (await db('nivaro_field_watches as w')
            .join('nivaro_field_watch_subscribers as ws', 'ws.watch', 'w.id')
            .where('w.collection', body.collection)
            .where((q) => q.where('w.item_id', body.item).orWhereNull('w.item_id'))
            .distinct('ws.user')) as Array<{ user: string }>
          const subRows = (await db('nivaro_notification_subscriptions')
            .where({ collection: body.collection, is_active: true })
            .where((q) =>
              q
                .whereNull('filter_field')
                .orWhereNot('filter_field', 'id')
                .orWhere('filter_value', String(body.item))
            )
            .distinct('user')) as Array<{ user: string }>
          const seenW = new Set(mentioned.map((u) => u.id))
          for (const r of [...watcherRows, ...subRows]) {
            if (seenW.has(r.user)) continue
            seenW.add(r.user)
            mentioned.push({ id: r.user } as never)
          }
        } catch {
          /* watcher expansion is best-effort */
        }
      }
      if (OWNERS_MENTION_RE.test(body.text)) {
        try {
          const owners = await resolveOwnerMentions(body.collection, body.item)
          const seen = new Set(mentioned.map((u) => u.id))
          for (const o of owners) {
            if (seen.has(o.id)) continue
            seen.add(o.id)
            mentioned.push(o)
          }
        } catch {
          /* owners are extra recipients, never a reason the note fails */
        }
      }
      for (const u of mentioned) {
        await db('nivaro_comment_mentions').insert({ comment: id, user: u.id })

        // Don't notify yourself.
        if (u.id === userId) continue

        const message = body.text.slice(0, 100)
        const [notif] = await db('nivaro_notifications')
          .insert({
            recipient: u.id,
            subject: 'You were mentioned',
            status: 'inbox',
            timestamp: now,
            sender: userId,
            message,
            collection: body.collection,
            item: body.item
          })
          .returning('*')

        if (app.io) {
          emitNotification(app.io, u.id, {
            id: notif && typeof notif === 'object' ? (notif as { id: number }).id : null,
            subject: 'You were mentioned',
            message,
            collection: body.collection,
            item: body.item,
            sender: userId,
            timestamp: now
          })
        }

        sendTeamsNotification({ title: 'You were mentioned', text: message }).catch(() => {})
      }

      // Real-time broadcast to viewers of this record.
      if (app.io) {
        const room = `collection:${body.collection}:${body.item}`
        app.io.to(room).emit('comment:created', {
          id,
          collection: body.collection,
          item: body.item,
          user: userId,
          text: body.text,
          created_at: now
        })
      }

      const row = (await db('nivaro_comments').where({ id }).first()) as CommentRow
      await logActivity({
        action: 'create',
        collection: 'nivaro_comments',
        item: id,
        user: userId,
        req,
        comment: body.collection + ':' + body.item
      })
      return reply.code(201).send({
        data: {
          ...row,
          mentions: mentioned.map((u) => ({
            id: u.id,
            first_name: u.first_name,
            last_name: u.last_name,
            email: u.email
          }))
        }
      })
    }
  )

  // Edit own comment (or admin)
  app.patch<{ Params: { id: string }; Body: { text: string } }>('/:id', async (req, reply) => {
    const { id } = req.params
    const existing = (await db('nivaro_comments').where({ id }).first()) as CommentRow | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    if (existing.user !== req.user!.id && !req.isAdmin) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const text = req.body?.text
    if (!text) return reply.code(400).send({ error: 'text is required' })

    await db('nivaro_comments').where({ id }).update({ text, updated_at: new Date() })
    const row = (await db('nivaro_comments').where({ id }).first()) as CommentRow
    await logActivity({
      action: 'update',
      collection: 'nivaro_comments',
      item: id,
      user: req.user?.id,
      req
    })
    return { data: row }
  })

  // Delete own comment (or admin)
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const { id } = req.params
    const existing = (await db('nivaro_comments').where({ id }).first()) as CommentRow | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    if (existing.user !== req.user!.id && !req.isAdmin) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_comments').where({ id }).delete()
    await logActivity({
      action: 'delete',
      collection: 'nivaro_comments',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })
}
