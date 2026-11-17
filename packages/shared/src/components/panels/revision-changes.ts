// The Revision history TABLE (2026-11-17): rows are the record's saves (created, changed,
// deleted, restored), columns are its fields — the old portal's audit grid, where a person reads
// down one column to follow a field over time, computed totals such as Requisition Amount
// included. Built from the same history the timeline shows. Pure: no React, no requests.

import type { ActivityO2m } from '../../lib/activity-sentence'

export interface ChangeSourceRevision {
  id: string | null
  action: string | null
  data: Record<string, unknown> | null
  delta: Record<string, unknown> | null
  timestamp: string | null
  user_id: string | null
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
  o2m?: ActivityO2m | null
  /** A pipeline move folded into the history (from/to step labels). */
  event?: {
    kind: 'transition' | 'start'
    from_label: string | null
    to_label: string | null
    /** Set when the move was on an addendum (its own pipeline), not the record. */
    addendum?: unknown
    /** 'auto' = the pipeline moved it itself (a condition met), no person pressed anything. */
    source?: string | null
  } | null
}

/** The grid's pipeline-step column: the step the record was in at each save. */
export const STEP_FIELD = '$step'
export const STEP_LABEL = 'Pipeline step'

export interface ChangeFieldMeta {
  label: string
  system: boolean
  /** Position on the form (lower first); fields off the form sort after, by label. */
  order?: number
}

/** Who moved a recalculated total: a child-row write between two saves (Line 1, +2,059). */
export interface ChangeVia {
  name: string
  userId: string | null
  row: string
  delta: number
}

export type SaveAction = 'created' | 'changed' | 'deleted' | 'restored' | 'moved'

export interface MatrixRow {
  key: string
  timestamp: string | null
  who: string
  userId: string | null
  action: SaveAction
  /** The record as this save left it. */
  values: Record<string, unknown>
  /** Fields this save wrote whose value moved. */
  changed: Set<string>
  /** Fields that moved without this save writing them (a rollup, a status worked out). */
  recalculated: Set<string>
  /** For a recalculated total: the child writes between the two saves that moved it. */
  via: Map<string, ChangeVia[]>
  /** An automatic move: the person whose write set it off, when one is that close in time. */
  trigger?: { name: string; userId: string | null } | null
  /** An automatic move set off by a save: that save's row key (the move is folded into it). */
  linkedTo?: string | null
  /** A save that set off an automatic pipeline move: the step it moved to. The save's row
   *  carries the move — one row, the person who saved, the step changed. */
  autoMove?: { from: string | null; to: string | null } | null
}

/** How close a person's write must be for an automatic move to be credited to it. */
const TRIGGER_WINDOW_MS = 15_000

export interface MatrixColumn {
  field: string
  label: string
  /** How many saves moved it (written or recalculated). */
  changes: number
}

const isSnapshot = (r: ChangeSourceRevision) =>
  r.id != null &&
  (r.action === 'create' ||
    r.action === 'update' ||
    r.action === 'delete' ||
    r.action === 'restore')

const time = (r: { timestamp: string | null }) =>
  r.timestamp ? new Date(r.timestamp).getTime() : 0

export const sameValue = (a: unknown, b: unknown) => {
  const s = (v: unknown) =>
    v === null || v === undefined || v === ''
      ? ''
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v)
  return s(a) === s(b)
}

export function personName(r: ChangeSourceRevision): string {
  const n = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
  return n || r.user_email || (r.user_id ? 'Someone' : 'System')
}

/**
 * One row per save, newest first, each holding the record as that save left it and which fields
 * moved. `name(rev)` names who did it (the panel's actor-aware name); defaults to the person.
 */
export function buildSaveRows(
  revisions: ChangeSourceRevision[],
  opts: { name?: (r: ChangeSourceRevision) => string; withMoves?: boolean } = {}
): MatrixRow[] {
  const name = opts.name ?? personName
  const ordered = [...revisions].sort((a, b) => time(b) - time(a))
  const saves = ordered.filter(isSnapshot)
  const childWrites = ordered.filter((r) => /^o2m-/.test(String(r.action ?? '')) && r.o2m)
  // The record's own pipeline moves, oldest first (an addendum's moves are its own pipeline).
  const moves = ordered
    .filter((r) => r.event && !r.event.addendum && r.event.to_label)
    .sort((a, b) => time(a) - time(b))
  const stepAt = (t: number): string | null => {
    let step: string | null = null
    for (const m of moves) {
      if (time(m) > t) break
      step = m.event?.to_label ?? step
    }
    return step
  }
  const saveRows: MatrixRow[] = saves.map((r, i) => {
    const prev = saves[i + 1]
    const values = r.data ?? {}
    const action: SaveAction =
      r.action === 'create'
        ? 'created'
        : r.action === 'delete'
          ? 'deleted'
          : r.action === 'restore'
            ? 'restored'
            : 'changed'
    const changed = new Set<string>()
    const recalculated = new Set<string>()
    const via = new Map<string, ChangeVia[]>()
    if (prev && action !== 'created') {
      const before = prev.data ?? {}
      const own = new Set(Object.keys(r.delta ?? {}))
      for (const f of new Set([...Object.keys(before), ...Object.keys(values)])) {
        if (f === 'id' || sameValue(before[f], values[f])) continue
        // A field the save before never recorded (an integration's create stores only what it
        // sent) has no "before": its first appearance is not a change, and above all not a
        // recalculation — P2, Is Send Back… all read "Σ No" on LinX-created workflows.
        if (!(f in before) && !own.has(f)) continue
        if (own.has(f)) {
          changed.add(f)
          continue
        }
        recalculated.add(f)
        const lo = time(prev)
        const hi = time(r)
        const movers = childWrites
          .filter((c) => {
            const t = time(c)
            return t > lo && t <= hi && (c.o2m?.totals ?? []).some((x) => x.field === f)
          })
          .map((c) => ({
            name: name(c),
            userId: c.user_id ?? null,
            row: c.o2m?.row_label || c.o2m?.collection_label || 'a related row',
            delta: (c.o2m?.totals ?? []).find((x) => x.field === f)?.delta ?? 0
          }))
          .reverse()
        if (movers.length) via.set(f, movers)
      }
    }
    return {
      key: `${r.id}|${r.timestamp ?? ''}`,
      timestamp: r.timestamp,
      who: name(r),
      userId: r.user_id ?? null,
      action,
      values: moves.length ? { ...values, [STEP_FIELD]: stepAt(time(r)) } : values,
      changed,
      recalculated,
      via
    }
  })
  if (!opts.withMoves || moves.length === 0) return saveRows
  // Each move is a row of its own: the step changed, every other field as the last save left it.
  // A person's writes (saves, line edits, moves) — what an automatic move is credited to.
  const personWrites = ordered.filter((r) => r.user_id && (isSnapshot(r) || r.event || r.o2m))
  const moveRows: MatrixRow[] = moves.map((m) => {
    const t = time(m)
    const last = saveRows.find((r) => (r.timestamp ? new Date(r.timestamp).getTime() : 0) <= t)
    const automatic = !m.user_id
    // The pipeline moved the record itself because a write met a step's condition: the write
    // just before it (within a few seconds) is what set it off — usually the same instant.
    const cause = automatic
      ? personWrites
          .filter((w) => w !== m && time(w) <= t + 2000 && t - time(w) <= TRIGGER_WINDOW_MS)
          .sort((a, b) => Math.abs(t - time(a)) - Math.abs(t - time(b)))[0]
      : undefined
    return {
      key: `move|${m.timestamp ?? ''}|${m.event?.to_label ?? ''}`,
      timestamp: m.timestamp,
      who: automatic ? 'Automatic' : name(m),
      userId: m.user_id ?? null,
      trigger: cause ? { name: name(cause), userId: cause.user_id ?? null } : null,
      linkedTo: cause && isSnapshot(cause) ? `${cause.id}|${cause.timestamp ?? ''}` : null,
      action: 'moved' as const,
      values: { ...(last?.values ?? {}), [STEP_FIELD]: m.event?.to_label ?? null },
      changed: new Set([STEP_FIELD]),
      recalculated: new Set<string>(),
      via: new Map()
    }
  })
  // An automatic move set off by a save is part of that save: fold it into the save's row (the
  // step it moved to, marked changed) instead of a row of its own credited to nobody.
  const byKey = new Map(saveRows.map((r) => [r.key, r]))
  const standalone: MatrixRow[] = []
  for (const [i, mv] of moveRows.entries()) {
    const cause = mv.linkedTo ? byKey.get(mv.linkedTo) : undefined
    if (!cause) {
      standalone.push(mv)
      continue
    }
    cause.values = { ...cause.values, [STEP_FIELD]: mv.values[STEP_FIELD] ?? null }
    cause.changed = new Set([...cause.changed, STEP_FIELD])
    cause.autoMove = {
      from: moves[i].event?.from_label ?? null,
      to: moves[i].event?.to_label ?? null
    }
  }
  return [...saveRows, ...standalone].sort(
    (a, b) =>
      (b.timestamp ? new Date(b.timestamp).getTime() : 0) -
      (a.timestamp ? new Date(a.timestamp).getTime() : 0)
  )
}

/**
 * Every field the grid can show, in form order: `changes` counts the saves that moved it, so the
 * default columns are the fields that ever changed (written or recalculated). System columns
 * (audit stamps, machine columns) are left out.
 */
export function matrixColumns(
  rows: MatrixRow[],
  meta: (field: string) => ChangeFieldMeta
): MatrixColumn[] {
  const counts = new Map<string, number>()
  for (const r of rows) {
    for (const f of Object.keys(r.values)) if (!counts.has(f)) counts.set(f, 0)
    for (const f of [...r.changed, ...r.recalculated]) counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  const metaOf = (f: string): ChangeFieldMeta =>
    f === STEP_FIELD ? { label: STEP_LABEL, system: false, order: -1 } : meta(f)
  return [...counts]
    .filter(([f]) => f !== 'id' && !metaOf(f).system)
    .map(([field, changes]) => ({ field, label: metaOf(field).label, changes }))
    .sort((a, b) => {
      const oa = metaOf(a.field).order ?? Number.POSITIVE_INFINITY
      const ob = metaOf(b.field).order ?? Number.POSITIVE_INFINITY
      return oa - ob || a.label.localeCompare(b.label)
    })
}

/** The saves that moved any of `fields` (plus the creation, the start of every column). */
export function rowsChanging(rows: MatrixRow[], fields: string[]): MatrixRow[] {
  return rows.filter(
    (r) =>
      (r.action !== 'changed' && r.action !== 'moved') ||
      fields.some((f) => r.changed.has(f) || r.recalculated.has(f))
  )
}

/** A total's move as text: "+2,059", "−50". */
export function signedAmount(delta: number): string {
  const abs = Math.abs(delta).toLocaleString('en-US', { maximumFractionDigits: 2 })
  return `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${abs}`
}

/** "Recalculated after Richard Peart · Line 1 +2,059" — the people behind a moved total. */
export function viaText(via: ChangeVia[] | undefined): string {
  if (!via?.length) return 'Recalculated'
  return `Recalculated after ${via.map((v) => `${v.name} · ${v.row} ${signedAmount(v.delta)}`).join(', ')}`
}

const ACTION_LABEL: Record<SaveAction, string> = {
  created: 'Created',
  changed: 'Changed',
  deleted: 'Deleted',
  restored: 'Restored',
  moved: 'Moved'
}
export const saveActionLabel = (a: SaveAction) => ACTION_LABEL[a]

/**
 * One CSV cell. A value a spreadsheet would run as a formula (=, +, -, @, tab, CR first) gets a
 * leading apostrophe — record values are typed by other people (formula injection); a plain
 * negative number stays a number. Exported for tests.
 */
export function csvCell(raw: string): string {
  let v = raw
  if (/^[=+\-@\t\r]/.test(v) && !/^-?\d[\d,]*(\.\d+)?$/.test(v)) v = `'${v}`
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** The grid as CSV, values as the reader sees them (`text`), for auditors who keep a copy. */
export function matrixCsv(
  rows: MatrixRow[],
  columns: MatrixColumn[],
  text: (field: string, value: unknown) => string,
  reason?: (field: string, row: MatrixRow) => RecalcReason
): string {
  const esc = csvCell
  const head = ['When', 'Changed by', 'Action', ...columns.map((c) => c.label), 'Recalculated']
  const lines = [head.map(esc).join(',')]
  for (const r of rows) {
    const recalculated = [...r.recalculated]
      .filter((f) => columns.some((c) => c.field === f))
      .map((f) => {
        const label = columns.find((c) => c.field === f)?.label ?? f
        if (!reason) return `${label}: ${viaText(r.via.get(f))}`
        const why = reason(f, r)
        return `${label}: ${why.why}${why.because ? ` — ${why.because}` : ''}`
      })
      .join('; ')
    lines.push(
      [
        r.timestamp ? new Date(r.timestamp).toLocaleString('en-US') : '',
        r.who,
        saveActionLabel(r.action),
        ...columns.map((c) => text(c.field, r.values[c.field])),
        recalculated
      ]
        .map((v) => esc(String(v ?? '')))
        .join(',')
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

// ─── Why a value was recalculated ───────────────────────────────────────────

/** How a field is worked out, read from its config (computed_type + computed_formula). */
export type DeriveInfo =
  | {
      kind: 'rollup'
      sources: Array<{ collection: string; field: string; aggregate: string; filtered: boolean }>
    }
  | { kind: 'formula'; inputs: string[] }
  | { kind: 'lookup'; fk: string; source: string }

const parseObj = (v: unknown): Record<string, unknown> | null => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v !== 'string' || !v.trim()) return null
  try {
    const p = JSON.parse(v) as unknown
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The field's derivation, or null for a plain field (set by people, rules, jobs, integrations). */
export function deriveOf(computedType: unknown, computedFormula: unknown): DeriveInfo | null {
  const type = String(computedType ?? '')
  if (type === 'rollup') {
    const cfg = parseObj(computedFormula)
    const list = Array.isArray(cfg?.sources) ? (cfg?.sources as Array<Record<string, unknown>>) : []
    const sources = list
      .filter((s) => typeof s.related_collection === 'string')
      .map((s) => ({
        collection: String(s.related_collection),
        field: String(s.value_field ?? ''),
        aggregate: String(s.aggregate ?? 'sum'),
        filtered: !!s.filter && Object.keys(s.filter as object).length > 0
      }))
    return sources.length ? { kind: 'rollup', sources } : null
  }
  if (type === 'lookup') {
    const cfg = parseObj(computedFormula)
    if (!cfg?.fk_field || !cfg?.source_field) return null
    return { kind: 'lookup', fk: String(cfg.fk_field), source: String(cfg.source_field) }
  }
  if (type === 'write' || type === 'read') {
    const inputs = [
      ...new Set(
        [...String(computedFormula ?? '').matchAll(/\{\{\s*([A-Za-z_][\w]*)/g)].map((m) => m[1])
      )
    ]
    return { kind: 'formula', inputs }
  }
  return null
}

const AGG_WORD: Record<string, string> = {
  sum: 'Sum',
  count: 'Count',
  avg: 'Average',
  min: 'Lowest',
  max: 'Highest',
  median: 'Median',
  distinct_count: 'Distinct count',
  weighted_avg: 'Weighted average'
}

const listWords = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

export interface RecalcReason {
  /** What the value is worked out from: "Sum of Workflow Line Items · Amount (filtered)". */
  why: string
  /** What moved it at this save, when the history knows: "Richard Peart changed Line 1 (+$2,059.00)". */
  because?: string
}

/**
 * Why `field` moved on `row` without that save writing it. `label(collection, field?)` names a
 * collection or one of its fields; `money(delta)` formats a total's move in the field's format.
 */
export function recalcReason(
  field: string,
  row: MatrixRow,
  derive: DeriveInfo | null,
  label: (collection: string | null, field?: string) => string,
  money: (delta: number) => string = signedAmount
): RecalcReason {
  const via = row.via.get(field)
  const movedBy = via?.length
    ? via.map((v) => `${v.name} changed ${v.row} (${money(v.delta)})`).join('; ')
    : undefined
  if (derive?.kind === 'rollup') {
    const parts = derive.sources.map((s) => {
      const agg = AGG_WORD[s.aggregate] ?? 'Total'
      const what =
        s.aggregate === 'count'
          ? label(s.collection)
          : `${label(s.collection)} · ${label(s.collection, s.field)}`
      return `${agg} of ${what}${s.filtered ? ' (filtered)' : ''}`
    })
    return {
      why: parts.join(' + '),
      because: movedBy ?? 'Its rows changed between these two saves'
    }
  }
  if (derive?.kind === 'formula') {
    const moved = derive.inputs.filter((f) => row.changed.has(f) || row.recalculated.has(f))
    return {
      why: derive.inputs.length
        ? `Worked out from ${listWords(derive.inputs.map((f) => label(null, f)))}`
        : 'Worked out by a formula',
      because: moved.length
        ? `${listWords(moved.map((f) => label(null, f)))} changed`
        : (movedBy ?? undefined)
    }
  }
  if (derive?.kind === 'lookup') {
    return {
      why: `Copied from ${label(null, derive.fk)} (${derive.source.replace(/_/g, ' ')})`,
      because: row.changed.has(derive.fk) ? `${label(null, derive.fk)} changed` : undefined
    }
  }
  return {
    why: 'Set automatically (rule, job or integration)',
    because: movedBy
  }
}

/** A line column's value at a moment: the last point at or before it. */
export function valueAt(series: Array<{ t: string; v: unknown }>, at: string | null): unknown {
  if (!at) return null
  const t = new Date(at).getTime()
  let v: unknown = null
  for (const p of series) {
    if (new Date(p.t).getTime() > t) break
    v = p.v
  }
  return v
}

/** GET /revisions/child-columns — the rows behind the record's totals, value over time. */
export interface ChildColumnsData {
  columns: Array<{
    key: string
    collection: string
    collection_label: string
    id: string
    row_label: string
    field: string
    field_label: string
    cmp: {
      field: string
      type: string | null
      interface: string | null
      options: unknown
      display_options: unknown
    }
  }>
  series: Record<string, Array<{ t: string; v: unknown }>>
}

/** GET /revisions/link-labels: field → id a snapshot holds → what it points at. */
export interface LinkLabelsData {
  fields: Record<string, Record<string, { target: string; label: string }>>
}

/**
 * The history with every to-many field's link ids read as what they point at ("Zone 3, Zone 4",
 * sorted), so a rewrite of the links that kept the same Zones is no change at all. Ids the reader
 * may not see read as a count ("2 linked"), never as ids. Fields the server named only; other
 * arrays are left alone. Pure; exported for tests.
 */
export function withLinkLabels<T extends { data?: Record<string, unknown> | null }>(
  revisions: T[],
  links: LinkLabelsData | null | undefined
): T[] {
  const fields = links?.fields ?? {}
  const names = Object.keys(fields)
  if (names.length === 0) return revisions
  return revisions.map((r) => {
    if (!r.data) return r
    let next: Record<string, unknown> | null = null
    for (const f of names) {
      const v = r.data[f]
      if (!Array.isArray(v)) continue
      const map = fields[f]
      const labels: string[] = []
      let unknown = 0
      for (const raw of v) {
        const id =
          raw && typeof raw === 'object' ? (raw as Record<string, unknown>).id : (raw as unknown)
        const hit = id == null ? undefined : map[String(id)]
        if (hit) labels.push(hit.label)
        else unknown++
      }
      labels.sort((a, b) => a.localeCompare(b))
      // Links the reader can't name (no access, a file, gone) read as a count, never as ids.
      const rest =
        unknown === 0 ? [] : labels.length === 0 ? [`${unknown} linked`] : [`+${unknown} more`]
      const text = [...new Set(labels), ...rest].join(', ')
      next = next ?? { ...r.data }
      next[f] = v.length === 0 ? null : text
    }
    return next ? { ...r, data: next } : r
  })
}
