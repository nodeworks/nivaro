import type { NotifyCategory } from '@nivaro/extension-kit'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { DecisionLayers, DeliveryDecision } from './notification-channels.js'
import type { RuleLayer } from './notification-layers.js'

/**
 * "Why did I get this?" (#3078, migration 514). Stored on nivaro_notifications.delivery_reason
 * when the row is written, so the answer is what happened — never a re-simulation:
 *
 *   path      — what sent it: {kind, text, label, id}. kind is the source the sender named
 *               (watch, subscription, task, flow…), else derived: mention, alert, owner (they
 *               own the record's current state), message (a person sent it), role_default (the
 *               role's rules turned the category on), rules (their own / the system's rules).
 *   rules     — the rules that picked or held each channel (category rule, quiet hours,
 *               critical bypass…), each with the layer it came from.
 *   layers    — per channel, the layer that decided it (person / role / system, #3077).
 *   escalation— unread-escalation steps the cron fired later (channel, after_min, layer, at).
 *
 * Bounded: the same short texts decideDelivery writes, at most 20 rules. Leaf module: only
 * TYPE imports from notification-channels.
 */

export interface ReasonPath {
  kind: string
  text: string
  label: string | null
  id: string | number | null
}

export interface ReasonRule {
  code: string
  channel: 'all' | 'inapp' | 'push' | 'teams' | 'email' | 'sms'
  text: string
  layer: RuleLayer
}

export interface EscalationStepReason {
  channel: 'push' | 'email'
  after_min: number
  layer: RuleLayer
  at: string
}

export interface StoredDeliveryReason {
  v: 1
  path: ReasonPath
  category: NotifyCategory | string
  critical: boolean
  role: { id: string; name: string | null } | null
  layers: DecisionLayers | null
  channels: {
    inapp: boolean
    push: boolean
    teams: boolean
    email: DeliveryDecision['email'] | 'subscription'
  }
  rules: ReasonRule[]
  escalation?: EscalationStepReason[]
}

const clip = (v: unknown, n: number) => String(v ?? '').slice(0, n)

/** The path kind when the sender named none — from what is known about the row. */
export function derivePathKind(opts: {
  sourceKind?: string | null
  sender?: string | null
  category: string
  ownsRecord?: boolean
  inappLayer?: RuleLayer | null
}): string {
  if (opts.sourceKind) return opts.sourceKind
  if (opts.category === 'mentions') return 'mention'
  if (opts.sender) return 'message'
  if (opts.category === 'alerts' || opts.category === 'anomaly') return 'alert'
  if (opts.ownsRecord) return 'owner'
  if (opts.inappLayer === 'role') return 'role_default'
  return 'rules'
}

/** Build the stored reason from the decision notifyUser executed and the "why me" path. */
export function buildDeliveryReason(
  decision: DeliveryDecision,
  path: { kind: string; text: string; label?: string | null; id?: string | number | null }
): StoredDeliveryReason {
  return {
    v: 1,
    path: {
      kind: clip(path.kind, 40),
      text: clip(path.text, 300),
      label: path.label != null ? clip(path.label, 160) : null,
      id: path.id ?? null
    },
    category: decision.category,
    critical: decision.critical,
    role: decision.role ?? null,
    layers: decision.layers ?? null,
    channels: {
      inapp: decision.inapp,
      push: decision.push,
      teams: decision.teams,
      email: decision.email
    },
    rules: decision.reasons.slice(0, 20).map((r) => ({
      code: r.code,
      channel: r.channel,
      text: clip(r.text, 300),
      layer: r.layer ?? 'system'
    }))
  }
}

/**
 * The reason for a row a raw writer inserts (a subscription's own channels, the welcome row…):
 * no decideDelivery ran, so the subscription / writer is the rule.
 */
export function rawWriterReason(opts: {
  path: { kind: string; text: string; label?: string | null; id?: string | number | null }
  category: NotifyCategory | string
  ruleText: string
  layer?: RuleLayer
  email?: boolean
}): StoredDeliveryReason {
  return {
    v: 1,
    path: {
      kind: clip(opts.path.kind, 40),
      text: clip(opts.path.text, 300),
      label: opts.path.label != null ? clip(opts.path.label, 160) : null,
      id: opts.path.id ?? null
    },
    category: opts.category,
    critical: false,
    role: null,
    layers: null,
    channels: {
      inapp: true,
      push: false,
      teams: false,
      email: opts.email ? 'subscription' : 'not_requested'
    },
    rules: [
      {
        code: 'source_channels',
        channel: 'inapp',
        text: clip(opts.ruleText, 300),
        layer: opts.layer ?? 'person'
      }
    ]
  }
}

/** `{delivery_reason}` for an insert — empty on a database behind migration 514. */
export async function reasonColumn(
  reason: StoredDeliveryReason | null
): Promise<{ delivery_reason?: string }> {
  if (!reason) return {}
  try {
    if (!(await hasColumn('nivaro_notifications', 'delivery_reason'))) return {}
    return { delivery_reason: JSON.stringify(reason) }
  } catch {
    return {}
  }
}

export function parseDeliveryReason(raw: unknown): StoredDeliveryReason | null {
  if (!raw) return null
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!v || typeof v !== 'object' || (v as { v?: unknown }).v !== 1) return null
    const r = v as StoredDeliveryReason
    if (!r.path || typeof r.path.kind !== 'string') return null
    return { ...r, rules: Array.isArray(r.rules) ? r.rules : [] }
  } catch {
    return null
  }
}

/** The escalation cron records a step it fired on the row's stored reason. Never throws. */
export async function appendEscalationReason(
  notificationId: number,
  step: EscalationStepReason
): Promise<void> {
  try {
    if (!(await hasColumn('nivaro_notifications', 'delivery_reason'))) return
    const row = (await db('nivaro_notifications')
      .where({ id: notificationId })
      .first('delivery_reason')) as { delivery_reason?: string | null } | undefined
    const cur = parseDeliveryReason(row?.delivery_reason)
    if (!cur) return
    const steps = [...(cur.escalation ?? []), step].slice(-4)
    await db('nivaro_notifications')
      .where({ id: notificationId })
      .update({ delivery_reason: JSON.stringify({ ...cur, escalation: steps }) })
  } catch {
    // the reason is diagnostic — never a reason an escalation fails
  }
}
