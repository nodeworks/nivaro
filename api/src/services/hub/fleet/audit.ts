import { db } from '../../../db/index.js'
import { nameFrom, namesOf } from './store.js'

/**
 * Hub audit timeline: every Hub action in one list, newest first — promotions, rollbacks, moves,
 * stack changes, key rotations, shared upgrades, app creation, sign-in client changes and plain
 * config edits. Built from two sources:
 *
 *  - nivaro_activity rows the Hub writes (collection `nivaro_hub_*`, or an action `hub-*`): who,
 *    when, what, and the note when one was given (a comment's `reason` / `note`, or its text);
 *  - the Hub's run tables (nivaro_hub_deploys, _moves, _shared_deploys, _creations) for the
 *    RESULT of a run an activity row started (success / failed / cancelled …), and as events of
 *    their own for runs no activity row names (an observed shared version change, a failed
 *    creation).
 *
 * Each row names its app and environment where one is known. Filters: app, environment, person,
 * category or exact action, time window. At most SCAN_MAX activity rows are read per answer
 * (newest first inside the window); `truncated` says when the window held more.
 */

export const SCAN_MAX = 5000

export type AuditCategory =
  | 'promote'
  | 'rollback'
  | 'move'
  | 'stack'
  | 'keys'
  | 'upgrade'
  | 'creation'
  | 'signin'
  | 'database'
  | 'config'

export const AUDIT_CATEGORIES: readonly AuditCategory[] = [
  'promote',
  'rollback',
  'move',
  'stack',
  'keys',
  'upgrade',
  'creation',
  'signin',
  'database',
  'config'
]

export interface AuditRow {
  id: string
  at: string | null
  action: string
  category: AuditCategory
  label: string
  app_id: number | null
  app_key: string | null
  environment_id: number | null
  env_key: string | null
  user_id: string | null
  user_name: string | null
  result: string | null
  note: string | null
  detail: string | null
  target: { table: string; id: string | null }
}

export interface AuditFilter {
  app_id?: number | null
  environment_id?: number | null
  user_id?: string | null
  /** A category, or an exact action (e.g. hub-promote-start). */
  action?: string | null
  from?: Date | null
  to?: Date | null
}

export interface AuditAnswer {
  rows: AuditRow[]
  total: number
  truncated: boolean
}

const LABELS: Record<string, string> = {
  'hub-promote-start': 'Promotion started',
  'hub-promote-cancel': 'Promotion cancelled',
  'hub-stack-apply': 'Stack applied',
  'hub-stack-restart': 'Stack restarted',
  'hub-stack-remove': 'Stack removed',
  'hub-stack-forget': 'Stack forgotten',
  'hub-move-start': 'Move started',
  'hub-move-done': 'Move finished',
  'hub-move-cancel': 'Move cancelled',
  'hub-move-rolled-back': 'Move rolled back',
  'hub-move-route-confirm': 'Move: route confirmed',
  'hub-move-checklist': 'Move: checklist item',
  'hub-place-shared': 'Placed on a shared deployment',
  'hub-place-shared-done': 'Placement on shared finished',
  'hub-shared-create': 'Shared deployment created',
  'hub-shared-update': 'Shared deployment changed',
  'hub-shared-delete': 'Shared deployment deleted',
  'hub-shared-token': 'Shared deployment token rotated',
  'hub-shared-upgrade': 'Shared upgrade started',
  'hub-shared-upgrade-cancel': 'Shared upgrade cancelled',
  'hub-shared-override': 'Shared upgrade override',
  'hub-shared-observed': 'Shared version change seen',
  'hub-create-start': 'App creation started',
  'hub-create-done': 'Environment created',
  'hub-create-retry': 'Creation retried',
  'hub-create-cancel': 'Creation cancelled',
  'hub-create-installed': 'Creation: install confirmed',
  'hub-create-check': 'Creation: checked now',
  'hub-create-failed': 'Creation failed',
  'hub-name-ready': 'Hostname ready',
  'hub-app-key': 'App key set',
  'hub-signin-mode': 'Sign-in mode changed',
  'hub-signin-key-rotate': 'Signing key rotated',
  'hub-oidc-key-remove': 'Signing key removed',
  'hub-signin-client-create': 'Sign-in client created',
  'hub-signin-client-rotate': 'Sign-in client secret rotated',
  'hub-signin-client-toggle': 'Sign-in client switched',
  'hub-db-adopt': 'Database adopted',
  'hub-db-check': 'Database checked',
  'hub-db-connection': 'Database connection changed',
  'hub-env-db-detach': 'Database record detached',
  'hub-fleet-settings': 'Fleet rules and targets changed',
  'hub-fleet-check': 'Fleet checked now',
  'hub-audit-export': 'Audit exported',
  'hub-deploy-run': 'Deploy run',
  'hub-move-run': 'Move run'
}

const TABLE_NAMES: Record<string, string> = {
  nivaro_hub_apps: 'App',
  nivaro_hub_app_owners: 'App owner',
  nivaro_hub_environments: 'Environment',
  nivaro_hub_drivers: 'Driver',
  nivaro_hub_placements: 'Placement',
  nivaro_hub_components: 'Component',
  nivaro_hub_targets: 'Target',
  nivaro_hub_db_servers: 'Database server',
  nivaro_hub_databases: 'Database',
  nivaro_hub_stack_settings: 'Stack settings',
  nivaro_hub_shared_deployments: 'Shared deployment',
  nivaro_hub_oidc_clients: 'Sign-in client',
  nivaro_hub_oidc_keys: 'Signing key',
  nivaro_hub_deploys: 'Deploy'
}

const VERB: Record<string, string> = { create: 'added', update: 'changed', delete: 'deleted' }

export function labelOf(action: string, collection: string | null): string {
  if (LABELS[action]) return LABELS[action]
  const what = collection ? (TABLE_NAMES[collection] ?? 'Hub record') : 'Hub'
  return VERB[action] ? `${what} ${VERB[action]}` : `${what}: ${action}`
}

export function categoryOf(
  action: string,
  collection: string | null,
  runKind?: string | null
): AuditCategory {
  if (collection === 'nivaro_hub_deploys' || action.startsWith('hub-promote')) {
    if (action.startsWith('hub-stack')) return 'stack'
    return runKind === 'rollback' ? 'rollback' : 'promote'
  }
  if (action.startsWith('hub-move') || action.startsWith('hub-place-shared')) return 'move'
  if (action.startsWith('hub-stack') || collection === 'nivaro_hub_stack_settings') return 'stack'
  if (collection === 'nivaro_hub_components') return 'stack'
  if (
    action === 'hub-signin-key-rotate' ||
    action === 'hub-oidc-key-remove' ||
    action === 'hub-shared-token' ||
    action === 'hub-app-key'
  )
    return 'keys'
  if (action.startsWith('hub-shared-upgrade') || action === 'hub-shared-observed') return 'upgrade'
  if (action.startsWith('hub-create') || action === 'hub-name-ready') return 'creation'
  if (action.startsWith('hub-signin') || collection === 'nivaro_hub_oidc_clients') return 'signin'
  if (
    action.startsWith('hub-db') ||
    action === 'hub-env-db-detach' ||
    collection === 'nivaro_hub_databases' ||
    collection === 'nivaro_hub_db_servers'
  )
    return 'database'
  return 'config'
}

/** A comment → the note a person gave (reason / note), and a short readable detail. */
export function readComment(raw: unknown): {
  note: string | null
  detail: string | null
  json: Record<string, unknown> | null
} {
  if (typeof raw !== 'string' || !raw.trim()) return { note: null, detail: null, json: null }
  const text = raw.trim()
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        const noteRaw = j.reason ?? j.note
        const note = typeof noteRaw === 'string' && noteRaw.trim() ? noteRaw.trim() : null
        const parts = Object.entries(j)
          .filter(([k, v]) => k !== 'reason' && k !== 'note' && v != null && typeof v !== 'object')
          .slice(0, 8)
          .map(([k, v]) => `${k}: ${String(v)}`)
        return { note, detail: parts.length ? parts.join(', ').slice(0, 500) : null, json: j }
      }
    } catch {
      /* plain text */
    }
  }
  return { note: null, detail: text.slice(0, 500), json: null }
}

function iso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

const idNum = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

interface RunRow {
  id: number
  table: string
  environment_id: number | null
  app_id: number | null
  shared_deployment_id?: number | null
  kind: string | null
  status: string
  version: string | null
  started_by: string | null
  started_at: string | null
  finished_at: string | null
  error: string | null
}

async function readRuns(
  table: string,
  ids: number[] | null,
  window: { from: Date | null; to: Date | null }
): Promise<RunRow[]> {
  if (ids && !ids.length) return []
  const q = db(table).select('*').orderBy('id', 'desc').limit(SCAN_MAX)
  if (ids) q.whereIn('id', ids.slice(0, 1000))
  else {
    const col = table === 'nivaro_hub_creations' ? 'created_at' : 'started_at'
    if (window.from) q.where(col, '>=', window.from)
    if (window.to) q.where(col, '<', window.to)
  }
  let rows: Array<Record<string, unknown>>
  try {
    rows = (await q) as Array<Record<string, unknown>>
  } catch {
    return []
  }
  return rows.map((r) => ({
    id: Number(r.id),
    table,
    environment_id: idNum(r.environment_id),
    app_id: idNum(r.app_id),
    shared_deployment_id: idNum(r.shared_deployment_id),
    kind: (r.kind as string | null) ?? null,
    status: String(r.status ?? ''),
    version: (r.version as string | null) ?? null,
    started_by: (r.started_by as string | null) ?? null,
    started_at: iso(r.started_at ?? r.created_at),
    finished_at: iso(r.finished_at),
    error: (r.error as string | null) ?? null
  }))
}

/** Where a Hub activity row points, read from its collection, item and comment. */
function refsOf(
  collection: string | null,
  item: string | null,
  json: Record<string, unknown> | null
): { deploy?: number; move?: number; sharedDeploy?: number } {
  const out: { deploy?: number; move?: number; sharedDeploy?: number } = {}
  if (collection === 'nivaro_hub_deploys' && idNum(item)) out.deploy = idNum(item) ?? undefined
  if (json && idNum(json.move_id)) out.move = idNum(json.move_id) ?? undefined
  if (json && idNum(json.shared_deploy)) out.sharedDeploy = idNum(json.shared_deploy) ?? undefined
  return out
}

function matchesAction(filter: string | null | undefined, action: string, cat: AuditCategory) {
  if (!filter) return true
  return (AUDIT_CATEGORIES as readonly string[]).includes(filter)
    ? cat === filter
    : action === filter
}

export async function listAudit(filter: AuditFilter): Promise<AuditAnswer> {
  const window = { from: filter.from ?? null, to: filter.to ?? null }
  const q = db('nivaro_activity')
    .where((w) => {
      w.where('collection', 'like', 'nivaro_hub_%').orWhere('action', 'like', 'hub-%')
    })
    .orderBy('timestamp', 'desc')
    .orderBy('id', 'desc')
    .limit(SCAN_MAX + 1)
    .select('id', 'action', 'user', 'timestamp', 'collection', 'item', 'comment')
  if (window.from) q.where('timestamp', '>=', window.from)
  if (window.to) q.where('timestamp', '<', window.to)
  if (filter.user_id) q.where('user', filter.user_id)
  let acts = (await q) as Array<Record<string, unknown>>
  const truncated = acts.length > SCAN_MAX
  acts = acts.slice(0, SCAN_MAX)

  // `_` is a LIKE wildcard (an escape is not portable across the five engines): keep only real
  // hub rows.
  acts = acts.filter((a) => {
    const c = (a.collection as string | null) ?? ''
    return c.startsWith('nivaro_hub_') || String(a.action ?? '').startsWith('hub-')
  })

  const parsed = acts.map((a) => {
    const c = readComment(a.comment)
    const collection = (a.collection as string | null) ?? null
    const item = a.item == null ? null : String(a.item)
    return { a, c, collection, item, refs: refsOf(collection, item, c.json) }
  })

  const deployIds = parsed.flatMap((p) => (p.refs.deploy ? [p.refs.deploy] : []))
  const moveIds = parsed.flatMap((p) => (p.refs.move ? [p.refs.move] : []))
  const sharedIds = parsed.flatMap((p) => (p.refs.sharedDeploy ? [p.refs.sharedDeploy] : []))

  const [deploysLinked, movesLinked, sharedLinked, deploysAll, movesAll, sharedAll, creations] =
    await Promise.all([
      readRuns('nivaro_hub_deploys', [...new Set(deployIds)], window),
      readRuns('nivaro_hub_moves', [...new Set(moveIds)], window),
      readRuns('nivaro_hub_shared_deploys', [...new Set(sharedIds)], window),
      readRuns('nivaro_hub_deploys', null, window),
      readRuns('nivaro_hub_moves', null, window),
      readRuns('nivaro_hub_shared_deploys', null, window),
      readRuns('nivaro_hub_creations', null, window)
    ])
  const runKey = (t: string, id: number) => `${t}:${id}`
  const runs = new Map<string, RunRow>()
  for (const r of [...deploysLinked, ...movesLinked, ...sharedLinked])
    runs.set(runKey(r.table, r.id), r)

  // Lookups: environments (→ app), apps, oidc clients (→ environment), shared deployments.
  const [envRows, appRows, clientRows] = await Promise.all([
    db('nivaro_hub_environments').select('id', 'app_id', 'key') as Promise<
      Array<Record<string, unknown>>
    >,
    db('nivaro_hub_apps').select('id', 'key') as Promise<Array<Record<string, unknown>>>,
    (
      db('nivaro_hub_oidc_clients').select('id', 'environment_id') as Promise<
        Array<Record<string, unknown>>
      >
    ).catch(() => [] as Array<Record<string, unknown>>)
  ])
  const envs = new Map(
    envRows.map((e) => [Number(e.id), { app_id: Number(e.app_id), key: String(e.key) }])
  )
  const apps = new Map(appRows.map((a) => [Number(a.id), String(a.key)]))
  const clients = new Map(clientRows.map((c) => [Number(c.id), Number(c.environment_id)]))

  const placeOf = (envId: number | null, appId: number | null) => {
    const env = envId != null ? envs.get(envId) : undefined
    const app = env?.app_id ?? appId
    return {
      environment_id: env ? envId : null,
      env_key: env?.key ?? null,
      app_id: app ?? null,
      app_key: app != null ? (apps.get(app) ?? null) : null
    }
  }

  const rows: AuditRow[] = []
  const linked = new Set<string>()
  for (const p of parsed) {
    const action = String(p.a.action ?? '')
    let envId: number | null = null
    let appId: number | null = null
    const item = idNum(p.item)
    if (p.collection === 'nivaro_hub_apps') appId = item
    else if (
      p.collection === 'nivaro_hub_environments' ||
      p.collection === 'nivaro_hub_stack_settings'
    )
      envId = item
    else if (p.collection === 'nivaro_hub_oidc_clients' && item) envId = clients.get(item) ?? null
    let run: RunRow | undefined
    if (p.refs.deploy) run = runs.get(runKey('nivaro_hub_deploys', p.refs.deploy))
    else if (p.refs.move) run = runs.get(runKey('nivaro_hub_moves', p.refs.move))
    else if (p.refs.sharedDeploy)
      run = runs.get(runKey('nivaro_hub_shared_deploys', p.refs.sharedDeploy))
    if (run) {
      linked.add(runKey(run.table, run.id))
      envId = envId ?? run.environment_id
      appId = appId ?? run.app_id
    }
    const category = categoryOf(action, p.collection, run?.kind ?? null)
    const label =
      action === 'hub-promote-start' && run?.kind === 'rollback'
        ? 'Rollback started'
        : labelOf(action, p.collection)
    rows.push({
      id: `a:${p.a.id}`,
      at: iso(p.a.timestamp),
      action,
      category,
      label,
      ...placeOf(envId, appId),
      user_id: (p.a.user as string | null) ?? null,
      user_name: null,
      result: run ? run.status : null,
      note: p.c.note,
      detail:
        [run?.version ? `version ${run.version}` : null, run?.error ? run.error : null, p.c.detail]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 600) || null,
      target: { table: p.collection ?? 'nivaro_activity', id: p.item }
    })
  }

  // Runs no activity row names (observed shared versions, runs a heal started, failed creations).
  const standalone = [
    ...deploysAll.map((r) => ({ r, action: 'hub-deploy-run' })),
    ...movesAll.map((r) => ({ r, action: 'hub-move-run' })),
    ...sharedAll.map((r) => ({
      r,
      action: r.kind === 'observed' ? 'hub-shared-observed' : 'hub-shared-upgrade'
    })),
    ...creations
      .filter((r) => r.status === 'failed')
      .map((r) => ({ r, action: 'hub-create-failed' }))
  ]
  const linkedDeployIds = new Set(deployIds)
  const linkedMoveIds = new Set(moveIds)
  const linkedSharedIds = new Set(sharedIds)
  for (const { r, action } of standalone) {
    if (linked.has(runKey(r.table, r.id))) continue
    if (r.table === 'nivaro_hub_deploys' && linkedDeployIds.has(r.id)) continue
    if (r.table === 'nivaro_hub_moves' && linkedMoveIds.has(r.id)) continue
    if (r.table === 'nivaro_hub_shared_deploys' && linkedSharedIds.has(r.id)) continue
    // A run whose start the activity log holds outside the scanned rows is still its own event.
    if (filter.user_id && (r.started_by ?? '').toLowerCase() !== filter.user_id.toLowerCase())
      continue
    rows.push({
      id: `r:${r.table}:${r.id}`,
      at: r.started_at,
      action,
      category: categoryOf(action, r.table, r.kind),
      label:
        r.table === 'nivaro_hub_deploys'
          ? r.kind === 'rollback'
            ? 'Rollback run'
            : 'Promotion run'
          : labelOf(action, r.table),
      ...placeOf(r.environment_id, r.app_id),
      user_id: r.started_by,
      user_name: null,
      result: r.status || null,
      note: null,
      detail:
        [r.version ? `version ${r.version}` : null, r.error].filter(Boolean).join(' · ') || null,
      target: { table: r.table, id: String(r.id) }
    })
  }

  const filtered = rows
    .filter((r) => matchesAction(filter.action, r.action, r.category))
    .filter((r) => !filter.app_id || r.app_id === filter.app_id)
    .filter((r) => !filter.environment_id || r.environment_id === filter.environment_id)
    .sort((x, y) => (y.at ?? '').localeCompare(x.at ?? '') || y.id.localeCompare(x.id))

  const names = await namesOf(filtered.map((r) => r.user_id))
  for (const r of filtered) r.user_name = r.user_id ? nameFrom(names, r.user_id) : 'System'
  return { rows: filtered, total: filtered.length, truncated }
}

const CSV_COLUMNS: Array<[string, (r: AuditRow) => string]> = [
  ['When (UTC)', (r) => r.at ?? ''],
  ['Action', (r) => r.label],
  ['Action id', (r) => r.action],
  ['Category', (r) => r.category],
  ['App', (r) => r.app_key ?? ''],
  ['Environment', (r) => r.env_key ?? ''],
  ['Who', (r) => r.user_name ?? ''],
  ['Result', (r) => r.result ?? ''],
  ['Reason / note', (r) => r.note ?? ''],
  ['Detail', (r) => r.detail ?? '']
]

function cell(v: string): string {
  // A cell a spreadsheet would read as a formula is prefixed with a quote.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function auditCsv(rows: AuditRow[]): string {
  const head = CSV_COLUMNS.map(([h]) => cell(h)).join(',')
  const body = rows.map((r) => CSV_COLUMNS.map(([, f]) => cell(f(r))).join(','))
  return `${[head, ...body].join('\r\n')}\r\n`
}
