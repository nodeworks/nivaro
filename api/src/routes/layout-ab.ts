import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { nameConfigCollection } from '../services/config-live.js'
import {
  type AbTest,
  abTestsForCollection,
  type CollectionAbTest,
  computeAbResults,
  forgetAbTests,
  parseAbTest
} from '../services/layout-ab.js'
import { peopleByIds } from '../services/layout-notify.js'
import { loadLayoutBundle, runLayoutOps } from '../services/layout-ops.js'
import { isRowId, parseConditions, roleAllows } from '../services/layout-patch.js'
import { planLayoutPromotion } from '../services/layout-promote.js'
import { promotionSkips } from '../services/layout-promote-skips.js'
import { cachedUsageRead, DAILY, usageTablesReady } from '../services/layout-usage.js'

/**
 * A/B layouts (#2614) — see services/layout-ab.ts. Admin-only, like the editor.
 *
 *   GET    /collection-layouts/:id/ab-test          the test this form is in (either side)
 *   GET    /collection-layouts/:id/ab-test/results  the halves' numbers (cached 10 min)
 *   POST   /collection-layouts/:id/ab-test          {variant_id, role_id} — start, on the control
 *   DELETE /collection-layouts/:id/ab-test?keep=    control (default) | variant — end
 *
 * Starting and ending write the variant's `conditions.ab` through the layout
 * ops path (atomic, versioned). Ending with keep=variant first makes the
 * control look like the variant (the promotion planner, its name, link name,
 * who-gets-it and New-menu settings kept), so the form people open keeps its
 * id, links and history.
 */

type LayoutRow = Record<string, unknown> & { id: number; collection: string; name: string }

const isRecordForm = (row: Record<string, unknown>) =>
  row.layout_type == null || row.layout_type === 'grouped'

/** Settings a "keep the new version" end never copies onto the control. */
const KEEP_ON_CONTROL = [
  'name',
  'slug',
  'conditions',
  'record_conditions',
  'create_label',
  'create_hidden',
  'is_active',
  'sort',
  'layout_type'
] as const

async function layoutRow(id: string | number): Promise<LayoutRow | null> {
  if (!isRowId(String(id))) return null
  const row = (await db('nivaro_collection_layouts')
    .where({ id: Number(id) })
    .first()) as LayoutRow | undefined
  return row ?? null
}

/** The live test `layout` takes part in, as control or as variant. */
async function testOf(layout: LayoutRow): Promise<CollectionAbTest | null> {
  const tests = await abTestsForCollection(String(layout.collection))
  return (
    tests.find((t) => t.variant_id === Number(layout.id) || t.control_id === Number(layout.id)) ??
    null
  )
}

/** The variant's conditions with `ab` set (or removed with null), everything else kept. */
function conditionsWithAb(conditions: unknown, ab: AbTest | null): Record<string, unknown> | null {
  const next: Record<string, unknown> = {
    ...((parseConditions(conditions) as Record<string, unknown> | null) ?? {})
  }
  if (ab) next.ab = ab
  else delete next.ab
  return Object.keys(next).length > 0 ? next : null
}

async function writeVariantAb(
  variantId: number,
  ab: AbTest | null,
  note: string,
  userId: string | null
) {
  const bundle = await loadLayoutBundle(db, variantId)
  if (!bundle) return { status: 404 as const }
  return runLayoutOps(
    variantId,
    {
      ops: [
        {
          op: 'layout_update',
          patch: { conditions: conditionsWithAb(bundle.layout.conditions, ab) as never }
        }
      ],
      base_rev: bundle.rev,
      note,
      reason: note
    },
    userId
  )
}

async function describe(test: CollectionAbTest) {
  const [rows, role] = await Promise.all([
    db('nivaro_collection_layouts')
      .whereIn('id', [test.control_id, test.variant_id])
      .select('id', 'name', 'slug') as Promise<Array<{ id: number; name: string; slug: string }>>,
    db('nivaro_roles').where({ id: test.role_id }).first('id', 'name') as Promise<
      { id: string; name: string } | undefined
    >
  ])
  const byId = new Map(rows.map((r) => [Number(r.id), r]))
  const starter = test.started_by
    ? ((await peopleByIds([test.started_by])).get(test.started_by.toUpperCase()) ?? null)
    : null
  const side = (id: number) => ({
    id,
    name: String(byId.get(id)?.name ?? id),
    slug: byId.get(id)?.slug ?? null
  })
  return {
    control: side(test.control_id),
    variant: side(test.variant_id),
    role: { id: test.role_id, name: role?.name ?? test.role_id },
    started_at: test.started_at || null,
    started_by: starter
  }
}

export async function layoutAbRoutes(app: FastifyInstance) {
  app.get('/:id/ab-test', { preHandler: requireAdmin }, async (req, reply) => {
    const layout = await layoutRow((req.params as { id: string }).id)
    if (!layout) return reply.code(404).send({ error: 'Layout not found' })
    const test = await testOf(layout)
    if (!test) return reply.send({ data: null })
    return reply.send({
      data: {
        ...(await describe(test)),
        side: test.variant_id === Number(layout.id) ? 'variant' : 'control'
      }
    })
  })

  app.get('/:id/ab-test/results', { preHandler: requireAdmin }, async (req, reply) => {
    const layout = await layoutRow((req.params as { id: string }).id)
    if (!layout) return reply.code(404).send({ error: 'Layout not found' })
    const test = await testOf(layout)
    if (!test) return reply.send({ data: null })
    const collection = String(layout.collection)
    const data = await cachedUsageRead(
      `layout-ab|${test.variant_id}|${test.salt}`,
      req.user?.id,
      async () =>
        computeAbResults({
          collection,
          test,
          variantId: test.variant_id,
          usageReady: await usageTablesReady(),
          dailyTable: DAILY
        })
    )
    return reply.send({ data })
  })

  app.post('/:id/ab-test', { preHandler: requireAdmin }, async (req, reply) => {
    const control = await layoutRow((req.params as { id: string }).id)
    if (!control) return reply.code(404).send({ error: 'Layout not found' })
    const body = (req.body ?? {}) as { variant_id?: unknown; role_id?: unknown }
    const variant = await layoutRow(String(body.variant_id ?? ''))
    const roleId = typeof body.role_id === 'string' ? body.role_id : ''
    if (!variant) return reply.code(400).send({ error: 'Pick the version to test' })
    if (!roleId || roleId.length > 64) return reply.code(400).send({ error: 'Pick a role' })
    const collection = String(control.collection)
    if (!isRecordForm(control) || !isRecordForm(variant))
      return reply.code(400).send({ error: 'Only record forms can be A/B tested' })
    if (String(variant.collection) !== collection || Number(variant.id) === Number(control.id))
      return reply
        .code(400)
        .send({ error: 'The test version must be another form of this collection' })
    if (variant.is_active)
      return reply.code(400).send({ error: 'The default form cannot be the test version' })
    if (parseAbTest(control.conditions))
      return reply.code(400).send({ error: 'This form is itself a test version' })
    const tests = await abTestsForCollection(collection)
    if (tests.some((t) => t.control_id === Number(control.id)))
      return reply.code(409).send({ error: 'This form already has an A/B test — end it first' })
    if (
      tests.some((t) => t.variant_id === Number(variant.id) || t.control_id === Number(variant.id))
    )
      return reply.code(409).send({ error: 'That version is already in another A/B test' })
    const role = (await db('nivaro_roles').where({ id: roleId }).first('id', 'admin_access')) as
      | { id: string; admin_access: unknown }
      | undefined
    if (!role) return reply.code(400).send({ error: 'Role not found' })
    if (role.admin_access)
      return reply
        .code(400)
        .send({ error: 'Administrators always get the original form; pick another role' })
    if (
      !roleAllows(control, String(role.id), false) ||
      !roleAllows(variant, String(role.id), false)
    )
      return reply.code(400).send({ error: 'Both forms must be open to that role' })

    const ab: AbTest = {
      control_id: Number(control.id),
      role_id: String(role.id),
      salt: randomBytes(6).toString('hex'),
      started_at: new Date().toISOString(),
      started_by: req.user?.id ? String(req.user.id) : null
    }
    const res = await writeVariantAb(
      Number(variant.id),
      ab,
      `A/B test started against “${control.name}”`,
      req.user?.id ?? null
    )
    if (res.status === 404) return reply.code(404).send({ error: 'Layout not found' })
    if (res.status === 409)
      return reply.code(409).send({ error: 'That version changed meanwhile — try again' })
    if (res.status === 400) return reply.code(400).send({ error: res.error, code: res.code })
    forgetAbTests(collection)
    nameConfigCollection(req, collection)
    await logActivity({
      action: 'layout-ab-start',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: String(control.id),
      comment: `A/B test: “${variant.name}” for half of role ${role.id}`,
      req
    })
    const live = (await abTestsForCollection(collection)).find(
      (t) => t.control_id === Number(control.id)
    )
    return reply.code(201).send({ data: live ? await describe(live) : null })
  })

  app.delete('/:id/ab-test', { preHandler: requireAdmin }, async (req, reply) => {
    const layout = await layoutRow((req.params as { id: string }).id)
    if (!layout) return reply.code(404).send({ error: 'Layout not found' })
    const keep = (req.query as { keep?: string }).keep === 'variant' ? 'variant' : 'control'
    const test = await testOf(layout)
    if (!test) return reply.code(404).send({ error: 'This form has no A/B test' })
    const collection = String(layout.collection)
    const userId = req.user?.id ?? null
    let applied = 0
    if (keep === 'variant') {
      const [mine, theirs] = await Promise.all([
        loadLayoutBundle(db, test.control_id),
        loadLayoutBundle(db, test.variant_id)
      ])
      if (!mine || !theirs) return reply.code(404).send({ error: 'Layout not found' })
      const skip = await promotionSkips(mine, theirs)
      for (const k of KEEP_ON_CONTROL) skip[k] = 'Kept on the original form'
      const plan = planLayoutPromotion(mine, theirs, skip)
      if (plan.ops.length) {
        const res = await runLayoutOps(
          test.control_id,
          {
            ops: plan.ops,
            base_rev: mine.rev,
            note: 'A/B test ended: the new version kept',
            reason: 'A/B test ended: the new version kept'
          },
          userId
        )
        if (res.status === 404) return reply.code(404).send({ error: 'Layout not found' })
        if (res.status === 409)
          return reply.code(409).send({ error: 'The original form changed meanwhile — try again' })
        if (res.status === 400) return reply.code(400).send({ error: res.error, code: res.code })
        applied = plan.ops.length
      }
    }
    const res = await writeVariantAb(test.variant_id, null, 'A/B test ended', userId)
    if (res.status === 404) return reply.code(404).send({ error: 'Layout not found' })
    if (res.status === 409)
      return reply.code(409).send({ error: 'The test version changed meanwhile — try again' })
    if (res.status === 400) return reply.code(400).send({ error: res.error, code: res.code })
    forgetAbTests(collection)
    nameConfigCollection(req, collection)
    await logActivity({
      action: 'layout-ab-end',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: String(test.control_id),
      comment:
        keep === 'variant'
          ? `A/B test ended: kept the new version (${applied} change(s) copied)`
          : 'A/B test ended: kept the original form',
      req
    })
    return reply.send({ data: { kept: keep, applied } })
  })
}
