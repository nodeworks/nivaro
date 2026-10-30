import { readableTitle } from '@nivaro/shared'
import { type ActivityFilters, cleanFilters, RANGE_LABELS, sameFilters } from './activity-search'

/**
 * The Audit report's words (admin pages/Reports.tsx): quick views → filters, the "Show reads"
 * switch, the one-line "what you are looking at" and the totals sentence. Pure — every name
 * comes in through the context the page builds (collection labels, the person's name), so the
 * page decides how things are read and these only put them into sentences.
 */

export const READ_ACTION = 'read'

/** The filters sent to the API: reads left out unless shown or asked for by name. */
export function effectiveFilters(f: ActivityFilters, showReads: boolean): ActivityFilters {
  const clean = cleanFilters(f)
  if (showReads || clean.actions?.includes(READ_ACTION)) return clean
  const excluded = new Set(clean.exclude_actions ?? [])
  excluded.add(READ_ACTION)
  return { ...clean, exclude_actions: [...excluded] }
}

/** A stored filter set (saved view, URL) → the page's filters + the reads switch. */
export function splitReads(f: ActivityFilters): { filters: ActivityFilters; showReads: boolean } {
  const clean = cleanFilters(f)
  const excluded = clean.exclude_actions ?? []
  if (!excluded.includes(READ_ACTION)) return { filters: clean, showReads: true }
  return {
    filters: cleanFilters({
      ...clean,
      exclude_actions: excluded.filter((a) => a !== READ_ACTION)
    }),
    showReads: false
  }
}

// ─── Quick views ────────────────────────────────────────────────────────────

/** Where access is decided: role, policy, scope and subtree-permission writes. */
export const PERMISSION_COLLECTIONS = [
  'nivaro_roles',
  'nivaro_policies',
  'nivaro_permissions',
  'nivaro_user_scopes',
  'nivaro_scope_dimensions',
  'nivaro_tree_permissions',
  'nivaro_role_checklists'
]

/** Import actions when the log has not told us its own yet. */
const IMPORT_ACTIONS_FALLBACK = [
  'import-complete',
  'import-failed',
  'import-queue',
  'import-rollback',
  'import-revert',
  'import-cancel'
]

export type AuditPresetId = 'last_7_days' | 'permissions' | 'deletes' | 'imports' | 'mine'

export interface AuditPreset {
  id: AuditPresetId
  label: string
  hint: string
}

export const AUDIT_PRESETS: AuditPreset[] = [
  { id: 'last_7_days', label: 'Last 7 days', hint: 'Everything except reads' },
  { id: 'permissions', label: 'Permission changes', hint: 'Roles, policies and scopes' },
  { id: 'deletes', label: 'Deletes', hint: 'Records removed, last 30 days' },
  { id: 'imports', label: 'Imports', hint: 'Import runs, last 30 days' },
  { id: 'mine', label: 'By me', hint: 'What you did, last 7 days' }
]

export interface PresetContext {
  /** The signed-in person's id (By me). */
  me: string | null
  /** Every action the log holds (GET /api/activity/actions). */
  actions?: string[] | null
}

/** A quick view's filters; null when it cannot apply (By me without a signed-in id). */
export function presetFilters(id: AuditPresetId, ctx: PresetContext): ActivityFilters | null {
  switch (id) {
    case 'last_7_days':
      return { range: 'last_7_days' }
    case 'permissions':
      return { collections: [...PERMISSION_COLLECTIONS], range: 'last_30_days' }
    case 'deletes':
      return { actions: ['delete'], range: 'last_30_days' }
    case 'imports': {
      const known = (ctx.actions ?? []).filter((a) => /^import[-_]/.test(a))
      return { actions: known.length ? known : [...IMPORT_ACTIONS_FALLBACK], range: 'last_30_days' }
    }
    case 'mine':
      return ctx.me ? { user: ctx.me, range: 'last_7_days' } : null
  }
}

/** The quick view these filters are exactly, else null. */
export function activePreset(f: ActivityFilters, ctx: PresetContext): AuditPresetId | null {
  for (const p of AUDIT_PRESETS) {
    const pf = presetFilters(p.id, ctx)
    if (pf && sameFilters(pf, f)) return p.id
  }
  return null
}

// ─── Words ──────────────────────────────────────────────────────────────────

const ACTION_NOUNS: Record<string, string> = {
  create: 'creates',
  update: 'updates',
  delete: 'deletes',
  transition: 'moves',
  'pipeline-transition': 'moves',
  read: 'reads',
  login: 'sign-ins',
  logout: 'sign-outs',
  export: 'exports',
  comment: 'comments'
}

/** One action as a noun, mid-sentence ("updates", "sign-ins", "import complete"); `n` 1 = singular. */
export function actionNoun(action: string, n?: number): string {
  const known = ACTION_NOUNS[action]
  if (known) return n === 1 ? known.replace(/s$/, '') : known
  const t = readableTitle(action)
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : action
}

/** "a", "a and b", "a, b and c". */
export function joinWords(list: string[]): string {
  if (list.length <= 1) return list[0] ?? ''
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

/** "Updates and deletes"; more than four kinds read as a count. */
export function actionsPhrase(actions: string[]): string {
  const nouns = [...new Set(actions.map((a) => actionNoun(a)))]
  if (nouns.length > 4) return `${nouns.length} kinds of activity`
  return cap(joinWords(nouns))
}

export interface DescribeContext {
  /** Collection key → its plural display name ("Workflows"). */
  collectionName: (collection: string) => string
  /** The filtered person's name, when known. */
  personName?: string | null
  /** The filtered person is the reader. */
  isMe?: boolean
  showReads: boolean
  /** A date (YYYY-MM-DD or ISO) as the reader reads it. */
  formatDay: (date: string) => string
}

/** The window in words ("last 7 days", "3 Oct 2026 to 10 Oct 2026", "any time"). */
export function windowPhrase(f: ActivityFilters, formatDay: (d: string) => string): string {
  if (f.range) {
    const l = RANGE_LABELS[f.range] ?? readableTitle(f.range)
    return l.charAt(0).toLowerCase() + l.slice(1)
  }
  if (f.from && f.to) return `${formatDay(f.from)} to ${formatDay(f.to)}`
  if (f.from) return `since ${formatDay(f.from)}`
  if (f.to) return `up to ${formatDay(f.to)}`
  return 'any time'
}

export function entriesText(n: number, format: (n: number) => string = String): string {
  return `${format(n)} ${n === 1 ? 'entry' : 'entries'}`
}

/**
 * What the page is showing, in one line:
 * "Updates and deletes in Workflows by Pat, last 7 days — 128 entries".
 */
export function describeFilters(
  f: ActivityFilters,
  ctx: DescribeContext,
  total?: number | null,
  format: (n: number) => string = String
): string {
  const clean = cleanFilters(f)
  const actions = clean.actions ?? []
  const excluded = [
    ...new Set([...(clean.exclude_actions ?? []), ...(ctx.showReads ? [] : [READ_ACTION])])
  ].filter((a) => !actions.includes(a))
  let head = actions.length ? actionsPhrase(actions) : 'All activity'
  if (!actions.length && excluded.length)
    head += ` except ${joinWords([...new Set(excluded.map((a) => actionNoun(a)))])}`
  const cols = clean.collections ?? []
  if (cols.length)
    head +=
      cols.length > 3
        ? ` in ${cols.length} collections`
        : ` in ${joinWords(cols.map(ctx.collectionName))}`
  if (clean.item) head += ` on record ${clean.item}`
  if (clean.user) head += ` by ${ctx.isMe ? 'you' : ctx.personName || 'one person'}`
  if (clean.q) head += ` mentioning “${clean.q}”`
  head += `, ${windowPhrase(clean, ctx.formatDay)}`
  if (total != null) head += ` — ${entriesText(total, format)}`
  return head
}

// ─── Totals in words ────────────────────────────────────────────────────────

export interface SummaryInput {
  total_events: number
  by_action: { action: string; count: number }[]
  by_collection: { collection: string; count: number }[]
  by_user: {
    user_id: string | null
    first_name: string | null
    last_name: string | null
    email: string | null
    count: number
  }[]
  largest_burst?: {
    group_key: string
    count: number
    action: string | null
    collection: string | null
  } | null
}

/** What wrote a burst, from its group key ("import_run:7" → "import"). */
export function burstKind(groupKey: string): string {
  const kind = groupKey.split(':')[0] ?? ''
  if (kind.startsWith('import')) return 'import'
  if (kind === 'flow_run' || kind === 'flow') return 'automation run'
  if (kind === 'cron') return 'scheduled job'
  if (kind === 'mcp') return 'assistant request'
  return 'bulk change'
}

/**
 * The totals as short phrases, most telling first:
 * ["128 entries by 6 people", "40 updates in one import", "most active: Workflows"].
 */
export function summaryPhrases(
  s: SummaryInput,
  ctx: { collectionName: (c: string) => string; format?: (n: number) => string }
): string[] {
  const fmt = ctx.format ?? String
  if (!s.total_events) return []
  const people = s.by_user.filter((u) => u.user_id != null).length
  const automated = s.by_user.some((u) => u.user_id == null && u.count > 0)
  let first = entriesText(s.total_events, fmt)
  if (people > 0)
    first += ` by ${fmt(people)} ${people === 1 ? 'person' : 'people'}${automated ? ' and automations' : ''}`
  else if (automated) first += ', all by automations'
  const out = [first]
  const b = s.largest_burst
  if (b && b.count > 1) {
    const what = b.action ? actionNoun(b.action) : 'entries'
    out.push(`${fmt(b.count)} ${what} in one ${burstKind(b.group_key)}`)
  }
  const top = s.by_collection[0]
  if (top && s.by_collection.length > 1)
    out.push(`most active: ${ctx.collectionName(top.collection)}`)
  else if (top) out.push(`all in ${ctx.collectionName(top.collection)}`)
  const person = s.by_user.find((u) => u.user_id != null)
  if (person && people > 1) {
    const name =
      [person.first_name, person.last_name].filter(Boolean).join(' ') || person.email || null
    if (name) out.push(`${name} did the most (${fmt(person.count)})`)
  }
  return out
}

/** "80 updates · 12 deletes · 9 creates" — the top kinds of action. */
export function actionBreakdown(
  s: Pick<SummaryInput, 'by_action'>,
  max = 4,
  format: (n: number) => string = String
): string {
  const rows = s.by_action.filter((a) => a.count > 0).slice(0, max)
  const rest = s.by_action.slice(max).reduce((n, a) => n + a.count, 0)
  const parts = rows.map((a) => `${format(a.count)} ${actionNoun(a.action, a.count)}`)
  if (rest > 0) parts.push(`${format(rest)} other`)
  return parts.join(' · ')
}
