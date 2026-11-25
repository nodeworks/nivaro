import { type ErrorDescription, isRawErrorText } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { hubError } from '../hub-api'

/**
 * Nivaro Hub — the Config tab (migration 575): promote an app's configuration from one of its
 * environments to another over their links. Types, query keys and fetchers for
 * /api/hub/config/groups, /api/hub/apps/:id/config-promotions and /api/hub/config-promotions/:id.
 * Values in a plan are capped and secret-masked by the app ('••••••').
 */

export type PromotionStatus =
  | 'planned'
  | 'applying'
  | 'applied'
  | 'failed'
  | 'stale'
  | 'superseded'
  | 'undoing'
  | 'undone'
  | 'interrupted'

export interface ConfigGroup {
  key: string
  label: string
  hint: string
  tables: string[]
}

export interface FieldChange {
  field: string
  current: unknown
  incoming: unknown
}

export interface RowChange {
  key: string
  op: 'insert' | 'update' | 'delete'
  label: string | null
  fields: FieldChange[]
}

export interface TableChange {
  table: string
  group: string | null
  inserts: number
  updates: number
  deletes: number
  unchanged: number
  more: number
  rows: RowChange[]
  dropped_columns: string[]
}

export interface PlanView {
  totals: { inserts: number; updates: number; deletes: number; tables: number }
  skipped_inactive_user: number
  tables: TableChange[]
  refused: Array<{ table: string; reason: string }>
  kept: Array<{ table: string; label: string; columns: string[] }>
  held: Array<{ table: string; key: string; label: string | null; reason: string }>
  switched_off: Array<{ table: string; key: string; label: string | null }>
  cascade: Array<{ table: string; child: string; column: string; action: string; rows: number }>
  over_cap: boolean
  cap: number
  warnings: string[]
  prod_only: { count: number; lines: string[]; refuse: boolean }
  /** Steps (or webhook flows) that need this environment's own values; their flows arrive off. */
  needs_setup?: Array<{ flow: string | null; step: string | null; reason: string }>
}

export interface ConfigPromotion {
  id: number
  app_id: number
  source_environment_id: number
  target_environment_id: number
  status: PromotionStatus
  groups: string[]
  tables: string[]
  deletes: boolean
  allow_cascade: boolean
  production: boolean
  plan_hash: string | null
  plan: PlanView | null
  result: {
    totals?: { inserted: number; updated: number; deleted: number }
    procedures?: { written: number; failed: string[] } | null
    needs_setup?: Array<{ flow: string | null; step: string | null; reason: string }>
    baseline?: 'moved' | 'unchanged'
  } | null
  pre_restore_id: number | null
  run_key: string | null
  /** Applied and the newest promotion that wrote to its target. */
  undo_ready: boolean
  undo_result: { totals?: { inserted: number; updated: number; deleted: number } } | null
  source_version: string | null
  target_version: string | null
  error: string | null
  planned_at: string | null
  applied_at: string | null
  undone_at: string | null
}

export interface UndoPreview {
  promotion: ConfigPromotion
  plan: PlanView
  plan_hash: string
}

export const configKeys = {
  groups: () => ['hub', 'config', 'groups'] as const,
  list: (appId: number) => ['hub', 'config', 'list', appId] as const,
  one: (id: number) => ['hub', 'config', 'one', id] as const
}

export function useConfigGroups() {
  return useQuery({
    queryKey: configKeys.groups(),
    queryFn: () =>
      api.get<{ data: ConfigGroup[] }>('/hub/config/groups').then((r) => r.data.data ?? []),
    staleTime: 10 * 60_000
  })
}

/** Refetched while one of them is being applied or undone. */
export function usePromotions(appId: number | null) {
  return useQuery({
    queryKey: configKeys.list(appId ?? 0),
    queryFn: () =>
      api
        .get<{ data: ConfigPromotion[] }>(`/hub/apps/${appId}/config-promotions`)
        .then((r) => r.data.data ?? []),
    enabled: appId != null,
    refetchInterval: (q) =>
      (q.state.data ?? []).some((p) => p.status === 'applying' || p.status === 'undoing')
        ? 3000
        : false
  })
}

export function usePromotion(id: number | null) {
  return useQuery({
    queryKey: configKeys.one(id ?? 0),
    queryFn: () =>
      api.get<{ data: ConfigPromotion }>(`/hub/config-promotions/${id}`).then((r) => r.data.data),
    enabled: id != null
  })
}

export const STATUS_LABEL: Record<PromotionStatus, string> = {
  planned: 'Planned',
  applying: 'Applying',
  applied: 'Applied',
  failed: 'Failed',
  stale: 'Needs a new plan',
  superseded: 'Replaced by a newer plan',
  undoing: 'Undoing',
  undone: 'Undone',
  interrupted: 'Interrupted'
}

export const STATUS_TONE: Record<PromotionStatus, string> = {
  planned:
    'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300',
  applying:
    'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300',
  applied:
    'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  failed:
    'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  stale:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
  superseded:
    'border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted dark:text-muted-foreground',
  undoing:
    'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300',
  undone:
    'border-slate-200 bg-slate-50 text-slate-700 dark:border-border dark:bg-muted dark:text-foreground',
  interrupted:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
}

/** The server's refusals in plain words; where its own sentence names the thing, it is the hint. */
const COPY: Record<string, { title: string; hint?: string; serverHint?: boolean }> = {
  STALE: {
    title: 'Configuration changed since the plan',
    hint: 'Something changed on one of the two environments. Nothing was written. Plan it again and review the new diff.'
  },
  PLAN_CHANGED: {
    title: 'This is not the plan you reviewed',
    hint: 'Reload the plan and review it again.'
  },
  PLAN_EXPIRED: {
    title: 'This plan is more than a day old',
    hint: 'Plan it again to see what it would change now.'
  },
  NOT_PLANNED: { title: 'This promotion can no longer be applied', serverHint: true },
  NOT_UNDOABLE: { title: 'This promotion cannot be undone', serverHint: true },
  CONFIRM_REQUIRED: { title: 'Type the environment’s key to confirm', serverHint: true },
  PROD_ONLY_CHANGES: {
    title: 'Changes made on the target would be overwritten',
    hint: 'Mark them as intended on that environment (Environments → Changed here), or tick “Overwrite them” and apply again.'
  },
  FROZEN: { title: 'Promotions are frozen', serverHint: true },
  FREEZE_UNKNOWN: {
    title: 'The Hub could not read its freeze windows',
    hint: 'Try again shortly.'
  },
  MOVE_OPEN: { title: 'A move of this environment is open', serverHint: true },
  CONFIG_PROMOTION_RUNNING: {
    title: 'Configuration is already being promoted here',
    hint: 'Wait for it to end.'
  },
  LINK_MISSING: {
    title: 'The app has no config link',
    hint: 'Both environments need Nivaro 0.3.215 or later and their hub token (or a shared deployment link).'
  },
  APP_UNREACHABLE: { title: 'The app did not answer', serverHint: true },
  ANSWER_TOO_LARGE: {
    title: 'Too much configuration at once',
    hint: 'Promote fewer groups at a time.'
  },
  NOT_SUPPORTED_ON_DATABASE: {
    title: 'This environment’s database cannot take a config promotion',
    hint: 'Config promotion needs SQL Server on both environments.'
  },
  OVER_CAP: {
    title: 'Too many rows would change at once',
    hint: 'Promote fewer groups at a time.'
  },
  CASCADE: {
    title: 'Removals would take other rows with them',
    hint: 'Plan again with “Let removals take linked rows” on, after checking which rows they are.'
  },
  BUSY: { title: 'The app is restoring configuration already', hint: 'Try again in a minute.' },
  SAME_ENVIRONMENT: { title: 'Pick two different environments' },
  ARCHIVED: { title: 'That environment is archived', serverHint: true },
  BAD_GROUPS: { title: 'Pick at least one kind of configuration' },
  ROW_UNMATCHED: {
    title: 'Some rows cannot be matched between the two environments',
    hint: 'Rows are matched by name or key, never by id. Rename or remove the rows listed below on one side, then plan again.'
  },
  REF_UNMAPPED: {
    title: 'Some references point at things the target does not have',
    hint: 'Create them on the target with the same name (or set the value on the target), then plan again.'
  },
  PROC_IMPORT_OWNED: {
    title: 'A procedure belongs to an import on the target',
    hint: 'Its import definition writes it there; leave managed procedures out or change the import.'
  },
  NOT_NEWEST: { title: 'Only the newest promotion can be undone', serverHint: true },
  INTERRUPTED: {
    title: 'The Hub lost the target’s answer',
    hint: 'It may have written. Use “Check the target” on the promotion to read what it says.'
  },
  NOTHING_TO_CHECK: { title: 'There is nothing to check on this promotion' },
  UNDO_ADMIN_SESSION_ONLY: {
    title: 'Undo needs an administrator on their own session',
    hint: 'Sign in as yourself (not View-as, an API key or a connected app) to undo it.'
  },
  OUTSIDE_WINDOW: { title: 'Outside this app’s deploy window', serverHint: true },
  CHECKLIST_REQUIRED: { title: 'Tick the pre-deploy checklist first', serverHint: true },
  CHECKLIST_INCOMPLETE: { title: 'Required checklist items are not ticked', serverHint: true },
  CHECKLIST_USED: { title: 'That checklist already started a run', serverHint: true },
  CHECKLIST_MISMATCH: { title: 'That checklist was ticked for another start', serverHint: true }
}

/** The rows a refusal names (ROW_UNMATCHED, REF_UNMAPPED, STALE …), when it names any. */
export function refusalItems(
  err: unknown
): Array<{ table: string; key: string; label: string | null; reason: string }> {
  const items = (err as { response?: { data?: { items?: unknown } } })?.response?.data?.items
  if (!Array.isArray(items)) return []
  return items
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    .slice(0, 50)
    .map((i) => ({
      table: typeof i.table === 'string' ? i.table : '',
      key: typeof i.key === 'string' ? i.key : String(i.key ?? ''),
      label: typeof i.label === 'string' ? i.label : null,
      reason: typeof i.reason === 'string' ? i.reason : ''
    }))
    .filter((i) => i.reason && !isRawErrorText(i.reason))
}

export const CONFIG_COPY_KEYS: ReadonlySet<string> = new Set(Object.keys(COPY))

export function configError(err: unknown, fallback: string): ErrorDescription {
  const d = hubError(err, fallback)
  const c = d.code ? COPY[d.code] : undefined
  if (!c) return d
  const body = (err as { response?: { data?: { message?: unknown; error?: unknown } } })?.response
    ?.data
  const said = typeof body?.message === 'string' ? body.message : body?.error
  const out: ErrorDescription = { ...d, title: c.title }
  if (c.serverHint && typeof said === 'string' && said.trim() && !isRawErrorText(said))
    out.hint = said.trim()
  else if (c.hint) out.hint = c.hint
  else delete out.hint
  return out
}

/** A value as the diff shows it: text as is, nothing as an em dash, the rest as JSON. */
export function shownValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** `nivaro_payload_template_versions` → "payload template versions". */
export function tableWords(table: string): string {
  return table.replace(/^nivaro_/, '').replace(/_/g, ' ')
}
