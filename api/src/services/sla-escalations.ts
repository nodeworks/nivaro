import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { notifyUser } from './notification-channels.js'
import { resolveStateOwnersBatch } from './pipeline-engine.js'

/**
 * SLA escalation ladders. A rule's ladder is tiers past the BREACH moment:
 * [{after_hours: 4, notify: 'manager'}, {after_hours: 24, notify: 'user:<id>'}].
 * The half-hourly sweep finds breached records per laddered rule, and for
 * each un-acknowledged episode fires whichever tiers have come due — once per
 * (record, state-entry episode, tier). Acknowledging the episode stops the
 * climb; leaving the state ends it naturally (a later re-entry is a NEW
 * episode, so old acks don't mute a fresh breach).
 */

interface LadderTier {
  after_hours: number
  notify: string // 'owner' | 'manager' | 'user:<uuid>'
}

interface LadderedRule {
  id: number
  workflow_template: string
  state_key: string
  name: string
  duration_hours: number
  business_hours_only: boolean
  escalation_ladder: string | null
}

function parseLadder(raw: unknown): LadderTier[] {
  try {
    const arr = raw ? (JSON.parse(String(raw)) as LadderTier[]) : []
    return (Array.isArray(arr) ? arr : [])
      .filter((t) => Number.isFinite(Number(t.after_hours)) && typeof t.notify === 'string')
      .sort((a, z) => Number(a.after_hours) - Number(z.after_hours))
  } catch {
    return []
  }
}

async function resolveRecipients(
  notify: string,
  collection: string,
  item: string,
  stateId: string,
  instanceId: string | null
): Promise<string[]> {
  if (notify.startsWith('user:')) return [notify.slice(5)]
  const ownersByKey = await resolveStateOwnersBatch([
    { key: item, stateId, instanceId, collection, itemId: item }
  ])
  const owners = (ownersByKey.get(item) ?? []).map((o: { id: unknown }) => String(o.id))
  if (notify === 'owner') return owners
  if (notify === 'manager') {
    if (owners.length === 0) return []
    const rows = (await db('nivaro_users')
      .whereIn('id', owners)
      .whereNotNull('manager_id')
      .select('manager_id')) as Array<{ manager_id: string }>
    return [...new Set(rows.map((r) => String(r.manager_id)))]
  }
  return []
}

export async function runSlaEscalations(app: FastifyInstance | null): Promise<string> {
  const rules = (await db('nivaro_sla_rules')
    .where('is_active', true)
    .whereNotNull('escalation_ladder')) as LadderedRule[]
  const laddered = rules.filter((r) => parseLadder(r.escalation_ladder).length > 0)
  if (laddered.length === 0) return 'no laddered rules'

  const { computeStatusBatch } = await import('../routes/sla.js')
  let fired = 0
  for (const rule of laddered) {
    const ladder = parseLadder(rule.escalation_ladder)
    // The rule's state uuid + bound collections.
    const state = (await db('nivaro_workflow_states')
      .where({ template: rule.workflow_template, key: rule.state_key })
      .first('id')) as { id: string } | undefined
    if (!state) continue
    const bindings = (await db('nivaro_workflow_bindings')
      .where({ template: rule.workflow_template })
      .select('collection')) as Array<{ collection: string }>

    for (const b of bindings) {
      const instances = (await db('nivaro_workflow_instances')
        .where({ template: rule.workflow_template, collection: b.collection, current_state: state.id })
        .whereNull('completed_at')
        .select('id', 'item', 'template', 'collection', 'current_state', 'started_at')) as Array<
        Record<string, unknown>
      >
      if (instances.length === 0) continue
      const items = instances.map((i) => String(i.item))
      const statuses = await computeStatusBatch(b.collection, items, instances as never)

      for (const item of items) {
        const st = statuses[item]
        if (!st || st.status !== 'breached' || st.duration_hours == null) continue
        const hoursPast = st.elapsed_hours - st.duration_hours
        const entered = new Date(st.entered_at)

        // MSSQL `datetime` rounds to 1/300s — exact equality on the episode
        // timestamp silently misses (verified live), so episode identity is a
        // 1s tolerance window everywhere in this feature.
        const acked = await db('nivaro_sla_acks')
          .where({ rule: rule.id, collection: b.collection, item })
          .whereRaw('ABS(DATEDIFF(ms, entered_state_at, ?)) < 1000', [entered])
          .first('id')
        if (acked) continue

        for (let tier = 0; tier < ladder.length; tier++) {
          if (hoursPast < Number(ladder[tier].after_hours)) break
          const already = await db('nivaro_sla_escalations')
            .where({ rule: rule.id, collection: b.collection, item, tier })
            .whereRaw('ABS(DATEDIFF(ms, entered_state_at, ?)) < 1000', [entered])
            .first('id')
          if (already) continue

          const inst = instances.find((i) => String(i.item) === item)
          const recipients = await resolveRecipients(
            ladder[tier].notify,
            b.collection,
            item,
            String(inst?.current_state ?? state.id),
            inst?.id != null ? String(inst.id) : null
          )
          let inserted = true
          await db('nivaro_sla_escalations')
            .insert({
              rule: rule.id,
              collection: b.collection,
              item,
              entered_state_at: entered,
              tier,
              notified_at: new Date(),
              recipients: JSON.stringify(recipients)
            })
            .catch(() => {
              // unique race with a parallel replica — theirs won, and the
              // notification must not fire twice.
              inserted = false
            })
          if (inserted && app) {
            for (const uid of recipients) {
              await notifyUser(app, uid, {
                subject: `SLA escalation (tier ${tier + 1}): ${rule.name}`,
                message: `A ${b.collection} record has been breached for ${Math.round(hoursPast)}h in "${rule.state_key}" with no acknowledgment. Open it and acknowledge to stop further escalation.`,
                collection: b.collection,
                item
              }).catch(() => {})
            }
          }
          fired++
        }
      }
    }
  }
  return `${fired} escalation(s) fired across ${laddered.length} laddered rule(s)`
}
