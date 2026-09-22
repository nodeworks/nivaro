/**
 * "For THIS write, who would be told — and why was everyone else not?" (#526)
 * and "the owners shown vs the owners told" (#525).
 *
 * /notification-bench/simulate answers one person × one event. Before changing
 * a subscription, a category rule or a pipeline, the question runs the other
 * way: start from a write and enumerate every path that notifies —
 * collection-wide subscriptions, record watches, workflow-state subscriptions,
 * field watches, and (for a transition) the new state's owners — then run the
 * SAME decideDelivery() notifyUser executes for each person. Subscriptions the
 * write does NOT satisfy come back too, with the reason, so "why didn't Beth
 * hear about it" has an answer.
 *
 * Matching mirrors the hooks exactly (hooks/notification-subscriptions.ts,
 * hooks/field-watches.ts): update/create subscriptions match on event_type and
 * the flat filter_field/value only; workflow_transition subscriptions match on
 * to_state and AND the `filters` list against the record. Nothing here sends.
 */
import { db } from '../db/index.js'
import {
  type DeliveryDecision,
  decideDelivery,
  type NotifyCategory
} from './notification-channels.js'

export type AudienceEvent = 'create' | 'update' | 'delete' | 'transition'

export interface AudienceVia {
  kind: 'subscription' | 'record_watch' | 'state_subscription' | 'field_watch' | 'owner'
  label: string
  id: string | number | null
}

export interface AudienceMember {
  user_id: string
  name: string
  email: string | null
  via: AudienceVia[]
  delivery: DeliveryDecision
}

export interface AudienceMiss {
  user_id: string
  name: string
  via: AudienceVia
  reason: string
}

export interface AudienceReport {
  collection: string
  item: string
  event: AudienceEvent
  to_state: { key: string; label: string } | null
  told: AudienceMember[]
  not_told: AudienceMiss[]
  /** The owners the record shows for the target state (#525) and which of them are told. */
  owners: Array<{ user_id: string; name: string; told: boolean; reason: string | null }>
  notes: string[]
}

function isRecordScoped(sub: { filter_field?: string | null; filters?: unknown }): boolean {
  if (sub.filter_field === 'id') return true
  try {
    const list = typeof sub.filters === 'string' ? JSON.parse(sub.filters) : sub.filters
    return (
      Array.isArray(list) &&
      list.length === 1 &&
      list[0]?.field === 'id' &&
      (list[0].op === 'eq' || list[0].op === undefined)
    )
  } catch {
    return false
  }
}

function recordScopeItem(sub: {
  filter_field?: string | null
  filter_value?: string | null
  filters?: unknown
}): string | null {
  if (sub.filter_field === 'id') return sub.filter_value ?? null
  try {
    const list = typeof sub.filters === 'string' ? JSON.parse(sub.filters) : sub.filters
    return Array.isArray(list) && list[0]?.field === 'id' ? String(list[0].value ?? '') : null
  } catch {
    return null
  }
}

function nameOf(u: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
}): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || 'Someone'
}

export async function whoWouldHear(input: {
  collection: string
  item: string
  event: AudienceEvent
  /** For update events: the fields the write changes (field watches key on them). */
  changed_fields?: string[]
  /** For transitions: the state key entered; default = the record's current state. */
  to_state?: string | null
  actor_id?: string | null
}): Promise<AudienceReport> {
  const { collection, item, event } = input
  const actor = input.actor_id ? String(input.actor_id).toUpperCase() : null
  const notes: string[] = []
  const record = ((await db(collection)
    .where({ id: item })
    .first()
    .catch(() => null)) ?? null) as Record<string, unknown> | null
  if (!record) notes.push('The record could not be read — record-value filters judged as empty.')

  // Candidate paths → people. A person reached twice keeps both reasons.
  const told = new Map<string, { via: AudienceVia[]; category: NotifyCategory }>()
  const notTold: AudienceMiss[] = []
  const users = new Map<string, Record<string, unknown>>()
  const addTold = (userId: string, via: AudienceVia, category: NotifyCategory) => {
    const k = userId.toUpperCase()
    const cur = told.get(k) ?? { via: [], category }
    cur.via.push(via)
    told.set(k, cur)
  }

  let toState: { key: string; label: string; id: string } | null = null
  let instanceId: string | null = null
  if (event === 'transition') {
    const inst = (await db('nivaro_workflow_instances as i')
      .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
      .where({ 'i.collection': collection, 'i.item': item })
      .first('i.id', 'i.template', 's.id as state_id', 's.key', 's.label')) as
      | { id: string; template: string; state_id: string; key: string; label: string }
      | undefined
    if (!inst)
      notes.push('This record has no pipeline instance — nobody is told about a transition.')
    else {
      instanceId = inst.id
      if (input.to_state && input.to_state !== inst.key) {
        const st = (await db('nivaro_workflow_states')
          .where({ template: inst.template, key: input.to_state })
          .first('id', 'key', 'label')) as { id: string; key: string; label: string } | undefined
        if (st) toState = st
        else notes.push(`No state "${input.to_state}" on this record's pipeline.`)
      } else toState = { id: inst.state_id, key: inst.key, label: inst.label }
    }
  }

  // ── Subscriptions ────────────────────────────────────────────────────────
  if (event !== 'transition') {
    const subs = (await db('nivaro_notification_subscriptions as ns')
      .join('nivaro_users as u', 'ns.user', 'u.id')
      .where({ 'ns.collection': collection, 'ns.is_active': true })
      .whereIn('ns.event_type', [event, 'all'])
      .select(
        'ns.id',
        'ns.user',
        'ns.filter_field',
        'ns.filter_value',
        'ns.filters',
        'ns.label',
        'u.first_name',
        'u.last_name',
        'u.email'
      )
      .catch(() => [])) as Array<Record<string, unknown>>
    for (const s of subs) {
      const uid = String(s.user)
      users.set(uid.toUpperCase(), s)
      const recordScoped = isRecordScoped(s as never)
      const kind: AudienceVia['kind'] = recordScoped ? 'record_watch' : 'subscription'
      const via: AudienceVia = {
        kind,
        label: recordScoped ? 'Watching this record' : String(s.label || `${collection} ${event}`),
        id: s.id as number
      }
      if (recordScoped) {
        const scoped = recordScopeItem(s as never)
        if (scoped != null && String(scoped) !== String(item)) continue // another record's watch
      }
      if (actor && uid.toUpperCase() === actor && !recordScoped) {
        notTold.push({
          user_id: uid,
          name: nameOf(s as never),
          via,
          reason: 'They made this change — collection-wide subscriptions skip the actor.'
        })
        continue
      }
      if (!recordScoped && s.filter_field) {
        const actual = String(record?.[String(s.filter_field)] ?? '')
        if (actual !== String(s.filter_value ?? '')) {
          notTold.push({
            user_id: uid,
            name: nameOf(s as never),
            via,
            reason: `Their filter wants ${String(s.filter_field)} = "${String(s.filter_value ?? '')}"; this record has "${actual}".`
          })
          continue
        }
      }
      addTold(uid, via, 'watch')
    }
  } else if (toState) {
    const subs = (await db('nivaro_notification_subscriptions as ns')
      .join('nivaro_users as u', 'ns.user', 'u.id')
      .where({
        'ns.collection': collection,
        'ns.is_active': true,
        'ns.event_type': 'workflow_transition'
      })
      .select(
        'ns.id',
        'ns.user',
        'ns.filter_field',
        'ns.filter_value',
        'ns.filters',
        'ns.label',
        'u.first_name',
        'u.last_name',
        'u.email'
      )
      .catch(() => [])) as Array<Record<string, unknown>>
    const { resolveRecordValue } = await import('./workflow-transitions.js')
    const { filterMatches } = await import('../hooks/notification-subscriptions.js')
    const cache = new Map<string, unknown>()
    const valueOf = async (path: string) => {
      if (!cache.has(path))
        cache.set(
          path,
          record ? await resolveRecordValue(collection, record, path, item, db) : null
        )
      return cache.get(path)
    }
    for (const s of subs) {
      const uid = String(s.user)
      users.set(uid.toUpperCase(), s)
      const via: AudienceVia = {
        kind: 'state_subscription',
        label: String(s.label || 'Workflow state changes'),
        id: s.id as number
      }
      const field = String(s.filter_field ?? 'to_state')
      if (s.filter_value && field === 'to_state' && s.filter_value !== toState.key) continue
      if (actor && uid.toUpperCase() === actor) {
        notTold.push({
          user_id: uid,
          name: nameOf(s as never),
          via,
          reason: 'They made this move — state subscriptions skip the actor.'
        })
        continue
      }
      let filters: Array<{ field?: string; op?: string; value?: unknown }> = []
      try {
        const parsed = s.filters ? JSON.parse(String(s.filters)) : []
        filters = Array.isArray(parsed) ? parsed : []
      } catch {
        filters = []
      }
      let failed: string | null = null
      for (const f of filters) {
        if (!f?.field || !f.op) continue
        const actual = await valueOf(f.field)
        if (!filterMatches(f.op as never, actual, f.value)) {
          failed = `Their filter ${f.field} ${f.op} ${JSON.stringify(f.value)} does not match this record (${JSON.stringify(actual)}).`
          break
        }
      }
      if (failed) {
        notTold.push({ user_id: uid, name: nameOf(s as never), via, reason: failed })
        continue
      }
      addTold(uid, via, 'workflow')
    }
  }

  // ── Field watches ─────────────────────────────────────────────────────────
  if (event === 'update' && (input.changed_fields?.length ?? 0) > 0) {
    const watches = (await db('nivaro_field_watches')
      .where({ collection, is_active: true })
      .whereIn('field', input.changed_fields ?? [])
      .select('*')
      .catch(() => [])) as Array<Record<string, unknown>>
    for (const w of watches) {
      if (w.item_id != null && String(w.item_id) !== String(item)) continue
      const subs = (await db('nivaro_field_watch_subscribers as s')
        .join('nivaro_users as u', 's.user', 'u.id')
        .where('s.watch', w.id as number)
        .select('s.user', 'u.first_name', 'u.last_name', 'u.email')
        .catch(() => [])) as Array<Record<string, unknown>>
      for (const s of subs) {
        users.set(String(s.user).toUpperCase(), s)
        addTold(
          String(s.user),
          {
            kind: 'field_watch',
            label: `Field watch: ${String(w.name ?? w.field)}`,
            id: w.id as number
          },
          'watch'
        )
      }
    }
  }

  // ── Owners of the state entered (#525) ────────────────────────────────────
  const owners: AudienceReport['owners'] = []
  if (event === 'transition' && toState) {
    const flows = (await db('nivaro_flows')
      .where({ status: 'active', trigger: 'workflow-transition' })
      .count('* as n')
      .first()
      .catch(() => ({ n: 0 }))) as { n: number | string } | undefined
    const flowCount = Number(flows?.n ?? 0)
    if (flowCount > 0)
      notes.push(
        `${flowCount} active flow(s) listen to workflow transitions and email the new state's owners — each flow's own condition decides whether it runs for this record.`
      )
    if (flowCount === 0)
      notes.push(
        'No active flow listens to workflow-transition, so owners are SHOWN but nobody emails them — only in-app state subscriptions fire.'
      )
    const { resolveStateOwnersBatch } = await import('./pipeline-engine.js')
    const map = await resolveStateOwnersBatch([
      { key: 'x', stateId: toState.id, instanceId, collection, itemId: item }
    ])
    for (const o of map.get('x') ?? []) {
      users.set(String(o.id).toUpperCase(), o as unknown as Record<string, unknown>)
      if (flowCount > 0)
        addTold(o.id, { kind: 'owner', label: `Owner of ${toState.label}`, id: null }, 'workflow')
    }
    for (const o of map.get('x') ?? []) {
      const d = told.get(String(o.id).toUpperCase())
      owners.push({
        user_id: o.id,
        name: nameOf(o),
        told: !!d,
        reason: d ? null : 'No notify flow is active for transitions.'
      })
    }
  }

  // ── Delivery for each person told ─────────────────────────────────────────
  const friendly = collection.replace(/_/g, ' ')
  const out: AudienceMember[] = []
  for (const [k, t] of told) {
    const u = users.get(k) ?? {}
    const subject =
      event === 'transition' && toState
        ? `${friendly} ${item} is now ${toState.label}`
        : `${friendly} ${item} ${event}d`
    const delivery = await decideDelivery(String(u.user ?? u.id ?? k), {
      subject,
      collection,
      item,
      category: t.category
    }).catch(
      (): DeliveryDecision => ({
        category: t.category,
        critical: false,
        inapp: false,
        push: false,
        email: 'off',
        sms: false,
        reasons: [],
        dropped: true
      })
    )
    out.push({
      user_id: String(u.user ?? u.id ?? k),
      name: nameOf(u as never),
      email: (u.email as string) ?? null,
      via: t.via,
      delivery
    })
  }
  // An owner told on paper but dropped by their own rules is still a gap.
  for (const o of owners) {
    if (!o.told) continue
    const m = out.find((x) => x.user_id.toUpperCase() === o.user_id.toUpperCase())
    if (
      m?.delivery.dropped ||
      (m && !m.delivery.inapp && m.delivery.email === 'off' && !m.delivery.push)
    ) {
      o.told = false
      o.reason = m.delivery.reasons[0]?.text ?? 'Their notification rules drop it.'
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return {
    collection,
    item,
    event,
    to_state: toState ? { key: toState.key, label: toState.label } : null,
    told: out,
    not_told: notTold.slice(0, 200),
    owners,
    notes
  }
}
