import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { getCollection, getFields } from '../services/collections.js'
import { collectionTitle } from '../services/record-label-fallback.js'
import { decideAssignment, loadRuleSet, saveRuleSet } from '../services/support-assign.js'
import {
  type AssignRuleSet,
  type RuleError,
  SOURCES,
  validateRuleSet
} from '../services/support-assign-rules.js'
import { userName } from '../services/support-tickets.js'
import { isSystemCollection } from '../services/system-collections.js'
import { resolveFriendlyIds } from '../services/workflow-transitions.js'

/**
 * /api/support/assign-rules — administrators set who new support requests go to
 * (services/support-assign*.ts). GET/PUT the ordered rule set, GET the editor's
 * choices, POST /test to see which rule a draft request meets and who would get it.
 */

const fieldLabel = (f: string) =>
  f
    .replace(/_id$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim()

/** Everything a rule names must exist: people, types, teams, roles, collections, fields, steps. */
export async function checkReferences(set: AssignRuleSet): Promise<RuleError[]> {
  const errors: RuleError[] = []
  const people = new Set<string>()
  const types = new Set<number>()
  const teams = new Set<number>()
  const roles = new Set<string>()
  const collections = new Set<string>()
  const states = new Set<string>()
  const fields: Array<{ rule: number; collection: string; field: string }> = []
  set.rules.forEach((r, i) => {
    for (const c of r.conditions) {
      if (c.kind === 'type') for (const v of c.values) types.add(v)
      if (c.kind === 'about') for (const v of c.collections) collections.add(v)
      if (c.kind === 'field') {
        collections.add(c.collection)
        fields.push({ rule: i, collection: c.collection, field: c.field })
      }
      if (c.kind === 'step') for (const v of c.states) states.add(v)
      if (c.kind === 'requester') for (const v of c.users) people.add(v)
      if (c.kind === 'requester_role') for (const v of c.roles) roles.add(v)
      if (c.kind === 'requester_team') for (const v of c.teams) teams.add(v)
    }
    if (r.action.kind === 'person') people.add(r.action.user)
    if (r.action.kind === 'share') for (const p of r.action.people) people.add(p.id)
    if (r.action.kind === 'team') teams.add(r.action.team)
    if (r.fallback.kind === 'person') people.add(r.fallback.user)
  })
  const found = async <T>(q: Promise<unknown[]>, key: string, norm: (v: unknown) => T) =>
    new Set(((await q.catch(() => [])) as Array<Record<string, unknown>>).map((r) => norm(r[key])))
  const up = (v: unknown) => String(v).toUpperCase()
  const [pSet, tSet, gSet, rSet, sSet] = await Promise.all([
    people.size
      ? found(
          db('nivaro_users')
            .whereIn('id', [...people])
            .select('id'),
          'id',
          up
        )
      : new Set<string>(),
    types.size
      ? found(
          db('nivaro_task_categories')
            .whereIn('id', [...types])
            .select('id'),
          'id',
          Number
        )
      : new Set<number>(),
    teams.size
      ? found(
          db('nivaro_user_groups')
            .whereIn('id', [...teams])
            .select('id'),
          'id',
          Number
        )
      : new Set<number>(),
    roles.size
      ? found(
          db('nivaro_roles')
            .whereIn('id', [...roles])
            .select('id'),
          'id',
          up
        )
      : new Set<string>(),
    states.size
      ? found(
          db('nivaro_workflow_states')
            .whereIn('id', [...states])
            .select('id'),
          'id',
          up
        )
      : new Set<string>()
  ])
  const missingCols = new Set<string>()
  for (const c of collections)
    if (isSystemCollection(c) || !(await getCollection(c).catch(() => null))) missingCols.add(c)
  const where = (pred: (i: number) => boolean, message: string) => {
    set.rules.forEach((_, i) => {
      if (pred(i)) errors.push({ rule: i, message })
    })
  }
  const ruleNames = (i: number) => set.rules[i]
  where((i) => {
    const r = ruleNames(i)
    const ids = [
      ...r.conditions.flatMap((c) => (c.kind === 'requester' ? c.users : [])),
      ...(r.action.kind === 'person' ? [r.action.user] : []),
      ...(r.action.kind === 'share' ? r.action.people.map((p) => p.id) : []),
      ...(r.fallback.kind === 'person' ? [r.fallback.user] : [])
    ]
    return ids.some((id) => !pSet.has(id.toUpperCase()))
  }, 'A person on this rule no longer exists')
  where(
    (i) =>
      ruleNames(i).conditions.some((c) => c.kind === 'type' && c.values.some((v) => !tSet.has(v))),
    'A request type on this rule no longer exists'
  )
  where((i) => {
    const r = ruleNames(i)
    return (
      r.conditions.some((c) => c.kind === 'requester_team' && c.teams.some((t) => !gSet.has(t))) ||
      (r.action.kind === 'team' && !gSet.has(r.action.team))
    )
  }, 'A team on this rule no longer exists')
  where(
    (i) =>
      ruleNames(i).conditions.some(
        (c) => c.kind === 'requester_role' && c.roles.some((v) => !rSet.has(v.toUpperCase()))
      ),
    'A role on this rule no longer exists'
  )
  where(
    (i) =>
      ruleNames(i).conditions.some(
        (c) => c.kind === 'step' && c.states.some((v) => !sSet.has(v.toUpperCase()))
      ),
    'A pipeline step on this rule no longer exists'
  )
  where(
    (i) =>
      ruleNames(i).conditions.some(
        (c) =>
          (c.kind === 'about' && c.collections.some((v) => missingCols.has(v))) ||
          (c.kind === 'field' && missingCols.has(c.collection))
      ),
    'A kind of record on this rule is not a collection'
  )
  const byCol = new Map<string, Set<string>>()
  for (const f of fields) {
    if (missingCols.has(f.collection)) continue
    if (!byCol.has(f.collection))
      byCol.set(
        f.collection,
        new Set((await getFields(f.collection).catch(() => [])).map((x) => x.field))
      )
    if (!byCol.get(f.collection)!.has(f.field))
      errors.push({ rule: f.rule, message: `${fieldLabel(f.field)} is not a field of that record` })
  }
  return errors
}

/** Names the editor shows for a rule set: people, and field values (a linked record's readable
 *  id or label, a choice's label). Admin-only. */
export async function ruleLabels(set: { rules: AssignRuleSet['rules'] }): Promise<{
  people: Record<string, string>
  values: Record<string, string>
}> {
  const people = new Set<string>()
  const fieldVals = new Map<string, { collection: string; field: string; values: Set<string> }>()
  for (const r of set.rules) {
    for (const c of r.conditions) {
      if (c.kind === 'requester') for (const u of c.users) people.add(u.toUpperCase())
      if (c.kind === 'field' && c.values.length) {
        const k = `${c.collection}.${c.field}`
        const e = fieldVals.get(k) ?? {
          collection: c.collection,
          field: c.field,
          values: new Set()
        }
        for (const v of c.values) e.values.add(v)
        fieldVals.set(k, e)
      }
    }
    if (r.action.kind === 'person') people.add(r.action.user.toUpperCase())
    if (r.action.kind === 'share') for (const p of r.action.people) people.add(p.id.toUpperCase())
    if (r.fallback.kind === 'person') people.add(r.fallback.user.toUpperCase())
  }
  const out = { people: {} as Record<string, string>, values: {} as Record<string, string> }
  if (people.size) {
    const rows = (await db('nivaro_users')
      .whereIn('id', [...people].slice(0, 500))
      .select('id', 'first_name', 'last_name', 'email')
      .catch(() => [])) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      email: string | null
    }>
    for (const u of rows) out.people[String(u.id).toUpperCase()] = userName(u) ?? 'Unknown person'
  }
  for (const e of fieldVals.values()) {
    if (isSystemCollection(e.collection)) continue
    const [defs, rel] = await Promise.all([
      getFields(e.collection).catch(() => []),
      db('nivaro_relations')
        .where({ many_collection: e.collection, many_field: e.field })
        .whereNull('junction_field')
        .first('one_collection')
        .catch(() => undefined) as Promise<{ one_collection: string | null } | undefined>
    ])
    const def = defs.find((d) => d.field === e.field)
    const choices = (def?.options as { choices?: Array<{ value: unknown; text?: string }> } | null)
      ?.choices
    const ids = [...e.values].slice(0, 200)
    if (Array.isArray(choices))
      for (const v of ids) {
        const ch = choices.find((c) => String(c.value) === v)
        if (ch) out.values[`${e.collection}.${e.field}:${v}`] = String(ch.text ?? ch.value)
      }
    if (rel?.one_collection && !isSystemCollection(rel.one_collection)) {
      const names = await resolveFriendlyIds(rel.one_collection, ids).catch(() => null)
      for (const v of ids) {
        const n = names?.get(v)
        if (n) out.values[`${e.collection}.${e.field}:${v}`] = n
      }
    }
  }
  return out
}

export async function supportAssignRuleRoutes(app: FastifyInstance) {
  // GET /assign-rules — the ordered rules and business hours.
  app.get('/assign-rules', { preHandler: requireAdmin }, async (_req, reply) => {
    const set = await loadRuleSet()
    return reply.send({ data: set, labels: await ruleLabels(set) })
  })

  // POST /assign-rules/labels {rules} — the names for an unsaved draft (nothing is written).
  app.post<{ Body: { rules?: unknown } }>(
    '/assign-rules/labels',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const v = validateRuleSet({ rules: req.body?.rules ?? [] })
      // A half-filled draft still gets names for what it has: read what validates loosely.
      const rules = v.ok ? v.set.rules : []
      return reply.send({ data: await ruleLabels({ rules }) })
    }
  )

  // PUT /assign-rules {rules, hours} — replace the whole set (order = precedence).
  app.put<{ Body: unknown }>('/assign-rules', { preHandler: requireAdmin }, async (req, reply) => {
    const v = validateRuleSet(req.body)
    if (!v.ok) return reply.code(400).send({ error: v.errors[0].message, errors: v.errors })
    const refs = await checkReferences(v.set)
    if (refs.length) return reply.code(400).send({ error: refs[0].message, errors: refs })
    const before = await loadRuleSet()
    await saveRuleSet(v.set)
    await logActivity({
      action: 'update',
      user: req.user!.id,
      collection: 'nivaro_extension_settings',
      item: 'support_assign_rules',
      comment: `Support assignment rules saved (${v.set.rules.length} rule${
        v.set.rules.length === 1 ? '' : 's'
      }, was ${before.rules.length})`,
      req
    }).catch(() => undefined)
    return reply.send({ data: v.set })
  })

  // GET /assign-rules/options — the editor's choices.
  app.get('/assign-rules/options', { preHandler: requireAdmin }, async (_req, reply) => {
    const [types, teams, roles, cols, junctions, states] = await Promise.all([
      db('nivaro_task_categories')
        .where('is_active', true)
        .orderBy('sort')
        .orderBy('name')
        .select('id', 'name', 'collection')
        .catch(() => []) as Promise<Array<{ id: number; name: string; collection: string | null }>>,
      db('nivaro_user_groups')
        .orderBy('name')
        .select('id', 'name')
        .catch(() => []) as Promise<Array<{ id: number; name: string }>>,
      db('nivaro_roles')
        .orderBy('name')
        .select('id', 'name')
        .catch(() => []) as Promise<Array<{ id: string; name: string }>>,
      db('nivaro_collections')
        .select('collection', 'display_name', 'hidden')
        .catch(() => []) as Promise<
        Array<{ collection: string; display_name: string | null; hidden: boolean | number }>
      >,
      db('nivaro_relations')
        .whereNotNull('junction_field')
        .select('many_collection')
        .catch(() => []) as Promise<Array<{ many_collection: string }>>,
      db('nivaro_workflow_states as s')
        .join('nivaro_workflow_bindings as b', 'b.template', 's.template')
        .select('b.collection', 's.id', 's.label', 's.key')
        .catch(() => []) as Promise<
        Array<{ collection: string; id: string; label: string | null; key: string }>
      >
    ])
    const junction = new Set(junctions.map((j) => j.many_collection))
    const collections = cols
      .filter((c) => !isSystemCollection(c.collection) && !junction.has(c.collection))
      .map((c) => ({
        collection: c.collection,
        name: collectionTitle(c.collection, c.display_name),
        hidden: !!c.hidden
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const stepsBy: Record<string, Array<{ id: string; label: string }>> = {}
    for (const s of states) {
      const list = stepsBy[s.collection] ?? []
      if (!list.some((x) => x.id === s.id)) list.push({ id: s.id, label: s.label || s.key })
      stepsBy[s.collection] = list
    }
    return reply.send({
      data: {
        types,
        teams,
        roles,
        collections,
        steps: stepsBy,
        sources: SOURCES
      }
    })
  })

  // GET /assign-rules/fields?collection= — the fields a condition can test, with the related
  //   collection for a link (so its own picker offers the values).
  app.get<{ Querystring: { collection?: string } }>(
    '/assign-rules/fields',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const collection = String(req.query.collection ?? '')
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(collection) || isSystemCollection(collection))
        return reply.code(400).send({ error: 'Pick a kind of record' })
      const [defs, rels] = await Promise.all([
        getFields(collection).catch(() => []),
        db('nivaro_relations')
          .where('many_collection', collection)
          .whereNull('junction_field')
          .select('many_field', 'one_collection')
          .catch(() => []) as Promise<Array<{ many_field: string; one_collection: string | null }>>
      ])
      const relOf = new Map(rels.map((r) => [r.many_field, r.one_collection]))
      const ALIAS = new Set(['alias', 'o2m', 'm2m', 'm2a', 'presentation'])
      const fields = defs
        .filter((f) => !ALIAS.has(String(f.type)) && !(f.special ?? []).some((s) => ALIAS.has(s)))
        .filter((f) => f.computed_type !== 'read')
        .map((f) => {
          const choices = (
            f.options as { choices?: Array<{ value: unknown; text?: string }> } | null
          )?.choices
          return {
            field: f.field,
            label: fieldLabel(f.field),
            type: String(f.type),
            related: relOf.get(f.field) ?? null,
            choices: Array.isArray(choices)
              ? choices
                  .slice(0, 200)
                  .map((c) => ({ value: String(c.value), label: String(c.text ?? c.value) }))
              : null
          }
        })
        .sort((a, b) => a.label.localeCompare(b.label))
      return reply.send({ data: fields })
    }
  )

  // POST /assign-rules/test {request, rules?, hours?} — which rule a draft request meets and who
  //   it would go to (nothing is written). With `rules` it tests the editor's unsaved draft.
  app.post<{ Body: Record<string, unknown> }>(
    '/assign-rules/test',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = req.body ?? {}
      let set = await loadRuleSet()
      if (b.rules !== undefined) {
        const v = validateRuleSet({ rules: b.rules, hours: b.hours ?? set.hours })
        if (!v.ok) return reply.code(400).send({ error: v.errors[0].message, errors: v.errors })
        set = v.set
      }
      const r = (b.request ?? {}) as Record<string, unknown>
      const collection = r.collection ? String(r.collection) : null
      if (
        collection &&
        (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(collection) || isSystemCollection(collection))
      )
        return reply.code(400).send({ error: 'Pick a kind of record' })
      const item =
        collection && r.item != null && r.item !== '' ? String(r.item).slice(0, 128) : null
      const categoryId =
        r.category_id != null && r.category_id !== '' ? Number(r.category_id) : null
      const category =
        categoryId != null && Number.isSafeInteger(categoryId)
          ? ((await db('nivaro_task_categories')
              .where('id', categoryId)
              .first('id', 'default_assignee')
              .catch(() => undefined)) as
              | { id: number; default_assignee: string | null }
              | undefined)
          : undefined
      const source = (SOURCES as readonly string[]).includes(String(r.source))
        ? (String(r.source) as (typeof SOURCES)[number])
        : null
      const at = r.at ? new Date(String(r.at)) : new Date()
      const fieldNames = new Map<string, string>()
      const decision = await decideAssignment(
        set,
        {
          category_id: category?.id ?? null,
          collection,
          item,
          requester: r.requester ? String(r.requester).toUpperCase() : null,
          priority: ['low', 'normal', 'urgent'].includes(String(r.priority))
            ? String(r.priority)
            : 'normal',
          title: String(r.title ?? '').slice(0, 500),
          description: r.description ? String(r.description).slice(0, 4000) : null,
          source,
          at: Number.isNaN(at.getTime()) ? new Date() : at
        },
        {
          trigger: r.trigger === 'type_change' ? 'type_change' : 'create',
          hasAssignee: !!r.has_assignee,
          typeDefault: category?.default_assignee ?? null,
          redis: app.redis,
          fieldLabel: (_c, f) => fieldNames.get(f) ?? fieldLabel(f)
        }
      )
      const requesterName = r.requester
        ? userName(
            (await db('nivaro_users')
              .where('id', String(r.requester))
              .first('first_name', 'last_name', 'email')
              .catch(() => undefined)) as never
          )
        : null
      return reply.send({ data: { ...decision, requester_name: requesterName } })
    }
  )
}
