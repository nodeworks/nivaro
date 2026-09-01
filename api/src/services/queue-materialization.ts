import { db } from '../db/index.js'
import {
  type AtRiskRuleRow,
  evaluateRows,
  parseActiveRules,
  referencedFields
} from '../routes/at-risk.js'
import { computeStatusBatch } from '../routes/sla.js'
import type { CMSRelation } from '../types.js'
import { resolveRecordZones } from './sla-zones.js'
import { parseJson, type ResolvedOwner, resolveStateOwnersBatch } from './pipeline-engine.js'
import {
  applyQueueConditions,
  type ConditionBuilder,
  filterBySlaStatus,
  getLabels,
  type QueueAggregateFn,
  type QueueCondition,
  type QueueSourceRow,
  renderTemplateLabels,
  resolveExtraPathValues,
  stateFilterKeep
} from './queues.js'

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
    if (!stateFilterKeep(instance?.state_key ?? null, stateValues, mode)) return false
  }

  if (source.sla_filter) {
    const slaMap = await computeStatusBatch(collection, [itemId])
    const kept = filterBySlaStatus([itemId], slaMap, source.sla_filter)
    if (kept.length === 0) return false
  }

  return true
}

export async function syncMaterializedQueueItem(collection: string, itemId: string): Promise<void> {
  const sources = (await db('nivaro_queue_sources as qs')
    .join('nivaro_queues as q', 'qs.queue_id', 'q.id')
    .where({ 'qs.type': 'collection', 'qs.collection': collection, 'q.materialized': true })
    .select('qs.*')) as QueueSourceRow[]

  for (const source of sources) {
    await syncOneMaterializedRow(source, collection, itemId)
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
        )
          .map((u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email)
          .join(' ')
      : null

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
      owner_names: ownerNames,
      // Reserved __ids key carries related-record ids for drill-down — the read
      // path (fetchMaterializedQueueItems) splits it back out into extra_ids.
      extra: JSON.stringify(
        Object.keys(extraIds).length > 0 ? { ...extra, __ids: extraIds } : extra
      ),
      url: `/collections/${collection}/${itemId}`,
      updated_at: new Date()
    },
    ownerIds
  }
}
