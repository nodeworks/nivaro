import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { getCollection, getFields } from '../services/collections.js'
import { selectInChunks } from '../services/db-batch.js'
import { readItems } from '../services/items.js'
import { getAllowedFields } from '../services/permissions.js'
import {
  type BadgeRule,
  type BadgeTableFacts,
  badgeNeeds,
  badgeWatch,
  defaultBadgeRules,
  effectiveBadgeRules,
  evaluateBadges,
  MAX_BADGE_IDS,
  type PickerBadge,
  parsePickerBadges,
  rulesForViewer
} from '../services/picker-badges.js'
import { isSystemCollection } from '../services/system-collections.js'
import { currentTenantKey } from '../services/tenant-rooms.js'

/**
 * Status badges in pickers (services/picker-badges.ts).
 *
 *   POST /api/picker-badges {collection, ids}
 *     → { data: {<id>: [{key, label, tone}]}, meta: {rules, watch} } — read AS THE CALLER:
 *       ids they cannot see answer nothing, rules on columns they cannot read are skipped.
 *       `meta.rules` 0 tells a client it need not ask again for this collection; `meta.watch`
 *       names the columns / aspects whose change can move a badge.
 *   GET /api/picker-badges/:collection/setup                                  (admin)
 *     → { setting, automatic, states, fields } for the Data Model card.
 *
 * Saving goes through the ordinary collection PATCH (browser_config.picker_badges).
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const FACTS_TTL_MS = 30_000
const factsCache = new Map<
  string,
  { at: number; facts: BadgeTableFacts; columns: Set<string>; template: string | null }
>()

async function tableFacts(collection: string) {
  const key = `${currentTenantKey()}\u0001${collection}`
  const hit = factsCache.get(key)
  if (hit && Date.now() - hit.at < FACTS_TTL_MS) return hit
  const [fields, binding] = await Promise.all([
    getFields(collection).catch(() => []),
    db('nivaro_workflow_bindings')
      .where({ collection })
      .first('template')
      .catch(() => undefined) as Promise<{ template?: string } | undefined>
  ])
  const plain = (fields as Array<{ field: string; type?: string | null }>).filter(
    (f) => f.type !== 'alias'
  )
  const entry = {
    at: Date.now(),
    facts: { pipeline: !!binding?.template, fields: plain } as BadgeTableFacts,
    columns: new Set(plain.map((f) => f.field)),
    template: binding?.template ?? null
  }
  if (factsCache.size > 500) factsCache.clear()
  factsCache.set(key, entry)
  return entry
}

/** For tests: forget cached table facts. */
export function resetPickerBadgeFacts() {
  factsCache.clear()
}

async function rulesFor(collection: string): Promise<{ rules: BadgeRule[]; columns: Set<string> }> {
  const col = (await getCollection(collection)) as { browser_config?: unknown } | undefined
  if (!col) return { rules: [], columns: new Set() }
  const facts = await tableFacts(collection)
  return {
    rules: effectiveBadgeRules(parsePickerBadges(col.browser_config), facts.facts),
    columns: facts.columns
  }
}

/** The badges for some records, as the caller. Exported for the route test. */
export async function badgesForCaller(
  req: FastifyRequest,
  collection: string,
  ids: string[]
): Promise<{ data: Record<string, PickerBadge[]>; meta: { rules: number; watch: string[] } }> {
  const none = { data: {}, meta: { rules: 0, watch: [] as string[] } }
  if (isSystemCollection(collection)) return none
  const { rules: all, columns } = await rulesFor(collection)
  if (all.length === 0) return none
  const allowed = await getAllowedFields(req.user!, 'read', collection)
  const rules = rulesForViewer(all, allowed, columns)
  if (rules.length === 0) return none
  const needs = badgeNeeds(rules)
  const meta = { rules: rules.length, watch: badgeWatch(needs) }
  if (ids.length === 0) return { data: {}, meta }
  const page = (await readItems(
    req.user!,
    collection,
    {
      fields: ['id', ...needs.fields, ...(needs.state ? ['$state'] : [])],
      filter: { id: { _in: ids } },
      limit: ids.length,
      count: false
    },
    req,
    req.workspaceId ?? undefined
  )) as { data?: Array<Record<string, unknown>> }
  const rows = page.data ?? []
  let hidden = new Set<string>()
  if (needs.hidden && rows.length > 0) {
    const seen = rows.map((r) => String(r.id))
    const ex = await selectInChunks(
      seen,
      1000,
      (chunk) =>
        db('nivaro_picker_exclusions')
          .where({ collection })
          .whereIn('item_id', chunk)
          .select('item_id') as Promise<Array<{ item_id: string }>>
    )
    hidden = new Set(ex.map((r) => String(r.item_id).toUpperCase()))
  }
  const data: Record<string, PickerBadge[]> = {}
  // Answer under the id spelling the caller asked with (GUIDs come back upper case).
  const asked = new Map(ids.map((i) => [i.toUpperCase(), i]))
  for (const row of rows) {
    const id = String(row.id)
    const badges = evaluateBadges(rules, row, hidden.has(id.toUpperCase()))
    if (badges.length) data[asked.get(id.toUpperCase()) ?? id] = badges
  }
  return { data, meta }
}

export async function pickerBadgeRoutes(app: FastifyInstance) {
  app.post('/', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { collection?: unknown; ids?: unknown }
    const collection = typeof body.collection === 'string' ? body.collection : ''
    if (!IDENT.test(collection) || !Array.isArray(body.ids))
      return reply.code(400).send({ error: 'collection and ids required' })
    const ids = [
      ...new Set(
        body.ids
          .filter((i) => typeof i === 'string' || typeof i === 'number')
          .map((i) => String(i))
          .filter((i) => i.length > 0 && i.length <= 64)
      )
    ]
    if (ids.length > MAX_BADGE_IDS)
      return reply.code(400).send({ error: `At most ${MAX_BADGE_IDS} ids per request` })
    try {
      return reply.send(await badgesForCaller(req, collection, ids))
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      // A collection the caller may not read simply has no badges for them.
      if (
        status === 403 ||
        status === 404 ||
        /^(ForbiddenError|CollectionNotFoundError)$/.test((err as Error).name)
      )
        return reply.send({ data: {}, meta: { rules: 0, watch: [] } })
      throw err
    }
  })

  app.get<{ Params: { collection: string } }>(
    '/:collection/setup',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { collection } = req.params
      if (!IDENT.test(collection)) return reply.code(400).send({ error: 'Bad collection' })
      const col = (await getCollection(collection)) as { browser_config?: unknown } | undefined
      if (!col) return reply.code(404).send({ error: 'Not found' })
      factsCache.delete(`${currentTenantKey()}\u0001${collection}`)
      const facts = await tableFacts(collection)
      const states = facts.template
        ? ((await db('nivaro_workflow_states')
            .where({ template: facts.template })
            .orderBy('sort')
            .select('key', 'label', 'is_terminal')) as Array<{
            key: string
            label: string
            is_terminal: boolean | number
          }>)
        : []
      return reply.send({
        data: {
          setting: parsePickerBadges(col.browser_config),
          automatic: defaultBadgeRules(facts.facts),
          states: states.map((s) => ({
            key: s.key,
            label: s.label,
            is_terminal: s.is_terminal === true || s.is_terminal === 1
          })),
          fields: facts.facts.fields.map((f) => ({ field: f.field, type: f.type ?? null }))
        }
      })
    }
  )
}
