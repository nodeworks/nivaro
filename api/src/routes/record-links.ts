import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { linkLabelsAsUser } from '../services/ai-link-labels.js'
import { compileAccessGates, visibleIds } from '../services/record-access.js'
import { recordVisibleTo } from '../services/revision-access.js'

/**
 * Related records — manual typed links between any two records, shown with
 * backlinks on both sides ("supersedes →" here, "← superseded by" there).
 *
 * Every end is judged as the caller, record by record (M1, security audit
 * 2026-10-27): reading a record's links needs that record visible (role
 * policy, row filter, User Scopes — 404 otherwise); a link whose OTHER end
 * the viewer cannot see is left out (its id is a fact about a hidden record);
 * labels are read as the viewer (linkLabelsAsUser), never raw. Creating a
 * link needs both records visible; removing one needs both ends visible too
 * — exactly the links the viewer was shown.
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export const LINK_TYPES = ['relates to', 'supersedes', 'duplicates', 'blocks', 'caused by']

/** The inverse phrasing shown on the target record. */
const INVERSE: Record<string, string> = {
  'relates to': 'related from',
  supersedes: 'superseded by',
  duplicates: 'duplicated by',
  blocks: 'blocked by',
  'caused by': 'caused'
}

const norm = (v: string) => v.toUpperCase()

/** An unrestricted administrator (no API-key scopes narrowing them) sees every record. */
function actingAdmin(req: FastifyRequest): boolean {
  const u = req.user
  const restricted =
    (u?.api_key_scope_restrictions?.length ?? 0) > 0 || (u?.api_key_scopes?.length ?? 0) > 0
  return !!req.isAdmin && !restricted
}

export async function recordLinkRoutes(app: FastifyInstance) {
  app.get<{ Params: { collection: string; id: string } }>(
    '/record-links/:collection/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!IDENT_RE.test(collection) || /^nivaro_/i.test(collection)) {
        return reply.code(400).send({ error: 'Not a valid collection' })
      }
      if (!(await recordVisibleTo(req, collection, id))) {
        return reply.code(404).send({ error: 'Not found' })
      }

      const [outgoing, incoming] = await Promise.all([
        db('nivaro_record_links').where({ from_collection: collection, from_item: String(id) }),
        db('nivaro_record_links').where({ to_collection: collection, to_item: String(id) })
      ])

      // Labels for every other-end record the viewer can read, one pass.
      const wanted = new Map<string, Set<string>>()
      const addWanted = (c: string, i: string) => {
        const set = wanted.get(c) ?? new Set<string>()
        set.add(i)
        wanted.set(c, set)
      }
      for (const l of outgoing) addWanted(String(l.to_collection), String(l.to_item))
      for (const l of incoming) addWanted(String(l.from_collection), String(l.from_item))
      // Only other ends the viewer can see, judged set-based per collection.
      const visible = new Map<string, Set<string>>()
      for (const [c, ids] of wanted) {
        if (/^nivaro_/i.test(c) || !IDENT_RE.test(c)) continue
        try {
          const gates = await compileAccessGates(req.user!, c, { actingAdmin: actingAdmin(req) })
          const seen = await visibleIds(gates, [...ids])
          if (seen.size > 0) visible.set(c, seen)
        } catch {
          /* an end whose collection cannot be judged stays hidden */
        }
      }
      // Ids compare case-insensitively (a uniqueidentifier reads back upper-case).
      const upper = new Map([...visible].map(([c, ids]) => [c, new Set([...ids].map(norm))]))
      const isVisible = (c: string, i: string) => upper.get(c)?.has(norm(i)) ?? false
      const labels: Record<string, string> = {}
      if (visible.size > 0) {
        for (const [k, v] of Object.entries(await linkLabelsAsUser(req.user!, visible))) {
          labels[norm(k)] = v
        }
      }

      const shape = (l: Record<string, unknown>, direction: 'out' | 'in') => {
        const oc = String(direction === 'out' ? l.to_collection : l.from_collection)
        const oi = String(direction === 'out' ? l.to_item : l.from_item)
        const type = (l.link_type as string | null) ?? 'relates to'
        return {
          id: Number(l.id),
          direction,
          type: direction === 'out' ? type : (INVERSE[type] ?? type),
          collection: oc,
          item: oi,
          label: labels[norm(`${oc}:${oi}`)] ?? null,
          note: (l.note as string | null) ?? null
        }
      }
      return reply.send({
        data: [
          ...outgoing
            .filter((l) => isVisible(String(l.to_collection), String(l.to_item)))
            .map((l) => shape(l, 'out')),
          ...incoming
            .filter((l) => isVisible(String(l.from_collection), String(l.from_item)))
            .map((l) => shape(l, 'in'))
        ]
      })
    }
  )

  app.post<{
    Body: {
      from_collection?: string
      from_item?: string
      to_collection?: string
      to_item?: string
      link_type?: string
      note?: string
    }
  }>('/record-links', { preHandler: requireAuth }, async (req, reply) => {
    const b = req.body ?? {}
    const fc = String(b.from_collection ?? '').trim()
    const fi = String(b.from_item ?? '').trim()
    const tc = String(b.to_collection ?? '').trim()
    const ti = String(b.to_item ?? '').trim()
    if (!fc || !fi || !tc || !ti) {
      return reply.code(400).send({ error: 'Both ends of the link are required' })
    }
    for (const c of [fc, tc]) {
      if (!IDENT_RE.test(c) || /^nivaro_/i.test(c)) {
        return reply.code(400).send({ error: 'Not a valid collection' })
      }
    }
    if (fc === tc && fi === ti) {
      return reply.code(400).send({ error: 'A record cannot link to itself' })
    }
    if (!(await recordVisibleTo(req, fc, fi)) || !(await recordVisibleTo(req, tc, ti))) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const linkType = LINK_TYPES.includes(String(b.link_type)) ? String(b.link_type) : 'relates to'

    const existing = await db('nivaro_record_links')
      .where({ from_collection: fc, from_item: fi, to_collection: tc, to_item: ti })
      .first('id')
    if (existing) return reply.code(409).send({ error: 'Those records are already linked' })

    await db('nivaro_record_links').insert({
      from_collection: fc,
      from_item: fi,
      to_collection: tc,
      to_item: ti,
      link_type: linkType,
      note:
        String(b.note ?? '')
          .trim()
          .slice(0, 255) || null,
      created_by: req.user?.id ?? null
    })
    void logActivity({
      action: 'record-link-create',
      user: req.user?.id ?? null,
      collection: fc,
      item: fi,
      comment: `${linkType} ${tc}/${ti}`
    })
    return reply.code(201).send({ data: { linked: true } })
  })

  app.delete<{ Params: { id: string } }>(
    '/record-links/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const row = await db('nivaro_record_links').where('id', Number(req.params.id)).first()
      if (!row) return reply.code(404).send({ error: 'Not found' })
      // Anyone who can see BOTH ends may unlink — a link is shared curation,
      // and seeing both records is what showed it to them at all.
      const seesBoth =
        (await recordVisibleTo(req, String(row.from_collection), String(row.from_item))) &&
        (await recordVisibleTo(req, String(row.to_collection), String(row.to_item)))
      if (!seesBoth) return reply.code(404).send({ error: 'Not found' })
      await db('nivaro_record_links').where('id', row.id).del()
      void logActivity({
        action: 'record-link-delete',
        user: req.user?.id ?? null,
        collection: String(row.from_collection),
        item: String(row.from_item),
        comment: `unlinked ${row.to_collection}/${row.to_item}`
      })
      return reply.send({ data: { deleted: true } })
    }
  )
}
