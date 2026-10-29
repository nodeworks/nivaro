import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { markConfigRead, nameConfigCollection } from '../services/config-live.js'
import { BlockError, extractSection } from '../services/layout-blocks.js'
import { loadLayoutBundle } from '../services/layout-ops.js'
import {
  isLinkedRootKey,
  LINKS_TABLE,
  linkInSync,
  linksOfLayout,
  linksOfTemplate,
  linksReady,
  mappedFor,
  markLink,
  planLinkedReplace,
  pushTemplateToLinks,
  rebaseEdited,
  reconcileLinks,
  type SectionLinkRow,
  withRootKey
} from '../services/layout-section-links.js'
import {
  cleanMap,
  collectionFieldNames,
  fieldResolver,
  type LoadedTemplate,
  loadTemplate,
  postedBundle,
  TEMPLATES_TABLE
} from '../services/layout-templates.js'

/**
 * Linked sections (#3194), under /collection-layouts (admin only):
 *
 *   GET    /:id/section-links              the form's linked sections, each with in_sync
 *   POST   /:id/section-links              { template_id, group_key, field_map? } — link a
 *                                          section the editor just dropped (POST /blocks/plan
 *                                          with linked: true picked its root key)
 *   DELETE /:id/section-links/:key         Unlink: the section stays as an ordinary copy
 *   POST   /:id/section-links/:key/plan    { bundle? } read-only: the ops that bring the
 *                                          editor's copy back to the library version
 *   PUT    /templates/:tid/content         { layout_id, group_key, note? } publish the form's
 *                                          SAVED copy to the library, then to every linked form
 *
 * Every form change goes through runLayoutOps (services/layout-section-links.ts).
 */

const MISSING = { error: 'Linked sections need migration 508 — restart the API to run it' }

const idOf = (v: unknown) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

interface LinkOut {
  id: number
  template_id: number
  template_name: string
  source_collection: string | null
  group_key: string
  field_map: Record<string, string | null>
  /** The group is on the saved form (false: still only in an unsaved draft). */
  confirmed: boolean
  /** The saved copy matches the library; null when it is not saved yet. */
  in_sync: boolean | null
  /** Forms (this one included) that link the same library section. */
  linked_forms: number
  created_at: unknown
  synced_at: unknown
}

export async function layoutSectionLinkRoutes(app: FastifyInstance) {
  app.get('/:id/section-links', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf((req.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'id must be a number' })
    if (!(await linksReady())) return reply.send({ data: [] })
    const bundle = await loadLayoutBundle(db, id)
    if (!bundle) return reply.code(404).send({ error: 'Not found' })
    const rows = await reconcileLinks(await linksOfLayout(id), bundle)
    const collection = String(bundle.layout.collection)
    const templates = new Map<number, LoadedTemplate | null>()
    for (const r of rows)
      if (!templates.has(Number(r.template_id)))
        templates.set(Number(r.template_id), await loadTemplate(r.template_id))
    const fields = rows.length ? await collectionFieldNames(collection) : new Set<string>()
    const counts = new Map<number, number>()
    for (const tid of templates.keys())
      counts.set(tid, new Set((await linksOfTemplate(tid)).map((l) => Number(l.layout_id))).size)
    const data: LinkOut[] = []
    for (const r of rows) {
      const t = templates.get(Number(r.template_id))
      if (!t) {
        // The library section is gone: the copy is an ordinary section now.
        await db(LINKS_TABLE).where({ id: r.id }).delete()
        continue
      }
      const map = cleanMap(r.field_map)
      const confirmed = r.confirmed_at != null
      data.push({
        id: r.id,
        template_id: t.id,
        template_name: t.name,
        source_collection: t.source_collection,
        group_key: r.group_key,
        field_map: map,
        confirmed,
        in_sync: confirmed
          ? linkInSync(mappedFor(t, collection, map, fields).block, bundle, r.group_key)
          : null,
        linked_forms: counts.get(t.id) ?? 1,
        created_at: r.created_at,
        synced_at: r.synced_at
      })
    }
    return reply.send({ data })
  })

  app.post('/:id/section-links', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf((req.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'id must be a number' })
    if (!(await linksReady())) return reply.code(503).send(MISSING)
    const body = (req.body ?? {}) as {
      template_id?: unknown
      group_key?: unknown
      field_map?: unknown
    }
    if (!isLinkedRootKey(body.group_key))
      return reply
        .code(400)
        .send({ error: 'group_key must be the key a linked drop was planned with' })
    const template = await loadTemplate(body.template_id)
    if (template?.kind !== 'section')
      return reply.code(404).send({ error: 'No library section with that id' })
    if (!(await loadLayoutBundle(db, id))) return reply.code(404).send({ error: 'Not found' })
    const taken = (await db(LINKS_TABLE)
      .where({ layout_id: id, group_key: body.group_key })
      .first()) as SectionLinkRow | undefined
    if (taken) return reply.code(409).send({ error: 'That section is already linked' })
    // Linking changes no form by itself (the section rides the editor's next save).
    markConfigRead(req)
    await db(LINKS_TABLE).insert({
      template_id: template.id,
      layout_id: id,
      group_key: body.group_key,
      field_map: JSON.stringify(cleanMap(body.field_map)),
      created_by: req.user?.id ?? null,
      created_at: new Date()
    })
    const row = (await db(LINKS_TABLE)
      .where({ layout_id: id, group_key: body.group_key })
      .first()) as SectionLinkRow | undefined
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: String(id),
      comment: `layout editor: placed library section ${template.name} as linked`,
      req
    })
    return reply.code(201).send({ data: { id: row?.id ?? null, group_key: body.group_key } })
  })

  app.delete('/:id/section-links/:key', { preHandler: requireAdmin }, async (req, reply) => {
    const { id: raw, key } = req.params as { id: string; key: string }
    const id = idOf(raw)
    if (!id) return reply.code(400).send({ error: 'id must be a number' })
    if (!(await linksReady())) return reply.code(404).send({ error: 'Not linked' })
    const row = (await db(LINKS_TABLE).where({ layout_id: id, group_key: key }).first()) as
      | SectionLinkRow
      | undefined
    if (!row) return reply.code(404).send({ error: 'Not linked' })
    await db(LINKS_TABLE).where({ id: row.id }).delete()
    const t = await loadTemplate(row.template_id)
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: String(id),
      comment: `layout editor: unlinked section ${key}${t ? ` from library section ${t.name}` : ''}`,
      req
    })
    return reply.code(204).send()
  })

  // Read-only: the ops that bring the editor's copy (bundle) back to the library version.
  app.post('/:id/section-links/:key/plan', { preHandler: requireAdmin }, async (req, reply) => {
    markConfigRead(req)
    const { id: raw, key } = req.params as { id: string; key: string }
    const id = idOf(raw)
    if (!id) return reply.code(400).send({ error: 'id must be a number' })
    if (!(await linksReady())) return reply.code(404).send({ error: 'Not linked' })
    const row = (await db(LINKS_TABLE).where({ layout_id: id, group_key: key }).first()) as
      | SectionLinkRow
      | undefined
    if (!row) return reply.code(404).send({ error: 'Not linked' })
    const [stored, template] = await Promise.all([
      loadLayoutBundle(db, id),
      loadTemplate(row.template_id)
    ])
    if (!stored) return reply.code(404).send({ error: 'Not found' })
    if (!template) return reply.code(404).send({ error: 'The library section is gone' })
    const bundle = postedBundle((req.body as { bundle?: unknown } | null)?.bundle, stored)
    const collection = String(stored.layout.collection)
    const mapped = mappedFor(
      template,
      collection,
      cleanMap(row.field_map),
      await collectionFieldNames(collection)
    )
    try {
      const plan = planLinkedReplace(mapped.block, bundle, key)
      return reply.send({
        ops: plan.ops,
        already: plan.already,
        unmapped: mapped.unmapped,
        dropped: mapped.dropped,
        in_sync: linkInSync(mapped.block, bundle, key)
      })
    } catch (err) {
      if (err instanceof BlockError) return reply.code(400).send({ error: err.message })
      throw err
    }
  })

  // Publish: the form's SAVED copy becomes the library section, then every other linked form
  // is updated (each its own History entry). The editor saves its draft first.
  app.put('/templates/:tid/content', { preHandler: requireAdmin }, async (req, reply) => {
    const tid = idOf((req.params as { tid: string }).tid)
    if (!tid) return reply.code(400).send({ error: 'tid must be a number' })
    if (!(await linksReady())) return reply.code(503).send(MISSING)
    const body = (req.body ?? {}) as { layout_id?: unknown; group_key?: unknown }
    const layoutId = idOf(body.layout_id)
    if (!layoutId || typeof body.group_key !== 'string')
      return reply.code(400).send({ error: 'layout_id and group_key name the edited section' })
    const template = await loadTemplate(tid)
    if (template?.kind !== 'section')
      return reply.code(404).send({ error: 'No library section with that id' })
    const link = (await db(LINKS_TABLE)
      .where({ layout_id: layoutId, group_key: body.group_key, template_id: tid })
      .first()) as SectionLinkRow | undefined
    if (!link)
      return reply.code(400).send({ error: 'That section is not linked to this library section' })
    const bundle = await loadLayoutBundle(db, layoutId)
    if (!bundle) return reply.code(404).send({ error: 'Not found' })
    if (!bundle.groups.some((g) => g.key === body.group_key))
      return reply
        .code(409)
        .send({ error: 'Save the form first: the section is not on the saved form' })
    const collection = String(bundle.layout.collection)
    let edited: ReturnType<typeof extractSection>
    try {
      edited = extractSection(bundle, body.group_key)
    } catch (err) {
      if (err instanceof BlockError) return reply.code(400).send({ error: err.message })
      throw err
    }
    const cross = !!template.source_collection && template.source_collection !== collection
    // The library keeps its own root key (this form's lib… key is this placement's).
    const top = template.block.top[0]
    const next = withRootKey(
      rebaseEdited(
        edited,
        template.block,
        cross,
        fieldResolver(cleanMap(link.field_map), await collectionFieldNames(collection))
      ),
      top && 'group' in top ? top.group : body.group_key
    )
    await db(TEMPLATES_TABLE)
      .where({ id: tid })
      .update({ payload: JSON.stringify(next), updated_at: new Date() })
    await markLink(link.id, { confirmed: true, synced: true })
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: TEMPLATES_TABLE,
      item: String(tid),
      comment: `section library: ${template.name} published from ${String(bundle.layout.name ?? `layout ${layoutId}`)}`,
      req
    })
    const outcomes = await pushTemplateToLinks(
      { ...template, block: next },
      {
        exceptLayoutId: layoutId,
        userId: req.user?.id ?? null,
        from: String(bundle.layout.name ?? '') || null
      }
    )
    for (const o of outcomes.filter((x) => x.result === 'updated'))
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_collection_layouts',
        item: String(o.layout_id),
        comment: `layout editor: linked section ${template.name} updated from the library`,
        req
      })
    // One collection touched: name it, so its open forms get the change notice.
    const touched = new Set(outcomes.filter((o) => o.result === 'updated').map((o) => o.collection))
    if (touched.size <= 1) nameConfigCollection(req, [...touched][0] ?? collection)
    return reply.send({
      data: {
        template_id: tid,
        updated: outcomes.filter((o) => o.result === 'updated'),
        unchanged: outcomes.filter((o) => o.result === 'unchanged').length,
        skipped: outcomes.filter((o) => o.result === 'skipped')
      }
    })
  })
}
