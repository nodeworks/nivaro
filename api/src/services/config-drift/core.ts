/**
 * Config changed here, not from promotion — the pure half (2026-11-13).
 *
 * Production's configuration is supposed to arrive by promotion (dev → staging → production:
 * efp-ops promote-config, or an uploaded snapshot applied through /config-diff/apply). A hand fix
 * made straight on production (a shared default saved view, the shared collection pins order) is
 * invisible to that path: dev never gets it, and the next promote replaces it without a word.
 *
 * The answer is a diff against the BASELINE — the stored config snapshot taken right after the
 * last promotion (trigger 'promote', or a restore point an admin pinned) — of every table the
 * config diff covers (CONFIG_TABLES) minus the ones a promotion never decides (DRIFT_EXCLUDED).
 * Each differing row is an item; who and when come from the activity log (a write on that row
 * since the baseline), the row's own updated-by columns, or a config-epoch stamp naming the table.
 * A row nobody can be named for still shows ("no record of who") — a direct SQL fix is exactly
 * the kind of change this exists to surface.
 *
 * "Mark as intended" is an activity row bound to the row's hash: it stops nagging while the row
 * stays as marked, and starts again once the row changes. Nothing here writes configuration.
 */
import type { SnapshotRow } from '../config-inventory.js'
import { RESTORE_EXCLUDED } from '../config-restore.js'
import { configArea } from '../config-stamps.js'
import { isSecretColumn } from '../system-collections.js'

export type DriftKind = 'added' | 'changed' | 'removed'
export type DriftEvidence = 'activity' | 'row' | 'stamp' | 'apply' | 'none'

/** Activity actions this feature writes (never read back as someone's config change). */
export const MARK_ACTION = 'config-drift-intended'
export const REOPEN_ACTION = 'config-drift-reopen'

/** Config tables whose rows a promotion never decides, with the reason the page shows. */
export const DRIFT_EXCLUDED: Record<string, string> = {
  ...RESTORE_EXCLUDED,
  nivaro_settings_overrides: 'Per-instance settings — promotion never copies them',
  nivaro_config_snapshots: 'This instance’s own restore points'
}

/**
 * Columns that move without anyone changing configuration (run stamps, counters, the target's own
 * deploy stamps). A row whose only differences are here is not a change made here.
 */
export const VOLATILE_COLUMN_RE =
  /^(last_(?!name$)[a-z0-9_]+|next_run(_at)?|date_updated|updated_at|user_updated|updated_by|modified_at|modified_by|run_count|hit_count|use_count|usage_count|open_count|view_count|fail_count|failure_count|error_count|consecutive_failures|deployed_(hash|at|by)|lease_[a-z0-9_]+|locked_(at|by|until))$/

const VALUE_CAP = 400
const MASK = '••••••'

export interface DriftField {
  field: string
  /** The value the promotion delivered (the baseline). */
  promoted: unknown
  /** The value on this instance now. */
  here: unknown
}

export interface DriftActivity {
  id: number
  action: string
  collection: string | null
  item: string | null
  user: string | null
  origin: string | null
  timestamp: string
  comment: string | null
}

export interface DriftMark {
  table: string
  key: string
  action: string
  hash: string | null
  note: string | null
  user: string | null
  at: string
  id: number
}

export interface DriftItem {
  /** `${table}:${key}` — stable across reads. */
  id: string
  table: string
  key: string
  area: string
  label: string | null
  kind: DriftKind
  fields: DriftField[]
  live_hash: string | null
  baseline_hash: string | null
  who: { user_id: string | null; name: string | null } | null
  at: string | null
  evidence: DriftEvidence
  /** One sentence: where the who/when came from. */
  evidence_note: string
  intended: { note: string | null; by: string | null; by_name: string | null; at: string } | null
}

export interface DriftSkipped {
  /** Personal rows (a person's own saved views) — not configuration a promotion decides. */
  personal: number
  /** Rows this instance keeps for itself by design (form-change links, preview comments). */
  local: number
  /** Rows that differ only in run stamps / counters. */
  volatile_only: number
  /** Tables the baseline does not carry (added by a migration since) — not compared. */
  tables_not_in_baseline: string[]
}

/** The tables a drift read covers: config tables minus the excluded ones. */
export function driftTables(configTables: string[]): string[] {
  return configTables.filter((t) => !DRIFT_EXCLUDED[t])
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

/** Rows a promotion leaves alone by design, or that belong to one person. */
export function rowScope(
  table: string,
  row: Record<string, unknown> | undefined
): 'config' | 'personal' | 'local' {
  if (!row) return 'config'
  if (table === 'nivaro_saved_views') {
    const shared = truthy(row.is_shared) || truthy(row.is_default) || truthy(row.default_for_role)
    return shared ? 'config' : 'personal'
  }
  if (table === 'nivaro_extension_settings') {
    const key = String(row.key ?? '')
    if (
      row.extension_id === 'nivaro-core' &&
      (key.startsWith('form_change:') || key.startsWith('layout_preview_comment:'))
    ) {
      return 'local'
    }
  }
  return 'config'
}

function norm(v: unknown): unknown {
  if (v === undefined || v === null) return null
  return v instanceof Date ? v.toISOString() : v
}

/** Field differences that are a configuration change (volatile columns left out). */
export function meaningfulFields(
  promoted: Record<string, unknown> | undefined,
  here: Record<string, unknown> | undefined
): Array<{ field: string; promoted: unknown; here: unknown }> {
  const a = promoted ?? {}
  const b = here ?? {}
  const out: Array<{ field: string; promoted: unknown; here: unknown }> = []
  for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (VOLATILE_COLUMN_RE.test(field)) continue
    const x = norm(a[field])
    const y = norm(b[field])
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ field, promoted: x, here: y })
  }
  return out
}

function cap(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.length > VALUE_CAP ? `${v.slice(0, VALUE_CAP)}…` : v
  const s = JSON.stringify(v)
  return s.length > VALUE_CAP ? `${s.slice(0, VALUE_CAP)}…` : v
}

function shownFields(fields: Array<{ field: string; promoted: unknown; here: unknown }>) {
  return fields.map((f) =>
    isSecretColumn(f.field)
      ? {
          field: f.field,
          promoted: f.promoted == null ? null : MASK,
          here: f.here == null ? null : MASK
        }
      : { field: f.field, promoted: cap(f.promoted), here: cap(f.here) }
  )
}

/** A short human name for a config row. */
export function rowLabel(table: string, data: Record<string, unknown> | undefined): string | null {
  if (!data) return null
  if (table === 'nivaro_extension_settings' && typeof data.key === 'string') {
    return `${String(data.extension_id ?? '')} · ${data.key}`.slice(0, 120)
  }
  for (const k of ['name', 'label', 'title', 'key', 'slug', 'field', 'collection']) {
    const v = data[k]
    if (typeof v === 'string' && v.trim()) {
      if (table === 'nivaro_saved_views' && typeof data.collection === 'string' && k === 'name')
        return `${v} (${data.collection})`.slice(0, 120)
      return v.slice(0, 120)
    }
  }
  return null
}

/**
 * The activity `item` values that name this row: the id, and for settings rows the
 * `<extension>:<key>` the collection-pins route (and others) log.
 */
export function itemAliases(table: string, key: string, data?: Record<string, unknown>): string[] {
  const out = [key]
  if (table === 'nivaro_extension_settings' && data?.extension_id && data?.key) {
    out.push(`${String(data.extension_id)}:${String(data.key)}`)
  }
  return out
}

/** Actions that are not someone changing a row (reads, sign-ins, this feature's own marks). */
const NOT_A_CHANGE = new Set([
  'read',
  'login',
  'logout',
  'config-epoch',
  'file-download',
  MARK_ACTION,
  REOPEN_ACTION
])

function isPerson(a: DriftActivity): boolean {
  return !!a.user && (a.origin == null || a.origin === '' || a.origin === 'person')
}

function rowWho(
  data: Record<string, unknown> | undefined,
  since: number
): { user: string | null; at: string } | null {
  if (!data) return null
  const atRaw = data.date_updated ?? data.updated_at ?? data.modified_at
  const userRaw = data.user_updated ?? data.updated_by ?? data.modified_by
  if (!atRaw) return null
  const at = new Date(atRaw as string)
  if (Number.isNaN(at.getTime()) || at.getTime() < since) return null
  return { user: userRaw ? String(userRaw) : null, at: at.toISOString() }
}

export interface ComputeDriftInput {
  tables: string[]
  live: Record<string, Record<string, SnapshotRow>>
  baseline: Record<string, Record<string, SnapshotRow>>
  /** The baseline's time (ISO); activity older than this is not a change since promotion. */
  since: string | null
  activity: DriftActivity[]
  /** config-epoch rows by a person since the baseline (comment names the tables). */
  stamps: DriftActivity[]
  marks: DriftMark[]
  names: Map<string, string>
}

/** The newest mark per row; a reopen after a mark cancels it. */
export function latestMarks(marks: DriftMark[]): Map<string, DriftMark> {
  const out = new Map<string, DriftMark>()
  for (const m of [...marks].sort((x, y) => x.id - y.id)) out.set(`${m.table}:${m.key}`, m)
  return out
}

export function computeDrift(input: ComputeDriftInput): {
  items: DriftItem[]
  skipped: DriftSkipped
} {
  const since = input.since ? Date.parse(input.since) : 0
  const skipped: DriftSkipped = {
    personal: 0,
    local: 0,
    volatile_only: 0,
    tables_not_in_baseline: []
  }
  const name = (u: string | null) => (u ? (input.names.get(u.toLowerCase()) ?? null) : null)

  // Activity per table + item, newest first.
  const byItem = new Map<string, DriftActivity[]>()
  const applies = new Map<string, DriftActivity>()
  for (const a of [...input.activity].sort((x, y) => y.id - x.id)) {
    if (!a.collection || NOT_A_CHANGE.has(a.action)) continue
    if (Date.parse(a.timestamp) < since) continue
    if (a.action === 'config-apply' || a.action === 'config-restore') {
      if (!applies.has(a.collection)) applies.set(a.collection, a)
      continue
    }
    if (!a.item) continue
    const k = `${a.collection}:${a.item}`
    const list = byItem.get(k) ?? []
    list.push(a)
    byItem.set(k, list)
  }
  const stampFor = (table: string): DriftActivity | null => {
    const re = new RegExp(`\\b${table}\\b`)
    let best: DriftActivity | null = null
    for (const s of input.stamps) {
      if (!s.comment || !re.test(s.comment) || Date.parse(s.timestamp) < since) continue
      if (!best || s.id > best.id) best = s
    }
    return best
  }
  const marks = latestMarks(input.marks)

  const items: DriftItem[] = []
  for (const table of input.tables) {
    const live = input.live[table]
    const base = input.baseline[table]
    if (!live) continue
    if (!base) {
      skipped.tables_not_in_baseline.push(table)
      continue
    }
    for (const key of new Set([...Object.keys(live), ...Object.keys(base)])) {
      const l = live[key]
      const b = base[key]
      if (l && b && l.hash === b.hash) continue
      const scope = rowScope(table, l?.data ?? b?.data)
      if (scope === 'personal') {
        skipped.personal++
        continue
      }
      if (scope === 'local') {
        skipped.local++
        continue
      }
      const kind: DriftKind = l && !b ? 'added' : !l && b ? 'removed' : 'changed'
      const fields = meaningfulFields(b?.data, l?.data)
      if (kind === 'changed' && fields.length === 0) {
        skipped.volatile_only++
        continue
      }

      // Who and when.
      let who: DriftItem['who'] = null
      let at: string | null = null
      let evidence: DriftEvidence = 'none'
      let note = 'No record of who changed it — a script or a direct database change.'
      const acts = itemAliases(table, key, l?.data ?? b?.data).flatMap(
        (alias) => byItem.get(`${table}:${alias}`) ?? []
      )
      const act = acts.sort((x, y) => y.id - x.id).find(isPerson) ?? acts[0]
      const fromRow = rowWho(l?.data, since)
      const stamp = act ? null : stampFor(table)
      const apply = applies.get(table)
      if (act) {
        who = { user_id: act.user, name: name(act.user) }
        at = act.timestamp
        evidence = 'activity'
        note = `${act.action} logged on this row${isPerson(act) ? '' : ` (${act.origin ?? 'not a person'})`}.`
      } else if (fromRow) {
        who = fromRow.user ? { user_id: fromRow.user, name: name(fromRow.user) } : null
        at = fromRow.at
        evidence = 'row'
        note = 'From the row’s own “updated” columns (no activity row names it).'
      } else if (apply && (!stamp || apply.id > stamp.id)) {
        who = apply.user ? { user_id: apply.user, name: name(apply.user) } : null
        at = apply.timestamp
        evidence = 'apply'
        note = 'This table was applied from a config file here after the promotion.'
      } else if (stamp) {
        who = stamp.user ? { user_id: stamp.user, name: name(stamp.user) } : null
        at = stamp.timestamp
        evidence = 'stamp'
        note = 'Probably this save: a configuration change to this table by this person.'
      }

      const id = `${table}:${key}`
      const mark = marks.get(id)
      const liveHash = l?.hash ?? null
      const intended =
        mark && mark.action === MARK_ACTION && mark.hash === (liveHash ?? 'removed')
          ? {
              note: mark.note,
              by: mark.user,
              by_name: name(mark.user),
              at: mark.at
            }
          : null

      items.push({
        id,
        table,
        key,
        area: configArea(table),
        label: rowLabel(table, l?.data ?? b?.data),
        kind,
        fields: shownFields(fields),
        live_hash: liveHash,
        baseline_hash: b?.hash ?? null,
        who,
        at,
        evidence,
        evidence_note: note,
        intended
      })
    }
  }
  items.sort((x, y) => (y.at ?? '').localeCompare(x.at ?? '') || x.id.localeCompare(y.id))
  return { items, skipped }
}

/**
 * The open items a write would overwrite. `target` = the rows the write would make true;
 * `deletes` = it also removes live rows the target lacks (a restore does, an upsert apply does
 * not); `keys` = only these rows of the tables (an apply scoped by keys).
 * `live` = this instance's rows now (for changed/added items).
 */
export function overwrittenBy(
  items: DriftItem[],
  target: Record<string, Record<string, SnapshotRow>>,
  live: Record<string, Record<string, SnapshotRow>>,
  opts: { tables: string[]; deletes: boolean; keys?: Set<string> | null }
): DriftItem[] {
  const tables = new Set(opts.tables)
  return items.filter((it) => {
    if (it.intended || !tables.has(it.table)) return false
    if (opts.keys && !opts.keys.has(it.key)) return false
    const t = target[it.table]?.[it.key]
    if (it.kind === 'removed') return !!t
    const l = live[it.table]?.[it.key]
    if (!t) return opts.deletes
    return meaningfulFields(t.data, l?.data).length > 0
  })
}

/** What a list or a 409 carries about an item — enough to name it. */
export function brief(it: DriftItem): Pick<
  DriftItem,
  'id' | 'table' | 'key' | 'label' | 'kind' | 'at'
> & {
  who: string | null
} {
  return {
    id: it.id,
    table: it.table,
    key: it.key,
    label: it.label,
    kind: it.kind,
    at: it.at,
    who: it.who?.name ?? it.who?.user_id ?? null
  }
}

/** One line per item for a warning list. */
export function describeItem(it: DriftItem): string {
  const what = it.label ? `${it.label} (${it.table} #${it.key})` : `${it.table} #${it.key}`
  const verb = it.kind === 'added' ? 'added' : it.kind === 'removed' ? 'removed' : 'changed'
  const by = it.who?.name ? ` by ${it.who.name}` : ''
  return `${what} — ${verb} here${by}`
}
