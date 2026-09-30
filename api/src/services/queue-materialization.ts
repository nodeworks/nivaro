import { db } from '../db/index.js'
import {
  type AtRiskRuleRow,
  evaluateRows,
  parseActiveRules,
  referencedFields
} from '../routes/at-risk.js'
import { computeStatusBatch } from '../routes/sla.js'
import type { CMSRelation } from '../types.js'
import { type ActiveAddendumInstance, activeAddendumInstances } from './addendum-summary.js'
import { getCollection } from './collections.js'
import { parseJson, type ResolvedOwner, resolveStateOwnersBatch } from './pipeline-engine.js'
import { ADDENDUM_COLLECTION } from './pipeline-subject.js'
import { encodeCachedExtra } from './queue-materialization-extra.js'
import {
  applyQueueConditions,
  type ConditionBuilder,
  filterBySlaStatus,
  getLabels,
  ownerSortKey,
  type QueueAggregateFn,
  type QueueCondition,
  type QueueSourceRow,
  renderTemplateLabels,
  resolveExtraPathValues,
  stateFilterKeep
} from './queues.js'
import { resolveRecordZones } from './sla-zones.js'

/**
 * The in-flight addendum whose state a record SHOWS (#715) — null when the
 * collection has not opted into addendums or none is in flight. The live
 * resolver makes the same substitution, so a cached row agrees with a live
 * one: state, state colour and owners come from the addendum's instance,
 * while the SLA clock stays on the record's own instance.
 */
async function effectiveAddendum(
  collection: string,
  itemId: string
): Promise<ActiveAddendumInstance | null> {
  const enabled = await getCollection(collection)
    .then((c) => !!c?.addendums_enabled)
    .catch(() => false)
  if (!enabled) return null
  const map = await activeAddendumInstances(collection, [itemId]).catch(() => new Map())
  return map.get(String(itemId)) ?? null
}

export async function queueItemMatchesSource(
  collection: string,
  itemId: string,
  source: QueueSourceRow
): Promise<boolean> {
  const conditions = (parseJson(source.filters) as QueueCondition[] | null) ?? []
  const q = db(collection).where('id', itemId).select('id')
  applyQueueConditions(q as unknown as ConditionBuilder, conditions)
  const baseRow = await q.first()
  if (!baseRow) return false

  const stateValues = parseJson(source.state_values) as string[] | null
  if (stateValues?.length) {
    const instance = (await db('nivaro_workflow_instances as wi')
      .leftJoin('nivaro_workflow_states as s', 'wi.current_state', 's.id')
      .where('wi.collection', collection)
      .where('wi.item', itemId)
      .select('s.key as state_key')
      .first()) as { state_key: string | null } | undefined
    const mode = source.state_mode === 'exclude' ? 'exclude' : 'include'
    const addendum = await effectiveAddendum(collection, itemId)
    const stateKey = addendum ? addendum.state_key : (instance?.state_key ?? null)
    if (!stateFilterKeep(stateKey, stateValues, mode)) return false
  }

  if (source.sla_filter) {
    const slaMap = await computeStatusBatch(collection, [itemId])
    const kept = filterBySlaStatus([itemId], slaMap, source.sla_filter)
    if (kept.length === 0) return false
  }

  return true
}

export async function syncMaterializedQueueItem(collection: string, itemId: string): Promise<void> {
  // An addendum's pipeline moved: its parent's row shows that state (#715)
  // and an addendums source may list the addendum itself (#742).
  if (collection === ADDENDUM_COLLECTION) {
    const row = (await db(ADDENDUM_COLLECTION)
      .where({ id: itemId })
      .first('parent_collection', 'parent_id')
      .catch(() => undefined)) as
      | { parent_collection: string | null; parent_id: unknown }
      | undefined
    await syncAddendumInQueues(
      itemId,
      row?.parent_collection ?? null,
      row?.parent_id == null ? null : String(row.parent_id)
    )
    return
  }
  const sources = (await db('nivaro_queue_sources as qs')
    .join('nivaro_queues as q', 'qs.queue_id', 'q.id')
    .where({ 'qs.type': 'collection', 'qs.collection': collection, 'q.materialized': true })
    .select('qs.*')) as QueueSourceRow[]

  for (const source of sources) {
    await syncOneMaterializedRow(source, collection, itemId)
  }
}

/**
 * Keep materialized queues current after an addendum is created, moves,
 * is approved/rejected, or is deleted: resync the parent record's rows (its
 * shown state follows the addendum) and the addendum's own row in every
 * materialized `addendums` source over that parent collection. Never throws —
 * a cache refresh must not fail the write that triggered it.
 */
export async function syncAddendumInQueues(
  addendumId: string,
  parentCollection: string | null,
  parentId: string | null
): Promise<void> {
  try {
    if (parentCollection && parentId) {
      await syncMaterializedQueueItem(parentCollection, parentId)
    }
    const sources = (await db('nivaro_queue_sources as qs')
      .join('nivaro_queues as q', 'qs.queue_id', 'q.id')
      .where({ 'qs.type': 'addendums', 'q.materialized': true })
      .modify((qb) => {
        if (parentCollection) qb.where('qs.collection', parentCollection)
      })
      .select('qs.*', 'q.owner as queue_owner')) as Array<QueueSourceRow & { queue_owner: string }>
    if (sources.length === 0) return
    const { resolveAddendumsSource } = await import('./queues.js')
    const { rowFromQueueItemWithSla, writeMaterializedRowChunk } = await import(
      '../functions/queue-materialization-jobs.js'
    )
    for (const source of sources) {
      // Membership is the resolver's own answer for this one addendum, so the
      // cached row and a live read can never disagree about it.
      const { items } = await resolveAddendumsSource(
        source,
        { id: source.queue_owner } as never,
        1,
        { enforceAccess: false, onlyIds: [addendumId] }
      )
      const existing = (await db('nivaro_queue_items')
        .where({ queue_id: source.queue_id, source_id: source.id, collection: ADDENDUM_COLLECTION })
        .whereRaw('UPPER(item_id) = UPPER(?)', [addendumId])
        .select('id', 'item_id')) as Array<{ id: number; item_id: string }>
      if (items.length === 0) {
        if (existing.length > 0) {
          await db('nivaro_queue_items')
            .whereIn(
              'id',
              existing.map((e) => e.id)
            )
            .delete()
        }
        continue
      }
      const rows = await rowFromQueueItemWithSla(items)
      await writeMaterializedRowChunk(source.queue_id as string, source.id as number, rows)
    }
  } catch (err) {
    console.warn('[queues] addendum cache refresh failed:', (err as Error).message)
  }
}

async function syncOneMaterializedRow(
  source: QueueSourceRow,
  collection: string,
  itemId: string
): Promise<void> {
  const existing = (await db('nivaro_queue_items')
    .where({ queue_id: source.queue_id, source_id: source.id, collection, item_id: itemId })
    .first()) as { id: number } | undefined

  const matches = await queueItemMatchesSource(collection, itemId, source)
  if (!matches) {
    if (existing) await db('nivaro_queue_items').where({ id: existing.id }).delete()
    return
  }

  const { row, ownerIds } = await buildMaterializedRow(source, collection, itemId)

  let queueItemId: number
  if (existing) {
    await db('nivaro_queue_items').where({ id: existing.id }).update(row)
    queueItemId = existing.id
  } else {
    await db('nivaro_queue_items').insert({
      queue_id: source.queue_id,
      source_id: source.id,
      collection,
      item_id: itemId,
      ...row
    })
    const inserted = (await db('nivaro_queue_items')
      .where({ queue_id: source.queue_id, source_id: source.id, collection, item_id: itemId })
      .select('id')
      .first()) as { id: number }
    queueItemId = inserted.id
  }

  await db('nivaro_queue_item_owners').where({ queue_item_id: queueItemId }).delete()
  if (ownerIds.length > 0) {
    await db('nivaro_queue_item_owners').insert(
      ownerIds.map((userId) => ({ queue_item_id: queueItemId, user_id: userId }))
    )
  }
}

async function buildMaterializedRow(
  source: QueueSourceRow,
  collection: string,
  itemId: string
): Promise<{ row: Record<string, unknown>; ownerIds: string[] }> {
  const labels = source.label_template
    ? await renderTemplateLabels(collection, [itemId], source.label_template)
    : await getLabels(new Map([[collection, new Set([itemId])]]))
  const label = labels[`${collection}:${itemId}`] ?? itemId

  const binding = (await db('nivaro_workflow_bindings').where({ collection }).first()) as
    | { id: number; template: string }
    | undefined

  let state: string | null = null
  let stateId: string | null = null
  let stateColor: string | null = null
  let enteredStateAt: Date | null = null
  let slaDurationHours: number | null = null
  let slaWarningPct: number | null = null
  let slaBusinessHoursOnly = false
  let slaTimezone: string | null = null
  let ownerIds: string[] = []

  if (binding) {
    const instance = (await db('nivaro_workflow_instances as wi')
      .leftJoin('nivaro_workflow_states as s', 'wi.current_state', 's.id')
      .where('wi.collection', collection)
      .where('wi.item', itemId)
      .select(
        'wi.id as instance_id',
        'wi.current_state',
        's.key as state_key',
        's.color as state_color'
      )
      .first()) as
      | {
          instance_id: string
          current_state: string | null
          state_key: string | null
          state_color: string | null
        }
      | undefined

    if (instance) {
      state = instance.state_key
      stateColor = instance.state_color
      stateId = instance.current_state

      if (instance.current_state) {
        const history = (await db('nivaro_workflow_history')
          .where({ instance: instance.instance_id, to_state: instance.current_state })
          .orderBy('timestamp', 'desc')
          .first()) as { timestamp: Date } | undefined
        enteredStateAt = history ? new Date(history.timestamp) : null

        const rule = (await db('nivaro_sla_rules')
          .where({
            workflow_template: binding.template,
            state_key: instance.state_key,
            is_active: true
          })
          .first()) as
          | { duration_hours: number; warning_threshold_pct: number; business_hours_only: boolean }
          | undefined
        if (rule) {
          slaDurationHours = rule.duration_hours
          slaWarningPct = rule.warning_threshold_pct
          slaBusinessHoursOnly = !!rule.business_hours_only
          if (slaBusinessHoursOnly) {
            slaTimezone = (await resolveRecordZones(collection, [itemId])).get(itemId) ?? null
          }
        }

        const ownersByItem = await resolveStateOwnersBatch([
          {
            key: itemId,
            stateId: instance.current_state,
            instanceId: instance.instance_id,
            collection,
            itemId
          }
        ])
        ownerIds = (ownersByItem.get(itemId) ?? ([] as ResolvedOwner[])).map((o) => o.id)
      }
    }
  }

  // #715: an in-flight addendum's state and owners are what the row shows.
  const addendum = await effectiveAddendum(collection, itemId)
  let via: { id: string; title: string | null } | null = null
  if (addendum) {
    state = addendum.state_key
    stateColor = addendum.state_color
    stateId = addendum.state_id
    const ownersByItem = await resolveStateOwnersBatch([
      {
        key: itemId,
        stateId: addendum.state_id,
        instanceId: addendum.instance_id,
        collection: ADDENDUM_COLLECTION,
        itemId: addendum.addendum_id
      }
    ])
    ownerIds = (ownersByItem.get(itemId) ?? ([] as ResolvedOwner[])).map((o) => o.id)
    via = { id: addendum.addendum_id, title: addendum.title }
  }

  const ruleRows = (await db('nivaro_at_risk_rules')
    .where({ collection, is_active: true })
    .orderBy('id')) as AtRiskRuleRow[]
  const rules = parseActiveRules(ruleRows)
  let atRisk = false
  let atRiskColor: string | null = null
  if (rules.length) {
    const fields = new Set<string>(['id'])
    for (const rule of rules) for (const f of referencedFields(rule.conditions)) fields.add(f)
    const riskRow = (await db(collection)
      .where('id', itemId)
      .select([...fields])
      .first()) as Record<string, unknown> | undefined
    if (riskRow) {
      const atRiskMap = evaluateRows([riskRow], rules)
      const flag = atRiskMap[itemId]
      atRisk = !!flag?.at_risk
      atRiskColor = flag?.color ?? null
    }
  }

  const extraFieldPaths = (parseJson(source.extra_fields) as string[] | null) ?? []
  const extra: Record<string, unknown> = {}
  const extraIds: Record<string, string[]> = {}
  if (extraFieldPaths.length) {
    const relationsCache = new Map<string, CMSRelation[]>()
    const aggregates =
      (parseJson(source.aggregates ?? null) as Record<string, QueueAggregateFn> | null) ?? null
    for (const path of extraFieldPaths) {
      try {
        const valuesByRowId = await resolveExtraPathValues(
          collection,
          [itemId],
          path,
          relationsCache,
          aggregates
        )
        const value = valuesByRowId.get(itemId)
        if (value !== undefined) {
          extra[path] = value.value
          if (value.ids.length > 0) extraIds[path] = value.ids
        }
      } catch {
        // Degrade gracefully — same as the live-resolve path's extra-field handling
      }
    }
  }

  const ownerNames =
    ownerIds.length > 0
      ? (
          (await db('nivaro_users')
            .whereIn('id', ownerIds)
            .select('first_name', 'last_name', 'email')) as Array<{
            first_name: string | null
            last_name: string | null
            email: string
          }>
        ).map((u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email)
      : []

  return {
    row: {
      label,
      state,
      state_id: stateId,
      state_color: stateColor,
      entered_state_at: enteredStateAt,
      sla_duration_hours: slaDurationHours,
      sla_warning_pct: slaWarningPct,
      sla_business_hours_only: slaBusinessHoursOnly,
      sla_timezone: slaTimezone,
      at_risk: atRisk,
      at_risk_color: atRiskColor,
      owner_names: ownerSortKey(ownerNames),
      // Reserved keys (__ids drill-down ids, __t typed twins, __via the
      // addendum) — see queue-materialization-extra.ts.
      extra: encodeCachedExtra(extra, extraIds, via),
      url: `/collections/${collection}/${itemId}`,
      updated_at: new Date()
    },
    ownerIds
  }
}
