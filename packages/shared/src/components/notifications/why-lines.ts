/**
 * "Why did I get this?" (#3078) — the stored reason (GET /notifications/:id/why) turned into
 * the lines the bell and the inbox show. Pure, so it is tested without React. Server shape:
 * api services/notification-reason.ts StoredDeliveryReason.
 */

export type WhyLayer = 'person' | 'role' | 'system'

export interface StoredWhyReason {
  v: 1
  path: { kind: string; text: string; label: string | null; id: string | number | null }
  category: string
  critical: boolean
  role: { id: string; name: string | null } | null
  layers: Record<'inapp' | 'push' | 'teams' | 'email' | 'quiet', WhyLayer> | null
  channels: { inapp: boolean; push: boolean; teams: boolean; email: string }
  rules: Array<{ code: string; channel: string; text: string; layer: WhyLayer }>
  escalation?: Array<{ channel: 'push' | 'email'; after_min: number; layer: WhyLayer; at: string }>
}

export const WHY_KIND_LABELS: Record<string, string> = {
  watch: 'Record watch',
  subscription: 'Subscription',
  rules: 'Your notification rules',
  role_default: 'Role default',
  owner: 'Owner of the state',
  message: 'Direct message',
  mention: '@mention',
  task: 'Task',
  approval: 'Approval',
  sla: 'SLA',
  flow: 'Flow',
  broadcast: 'Broadcast',
  alert: 'Alert subscription',
  welcome: 'Welcome'
}

export const WHY_LAYER_LABELS: Record<WhyLayer, string> = {
  person: 'your own rules',
  role: 'role default',
  system: 'system default'
}

export interface WhyLine {
  key: string
  label: string
  outcome: string
  rule: string | null
  /** Null = not a rules matter (the channel was not asked for). */
  layer: WhyLayer | null
}

const CHANNELS: Array<{ key: 'inapp' | 'push' | 'email' | 'teams'; label: string }> = [
  { key: 'inapp', label: 'In-app' },
  { key: 'push', label: 'Push' },
  { key: 'email', label: 'Email' },
  { key: 'teams', label: 'Teams' }
]

function emailOutcome(email: string): string {
  if (email === 'send' || email === 'subscription') return 'sent'
  if (email === 'deferred') return 'daily summary'
  if (email === 'not_requested') return 'not asked for'
  if (email === 'no_address') return 'no address on file'
  return 'not sent'
}

/** One line per channel (Teams only when Teams had something to say) + escalation steps. */
export function whyLines(reason: StoredWhyReason): WhyLine[] {
  const out: WhyLine[] = []
  for (const c of CHANNELS) {
    if (c.key === 'teams' && !reason.rules.some((r) => r.channel === 'teams')) continue
    const outcome =
      c.key === 'email'
        ? emailOutcome(reason.channels.email)
        : reason.channels[c.key]
          ? 'sent'
          : 'not sent'
    const rule =
      reason.rules.find((r) => r.channel === c.key) ?? reason.rules.find((r) => r.channel === 'all')
    out.push({
      key: c.key,
      label: c.label,
      outcome,
      rule: rule?.text ?? null,
      layer:
        outcome === 'not asked for' ? null : (rule?.layer ?? reason.layers?.[c.key] ?? 'system')
    })
  }
  for (const e of reason.escalation ?? []) {
    const after = e.after_min < 60 ? `${e.after_min} min` : `${Math.round(e.after_min / 6) / 10} h`
    out.push({
      key: `escalation-${e.channel}-${e.at}`,
      label: 'Escalation',
      outcome: `still unread after ${after} → ${e.channel}`,
      rule: null,
      layer: e.layer
    })
  }
  return out
}

/** Where "change it" goes: subscriptions for a watch/subscription/alert path, else the rules. */
export function whyChangeLinks(
  kind: string,
  paths: { subscriptionsPath?: string | null; rulesPath?: string | null }
): Array<{ to: string; label: string }> {
  const out: Array<{ to: string; label: string }> = []
  if (['watch', 'subscription', 'alert'].includes(kind) && paths.subscriptionsPath)
    out.push({ to: paths.subscriptionsPath, label: 'Manage your subscriptions' })
  if (paths.rulesPath) out.push({ to: paths.rulesPath, label: 'Change your notification rules' })
  return out
}
