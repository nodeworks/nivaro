/**
 * Config changed here, not from promotion — reads, settings, marks and the copy bundle.
 * The pure diff lives in ./core.ts; this module only gathers its inputs.
 *
 * State, with no new table:
 *  - the BASELINE is a row of nivaro_config_snapshots: the newest with trigger 'promote' (the
 *    promote chain stores one right after it copies: POST /api/config-diff/history
 *    {trigger:'promote'}), or one an admin pinned from the restore points;
 *  - settings live under `config_drift` in THIS instance's nivaro_settings_overrides row
 *    (per instance, never promoted — INSTANCE_RESERVED_KEYS);
 *  - "Mark as intended" / "Reopen" are nivaro_activity rows (production keeps its own activity;
 *    a promotion never copies it), bound to the row's hash.
 */
import type { FastifyRequest } from 'fastify'
import { config } from '../../config.js'
import { db } from '../../db/index.js'
import { NIVARO_VERSION } from '../../version.js'
import { logActivity } from '../activity.js'
import { appEnvironment } from '../app-info-environment.js'
import {
  buildConfigSnapshot,
  CONFIG_TABLES,
  type ConfigSnapshot,
  type SnapshotRow
} from '../config-inventory.js'
import { loadConfigSnapshot } from '../config-snapshots.js'
import { chunkArray } from '../db-batch.js'
import { instanceKey } from '../instance-key.js'
import {
  brief,
  computeDrift,
  type DriftActivity,
  type DriftItem,
  type DriftMark,
  type DriftSkipped,
  describeItem,
  driftTables,
  MARK_ACTION,
  overwrittenBy,
  REOPEN_ACTION
} from './core.js'

export const DRIFT_SETTINGS_KEY = 'config_drift'

export interface DriftSettings {
  /** Promotion/apply paths refuse (409 PROD_ONLY_CHANGES) while unmarked changes would be lost. */
  refuse_overwrite: boolean
  /** A restore point an admin chose as "the last promotion"; null = newest 'promote' snapshot. */
  baseline_snapshot_id: number | null
  /** Track on an instance that is not production (staging rehearsals, tests). */
  track_here: boolean
}

export const DRIFT_DEFAULTS: DriftSettings = {
  refuse_overwrite: false,
  baseline_snapshot_id: null,
  track_here: false
}

export interface DriftBaseline {
  snapshot_id: number
  taken_at: string
  trigger: string
  version: string | null
  environment: string | null
  pinned: boolean
}

export interface DriftReport {
  environment: string
  /** Tracking runs on this instance (production, or track_here). */
  active: boolean
  settings: DriftSettings
  baseline: DriftBaseline | null
  items: DriftItem[]
  totals: { open: number; intended: number; tables: number }
  skipped: DriftSkipped
  /** Table read errors (one unreadable table never costs the list). */
  errors: Record<string, string>
  generated_at: string
}

const cloudMode = (): boolean => !!process.env.CLOUD_META_DB_URL

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

/** Stored JSON → settings (pure; anything unreadable falls back to its default). */
export function normalizeDriftSettings(raw: unknown): DriftSettings {
  const o = obj(raw)
  const id = Number(o.baseline_snapshot_id)
  return {
    refuse_overwrite: o.refuse_overwrite === true,
    baseline_snapshot_id: Number.isInteger(id) && id > 0 ? id : null,
    track_here: o.track_here === true
  }
}

async function readOverridesRow(): Promise<{ id: number; data: Record<string, unknown> } | null> {
  const row = (await db('nivaro_settings_overrides')
    .where({ instance_key: instanceKey() })
    .first('id', 'data')) as { id: number; data?: string | null } | undefined
  if (!row) return null
  try {
    return { id: row.id, data: obj(row.data ? JSON.parse(row.data) : {}) }
  } catch {
    return { id: row.id, data: {} }
  }
}

export async function getDriftSettings(): Promise<DriftSettings> {
  try {
    return normalizeDriftSettings((await readOverridesRow())?.data[DRIFT_SETTINGS_KEY])
  } catch {
    return DRIFT_DEFAULTS
  }
}

export async function saveDriftSettings(patch: Partial<DriftSettings>): Promise<DriftSettings> {
  const row = await readOverridesRow()
  const next = normalizeDriftSettings({
    ...normalizeDriftSettings(row?.data[DRIFT_SETTINGS_KEY]),
    ...patch
  })
  const data = { ...(row?.data ?? {}), [DRIFT_SETTINGS_KEY]: next }
  if (row) {
    await db('nivaro_settings_overrides')
      .where({ id: row.id })
      .update({ data: JSON.stringify(data), updated_at: new Date() })
  } else {
    await db('nivaro_settings_overrides').insert({
      instance_key: instanceKey(),
      data: JSON.stringify(data),
      updated_at: new Date()
    })
  }
  forgetDriftReport()
  return next
}

export function driftActive(settings: DriftSettings): boolean {
  if (cloudMode()) return false
  return appEnvironment() === 'production' || settings.track_here
}

/** Cheap: whether this instance tracks at all (no snapshot read). Never throws. */
export async function driftTrackingHere(): Promise<boolean> {
  try {
    return driftActive(await getDriftSettings())
  } catch {
    return false
  }
}

/** The baseline: the pinned restore point, else the newest 'promote' snapshot. */
export async function resolveBaseline(settings: DriftSettings): Promise<DriftBaseline | null> {
  const cols = ['id', 'taken_at', 'trigger', 'version', 'environment']
  type Row = {
    id: number
    taken_at: Date | string
    trigger: string | null
    version: string | null
    environment: string | null
  }
  let row: Row | undefined
  let pinned = false
  if (settings.baseline_snapshot_id) {
    row = (await db('nivaro_config_snapshots')
      .where({ id: settings.baseline_snapshot_id })
      .first(cols)) as Row | undefined
    pinned = !!row
  }
  if (!row) {
    row = (await db('nivaro_config_snapshots')
      .where({ trigger: 'promote' })
      .orderBy('id', 'desc')
      .first(cols)) as Row | undefined
  }
  if (!row) return null
  return {
    snapshot_id: Number(row.id),
    taken_at: new Date(row.taken_at).toISOString(),
    trigger: row.trigger ?? 'cron',
    version: row.version,
    environment: row.environment,
    pinned
  }
}

const ACTIVITY_CAP = 5000
const IGNORED_ACTIONS = ['read', 'login', 'logout', 'config-epoch', 'file-download']

function toActivity(r: Record<string, unknown>): DriftActivity {
  return {
    id: Number(r.id),
    action: String(r.action ?? ''),
    collection: (r.collection as string | null) ?? null,
    item: r.item == null ? null : String(r.item),
    user: r.user == null ? null : String(r.user),
    origin: (r.origin as string | null) ?? null,
    timestamp: new Date(r.timestamp as string).toISOString(),
    comment: (r.comment as string | null) ?? null
  }
}

async function loadActivity(tables: string[], since: Date): Promise<DriftActivity[]> {
  const out: DriftActivity[] = []
  for (const part of chunkArray(tables, 200)) {
    const rows = (await db('nivaro_activity')
      .where('timestamp', '>=', since)
      .whereIn('collection', part)
      .whereNotIn('action', [...IGNORED_ACTIONS, MARK_ACTION, REOPEN_ACTION])
      .orderBy('id', 'desc')
      .limit(ACTIVITY_CAP)
      .select(
        'id',
        'action',
        'collection',
        'item',
        'user',
        'origin',
        'timestamp',
        'comment'
      )) as Array<Record<string, unknown>>
    out.push(...rows.map(toActivity))
  }
  return out
}

async function loadStamps(since: Date): Promise<DriftActivity[]> {
  const rows = (await db('nivaro_activity')
    .where('timestamp', '>=', since)
    .where('action', 'config-epoch')
    .whereNotNull('user')
    .orderBy('id', 'desc')
    .limit(2000)
    .select(
      'id',
      'action',
      'collection',
      'item',
      'user',
      'origin',
      'timestamp',
      'comment'
    )) as Array<Record<string, unknown>>
  return rows.map(toActivity)
}

async function loadMarks(tables: string[]): Promise<DriftMark[]> {
  const out: DriftMark[] = []
  for (const part of chunkArray(tables, 200)) {
    const rows = (await db('nivaro_activity')
      .whereIn('action', [MARK_ACTION, REOPEN_ACTION])
      .whereIn('collection', part)
      .orderBy('id', 'desc')
      .limit(ACTIVITY_CAP)
      .select('id', 'action', 'collection', 'item', 'user', 'timestamp', 'comment')) as Array<
      Record<string, unknown>
    >
    for (const r of rows) {
      let parsed: { hash?: unknown; note?: unknown } = {}
      try {
        parsed = r.comment ? JSON.parse(String(r.comment)) : {}
      } catch {
        parsed = {}
      }
      out.push({
        id: Number(r.id),
        table: String(r.collection),
        key: String(r.item ?? ''),
        action: String(r.action),
        hash: typeof parsed.hash === 'string' ? parsed.hash : null,
        note: typeof parsed.note === 'string' ? parsed.note : null,
        user: r.user == null ? null : String(r.user),
        at: new Date(r.timestamp as string).toISOString()
      })
    }
  }
  return out
}

async function loadNames(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const unique = [...new Set(ids.filter(Boolean))]
  for (const part of chunkArray(unique, 500)) {
    const rows = (await db('nivaro_users')
      .whereIn('id', part)
      .select('id', 'first_name', 'last_name', 'email')) as Array<{
      id: string
      first_name?: string | null
      last_name?: string | null
      email?: string | null
    }>
    for (const u of rows) {
      const n = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || ''
      if (n) names.set(String(u.id).toLowerCase(), n)
    }
  }
  return names
}

interface DriftState {
  report: DriftReport
  live: ConfigSnapshot['tables']
  liveSnapshot: ConfigSnapshot | null
}

let cached: { at: number; state: DriftState } | null = null
const CACHE_MS = 60_000

export function forgetDriftReport(): void {
  cached = null
}

/**
 * The whole read: live config of the drift tables vs the baseline, attributed and marked.
 * `tables` narrows it (the apply guards); the full read is reused for a minute.
 */
export async function readDriftState(
  opts: { tables?: string[]; fresh?: boolean } = {}
): Promise<DriftState> {
  if (!opts.tables && !opts.fresh && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.state
  }
  const settings = await getDriftSettings()
  const active = driftActive(settings)
  const environment = appEnvironment()
  const empty: DriftReport = {
    environment,
    active,
    settings,
    baseline: null,
    items: [],
    totals: { open: 0, intended: 0, tables: 0 },
    skipped: { personal: 0, local: 0, volatile_only: 0, tables_not_in_baseline: [] },
    errors: {},
    generated_at: new Date().toISOString()
  }
  if (!active) return { report: empty, live: {}, liveSnapshot: null }
  const baseline = await resolveBaseline(settings)
  if (!baseline) return { report: { ...empty }, live: {}, liveSnapshot: null }

  const base = await loadConfigSnapshot(baseline.snapshot_id)
  if (!base) return { report: { ...empty }, live: {}, liveSnapshot: null }
  const all = driftTables(CONFIG_TABLES)
  const tables = opts.tables ? all.filter((t) => opts.tables?.includes(t)) : all
  const liveSnapshot = await buildConfigSnapshot({
    tables,
    version: NIVARO_VERSION,
    environment: config.NODE_ENV,
    concurrency: 4
  })
  const since = new Date(baseline.taken_at)
  const [activity, stamps, marks] = await Promise.all([
    loadActivity(tables, since),
    loadStamps(since),
    loadMarks(tables)
  ])
  const userIds = [...activity, ...stamps].map((a) => a.user ?? '')
  for (const m of marks) if (m.user) userIds.push(m.user)
  for (const t of Object.values(liveSnapshot.tables)) {
    for (const r of Object.values(t)) {
      const u = r.data.user_updated ?? r.data.updated_by
      if (u) userIds.push(String(u))
    }
  }
  const names = await loadNames(userIds)
  const { items, skipped } = computeDrift({
    tables,
    live: liveSnapshot.tables,
    baseline: base.tables,
    since: baseline.taken_at,
    activity,
    stamps,
    marks,
    names
  })
  const open = items.filter((i) => !i.intended)
  const report: DriftReport = {
    environment,
    active,
    settings,
    baseline,
    items,
    totals: {
      open: open.length,
      intended: items.length - open.length,
      tables: new Set(open.map((i) => i.table)).size
    },
    skipped,
    errors: liveSnapshot.errors,
    generated_at: new Date().toISOString()
  }
  const state = { report, live: liveSnapshot.tables, liveSnapshot }
  if (!opts.tables) cached = { at: Date.now(), state }
  return state
}

export async function getDriftReport(opts: { fresh?: boolean } = {}): Promise<DriftReport> {
  return (await readDriftState(opts)).report
}

/** Mark rows as intended (or reopen them). Bound to each row's hash now. */
export async function markItems(
  ids: string[],
  opts: { note: string | null; userId: string | null; reopen?: boolean; req?: FastifyRequest }
): Promise<{ marked: number; missing: string[] }> {
  const state = await readDriftState({ fresh: true })
  const byId = new Map(state.report.items.map((i) => [i.id, i]))
  const missing: string[] = []
  let marked = 0
  for (const id of ids) {
    const it = byId.get(id)
    if (!it) {
      missing.push(id)
      continue
    }
    await logActivity({
      action: opts.reopen ? REOPEN_ACTION : MARK_ACTION,
      user: opts.userId,
      collection: it.table,
      item: it.key,
      comment: JSON.stringify({
        hash: it.live_hash ?? 'removed',
        note: opts.note ? opts.note.slice(0, 300) : null
      }),
      origin: 'person',
      req: opts.req
    })
    marked++
  }
  forgetDriftReport()
  return { marked, missing }
}

/**
 * "Copy to dev": the live rows of the chosen items as a format-1 config snapshot that dev's
 * Config diff page uploads, compares and applies (table by table, upsert only). `bundle` says it
 * carries only these rows, so the compare does not list every other dev row as "only here".
 * Rows REMOVED here cannot be carried by an upsert — they are listed in `bundle.removed`.
 */
export async function buildCopyBundle(ids: string[] | null): Promise<ConfigSnapshot> {
  const state = await readDriftState({ fresh: true })
  const chosen = state.report.items.filter((i) => (ids ? ids.includes(i.id) : !i.intended))
  const tables: ConfigSnapshot['tables'] = {}
  const removed: Array<{ table: string; key: string; label: string | null }> = []
  for (const it of chosen) {
    if (it.kind === 'removed') {
      removed.push({ table: it.table, key: it.key, label: it.label })
      continue
    }
    const row: SnapshotRow | undefined = state.live[it.table]?.[it.key]
    if (!row) continue
    if (!tables[it.table]) tables[it.table] = {}
    tables[it.table][it.key] = row
  }
  const live = state.liveSnapshot
  return {
    format: 1,
    generated_at: new Date().toISOString(),
    instance: {
      version: NIVARO_VERSION,
      environment: appEnvironment(),
      database: live?.instance.database ?? config.DB_DATABASE,
      label: 'Changed here, not from promotion'
    },
    classification: live?.classification ?? {
      config: Object.keys(tables),
      derived: [],
      runtime: [],
      unclassified: [],
      absent: []
    },
    tables,
    errors: {},
    bundle: {
      kind: 'changed-here',
      items: chosen.map(brief),
      removed,
      baseline_snapshot_id: state.report.baseline?.snapshot_id ?? null
    }
  }
}

export interface OverwriteCheck {
  /** Tracking runs here (production or track_here). */
  active: boolean
  /** The setting: refuse instead of warn. */
  refuse: boolean
  items: ReturnType<typeof brief>[]
  /** One sentence per item, for warning lists. */
  lines: string[]
  error?: string
}

/**
 * The open changes made here that a write would overwrite. Never throws: a failed read answers
 * `error` and no items (the write warns about the failed check instead of being blocked by it).
 */
export async function checkOverwrite(
  target: ConfigSnapshot['tables'] | null,
  opts: { tables: string[]; deletes: boolean; keys?: string[] | null }
): Promise<OverwriteCheck> {
  let settings = DRIFT_DEFAULTS
  try {
    settings = await getDriftSettings()
    if (!driftActive(settings)) return { active: false, refuse: false, items: [], lines: [] }
    const state = await readDriftState({ tables: opts.tables })
    const open = state.report.items.filter((i) => !i.intended)
    const hit = target
      ? overwrittenBy(open, target, state.live, {
          tables: opts.tables,
          deletes: opts.deletes,
          keys: opts.keys?.length ? new Set(opts.keys) : null
        })
      : open.filter((i) => opts.tables.includes(i.table))
    return {
      active: true,
      refuse: settings.refuse_overwrite,
      items: hit.map(brief),
      lines: hit.map(describeItem)
    }
  } catch (err) {
    return {
      active: true,
      refuse: false,
      items: [],
      lines: [],
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
