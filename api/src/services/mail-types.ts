import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { renderMailTemplate, sendMail, sendRawMail } from './mail.js'
import { buildRecordCard } from './mail-record-card.js'
import type { NotifyCategory } from './notification-channels.js'
import { getLabels } from './queues.js'

/**
 * Mail-type registry — every kind of email the instance sends, described once:
 * what it is, which Liquid template renders it, and how to build its context
 * from a REAL sample (a record, a workflow-history row, a user) so an admin
 * can preview / send the exact email production would send, without waiting
 * for the event. Senders that go through `renderMailType` share the builder
 * with the harness; extensions register their own types via
 * `ctx.mail.registerType` (efp-ops: invoice on-hold, PO received…).
 */

export type MailSampleKind = 'record' | 'history' | 'user' | 'notification' | 'none'

export interface MailSampleOption {
  id: string
  label: string
  hint?: string
}

export interface MailRendered {
  subject: string
  html: string
  /** Who production would send this to, with the reason each is on the list. */
  recipients: Array<{ email: string; reason: string }>
  category?: NotifyCategory
}

export interface MailTypeDef {
  key: string
  label: string
  group: string
  description: string
  /** Liquid template name (core or extension root) — informational for
   *  types whose builder assembles HTML itself. */
  template: string | null
  category?: NotifyCategory
  sample: {
    kind: MailSampleKind
    /** For 'record': the collection the picker browses. For 'history': the
     *  bound collection whose instances are offered (null = any). */
    collection?: string | null
    /** Extra narrowing for 'history' samples (e.g. only terminal 'canceled'). */
    history_filter?: 'canceled' | 'any'
    /** 'notification': subject prefix / category the sample rows are drawn from. */
    notification_category?: NotifyCategory
  }
  /** Sample rows the picker offers (most recent first). */
  samples: (q: string) => Promise<MailSampleOption[]>
  /** Render for a chosen sample id (+ the recipient the harness will use). */
  render: (sampleId: string, opts: { recipientUserId?: string }) => Promise<MailRendered>
}

const registry = new Map<string, MailTypeDef>()

export function registerMailType(def: MailTypeDef): void {
  registry.set(def.key, def)
}

export function listMailTypes(): MailTypeDef[] {
  return [...registry.values()].sort((a, b) =>
    a.group === b.group ? a.label.localeCompare(b.label) : a.group.localeCompare(b.group)
  )
}

export function getMailType(key: string): MailTypeDef | undefined {
  return registry.get(key)
}

// ── shared sample helpers ────────────────────────────────────────────────────

const userName = (u: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
}) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || ''

export async function recordSamples(collection: string, q: string): Promise<MailSampleOption[]> {
  const idCol = 'id'
  let qb = db(collection).orderBy(idCol, 'desc').limit(25).select(idCol)
  if (q.trim()) {
    const like = `%${q.trim().replace(/[%_[]/g, '[$&]')}%`
    // Try the collection's friendly id / name columns.
    const cols = (await db.raw(
      `SELECT COLUMN_NAME c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME IN ('workflow_id','inventory_request_id','name','number','title','project_id')`,
      [collection]
    )) as unknown as { recordset?: Array<{ c: string }> }
    const names = (cols.recordset ?? (cols as unknown as Array<{ c: string }>)).map((r) => r.c)
    if (names.length)
      qb = qb.where((b) => {
        for (const c of names) b.orWhere(c, 'like', like)
      })
  }
  const rows = (await qb) as Array<Record<string, unknown>>
  const ids = rows.map((r) => String(r[idCol]))
  const labels = await getLabels(new Map([[collection, new Set(ids)]])).catch(
    () => ({}) as Record<string, string>
  )
  return ids.map((id) => ({ id, label: labels[`${collection}:${id}`] || id }))
}

export async function historySamples(
  q: string,
  opts: { collection?: string | null; filter?: 'canceled' | 'any' } = {}
): Promise<MailSampleOption[]> {
  let qb = db('nivaro_workflow_history as h')
    .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
    .join('nivaro_workflow_states as s', 's.id', 'h.to_state')
    .leftJoin('nivaro_workflow_transitions as t', 't.id', 'h.transition')
    .leftJoin('nivaro_users as u', 'u.id', 'h.user')
    .orderBy('h.timestamp', 'desc')
    .limit(q.trim() ? 400 : 30)
    .select(
      'h.id',
      'h.timestamp',
      'i.collection',
      'i.item',
      's.label as state',
      't.label as transition',
      'u.first_name',
      'u.last_name',
      'u.email'
    )
  if (opts.collection) qb = qb.where('i.collection', opts.collection)
  if (opts.filter === 'canceled') qb = qb.where('s.key', 'like', '%cancel%')
  const rows = (await qb) as Array<{
    id: number
    timestamp: Date
    collection: string
    item: string
    state: string
    transition: string | null
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  const byCol = new Map<string, Set<string>>()
  for (const r of rows) {
    const set = byCol.get(r.collection) ?? new Set<string>()
    set.add(String(r.item))
    byCol.set(r.collection, set)
  }
  const labels = await getLabels(byCol).catch(() => ({}) as Record<string, string>)
  const needle = q.trim().toLowerCase()
  return rows
    .map((r) => ({
      id: String(r.id),
      label: `${labels[`${r.collection}:${r.item}`] || r.item} — ${r.transition ?? 'moved'} → ${r.state}`,
      hint: `${userName(r) || 'system'} · ${new Date(r.timestamp).toLocaleString('en-US')}`
    }))
    .filter(
      (o) =>
        !needle ||
        o.label.toLowerCase().includes(needle) ||
        (o.hint ?? '').toLowerCase().includes(needle)
    )
}

export async function userSamples(q: string): Promise<MailSampleOption[]> {
  let qb = db('nivaro_users')
    .where('status', 'active')
    .where('is_redacted', 0)
    .orderBy('last_access', 'desc')
    .limit(25)
    .select('id', 'first_name', 'last_name', 'email')
  if (q.trim()) {
    const like = `%${q.trim()}%`
    qb = qb.where((b) =>
      b
        .where('email', 'like', like)
        .orWhere('first_name', 'like', like)
        .orWhere('last_name', 'like', like)
    )
  }
  const rows = (await qb) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string
  }>
  return rows.map((u) => ({ id: u.id, label: userName(u), hint: u.email }))
}

export async function notificationSamples(
  q: string,
  category?: NotifyCategory
): Promise<MailSampleOption[]> {
  const { classifyNotification } = await import('./notification-channels.js')
  let qb = db('nivaro_notifications as n')
    .leftJoin('nivaro_users as u', 'u.id', 'n.recipient')
    .orderBy('n.timestamp', 'desc')
    .limit(category ? 400 : 40)
    .select('n.id', 'n.subject', 'n.timestamp', 'u.email')
  if (q.trim()) qb = qb.where('n.subject', 'like', `%${q.trim()}%`)
  const rows = (await qb) as Array<{
    id: number
    subject: string
    timestamp: Date
    email: string | null
  }>
  return rows
    .filter((r) => !category || classifyNotification(r.subject) === category)
    .slice(0, 30)
    .map((r) => ({
      id: String(r.id),
      label: r.subject,
      hint: `${r.email ?? ''} · ${new Date(r.timestamp).toLocaleString('en-US')}`
    }))
}

// ── change extraction for watch / subscription mails ─────────────────────────

const HIDDEN_KEYS = new Set([
  'date_updated',
  'user_updated',
  'changed',
  'last_state_change',
  'updated_at'
])
const fmtV = (v: unknown): string =>
  v == null || v === ''
    ? ''
    : typeof v === 'number'
      ? v.toLocaleString('en-US', { maximumFractionDigits: 2 })
      : typeof v === 'boolean'
        ? v
          ? 'Yes'
          : 'No'
        : typeof v === 'object'
          ? JSON.stringify(v).slice(0, 80)
          : String(v)
              .replace(/<[^>]+>/g, '')
              .slice(0, 120)

/** Labelled old → new pairs for a delta, FK ids resolved to display labels. */
export async function labelledChanges(
  collection: string,
  delta: Record<string, unknown> | null | undefined,
  previous: Record<string, unknown> | null | undefined,
  cap = 12
): Promise<Array<{ field: string; label: string; old: string; new: string }>> {
  if (!delta) return []
  const keys = Object.keys(delta)
    .filter((k) => !k.startsWith('_') && !HIDDEN_KEYS.has(k))
    .slice(0, cap)
  if (keys.length === 0) return []
  const [fields, rels] = await Promise.all([
    db('nivaro_fields')
      .where({ collection })
      .whereIn('field', keys)
      .select('field', 'label') as Promise<Array<{ field: string; label: string | null }>>,
    db('nivaro_relations')
      .where({ many_collection: collection })
      .whereIn('many_field', keys)
      .whereNull('junction_field')
      .select('many_field', 'one_collection') as Promise<
      Array<{ many_field: string; one_collection: string | null }>
    >
  ])
  const labelOf = new Map(fields.map((f) => [f.field, f.label]))
  const target = new Map(
    rels.filter((r) => r.one_collection).map((r) => [r.many_field, r.one_collection as string])
  )
  const want = new Map<string, Set<string>>()
  for (const k of keys) {
    const t = target.get(k)
    if (!t) continue
    for (const v of [previous?.[k], delta[k]]) {
      if (v == null || v === '' || typeof v === 'object') continue
      const set = want.get(t) ?? new Set<string>()
      set.add(String(v))
      want.set(t, set)
    }
  }
  const labels = want.size ? await getLabels(want).catch(() => ({}) as Record<string, string>) : {}
  const show = (k: string, v: unknown) => {
    const t = target.get(k)
    return t && v != null && v !== '' && typeof v !== 'object'
      ? (labels[`${t}:${String(v)}`] ?? fmtV(v))
      : fmtV(v)
  }
  const titleCase = (s: string) => s.replace(/_+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return keys.map((k) => ({
    field: k,
    label: labelOf.get(k) || titleCase(k),
    old: previous && k in previous ? show(k, previous[k]) : '',
    new: show(k, delta[k])
  }))
}

/** Context for a record watch / subscription mail about ONE activity row. */
export async function buildRecordChangeContext(
  activityId: number
): Promise<Record<string, unknown> | null> {
  const a = (await db('nivaro_activity as a')
    .leftJoin('nivaro_users as u', 'u.id', 'a.user')
    .where('a.id', activityId)
    .first(
      'a.id',
      'a.action',
      'a.collection',
      'a.item',
      'a.timestamp',
      'a.user',
      'u.first_name',
      'u.last_name',
      'u.email'
    )) as
    | {
        id: number
        action: string
        collection: string
        item: string
        timestamp: Date
        user: string | null
        first_name: string | null
        last_name: string | null
        email: string | null
      }
    | undefined
  if (!a) return null
  const rev = (await db('nivaro_revisions').where({ activity: a.id }).first('delta')) as
    | { delta: string | null }
    | undefined
  const prev = (await db('nivaro_revisions as r')
    .join('nivaro_activity as x', 'x.id', 'r.activity')
    .where('x.collection', a.collection)
    .where('x.item', String(a.item))
    .where('x.timestamp', '<', a.timestamp)
    .orderBy('x.timestamp', 'desc')
    .first('r.data')) as { data: string | null } | undefined
  const parse = (s: string | null | undefined) => {
    try {
      return s ? (JSON.parse(s) as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const delta = parse(rev?.delta)
  const previous = parse(prev?.data)
  const card = await buildRecordCard(a.collection, a.item).catch(() => null)
  const changes = a.action === 'update' ? await labelledChanges(a.collection, delta, previous) : []
  return {
    collection: a.collection,
    item: a.item,
    event: a.action === 'create' ? 'create' : a.action === 'delete' ? 'delete' : 'update',
    actor_name: userName(a) || null,
    record_card: card,
    record_url: card?.url ?? `${adminBaseUrl() ?? ''}/collections/${a.collection}/${a.item}`,
    friendly_id: card?.title ?? String(a.item),
    changes,
    changed_at: new Date(a.timestamp).toISOString()
  }
}

// ── render through the delivering FLOW (exact production fidelity) ───────────

/**
 * Run an active flow in dry-run with the given payload and return what its
 * first mail op WOULD send — the flow's own `to` / `subject` / template.
 * Null when the flow is missing, inactive, or its condition op rejects the
 * payload (e.g. a workflows flow given an IR transition); callers fall back
 * to rendering the type's template directly.
 */
export async function renderViaFlow(
  flowName: string,
  payload: Record<string, unknown>
): Promise<{ to: string; subject: string; html: string } | null> {
  const flow = (await db('nivaro_flows').where({ name: flowName, status: 'active' }).first()) as
    | { id: string; name: string }
    | undefined
  if (!flow) return null
  const { executeFlow } = await import('./flow-executor.js')
  const noop = () => undefined
  const log = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => log
  } as unknown as import('fastify').FastifyBaseLogger
  let output: Record<string, unknown> = {}
  try {
    output = await executeFlow({
      flowId: flow.id,
      flowName: flow.name,
      trigger: 'harness',
      payload,
      log,
      dryRun: true,
      trace: []
    })
  } catch {
    return null
  }
  for (const [k, v] of Object.entries(output)) {
    if (!k.startsWith('$preview_')) continue
    const p = v as { op?: string; to?: string; subject?: string; body?: string }
    if (p?.op === 'mail' && typeof p.body === 'string') {
      const { wrapMailFragment } = await import('./mail.js')
      return {
        to: String(p.to ?? ''),
        subject: String(p.subject ?? ''),
        html: await wrapMailFragment(p.body)
      }
    }
  }
  return null
}

const splitTo = (to: string) =>
  to
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes('@'))

// ── core types ───────────────────────────────────────────────────────────────

export function registerCoreMailTypes(): void {
  registerMailType({
    key: 'workflow_transition',
    label: 'Workflow state change',
    group: 'Workflow',
    description:
      'Sent when a workflow or inventory request moves state — to the new state\'s owners, the creator and contacts (flows "Workflows — notify owners" / "IR Approval — notify owners").',
    template: 'workflow_transition',
    category: 'workflow',
    sample: { kind: 'history' },
    samples: (q) => historySamples(q),
    render: async (id) => {
      const { buildTransitionPayloadFromHistory } = await import('./workflow-transitions.js')
      const payload = await buildTransitionPayloadFromHistory(Number(id))
      if (!payload) throw new Error('History entry not found')
      const flowName =
        payload.subject_collection === 'inventory_request'
          ? 'IR Approval — notify owners'
          : 'Workflows — notify owners'
      const viaFlow = await renderViaFlow(flowName, payload)
      if (viaFlow) {
        const derived = transitionRecipients(payload)
        const recipients = splitTo(viaFlow.to).map((email) => ({
          email,
          reason: derived.find((d) => d.email === email)?.reason ?? `flow "${flowName}"`
        }))
        return { subject: viaFlow.subject, html: viaFlow.html, recipients, category: 'workflow' }
      }
      const to = payload.to_state as { label: string } | null
      const subject = `${payload.transition_label} — ${payload.friendly_id} is now ${to?.label ?? ''}`
      const html = await renderMailTemplate('workflow_transition', payload)
      return { subject, html, recipients: transitionRecipients(payload), category: 'workflow' }
    }
  })
  registerMailType({
    key: 'workflow_canceled',
    label: 'Workflow canceled',
    group: 'Workflow',
    description:
      'Sent to the creator and contacts when a workflow is canceled (flow "Workflows — cancellation notice").',
    template: 'workflow_canceled',
    category: 'workflow',
    sample: { kind: 'history', history_filter: 'canceled' },
    samples: (q) => historySamples(q, { filter: 'canceled' }),
    render: async (id) => {
      const { buildTransitionPayloadFromHistory } = await import('./workflow-transitions.js')
      const payload = await buildTransitionPayloadFromHistory(Number(id))
      if (!payload) throw new Error('History entry not found')
      const viaFlow = await renderViaFlow('Workflows — cancellation notice', payload)
      if (viaFlow) {
        return {
          subject: viaFlow.subject,
          html: viaFlow.html,
          recipients: splitTo(viaFlow.to).map((email) => ({
            email,
            reason: 'flow "Workflows — cancellation notice"'
          })),
          category: 'workflow'
        }
      }
      const subject = `Workflow ${payload.friendly_id} was canceled`
      const html = await renderMailTemplate('workflow_canceled', payload)
      return {
        subject,
        html,
        recipients: transitionRecipients(payload, true),
        category: 'workflow'
      }
    }
  })
  registerMailType({
    key: 'record_watch',
    label: 'Record you watch changed',
    group: 'Subscriptions',
    description:
      'The per-record bell: instant mail when a record you watch (or one of its child rows) is created, updated or deleted.',
    template: 'record_watch',
    category: 'watch',
    sample: { kind: 'notification' },
    samples: (q) => activitySamples(q),
    render: async (id, { recipientUserId }) => {
      const ctx = await buildRecordChangeContext(Number(id))
      if (!ctx) throw new Error('Activity entry not found')
      const subject = `Watching ${ctx.friendly_id}: ${ctx.event}d${ctx.actor_name ? ` by ${ctx.actor_name}` : ''}`
      const html = await renderMailTemplate('record_watch', {
        ...ctx,
        first_name: await firstName(recipientUserId)
      })
      return {
        subject,
        html,
        recipients: await watcherRecipients(String(ctx.collection), String(ctx.item)),
        category: 'watch'
      }
    }
  })
  registerMailType({
    key: 'subscription',
    label: 'Collection subscription',
    group: 'Subscriptions',
    description:
      'Instant mail for a collection you follow (create / update / delete), from /notification-subscriptions.',
    template: 'subscription',
    category: 'watch',
    sample: { kind: 'notification' },
    samples: (q) => activitySamples(q),
    render: async (id, { recipientUserId }) => {
      const ctx = await buildRecordChangeContext(Number(id))
      if (!ctx) throw new Error('Activity entry not found')
      const subject = `${String(ctx.collection).replace(/_/g, ' ')} ${ctx.event}: ${ctx.friendly_id}${ctx.actor_name ? ` by ${ctx.actor_name}` : ''}`
      const html = await renderMailTemplate('subscription', {
        ...ctx,
        subscription_label: `${String(ctx.collection).replace(/_/g, ' ')} subscription`,
        first_name: await firstName(recipientUserId)
      })
      return {
        subject,
        html,
        recipients: await collectionSubscriberRecipients(String(ctx.collection)),
        category: 'watch'
      }
    }
  })
  registerMailType({
    key: 'daily_summary',
    label: 'Daily action summary',
    group: 'Digests',
    description:
      'The per-user daily (Monday: weekly) digest — deferred notifications, open items you own, daily subscriptions, queue stats, extension sections.',
    template: null,
    category: 'system',
    sample: { kind: 'user' },
    samples: (q) => userSamples(q),
    render: async (userId) => {
      const { runDailyActionDigest } = await import('./daily-digest.js')
      let captured: { to: string; subject: string; html: string } | null = null
      await runDailyActionDigest(undefined, {
        onlyUserId: userId,
        preserveDeferred: true,
        capture: (m) => {
          captured = m
        }
      })
      if (!captured) {
        const u = (await db('nivaro_users').where({ id: userId }).first('email')) as
          | { email: string }
          | undefined
        return {
          subject: 'Your daily action summary',
          html: '<p style="font-family:Arial,sans-serif;font-size:13px;color:#64748b;">Nothing is waiting on this user right now — the digest would not be sent today.</p>',
          recipients: u ? [{ email: u.email, reason: 'digest recipient' }] : [],
          category: 'system'
        }
      }
      const c = captured as { to: string; subject: string; html: string }
      return {
        subject: c.subject,
        html: c.html,
        recipients: [{ email: c.to, reason: 'digest recipient' }],
        category: 'system'
      }
    }
  })
  // ── Dedicated templates (mail-builders.ts) — sampled from their own rows ──
  const B = () => import('./mail-builders.js')
  const rt = (built: {
    subject: string
    html?: string
    template: string
    data: Record<string, unknown>
  }) => built
  const renderBuilt = async (
    b: { template: string; subject: string; data: Record<string, unknown> },
    first_name: string | null
  ) => ({
    subject: b.subject,
    html: await renderMailTemplate(b.template, { ...b.data, first_name, subject: b.subject })
  })
  const emailOf = async (userId: string | null | undefined, reason: string) => {
    if (!userId) return []
    const u = (await db('nivaro_users').where({ id: userId }).first('email')) as
      | { email: string }
      | undefined
    return u?.email ? [{ email: u.email, reason }] : []
  }
  void rt

  registerMailType({
    key: 'task_assigned',
    label: 'Task assigned',
    group: 'People',
    description: 'Sent to the assignee when a task is created for them or reassigned.',
    template: 'task_assigned',
    category: 'workflow',
    sample: { kind: 'record', collection: 'nivaro_tasks' },
    samples: async (q) => {
      let qb = db('nivaro_tasks as t')
        .leftJoin('nivaro_users as a', 'a.id', 't.assignee')
        .orderBy('t.id', 'desc')
        .limit(30)
        .select('t.id', 't.title', 't.collection', 't.item', 't.status', 'a.email')
      if (q.trim()) qb = qb.where('t.title', 'like', `%${q.trim()}%`)
      const rows = (await qb) as Array<{
        id: number
        title: string
        collection: string
        item: string
        status: string
        email: string | null
      }>
      return rows.map((r) => ({
        id: String(r.id),
        label: r.title,
        hint: `${r.collection}/${r.item} · ${r.status} · ${r.email ?? 'unassigned'}`
      }))
    },
    render: async (id, { recipientUserId }) => {
      const { buildTaskAssignedMail } = await B()
      const b = await buildTaskAssignedMail(id)
      if (!b) throw new Error('Task not found')
      const t = (await db('nivaro_tasks').where({ id }).first('assignee')) as
        | { assignee: string }
        | undefined
      return {
        ...(await renderBuilt(b, await firstName(recipientUserId))),
        recipients: await emailOf(t?.assignee, 'assignee'),
        category: 'workflow'
      }
    }
  })

  registerMailType({
    key: 'approval',
    label: 'Approval requested / rejected / completed',
    group: 'People',
    description:
      'Approval-chain notices: approvers are asked at each step; the requester hears the outcome.',
    template: 'approval',
    category: 'workflow',
    sample: { kind: 'record', collection: 'nivaro_approval_instances' },
    samples: async (q) => {
      const rows = (await db('nivaro_approval_instances as i')
        .join('nivaro_approval_chains as c', 'c.id', 'i.chain')
        .orderBy('i.id', 'desc')
        .limit(30)
        .select('i.id', 'i.collection', 'i.item', 'i.status', 'c.name')) as Array<{
        id: number
        collection: string
        item: string
        status: string
        name: string
      }>
      const needle = q.trim().toLowerCase()
      return rows
        .map((r) => ({
          id: String(r.id),
          label: `${r.name} — ${r.collection}/${r.item}`,
          hint: r.status
        }))
        .filter((o) => !needle || o.label.toLowerCase().includes(needle))
    },
    render: async (id, { recipientUserId }) => {
      const { buildApprovalMail } = await B()
      const inst = (await db('nivaro_approval_instances')
        .where({ id })
        .first('status', 'started_by')) as { status: string; started_by: string } | undefined
      if (!inst) throw new Error('Approval instance not found')
      const kind =
        inst.status === 'rejected'
          ? 'rejected'
          : inst.status === 'approved'
            ? 'completed'
            : 'requested'
      const b = await buildApprovalMail(id, kind)
      if (!b) throw new Error('Approval instance not found')
      return {
        ...(await renderBuilt(b, await firstName(recipientUserId))),
        recipients: await emailOf(
          inst.started_by,
          kind === 'requested' ? 'approver (sample: requester)' : 'requester'
        ),
        category: 'workflow'
      }
    }
  })

  registerMailType({
    key: 'sla_escalation',
    label: 'SLA escalation',
    group: 'Alerts & monitoring',
    description:
      'A record breached its SLA and nobody acknowledged — sent per ladder tier to the owner / manager / named user.',
    template: 'sla_escalation',
    category: 'sla',
    sample: { kind: 'record', collection: 'nivaro_sla_escalations' },
    samples: async (q) => {
      const rows = (await db('nivaro_sla_escalations as e')
        .join('nivaro_sla_rules as r', 'r.id', 'e.rule')
        .orderBy('e.id', 'desc')
        .limit(30)
        .select('e.id', 'e.collection', 'e.item', 'e.tier', 'e.notified_at', 'r.name')) as Array<{
        id: number
        collection: string
        item: string
        tier: number
        notified_at: Date
        name: string
      }>
      const byCol = new Map<string, Set<string>>()
      for (const r of rows)
        byCol.set(r.collection, (byCol.get(r.collection) ?? new Set()).add(String(r.item)))
      const labels = await getLabels(byCol).catch(() => ({}) as Record<string, string>)
      const needle = q.trim().toLowerCase()
      return rows
        .map((r) => ({
          id: String(r.id),
          label: `${labels[`${r.collection}:${r.item}`] || r.item} — ${r.name} (tier ${r.tier + 1})`,
          hint: new Date(r.notified_at).toLocaleString('en-US')
        }))
        .filter((o) => !needle || o.label.toLowerCase().includes(needle))
    },
    render: async (id, { recipientUserId }) => {
      const { buildSlaEscalationMail } = await B()
      const e = (await db('nivaro_sla_escalations as e')
        .join('nivaro_sla_rules as r', 'r.id', 'e.rule')
        .where('e.id', id)
        .first('e.*', 'r.name', 'r.state_key', 'r.workflow_template', 'r.duration_hours')) as
        | {
            collection: string
            item: string
            tier: number
            entered_state_at: Date
            recipients: string | null
            name: string
            state_key: string
            workflow_template: string | null
            duration_hours: number
          }
        | undefined
      if (!e) throw new Error('Escalation not found')
      const { resolveFriendlyId } = await import('./workflow-transitions.js')
      const friendly = await resolveFriendlyId(e.collection, String(e.item)).catch(() =>
        String(e.item)
      )
      const hoursPast = Math.max(
        0,
        (Date.now() - new Date(e.entered_state_at).getTime()) / 3_600_000 -
          Number(e.duration_hours || 0)
      )
      const b = await buildSlaEscalationMail({
        ruleName: e.name,
        stateKey: e.state_key,
        templateId: e.workflow_template,
        tier: e.tier,
        hoursPast,
        friendly,
        collection: e.collection,
        item: String(e.item)
      })
      let recipients: MailRendered['recipients'] = []
      try {
        const ids = JSON.parse(e.recipients ?? '[]') as string[]
        for (const uid of ids) recipients.push(...(await emailOf(uid, 'escalation recipient')))
      } catch {
        recipients = []
      }
      return {
        ...(await renderBuilt(b, await firstName(recipientUserId))),
        recipients,
        category: 'sla'
      }
    }
  })

  registerMailType({
    key: 'alert_record',
    label: 'Alert (record threshold)',
    group: 'Alerts & monitoring',
    description:
      "A per-record alert definition fired (field crossed its threshold) — sent to the definition's subscribers.",
    template: 'alert',
    category: 'alerts',
    sample: { kind: 'record', collection: 'nivaro_alert_log' },
    samples: async (q) => {
      const rows = (await db('nivaro_alert_log as l')
        .join('nivaro_alert_definitions as d', 'd.id', 'l.alert_definition')
        .orderBy('l.id', 'desc')
        .limit(30)
        .select(
          'l.id',
          'l.collection',
          'l.item',
          'l.field_value',
          'l.triggered_at',
          'd.name'
        )) as Array<{
        id: number
        collection: string
        item: string
        field_value: string | null
        triggered_at: Date
        name: string
      }>
      const needle = q.trim().toLowerCase()
      return rows
        .map((r) => ({
          id: String(r.id),
          label: `${r.name} — ${r.collection}/${r.item} = ${r.field_value ?? ''}`,
          hint: new Date(r.triggered_at).toLocaleString('en-US')
        }))
        .filter((o) => !needle || o.label.toLowerCase().includes(needle))
    },
    render: async (id, { recipientUserId }) => {
      const { buildRecordAlertMail } = await B()
      const l = (await db('nivaro_alert_log as l')
        .join('nivaro_alert_definitions as d', 'd.id', 'l.alert_definition')
        .where('l.id', id)
        .first(
          'l.item',
          'l.field_value',
          'd.id as def_id',
          'd.name',
          'd.collection',
          'd.field',
          'd.operator',
          'd.threshold'
        )) as
        | {
            item: string
            field_value: string | null
            def_id: number
            name: string
            collection: string
            field: string
            operator: string
            threshold: unknown
          }
        | undefined
      if (!l) throw new Error('Alert log row not found')
      const b = await buildRecordAlertMail(l, String(l.item), String(l.field_value ?? ''))
      const subs = (await db('nivaro_alert_subscriptions as s')
        .join('nivaro_users as u', 'u.id', 's.user')
        .where('s.alert_definition', l.def_id)
        .where('s.notify_email', 1)
        .select('u.email')) as Array<{ email: string }>
      return {
        ...(await renderBuilt(b, await firstName(recipientUserId))),
        recipients: subs.map((s) => ({ email: s.email, reason: 'alert subscriber' })),
        category: 'alerts'
      }
    }
  })

  registerMailType({
    key: 'access_request',
    label: 'Access request (to admins)',
    group: 'System',
    description:
      'Someone hit the access-denied panel and asked for help — admins get the request with the reasons they are blocked.',
    template: 'access_request',
    category: 'system',
    sample: { kind: 'record', collection: 'nivaro_access_requests' },
    samples: async (q) => {
      const rows = (await db('nivaro_access_requests as a')
        .leftJoin('nivaro_users as u', 'u.id', 'a.user')
        .orderBy('a.id', 'desc')
        .limit(30)
        .select(
          'a.id',
          'a.collection',
          'a.item',
          'a.status',
          'a.created_at',
          'u.first_name',
          'u.last_name',
          'u.email'
        )) as Array<{
        id: number
        collection: string
        item: string | null
        status: string
        created_at: Date
        first_name: string | null
        last_name: string | null
        email: string | null
      }>
      const needle = q.trim().toLowerCase()
      return rows
        .map((r) => ({
          id: String(r.id),
          label: `${userName(r)} → ${r.collection}${r.item ? `/${r.item}` : ''}`,
          hint: `${r.status} · ${new Date(r.created_at).toLocaleString('en-US')}`
        }))
        .filter((o) => !needle || o.label.toLowerCase().includes(needle))
    },
    render: async (id, { recipientUserId }) => {
      const { buildAccessRequestMail } = await B()
      const r = (await db('nivaro_access_requests as a')
        .leftJoin('nivaro_users as u', 'u.id', 'a.user')
        .where('a.id', id)
        .first('a.*', 'u.first_name', 'u.last_name', 'u.email')) as
        | {
            user: string
            collection: string
            item: string | null
            note: string | null
            reasons: string | null
            first_name: string | null
            last_name: string | null
            email: string | null
          }
        | undefined
      if (!r) throw new Error('Access request not found')
      const { resolveFriendlyId } = await import('./workflow-transitions.js')
      const friendly = r.item
        ? await resolveFriendlyId(r.collection, String(r.item)).catch(() => String(r.item))
        : null
      let reasons: Array<{ message?: string }> = []
      try {
        reasons = r.reasons ? (JSON.parse(r.reasons) as Array<{ message?: string }>) : []
      } catch {
        reasons = []
      }
      const b = await buildAccessRequestMail({
        requesterId: r.user,
        requesterName: userName(r) || 'A user',
        collection: r.collection,
        item: r.item,
        friendly,
        note: r.note,
        reasons
      })
      const admins = (await db('nivaro_users as u')
        .join('nivaro_roles as ro', 'ro.id', 'u.role')
        .where('ro.admin_access', true)
        .whereNot('u.status', 'suspended')
        .limit(10)
        .select('u.email')) as Array<{ email: string }>
      return {
        ...(await renderBuilt(b, await firstName(recipientUserId))),
        recipients: admins.map((a) => ({ email: a.email, reason: 'administrator' })),
        category: 'system'
      }
    }
  })

  registerMailType({
    key: 'mention',
    label: 'Chat mention',
    group: 'People',
    description: 'Someone @mentioned you in chat (or used @channel in a room you belong to).',
    template: 'mention',
    category: 'mentions',
    sample: { kind: 'record', collection: 'chat_messages' },
    samples: async (q) => {
      let qb = db('chat_messages as m')
        .leftJoin('nivaro_users as u', 'u.id', 'm.sender')
        .where('m.message', 'like', '%@[%')
        .orderBy('m.id', 'desc')
        .limit(30)
        .select(
          'm.id',
          'm.room',
          'm.message',
          'm.created_at',
          'u.first_name',
          'u.last_name',
          'u.email'
        )
      if (q.trim()) qb = qb.where('m.message', 'like', `%${q.trim()}%`)
      const rows = (await qb.catch(() => [])) as Array<{
        id: number
        room: string
        message: string
        created_at: Date
        first_name: string | null
        last_name: string | null
        email: string | null
      }>
      return rows.map((r) => ({
        id: String(r.id),
        label: r.message.replace(/\s+/g, ' ').slice(0, 90),
        hint: `${userName(r) || 'someone'} · ${r.room} · ${new Date(r.created_at).toLocaleString('en-US')}`
      }))
    },
    render: async (id, { recipientUserId }) => {
      const { buildMentionMail } = await B()
      const m = (await db('chat_messages as m')
        .leftJoin('nivaro_users as u', 'u.id', 'm.sender')
        .where('m.id', id)
        .first('m.room', 'm.message', 'm.sender', 'u.first_name', 'u.last_name', 'u.email')) as
        | {
            room: string
            message: string
            sender: string | null
            first_name: string | null
            last_name: string | null
            email: string | null
          }
        | undefined
      if (!m) throw new Error('Message not found')
      const b = await buildMentionMail({
        senderId: m.sender,
        senderName: userName(m) || null,
        room: m.room,
        message: m.message
      })
      const names = [...m.message.matchAll(/@\[([^\]]+)\]/g)].map((x) => x[1])
      const recipients: MailRendered['recipients'] = []
      for (const n of names.slice(0, 10)) {
        const [first, ...rest] = n.split(' ')
        const u = (await db('nivaro_users')
          .where({ first_name: first })
          .andWhere('last_name', rest.join(' '))
          .first('email')
          .catch(() => undefined)) as { email: string } | undefined
        if (u?.email) recipients.push({ email: u.email, reason: 'mentioned' })
      }
      return {
        ...(await renderBuilt(b, await firstName(recipientUserId))),
        recipients,
        category: 'mentions'
      }
    }
  })

  registerMailType({
    key: 'queue_entry',
    label: 'Queue: new items',
    group: 'Workflow',
    description:
      'A queue you subscribe to gained items — the newest ones, linked. Sample = the queue; the items shown are its current newest.',
    template: 'queue_entry',
    category: 'workflow',
    sample: { kind: 'record', collection: 'nivaro_queues' },
    samples: async (q) => {
      let qb = db('nivaro_queues').orderBy('name').limit(40).select('id', 'name')
      if (q.trim()) qb = qb.where('name', 'like', `%${q.trim()}%`)
      const rows = (await qb) as Array<{ id: string; name: string }>
      return rows.map((r) => ({ id: String(r.id), label: r.name }))
    },
    render: async (id, { recipientUserId }) => {
      const { buildQueueEntryMail } = await B()
      const queue = (await db('nivaro_queues').where({ id }).first('id', 'name', 'owner')) as
        | { id: string; name: string; owner: string }
        | undefined
      if (!queue) throw new Error('Queue not found')
      const { fetchQueueItems } = await import('./queues.js')
      const owner = (await db('nivaro_users').where({ id: queue.owner }).first()) as
        | Record<string, unknown>
        | undefined
      const { items } = await fetchQueueItems(queue.id, owner as never, 'all', {
        page: 1,
        limit: 5
      } as never)
      const b = buildQueueEntryMail({
        queueId: queue.id,
        queueName: queue.name,
        items: items.map((i) => ({ label: i.label, collection: i.collection, item_id: i.item_id }))
      })
      const subs = (await db('nivaro_notification_subscriptions as s')
        .join('nivaro_users as u', 'u.id', 's.user')
        .where('s.queue_id', queue.id)
        .where('s.is_active', 1)
        .select('u.email')) as Array<{ email: string }>
      return {
        ...(await renderBuilt(b, await firstName(recipientUserId))),
        recipients: subs.map((s) => ({ email: s.email, reason: 'queue subscriber' })),
        category: 'workflow'
      }
    }
  })

  registerMailType({
    key: 'line_sla',
    label: 'Lines missing a required id (line SLA)',
    group: 'Alerts & monitoring',
    description:
      "Daily reminder to a record's owners while grid lines still lack a required field past the configured days.",
    template: 'line_sla',
    category: 'sla',
    sample: { kind: 'none' },
    samples: async () => [],
    render: async (_id, { recipientUserId }) => {
      const { scanLineSla } = await import('./line-sla.js')
      const { buildLineSlaMail } = await B()
      const findings = await scanLineSla()
      const f = findings[0]
      if (!f) throw new Error('No line-SLA findings right now (or no grid has line_sla enabled)')
      const subject = `${f.friendlyId}: ${f.count} ${f.count === 1 ? 'line is' : 'lines are'} missing a ${f.label} (${f.days}d)`
      const b = await buildLineSlaMail({ ...f, subject })
      const recipients: MailRendered['recipients'] = []
      for (const uid of f.ownerIds ?? []) recipients.push(...(await emailOf(uid, 'record owner')))
      return {
        ...(await renderBuilt(b, await firstName(recipientUserId))),
        recipients,
        category: 'sla'
      }
    }
  })

  // Generic notification emails — everything still routed through the plain
  // `notification` template, sampled from real inbox rows of that category so
  // each one is previewable exactly as it went out.
  const generic: Array<{
    key: string
    label: string
    group: string
    category: NotifyCategory
    description: string
  }> = [
    {
      key: 'notification_workflow',
      label: 'Other workflow notices (generic template)',
      group: 'Workflow',
      category: 'workflow',
      description:
        'NOT the state-change email — every other workflow-category inbox notice (owner added, task assigned, approval chain, queue entry, PO received…) that still goes out on the plain notification template. Each gets its own template in a later pass.'
    },
    {
      key: 'notification_alerts',
      label: 'Alert',
      group: 'Alerts & monitoring',
      category: 'alerts',
      description: 'Metric alert rules, per-record alert definitions, report alerts.'
    },
    {
      key: 'notification_anomaly',
      label: 'Anomaly detected',
      group: 'Alerts & monitoring',
      category: 'anomaly',
      description: 'Anomaly detection rules.'
    },
    {
      key: 'notification_sla',
      label: 'SLA escalation',
      group: 'Alerts & monitoring',
      category: 'sla',
      description: 'SLA breach ladders and line-SLA reminders.'
    },
    {
      key: 'notification_mentions',
      label: 'Mention / chat',
      group: 'People',
      category: 'mentions',
      description: '@mentions in comments and chat, @channel.'
    },
    {
      key: 'notification_reports',
      label: 'Report ready',
      group: 'Digests',
      category: 'reports',
      description: 'Report Studio / scheduled report / export ready notices.'
    },
    {
      key: 'notification_system',
      label: 'System notice',
      group: 'System',
      category: 'system',
      description:
        'Sign-in alerts, access requests, edit locks, data-integrity, monitors, flow failures.'
    }
  ]
  for (const g of generic) {
    registerMailType({
      key: g.key,
      label: g.label,
      group: g.group,
      description: g.description,
      template: 'notification',
      category: g.category,
      sample: { kind: 'notification', notification_category: g.category },
      samples: (q) => notificationSamples(q, g.category),
      render: async (id) => {
        const n = (await db('nivaro_notifications as n')
          .leftJoin('nivaro_users as u', 'u.id', 'n.recipient')
          .where('n.id', Number(id))
          .first('n.subject', 'n.message', 'n.collection', 'n.item', 'u.email', 'u.first_name')) as
          | {
              subject: string
              message: string | null
              collection: string | null
              item: string | null
              email: string | null
              first_name: string | null
            }
          | undefined
        if (!n) throw new Error('Notification not found')
        const base = adminBaseUrl() ?? ''
        const html = await renderMailTemplate('notification', {
          first_name: n.first_name,
          message: n.message ?? '',
          ...(n.collection && n.item
            ? {
                action_url: `${base}/collections/${n.collection}/${n.item}`,
                action_label: 'View item'
              }
            : {})
        })
        return {
          subject: n.subject,
          html,
          recipients: n.email ? [{ email: n.email, reason: 'notification recipient' }] : [],
          category: g.category
        }
      }
    })
  }
}

async function firstName(userId?: string): Promise<string | null> {
  if (!userId) return null
  const u = (await db('nivaro_users').where({ id: userId }).first('first_name')) as
    | { first_name: string | null }
    | undefined
  return u?.first_name ?? null
}

async function activitySamples(q: string): Promise<MailSampleOption[]> {
  let qb = db('nivaro_activity as a')
    .leftJoin('nivaro_users as u', 'u.id', 'a.user')
    .whereIn('a.action', ['create', 'update', 'delete'])
    .whereNot('a.collection', 'like', 'nivaro%')
    .whereNot('a.collection', 'like', 'directus%')
    .whereNot('a.collection', 'like', 'chat%')
    .whereNot('a.collection', 'user_presence')
    .orderBy('a.id', 'desc')
    .limit(30)
    .select(
      'a.id',
      'a.action',
      'a.collection',
      'a.item',
      'a.timestamp',
      'u.first_name',
      'u.last_name',
      'u.email'
    )
  if (q.trim())
    qb = qb.where((b) =>
      b.where('a.collection', 'like', `%${q.trim()}%`).orWhere('a.item', 'like', `%${q.trim()}%`)
    )
  const rows = (await qb) as Array<{
    id: number
    action: string
    collection: string
    item: string
    timestamp: Date
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  const byCol = new Map<string, Set<string>>()
  for (const r of rows) {
    const set = byCol.get(r.collection) ?? new Set<string>()
    set.add(String(r.item))
    byCol.set(r.collection, set)
  }
  const labels = await getLabels(byCol).catch(() => ({}) as Record<string, string>)
  return rows.map((r) => ({
    id: String(r.id),
    label: `${r.collection.replace(/_/g, ' ')} · ${labels[`${r.collection}:${r.item}`] || r.item} — ${r.action}d`,
    hint: `${userName(r) || 'system'} · ${new Date(r.timestamp).toLocaleString('en-US')}`
  }))
}

function transitionRecipients(
  payload: Record<string, unknown>,
  creatorOnly = false
): MailRendered['recipients'] {
  const out: MailRendered['recipients'] = []
  const seen = new Set<string>()
  const push = (email: unknown, reason: string) => {
    if (typeof email !== 'string' || !email.includes('@')) return
    const e = email.trim().toLowerCase()
    if (seen.has(e)) return
    seen.add(e)
    out.push({ email: e, reason })
  }
  if (!creatorOnly)
    for (const o of (payload.owners as Array<{
      email?: string
      first_name?: string | null
      last_name?: string | null
    }>) ?? [])
      push(
        o.email,
        `owner of ${(payload.to_state as { label?: string } | null)?.label ?? 'the new state'}`
      )
  const rec = payload.record as Record<string, unknown> | undefined
  const creator = (rec?.creator ?? rec?.user_created) as { email?: string } | undefined
  if (creator?.email) push(creator.email, 'creator')
  const contact = rec?.additional_contact as { email?: string } | undefined
  if (contact?.email) push(contact.email, 'additional contact')
  return out
}

async function watcherRecipients(
  collection: string,
  item: string
): Promise<MailRendered['recipients']> {
  const rows = (await db('nivaro_notification_subscriptions as s')
    .join('nivaro_users as u', 'u.id', 's.user')
    .where('s.collection', collection)
    .where('s.is_active', 1)
    .where((b) =>
      b
        .where({ 's.filter_field': 'id', 's.filter_value': String(item) })
        .orWhere('s.filters', 'like', `%"value":"${item}"%`)
        .orWhere('s.filters', 'like', `%"value":${item}%`)
    )
    .select('u.email')) as Array<{ email: string }>
  return rows.map((r) => ({ email: r.email, reason: 'watches this record' }))
}

async function collectionSubscriberRecipients(
  collection: string
): Promise<MailRendered['recipients']> {
  const rows = (await db('nivaro_notification_subscriptions as s')
    .join('nivaro_users as u', 'u.id', 's.user')
    .where('s.collection', collection)
    .where('s.is_active', 1)
    .whereNull('s.filter_field')
    .whereNull('s.filters')
    .select('u.email')) as Array<{ email: string }>
  return rows.map((r) => ({
    email: r.email,
    reason: `subscribed to ${collection.replace(/_/g, ' ')}`
  }))
}

// ── send from the harness ────────────────────────────────────────────────────

export async function sendRenderedMail(
  rendered: MailRendered,
  to: string[],
  opts: { collection?: string; item?: string } = {}
): Promise<void> {
  for (const addr of to) {
    await sendRawMail({
      to: addr,
      subject: rendered.subject,
      html: rendered.html,
      wrap: false,
      skipDigest: true,
      ...(rendered.category ? { category: rendered.category } : {}),
      ...(opts.collection ? { collection: opts.collection } : {}),
      ...(opts.item ? { item: opts.item } : {})
    })
  }
}

// Keep sendMail referenced for types that prefer template-by-name sends.
export const _sendMail = sendMail
