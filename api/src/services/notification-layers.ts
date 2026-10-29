import type { NotifyCategory } from '@nivaro/extension-kit'

/**
 * Notification rules come in three layers (#3077):
 *
 *   person  — the person's own Profile → Notification rules (preferences.notification_prefs)
 *   role    — their CURRENT role's defaults (nivaro_role_notification_defaults.rules)
 *   system  — the built-in behaviour when neither says anything (in-app + push on,
 *             email instant, Teams off, no quiet hours, no escalation)
 *
 * Merged value by value: a person who set "push off for Workflow" keeps it whatever their role
 * says; everything they never set follows the role. Nothing is ever copied onto the person, so a
 * role change brings the new role's defaults on the next decision. This module is a leaf (no db,
 * no imports from notification-channels) so the merge is unit-testable and shared by every
 * reader.
 */

export type RuleLayer = 'person' | 'role' | 'system'

export const NOTIFY_CATEGORIES: NotifyCategory[] = [
  'mentions',
  'workflow',
  'sla',
  'watch',
  'alerts',
  'audit',
  'anomaly',
  'reports',
  'integrations',
  'system',
  'huddle',
  'chaos',
  'other'
]

export type EmailMode = 'instant' | 'daily' | 'off'

export interface MatrixRow {
  inapp?: boolean
  push?: boolean
  /** Teams 1:1 message. Opt-in: absent = off (unlike push). */
  teams?: boolean
  email?: EmailMode
  quiet_override?: boolean
}

export interface EscalationRule {
  /** Minutes unread before the push step; 0 = explicitly never. */
  push_after_min?: number
  email_after_min?: number
}

/** The rules shape a person stores and a role default stores — the SAME shape. */
export interface NotifyRules {
  /** '' = explicitly no quiet hours (a person opting out of their role's). */
  quiet_start?: string
  quiet_end?: string
  /** Teams only: set by the bot's `mute 1h`. Person layer only. */
  teams_muted_until?: string
  matrix?: Partial<Record<NotifyCategory, MatrixRow>>
  escalation?: Partial<Record<NotifyCategory, EscalationRule>>
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const MATRIX_KEYS = ['inapp', 'push', 'teams', 'email', 'quiet_override'] as const
const ESCALATION_STEPS = ['push_after_min', 'email_after_min'] as const

/**
 * The one sanitizer for stored rules (person and role). Keeps ABSENCE: only values actually
 * given are written, so an untouched value keeps following the layer below. `''` quiet hours
 * and `0` escalation minutes are explicit "none" values a person can set over a role default.
 */
export function sanitizeNotifyRules(
  raw: unknown,
  opts: { allowTeamsMute?: boolean } = {}
): NotifyRules {
  const np = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  const out: NotifyRules = {}
  for (const k of ['quiet_start', 'quiet_end'] as const) {
    const v = np[k]
    if (typeof v === 'string' && (v === '' || TIME.test(v))) out[k] = v
  }
  if (
    opts.allowTeamsMute !== false &&
    typeof np.teams_muted_until === 'string' &&
    !Number.isNaN(Date.parse(np.teams_muted_until))
  )
    out.teams_muted_until = np.teams_muted_until
  if (np.matrix && typeof np.matrix === 'object') {
    const m: NonNullable<NotifyRules['matrix']> = {}
    for (const cat of NOTIFY_CATEGORIES) {
      const row = (np.matrix as Record<string, unknown>)[cat] as Record<string, unknown> | undefined
      if (!row || typeof row !== 'object') continue
      const clean: MatrixRow = {}
      if (typeof row.inapp === 'boolean') clean.inapp = row.inapp
      if (typeof row.push === 'boolean') clean.push = row.push
      if (typeof row.teams === 'boolean') clean.teams = row.teams
      if (row.email === 'instant' || row.email === 'daily' || row.email === 'off')
        clean.email = row.email
      if (typeof row.quiet_override === 'boolean') clean.quiet_override = row.quiet_override
      if (Object.keys(clean).length) m[cat] = clean
    }
    out.matrix = m
  }
  if (np.escalation && typeof np.escalation === 'object') {
    const esc: NonNullable<NotifyRules['escalation']> = {}
    const minutes = (v: unknown) => {
      if (v === 0) return 0
      const n = Number(v)
      return v != null && v !== '' && Number.isFinite(n) && n >= 5 && n <= 10_080
        ? Math.round(n)
        : undefined
    }
    for (const cat of NOTIFY_CATEGORIES) {
      const row = (np.escalation as Record<string, unknown>)[cat]
      if (!row || typeof row !== 'object') continue
      const clean: EscalationRule = {}
      for (const step of ESCALATION_STEPS) {
        const v = minutes((row as Record<string, unknown>)[step])
        if (v !== undefined) clean[step] = v
      }
      if (Object.keys(clean).length) esc[cat] = clean
    }
    out.escalation = esc
  }
  return out
}

export interface LayeredRules {
  /** What every reader judges by — person over role over nothing. */
  merged: NotifyRules
  own: NotifyRules | null
  role: { id: string; name: string | null; rules: NotifyRules } | null
}

const hasQuiet = (r: NotifyRules | null | undefined) =>
  !!r && (r.quiet_start !== undefined || r.quiet_end !== undefined)

/** Merge a person's own rules over their role's defaults, value by value. */
export function mergeNotifyRules(
  own: NotifyRules | null | undefined,
  role: NotifyRules | null | undefined
): NotifyRules {
  const out: NotifyRules = {}
  // Quiet hours are one window: whichever layer set either end owns both.
  const quietFrom = hasQuiet(own) ? own : hasQuiet(role) ? role : null
  if (quietFrom?.quiet_start !== undefined) out.quiet_start = quietFrom.quiet_start
  if (quietFrom?.quiet_end !== undefined) out.quiet_end = quietFrom.quiet_end
  if (own?.teams_muted_until) out.teams_muted_until = own.teams_muted_until
  const cats = new Set<NotifyCategory>([
    ...(Object.keys(role?.matrix ?? {}) as NotifyCategory[]),
    ...(Object.keys(own?.matrix ?? {}) as NotifyCategory[])
  ])
  if (own?.matrix || role?.matrix) {
    const m: NonNullable<NotifyRules['matrix']> = {}
    for (const cat of cats) {
      const row: MatrixRow = {}
      for (const k of MATRIX_KEYS) {
        const v = own?.matrix?.[cat]?.[k] ?? role?.matrix?.[cat]?.[k]
        if (v !== undefined) (row as Record<string, unknown>)[k] = v
      }
      if (Object.keys(row).length) m[cat] = row
    }
    out.matrix = m
  }
  const escCats = new Set<NotifyCategory>([
    ...(Object.keys(role?.escalation ?? {}) as NotifyCategory[]),
    ...(Object.keys(own?.escalation ?? {}) as NotifyCategory[])
  ])
  if (own?.escalation || role?.escalation) {
    const esc: NonNullable<NotifyRules['escalation']> = {}
    for (const cat of escCats) {
      const rule: EscalationRule = {}
      for (const step of ESCALATION_STEPS) {
        const v = own?.escalation?.[cat]?.[step] ?? role?.escalation?.[cat]?.[step]
        if (v !== undefined) rule[step] = v
      }
      if (Object.keys(rule).length) esc[cat] = rule
    }
    out.escalation = esc
  }
  return out
}

/** A value path in the rules: `quiet`, `matrix.<cat>.<key>`, `escalation.<cat>.<step>`. */
export type RulePath =
  | 'quiet'
  | `matrix.${string}.${(typeof MATRIX_KEYS)[number]}`
  | `escalation.${string}.${(typeof ESCALATION_STEPS)[number]}`

/** Which layer supplies one value. */
export function layerOf(
  own: NotifyRules | null | undefined,
  role: NotifyRules | null | undefined,
  path: RulePath
): RuleLayer {
  if (path === 'quiet') return hasQuiet(own) ? 'person' : hasQuiet(role) ? 'role' : 'system'
  const [group, cat, key] = path.split('.') as [string, NotifyCategory, string]
  const pick = (r: NotifyRules | null | undefined) =>
    group === 'matrix'
      ? (r?.matrix?.[cat] as Record<string, unknown> | undefined)?.[key]
      : (r?.escalation?.[cat] as Record<string, unknown> | undefined)?.[key]
  if (pick(own) !== undefined) return 'person'
  if (pick(role) !== undefined) return 'role'
  return 'system'
}

/**
 * Where the email mode for a category comes from. The person's legacy account-wide
 * `email_digest: 'daily'` is a person-level choice and beats a role default; 'instant' is the
 * system default anyway, so it never shadows the role.
 */
export function emailLayerOf(
  own: NotifyRules | null | undefined,
  role: NotifyRules | null | undefined,
  category: NotifyCategory,
  legacyEmailDigest: unknown
): RuleLayer {
  if (own?.matrix?.[category]?.email !== undefined) return 'person'
  if (legacyEmailDigest === 'daily') return 'person'
  if (role?.matrix?.[category]?.email !== undefined) return 'role'
  return 'system'
}

/** The merged rules with the legacy daily default folded in where the person outranks the role. */
export function effectiveRules(
  own: NotifyRules | null | undefined,
  role: NotifyRules | null | undefined,
  legacyEmailDigest: unknown
): NotifyRules {
  const merged = mergeNotifyRules(own, role)
  if (legacyEmailDigest !== 'daily' || !role?.matrix) return merged
  // A category whose email only the ROLE set: the person's account-wide daily choice wins.
  const m = { ...(merged.matrix ?? {}) }
  for (const cat of Object.keys(role.matrix) as NotifyCategory[]) {
    if (own?.matrix?.[cat]?.email !== undefined) continue
    if (role.matrix[cat]?.email === undefined) continue
    m[cat] = { ...(m[cat] ?? {}), email: 'daily' }
  }
  return { ...merged, matrix: m }
}

export const RULE_LAYER_LABELS: Record<RuleLayer, string> = {
  person: 'Your own rules',
  role: 'Role default',
  system: 'System default'
}
