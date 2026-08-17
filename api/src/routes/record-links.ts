import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'
import { getLabels } from '../services/queues.js'

/**
 * Related records — manual typed links between any two records, shown with
 * backlinks on both sides ("supersedes →" here, "← superseded by" there).
 *
 * Reading a record's links requires read on that record's collection; the
 * OTHER side's label only renders if the viewer can read that collection too
 * (unreadable ends degrade to "collection/id" with no label — existence of a
 * link is metadata the linking user chose to attach, same posture as
 * comments naming a record).
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

export async function recordLinkRoutes(app: FastifyInstance) {
  app.get<{ Params: { collection: string; id: string } }>(
    '/record-links/:collection/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!IDENT_RE.test(collection) || /^nivaro_/i.test(collection)) {
        return reply.code(400).send({ error: 'Not a valid collection' })
      }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
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
      for (const c of [...wanted.keys()]) {
        if (!(await can(req.user!, 'read', c))) wanted.delete(c)
      }
      const labels = wanted.size > 0 ? await getLabels(wanted).catch(() => ({})) : {}

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
          label: (labels as Record<string, string>)[`${oc}:${oi}`] ?? null,
          note: (l.note as string | null) ?? null
        }
      }
      return reply.send({
        data: [...outgoing.map((l) => shape(l, 'out')), ...incoming.map((l) => shape(l, 'in'))]
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
    if (!(await can(req.user!, 'read', fc)) || !(await can(req.user!, 'read', tc))) {
      return reply.code(403).send({ error: 'Forbidden' })
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
      note: String(b.note ?? '').trim().slice(0, 255) || null,
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
      // Anyone who can read the FROM side may unlink — a link is shared
      // curation, and read access is what let them see it at all.
      if (!(await can(req.user!, 'read', String(row.from_collection)))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
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
