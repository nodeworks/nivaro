import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'

/**
 * Record graph — instance-level relation neighborhood for one record:
 * M2O parents, O2M children, and M2M partners (via junction pairs), each
 * with resolved labels. The explorer recenters on click, so one hop per
 * request is all it ever needs.
 */

interface GraphNode {
  collection: string
  id: string
  label: string
}

interface GraphEdge {
  kind: 'm2o' | 'o2m' | 'm2m'
  via: string // field / junction name
  node: GraphNode
}

const CHILD_CAP = 12

function rowLabel(row: Record<string, unknown> | undefined, fallback: string): string {
  if (!row) return fallback
  return String(row.title ?? row.name ?? row.label ?? row.subject ?? fallback).slice(0, 60)
}

async function readableSet(userRole: string | null, isAdmin: boolean): Promise<Set<string> | null> {
  if (isAdmin) return null // null = everything
  if (!userRole) return new Set()
  const policies = (await db('nivaro_policies')
    .where({ role: userRole, action: 'read' })
    .select('collection')) as Array<{ collection: string }>
  return new Set(policies.map((p) => p.collection))
}

export async function recordGraphRoutes(app: FastifyInstance) {
  app.get('/:collection/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, id } = req.params as { collection: string; id: string }
    if (!/^[a-zA-Z0-9_]+$/.test(collection) || collection.startsWith('nivaro_')) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const readable = await readableSet(req.user?.role ?? null, req.isAdmin ?? false)
    const canRead = (c: string) => (readable === null ? true : readable.has(c) || readable.has('*'))

    let record: Record<string, unknown> | undefined
    try {
      record = (await db(collection).where({ id }).first()) as Record<string, unknown> | undefined
    } catch {
      record = undefined
    }
    if (!record) return reply.code(404).send({ error: 'Record not found' })

    const relations = (await db('nivaro_relations')
      .where('many_collection', collection)
      .orWhere('one_collection', collection)) as Array<Record<string, unknown>>

    const edges: GraphEdge[] = []
    let truncated = false

    // M2O parents: this record's FK columns → parent rows
    const m2oRels = relations.filter(
      (r) => r.many_collection === collection && r.one_collection && r.junction_field == null
    )
    for (const r of m2oRels) {
      const target = String(r.one_collection)
      const fk = String(r.many_field ?? '')
      const fkVal = record[fk]
      if (!fk || fkVal == null || !canRead(target) || target.startsWith('nivaro_')) continue
      try {
        const parent = (await db(target).where({ id: fkVal }).first()) as
          | Record<string, unknown>
          | undefined
        if (parent) {
          edges.push({
            kind: 'm2o',
            via: fk,
            node: { collection: target, id: String(fkVal), label: rowLabel(parent, String(fkVal)) }
          })
        }
      } catch {
        /* physical mismatch — skip */
      }
    }

    // O2M children: relations where we are the "one" side, no junction
    const o2mRels = relations.filter(
      (r) => r.one_collection === collection && r.junction_field == null
    )
    for (const r of o2mRels) {
      const child = String(r.many_collection)
      const fk = String(r.many_field ?? '')
      if (!fk || !canRead(child) || child.startsWith('nivaro_')) continue
      try {
        const rows = (await db(child)
          .where({ [fk]: id })
          .limit(CHILD_CAP + 1)) as Array<Record<string, unknown>>
        if (rows.length > CHILD_CAP) truncated = true
        for (const row of rows.slice(0, CHILD_CAP)) {
          edges.push({
            kind: 'o2m',
            via: fk,
            node: { collection: child, id: String(row.id), label: rowLabel(row, String(row.id)) }
          })
        }
      } catch {
        /* skip */
      }
    }

    // M2M partners: junction pairs
    const m2mRels = relations.filter(
      (r) => r.one_collection === collection && r.junction_field != null
    )
    // Companion rows (junction → other side) have neither endpoint equal to
    // this collection, so they need their own fetch.
    const junctionNames = m2mRels.map((r) => String(r.many_collection))
    const companions = junctionNames.length
      ? ((await db('nivaro_relations').whereIn(
          'many_collection',
          junctionNames
        )) as Array<Record<string, unknown>>)
      : []
    for (const r of m2mRels) {
      const junction = String(r.many_collection)
      const myFk = String(r.junction_field ?? '') // column pointing at ME? convention check:
      // In this registry, many_field points at the parent (this collection) and
      // junction_field at the related record — same reading the queue resolvers use.
      const parentCol = String(r.many_field ?? '')
      const relatedCol = String(r.junction_field ?? '')
      // Companion relation names the other side's collection
      const companion = companions.find(
        (c) =>
          c.many_collection === junction &&
          String(c.many_field) !== parentCol &&
          c.one_collection
      )
      const target = companion ? String(companion.one_collection) : null
      if (!target || !canRead(target) || target.startsWith('nivaro_')) {
        if (target !== 'nivaro_files') continue
      }
      const targetCollection = target as string
      try {
        const links = (await db(junction)
          .where({ [parentCol]: id })
          .limit(CHILD_CAP + 1)
          .select(relatedCol)) as Array<Record<string, unknown>>
        if (links.length > CHILD_CAP) truncated = true
        const ids = links.slice(0, CHILD_CAP).map((l) => l[relatedCol]).filter((v) => v != null)
        if (ids.length === 0) continue
        const rows = (await db(targetCollection).whereIn('id', ids as Array<string | number>)) as Array<
          Record<string, unknown>
        >
        const byId = new Map(rows.map((row) => [String(row.id), row]))
        for (const rid of ids) {
          edges.push({
            kind: 'm2m',
            via: junction,
            node: {
              collection: targetCollection,
              id: String(rid),
              label: rowLabel(byId.get(String(rid)), String(rid))
            }
          })
        }
      } catch {
        /* skip */
      }
      void myFk
    }

    return reply.send({
      data: {
        node: { collection, id, label: rowLabel(record, id) },
        edges,
        truncated
      }
    })
  })
}
