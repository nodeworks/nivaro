import { db } from '../db/index.js'
import { appForUser } from './app-links.js'
import {
  decideDelivery,
  getNotifyPrefsLayered,
  NOTIFY_CATEGORIES,
  type NotifyCategory
} from './notification-channels.js'
import { RULE_LAYER_LABELS } from './notification-layers.js'
import {
  actionsFor,
  deriveTarget,
  normalizeTarget,
  resolveTargetUrl
} from './notification-target.js'

/**
 * "Which channels would fire for THIS person for THIS event, and why" — the same
 * decideDelivery() notifyUser executes, rendered instead of acted on. Nothing here sends.
 * The admin bench calls it for any person; Profile → "Test my rules" (#3078) calls it for the
 * signed-in person only (the route passes req.user.id, never a body id).
 */
export interface SimulateInput {
  subject?: string
  category?: string
  collection?: string | null
  item?: string | null
  channels?: { inapp?: boolean; email?: boolean; sms?: boolean }
  always_inbox?: boolean
  cadence?: 'sender'
  target?: unknown
  at?: string
}

export async function simulateDelivery(userId: string, b: SimulateInput) {
  const user = (await db('nivaro_users as u')
    .leftJoin('nivaro_roles as r', 'r.id', 'u.role')
    .where('u.id', userId)
    .first(
      'u.id',
      'u.email',
      'u.first_name',
      'u.last_name',
      'u.status',
      'u.is_redacted',
      'u.phone',
      'u.preferences',
      'r.name as role_name',
      'r.admin_access'
    )) as
    | {
        id: string
        email: string | null
        first_name: string | null
        last_name: string | null
        status: string | null
        is_redacted: boolean | number | null
        phone: string | null
        preferences: unknown
        role_name: string | null
        admin_access: boolean | number | null
      }
    | undefined
  if (!user) return null
  const subject = String(b.subject ?? 'Sample notification').slice(0, 255)
  const category = (NOTIFY_CATEGORIES as string[]).includes(String(b.category))
    ? (b.category as NotifyCategory)
    : undefined
  const at = b.at ? new Date(b.at) : new Date()
  const now = Number.isNaN(at.getTime()) ? new Date() : at
  const opts = {
    subject,
    category,
    collection: b.collection ?? undefined,
    item: b.item ?? undefined,
    channels: {
      inapp: b.channels?.inapp !== false,
      email: !!b.channels?.email,
      sms: !!b.channels?.sms
    },
    always_inbox: !!b.always_inbox,
    cadence: b.cadence === 'sender' ? ('sender' as const) : undefined
  }
  const decision = await decideDelivery(user.id, opts, now)
  const target =
    normalizeTarget(b.target) ??
    deriveTarget({ collection: b.collection ?? null, item: b.item ?? null, subject })
  const [portalUrl, adminUrl, preferredApp, layered] = await Promise.all([
    resolveTargetUrl(target, { app: 'portal' }).catch(() => null),
    resolveTargetUrl(target, { app: 'admin' }).catch(() => null),
    appForUser(user.id),
    getNotifyPrefsLayered(user.id)
  ])
  const prefs = layered.own || layered.role ? layered.merged : null
  let digestHour: number | null = null
  let timezone: string | null = null
  try {
    const p = typeof user.preferences === 'string' ? JSON.parse(user.preferences) : user.preferences
    const h = Number((p as { digest_hour?: unknown })?.digest_hour)
    digestHour = Number.isInteger(h) ? h : 7
    const tz = (p as { timezone?: unknown })?.timezone
    timezone = typeof tz === 'string' ? tz : null
  } catch {
    digestHour = 7
  }
  // Push needs a registered browser subscription to reach anyone at all.
  const pushSubs = Number(
    (
      (await db('nivaro_push_subscriptions')
        .where({ user: user.id })
        .count({ c: '*' })
        .first()
        .catch(() => ({ c: 0 }))) as { c?: number | string }
    )?.c ?? 0
  )
  const layers = decision.layers ?? null
  return {
    user: {
      id: user.id,
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email,
      email: user.email,
      phone: user.phone ? 'on file' : null,
      role: user.role_name,
      admin: !!user.admin_access,
      status: user.status,
      preferred_app: preferredApp,
      push_subscriptions: pushSubs,
      quiet_hours:
        prefs?.quiet_start && prefs?.quiet_end
          ? `${prefs.quiet_start}–${prefs.quiet_end} ET`
          : null,
      matrix_row: prefs?.matrix?.[decision.category] ?? null,
      // #3077 — the person's own row and their role's row, side by side.
      own_matrix_row: layered.own?.matrix?.[decision.category] ?? null,
      role_matrix_row: layered.role?.rules.matrix?.[decision.category] ?? null,
      role_defaults: layered.role ? { id: layered.role.id, name: layered.role.name } : null,
      digest_hour: digestHour,
      timezone
    },
    evaluated_at: now.toISOString(),
    decision,
    /** #3077 — per channel: which layer decided (person / role default / system default). */
    layers,
    layer_labels: RULE_LAYER_LABELS,
    target,
    actions: actionsFor(target),
    urls: { portal: portalUrl, admin: adminUrl, preferred: preferredApp }
  }
}
