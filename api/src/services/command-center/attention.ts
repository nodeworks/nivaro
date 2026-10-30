import type { FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { selectInChunks } from '../db-batch.js'
import { sharedGatedRead } from '../read-gate.js'
import { alertPrefillHref } from './alert-href.js'
import { ccIsAdmin } from './auth.js'
import { readCcConfig } from './config.js'
import { collectionLabels, viewerSlice } from './flow.js'
import { type OpenInstance, type OpenWorkIndex, openWorkFor } from './open-work.js'
import { readCcScope } from './scope.js'
import { tenantMemo, Viewer } from './work-access.js'
import { DAY_MS, rankAttention } from './work-math.js'

/**
 * CC-6 "Needs attention": one ranked list (severity, then oldest) of what needs a person now —
 *   sla_breached / sla_warning  open records past / near their SLA (the queue SLA evaluator)
 *   stuck                       records longer than stuck_days in one state, per state
 *   approval_blocked            approval steps whose every approver is away, or waiting too long
 *   alert                       alert-engine hits in the last 24 h
 *   integration (admin)         open Integrations-console problems
 *   coverage_gap (admin)        records nobody available owns (the coverage-gap report)
 * Every record-level item is a record the caller can open (row filter + User Scopes), inside the
 * focused region when one is set. Live only (rewind answers live with meta.live_only).
 *
 * Mirrors packages/shared/src/components/command-center/types.ts AttentionItem.
 */
export interface AttentionAction {
  kind: 'open' | 'nudge' | 'reassign' | 'transition' | 'alert' | 'approve'
  label: string
  href?: string
  target?: { collection: string; id: string; transition?: string; approval_id?: number }
  targets?: Array<{ collection: string; id: string }>
}

export interface AttentionItem {
  id: string
  kind:
    | 'sla_breached'
    | 'sla_warning'
    | 'stuck'
    | 'integration'
    | 'coverage_gap'
    | 'approval_blocked'
    | 'alert'
  severity: 'critical' | 'warning' | 'info'
  title: string
  detail: string | null
  count: number | null
  href: string | null
  record?: { collection: string; id: string } | null
  since?: string | null
  /** A list to open for a group: the collection filtered to a state (and minimum age). */
  list?: { collection: string; state?: string; min_age_hours?: number } | null
  actions: AttentionAction[]
}

export const RECORD_ITEMS_PER_KIND = 8
export const MAX_ITEMS = 40
export const MAX_REASSIGN = 50

const iso = (ms: number | null | undefined) =>
  ms != null && Number.isFinite(ms) ? new Date(ms).toISOString() : null
const U = (v: unknown) => String(v ?? '').toUpperCase()

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "3 days" / "5 hours" / "12 minutes" — a span in plain words. */
export function spanWords(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return plural(m, 'minute')
  const h = Math.round(m / 60)
  if (h < 48) return plural(h, 'hour')
  return plural(Math.round(h / 24), 'day')
}

async function recordLabels(user: User, keys: Array<{ collection: string; id: string }>) {
  const by = new Map<string, Set<string>>()
  for (const k of keys) by.set(k.collection, (by.get(k.collection) ?? new Set()).add(k.id))
  const out = new Map<string, string>()
  if (by.size === 0) return out
  try {
    // As the caller: a display template renders only fields the caller may read (a record they
    // cannot read at all has no label and falls back to its id).
    const { linkLabelsAsUser } = await import('../ai-link-labels.js')
    const labels = await linkLabelsAsUser(user, by)
    for (const [k, v] of Object.entries(labels)) out.set(U(k), v)
  } catch {
    /* labels fall back to the id */
  }
  return out
}

interface Ctx {
  user: User
  viewer: Viewer
  index: OpenWorkIndex
  stuckDays: number
  isAdmin: boolean
  userId: string
  collectionLabel: Map<string, string>
}

function recordActions(
  ctx: Ctx,
  collection: string,
  id: string,
  alert?: { name: string; category: 'sla' | 'workflow' }
): AttentionAction[] {
  const target = { collection, id }
  const out: AttentionAction[] = [
    { kind: 'open', label: 'Open', target },
    { kind: 'nudge', label: 'Nudge owners', target },
    { kind: 'transition', label: 'Move it', target }
  ]
  if (ctx.isAdmin && alert)
    out.push({
      kind: 'alert',
      label: 'Alert me',
      href: alertPrefillHref({ name: alert.name, collection, category: alert.category })
    })
  return out
}

/** SLA breached / warning records + stuck groups, from the open-work index. */
async function workItems(ctx: Ctx): Promise<AttentionItem[]> {
  const breached: OpenInstance[] = []
  const warning: OpenInstance[] = []
  const stuckByState = new Map<string, OpenInstance[]>()
  const stuckMs = ctx.stuckDays * DAY_MS
  for (const b of ctx.index.bindings) {
    const slice = await viewerSlice(ctx.viewer, ctx.index, b.collection, b.template)
    if (!slice) continue
    for (const o of slice.open) {
      if (o.sla === 'breached') breached.push(o)
      else if (o.sla === 'warning') warning.push(o)
      if (ctx.index.as_of - o.entered_at > stuckMs) {
        const k = `${o.collection}|${U(o.state_id)}`
        stuckByState.set(k, [...(stuckByState.get(k) ?? []), o])
      }
    }
  }
  const byRemaining = (a: OpenInstance, b: OpenInstance) =>
    (a.sla_remaining_h ?? 0) - (b.sla_remaining_h ?? 0)
  breached.sort(byRemaining)
  warning.sort(byRemaining)
  const shownBreached = breached.slice(0, RECORD_ITEMS_PER_KIND)
  const shownWarning = warning.slice(0, RECORD_ITEMS_PER_KIND)
  const oldestStuck = [...stuckByState.values()].map(
    (list) => list.reduce((a, b) => (b.entered_at < a.entered_at ? b : a)) as OpenInstance
  )
  const labels = await recordLabels(
    ctx.user,
    [...shownBreached, ...shownWarning, ...oldestStuck].map((o) => ({
      collection: o.collection,
      id: o.item
    }))
  )
  const labelOf = (o: OpenInstance) => labels.get(U(`${o.collection}:${o.item}`)) ?? `#${o.item}`
  const stateOf = (o: OpenInstance) => ctx.index.states.get(U(o.state_id))
  const collLabel = (c: string) => ctx.collectionLabel.get(c) ?? c

  const out: AttentionItem[] = []
  const slaItem = (o: OpenInstance, kind: 'sla_breached' | 'sla_warning'): AttentionItem => {
    const st = stateOf(o)
    const rem = o.sla_remaining_h ?? 0
    const when =
      kind === 'sla_breached'
        ? `past its deadline by ${spanWords(Math.abs(rem) * 3_600_000)}`
        : `deadline in ${spanWords(Math.max(0, rem) * 3_600_000)}`
    return {
      id: `${kind}:${o.collection}:${o.item}`,
      kind,
      severity: kind === 'sla_breached' ? 'critical' : 'warning',
      title: labelOf(o),
      detail: `${collLabel(o.collection)} · ${st?.label ?? 'In progress'} · ${when}`,
      count: null,
      href: null,
      record: { collection: o.collection, id: o.item },
      since: iso(o.entered_at),
      actions: recordActions(ctx, o.collection, o.item, {
        name: `${collLabel(o.collection)} past deadline`,
        category: 'sla'
      })
    }
  }
  for (const o of shownBreached) out.push(slaItem(o, 'sla_breached'))
  for (const o of shownWarning) out.push(slaItem(o, 'sla_warning'))
  // The rest, one line per collection, so nothing is silently dropped.
  for (const [kind, all, shown] of [
    ['sla_breached', breached, shownBreached],
    ['sla_warning', warning, shownWarning]
  ] as const) {
    const shownIds = new Set(shown.map((o) => `${o.collection}|${U(o.item)}`))
    const rest = new Map<string, OpenInstance[]>()
    for (const o of all)
      if (!shownIds.has(`${o.collection}|${U(o.item)}`))
        rest.set(o.collection, [...(rest.get(o.collection) ?? []), o])
    for (const [collection, list] of rest) {
      const oldest = Math.min(...list.map((o) => o.entered_at))
      out.push({
        id: `${kind}-more:${collection}`,
        kind,
        severity: kind === 'sla_breached' ? 'critical' : 'warning',
        title: `${plural(list.length, 'more record')} ${
          kind === 'sla_breached' ? 'past their deadline' : 'near their deadline'
        }`,
        detail: collLabel(collection),
        count: list.length,
        href: null,
        record: null,
        since: iso(oldest),
        list: { collection },
        actions: [{ kind: 'open', label: 'Open list' }]
      })
    }
  }
  for (const [, list] of stuckByState) {
    const oldest = list.reduce((a, b) => (b.entered_at < a.entered_at ? b : a))
    const st = stateOf(oldest)
    const days = Math.floor((ctx.index.as_of - oldest.entered_at) / DAY_MS)
    const targets = [...list]
      .sort((a, b) => a.entered_at - b.entered_at)
      .slice(0, MAX_REASSIGN)
      .map((o) => ({ collection: o.collection, id: o.item }))
    const actions: AttentionAction[] = [
      { kind: 'open', label: 'Open list' },
      { kind: 'reassign', label: 'Reassign', targets },
      {
        kind: 'nudge',
        label: 'Nudge oldest',
        target: { collection: oldest.collection, id: oldest.item }
      }
    ]
    if (ctx.isAdmin)
      actions.push({
        kind: 'alert',
        label: 'Alert me',
        href: alertPrefillHref({
          name: `${collLabel(oldest.collection)} stuck in ${st?.label ?? 'a state'}`,
          collection: oldest.collection,
          category: 'workflow'
        })
      })
    out.push({
      id: `stuck:${oldest.collection}:${st?.key ?? oldest.state_id}`,
      kind: 'stuck',
      severity: 'warning',
      title: `${plural(list.length, 'record')} stuck in ${st?.label ?? 'one state'}`,
      detail: `${collLabel(oldest.collection)} · oldest ${plural(days, 'day')}: ${labelOf(oldest)}`,
      count: list.length,
      href: null,
      record: { collection: oldest.collection, id: oldest.item },
      since: iso(oldest.entered_at),
      list: {
        collection: oldest.collection,
        state: st?.key,
        min_age_hours: ctx.stuckDays * 24
      },
      actions
    })
  }
  return out
}

/** Pending approval steps every approver of which is away, or that waited past stuck_days. */
async function approvalItems(ctx: Ctx): Promise<AttentionItem[]> {
  const pending = (await db('nivaro_approval_instances as i')
    .join('nivaro_approval_chains as ch', 'i.chain', 'ch.id')
    .where('i.status', 'pending')
    .orderBy('i.created_at', 'asc')
    .limit(2000)
    .select(
      'i.id',
      'i.chain',
      'i.collection',
      'i.item',
      'i.current_step',
      'i.created_at',
      'ch.name'
    )
    .catch(() => [])) as Array<{
    id: number
    chain: number
    collection: string
    item: string
    current_step: number
    created_at: Date
    name: string
  }>
  if (pending.length === 0) return []
  const byCollection = new Map<string, typeof pending>()
  for (const p of pending)
    byCollection.set(p.collection, [...(byCollection.get(p.collection) ?? []), p])
  const visible: typeof pending = []
  for (const [collection, list] of byCollection)
    visible.push(...(await ctx.viewer.filter(collection, list, (p) => String(p.item))))
  if (visible.length === 0) return []

  const chains = [...new Set(visible.map((p) => p.chain))]
  const steps = (await db('nivaro_approval_chain_steps')
    .whereIn('chain', chains)
    .select('id', 'chain', 'step_order', 'approver', 'approver_role', 'label')) as Array<{
    id: number
    chain: number
    step_order: number
    approver: string | null
    approver_role: string | null
    label: string | null
  }>
  const { resolveStepApprovers } = await import('../../routes/approvals.js')
  const approversByStep = new Map<number, string[]>()
  for (const s of steps) approversByStep.set(s.id, await resolveStepApprovers(s).catch(() => []))
  const everyone = [...new Set([...approversByStep.values()].flat().map(U))]
  const users = (await selectInChunks(everyone, 2000, (chunk) =>
    db('nivaro_users')
      .whereIn('id', chunk)
      .select(
        'id',
        'status',
        'is_redacted',
        'is_out_of_office',
        'delegate_id',
        'delegate_expires_at'
      )
  )) as Array<Record<string, unknown>>
  const now = Date.now()
  const available = new Set(
    users
      .filter((u) => {
        if (u.is_redacted === true || u.is_redacted === 1) return false
        if (u.status != null && u.status !== 'active') return false
        const out = u.is_out_of_office === true || u.is_out_of_office === 1
        if (!out) return true
        const exp = u.delegate_expires_at ? new Date(u.delegate_expires_at as Date).getTime() : null
        return !!u.delegate_id && (exp == null || exp > now)
      })
      .map((u) => U(u.id))
  )
  const waitMs = ctx.stuckDays * DAY_MS
  const blocked: Array<{
    p: (typeof visible)[number]
    reason: 'away' | 'waiting'
    mine: boolean
    step: string
  }> = []
  for (const p of visible) {
    const step = steps.find((s) => s.chain === p.chain && s.step_order === p.current_step)
    if (!step) continue
    const approvers = (approversByStep.get(step.id) ?? []).map(U)
    const away = approvers.length === 0 || approvers.every((a) => !available.has(a))
    const waiting = now - new Date(p.created_at).getTime() > waitMs
    if (!away && !waiting) continue
    blocked.push({
      p,
      reason: away ? 'away' : 'waiting',
      mine: approvers.includes(U(ctx.userId)),
      step: step.label || `Step ${step.step_order + 1}`
    })
  }
  const shown = blocked.slice(0, RECORD_ITEMS_PER_KIND * 2)
  const labels = await recordLabels(
    ctx.user,
    shown.map((b) => ({ collection: b.p.collection, id: String(b.p.item) }))
  )
  return shown.map(({ p, reason, mine, step }) => {
    const target = { collection: p.collection, id: String(p.item) }
    const actions: AttentionAction[] = [{ kind: 'open', label: 'Open', target }]
    if (mine || ctx.isAdmin)
      actions.push({ kind: 'approve', label: 'Approve', target: { ...target, approval_id: p.id } })
    actions.push({ kind: 'nudge', label: 'Nudge owners', target })
    return {
      id: `approval:${p.id}`,
      kind: 'approval_blocked' as const,
      severity: reason === 'away' ? ('critical' as const) : ('warning' as const),
      title: labels.get(U(`${p.collection}:${p.item}`)) ?? `#${p.item}`,
      detail: `${p.name} · ${step} · ${
        reason === 'away'
          ? 'everyone who can approve it is away'
          : `waiting ${spanWords(now - new Date(p.created_at).getTime())}`
      }`,
      count: null,
      href: null,
      record: target,
      since: iso(new Date(p.created_at).getTime()),
      actions
    }
  })
}

/** Alert-engine hits in the last 24 h: admins all; others the alerts they subscribe to. */
async function alertItems(ctx: Ctx): Promise<AttentionItem[]> {
  const since = new Date(Date.now() - DAY_MS)
  let q = db('nivaro_alert_log as l')
    .join('nivaro_alert_definitions as d', 'l.alert_definition', 'd.id')
    .where('l.triggered_at', '>=', since)
    .orderBy('l.triggered_at', 'desc')
    .limit(2000)
    .select('l.alert_definition', 'l.collection', 'l.item', 'l.triggered_at', 'd.name')
  if (!ctx.isAdmin)
    q = q.whereIn(
      'l.alert_definition',
      db('nivaro_alert_subscriptions').where('user', ctx.userId).select('alert_definition')
    )
  const rows = (await q.catch(() => [])) as Array<{
    alert_definition: number
    collection: string
    item: string
    triggered_at: Date
    name: string
  }>
  const byCollection = new Map<string, typeof rows>()
  for (const r of rows)
    byCollection.set(r.collection, [...(byCollection.get(r.collection) ?? []), r])
  const seen: typeof rows = []
  for (const [collection, list] of byCollection)
    seen.push(...(await ctx.viewer.filter(collection, list, (r) => String(r.item))))
  const byDef = new Map<number, typeof rows>()
  for (const r of seen) byDef.set(r.alert_definition, [...(byDef.get(r.alert_definition) ?? []), r])
  return [...byDef.entries()].map(([def, list]) => {
    const records = new Set(list.map((r) => `${r.collection}|${U(r.item)}`))
    const first = list[list.length - 1]
    const one =
      records.size === 1 ? { collection: list[0].collection, id: String(list[0].item) } : null
    return {
      id: `alert:${def}`,
      kind: 'alert' as const,
      severity: 'warning' as const,
      title: `${list[0].name} fired ${plural(list.length, 'time')}`,
      detail: `${plural(records.size, 'record')} in the last 24 hours`,
      count: list.length,
      href: ctx.isAdmin ? `/alerts/${def}` : null,
      record: one,
      since: iso(new Date(first.triggered_at).getTime()),
      actions: one
        ? [{ kind: 'open', label: 'Open', target: one }]
        : ctx.isAdmin
          ? [{ kind: 'open', label: 'Open alert', href: `/alerts/${def}` }]
          : []
    }
  })
}

/** Open Integrations-console problems per signal (admin). */
async function integrationItems(): Promise<AttentionItem[]> {
  const rows = (await db('nivaro_integration_signal_rows')
    .whereNull('cleared_at')
    .groupBy('signal')
    .select('signal')
    .count({ n: '*' })
    .min({ since: 'first_seen' })
    .catch(() => [])) as Array<{ signal: string; n: number | string; since: Date | null }>
  if (rows.length === 0) return []
  const { listIntegrationSignals } = await import('../integration-signals.js')
  const defs = new Map(listIntegrationSignals().map((d) => [d.id, d]))
  return rows.map((r) => {
    const def = defs.get(r.signal)
    const n = Number(r.n)
    return {
      id: `integration:${r.signal}`,
      kind: 'integration' as const,
      severity: def?.severity === 'critical' ? ('critical' as const) : ('warning' as const),
      title: def?.label ?? 'Integration problem',
      detail: plural(n, 'open problem'),
      count: n,
      href: '/integration-health',
      record: null,
      since: iso(r.since ? new Date(r.since).getTime() : null),
      actions: [{ kind: 'open', label: 'Open integrations', href: '/integration-health' }]
    }
  })
}

/** Records nobody available owns (admin). The report is heavy: shared, cached 5 minutes. */
async function coverageItems(): Promise<AttentionItem[]> {
  const report = await tenantMemo(
    'cc:coverage-gaps',
    5 * 60_000,
    async () => {
      const { buildCoverageGapReport } = await import('../coverage-gaps.js')
      return (
        await sharedGatedRead('cc:coverage-gaps', 'command-center', buildCoverageGapReport, {
          label: 'cc:coverage-gaps'
        })
      ).value
    },
    { waitMs: 1500 }
  ).catch(() => undefined)
  const blocked = report?.blocked ?? []
  if (blocked.length === 0) return []
  return [
    {
      id: 'coverage-gaps',
      kind: 'coverage_gap',
      severity: 'critical',
      title: `${plural(blocked.length, 'record')} nobody available can act on`,
      detail: 'Every owner is out, suspended or missing',
      count: blocked.length,
      href: '/coverage/gaps',
      record: null,
      since: null,
      actions: [{ kind: 'open', label: 'Open coverage gaps', href: '/coverage/gaps' }]
    }
  ]
}

export async function computeAttention(ctx: Ctx): Promise<AttentionItem[]> {
  const safe = <T>(p: Promise<T[]>) => p.catch(() => [] as T[])
  const parts = await Promise.all([
    safe(workItems(ctx)),
    safe(approvalItems(ctx)),
    safe(alertItems(ctx)),
    ctx.isAdmin ? safe(integrationItems()) : Promise.resolve([]),
    ctx.isAdmin ? safe(coverageItems()) : Promise.resolve([])
  ])
  return rankAttention(parts.flat()).slice(0, MAX_ITEMS)
}

/** GET /command-center/attention for one request. */
export async function attentionForRequest(
  req: FastifyRequest
): Promise<{ items: AttentionItem[]; live_only: boolean; region_applies: boolean | null }> {
  const scope = readCcScope(req.query)
  const viewer = new Viewer(req.user!, ccIsAdmin(req), scope.region)
  // Attention is about now: a rewound board still gets the live list, marked live_only.
  const { index } = await openWorkFor(null, String(req.user!.id))
  const cfg = await readCcConfig()
  if (!index) return { items: [], live_only: !!scope.at, region_applies: null }
  const items = await computeAttention({
    user: req.user!,
    viewer,
    index,
    stuckDays: cfg.stuck_days,
    isAdmin: ccIsAdmin(req),
    userId: String(req.user!.id),
    collectionLabel: await collectionLabels([...new Set(index.bindings.map((b) => b.collection))])
  })
  return {
    // A wallboard only shows the list: its rows carry no actions and no way into a record.
    items: req.ccKiosk
      ? items.map((i) => ({ ...i, href: null, record: null, list: null, actions: [] }))
      : items,
    live_only: !!scope.at,
    region_applies: scope.region ? viewer.regionApplied : null
  }
}
