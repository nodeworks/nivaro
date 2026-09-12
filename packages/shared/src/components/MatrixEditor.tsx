import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../context'
import { get, patch, post } from '../lib/commands'
import { evaluateNumeric } from '../lib/expression'
import { cn } from '../lib/utils'
import { RelationCombobox } from './item-edit/RelationCombobox'

// Generic tuple-scoped value editor. Base shape (EFP ProjectTypeBudgetForm):
// scope pickers → one row per OPTION with current value + input → upsert.
// Extended shape (EFP ManageAllocations): OPTION rows grouped under GROUP
// sections (e.g. categories × regions), synthetic Uncategorized/Inventory
// buckets, a misallocated line for target rows matching no cell, per-cell
// metric columns from a custom query, seeds derived from a scope record, and
// a live cap strip with client-side clamping. Fully config-driven.
export interface MatrixEditorConfig {
  title?: string
  target_collection: string
  option_collection: string
  /** Plain display column (default 'name') — or use option_label_template. */
  option_label?: string
  /** Dotted display template, e.g. '{{core_category.name}} - {{sub_category.name}}'. */
  option_label_template?: string
  /** Filter for the option fetch. '$scope.<field>' tokens resolve from scope. */
  option_filter?: Record<string, unknown>
  key_field: string
  value_field: string
  value_label?: string
  value_format?: 'currency' | 'number'
  /** Scope pickers. `filter` narrows a picker's options; '$scope.<field>'
   *  tokens resolve from the other scope values (EFP: sub types limited to the
   *  chosen project's linked sub types) — unresolved tokens drop the filter. */
  scope_fields: Array<{
    field: string
    collection: string
    label?: string
    filter?: Record<string, unknown>
  }>
  /** Third level: sub-group options WITHIN a group section by a template over
   *  the option record (EFP region → core category → Labor/Materials/Equipment:
   *  label_template '{{core_category.name}}', row_label_template
   *  '{{sub_category.name}}'). Sub-headers aggregate their children and
   *  collapse independently. */
  option_section?: {
    label_template: string
    /** Leaf row label; defaults to the full option label. */
    row_label_template?: string
  }
  /** Second axis: sections per group record; target rows keyed (key, group, scope). */
  group?: {
    field: string
    collection: string
    label_field?: string
    filter?: Record<string, unknown>
  }
  /** Extra seeds on created rows, '$<scopeField>.<path>' — path may be dotted
   *  and use [n] (e.g. '$project.funding_years[0].funding_year'). */
  scope_seeds?: Record<string, string>
  /** Auto-fill a scope picker from another scope record when empty, e.g.
   *  {project_sub_type: '$project.default_sub_type'} (EFP default sub type). */
  scope_defaults?: Record<string, string>
  /** Seeds copied from the GROUP record onto rows created in that section,
   *  {targetField: groupField} — e.g. {division: 'division'} (allocation rows
   *  carry the region's division, not one picked from the project). */
  group_seeds?: Record<string, string>
  /** Cap strip: cap value read from a scope record's field; total of all cells
   *  is clamped so it never exceeds the cap (server sum_cap should back this). */
  cap?: { scope_field: string; field: string; label?: string }
  /** Synthetic rows per group for target rows with a NULL key (Uncategorized)
   *  and/or a boolean bucket flag (Inventory: rows with flag true, key null). */
  specials?: {
    uncategorized?: { label?: string; metric_value?: number | null }
    bucket?: { flag_field: string; label?: string; metric_value?: number | null }
  }
  /** Per-cell read-only metric columns from a custom query. */
  metrics?: {
    query_slug: string
    params?: Record<string, unknown>
    match_option_field: string
    match_group_field?: string
    columns: Array<{ field: string; label?: string; format?: 'currency' | 'number' }>
    /** Computed columns over the row: `{{__current__}}` (saved value),
     *  `{{__new__}}` (live value incl. the edit) and any metric field —
     *  e.g. Remaining = `{{__new__}} - {{current_spend}} - {{committed_costs}}`.
     *  Aggregated levels sum the inputs first, then apply the formula. */
    derived?: Array<{ label: string; formula: string; format?: 'currency' | 'number' }>
    /** Metric rows that match no rendered cell still count: shown read-only as
     *  an "Other …" row per group (options outside the project's list) and an
     *  "Other …" group (groups outside the project's list), so the totals
     *  reconcile with the project-level figures. */
    unmatched?: { option_label?: string; group_label?: string } | false
  }
}

const UNCAT = '__uncat__'
const BUCKET = '__bucket__'

function resolveScopeTokens(
  filter: Record<string, unknown> | undefined,
  scope: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!filter) return undefined
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('$scope.')) return scope[v.slice('$scope.'.length)]
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)])
      )
    return v
  }
  return walk(filter) as Record<string, unknown>
}

/** True when any leaf of a resolved filter is undefined (an unresolved
 *  '$scope.' token) — callers drop the filter rather than send a broken one. */
function hasUnresolved(v: unknown): boolean {
  if (v === undefined) return true
  if (Array.isArray(v)) return v.some(hasUnresolved)
  if (v && typeof v === 'object') return Object.values(v).some(hasUnresolved)
  return false
}

/** Walk 'a.b[0].c' through a nested object. Dotted alias paths resolved via
 *  resolve-paths are stored FLAT under their literal path key ([n] stripped) —
 *  check that first, then fall back to a segment walk. */
function walkPath(root: unknown, path: string): unknown {
  if (root && typeof root === 'object') {
    const literal = path.replace(/\[\d+\]/g, '')
    if (literal in (root as Record<string, unknown>)) {
      return (root as Record<string, unknown>)[literal] ?? null
    }
  }
  const segs = path.split('.').flatMap((s) => {
    const m = /^(\w+)\[(\d+)\]$/.exec(s)
    return m ? [m[1], Number(m[2])] : [s]
  })
  let v: unknown = root
  for (const seg of segs) {
    if (v == null || typeof v !== 'object') return null
    v = (v as Record<string | number, unknown>)[seg as string | number]
  }
  return v ?? null
}

function applyTemplate(tmpl: string, row: Record<string, unknown>): string {
  return tmpl.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_, p: string) => {
    const v = walkPath(row, p)
    return v == null ? '' : String(v)
  })
}

function fmtVal(v: unknown, format?: 'currency' | 'number'): string {
  const n = Number(v)
  if (v == null || v === '' || !Number.isFinite(n)) return '—'
  return format === 'currency'
    ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    : n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

type Cell = { ids: unknown[]; total: number }

export function MatrixEditor({
  config,
  initialScope,
  lockScope = false
}: {
  config: MatrixEditorConfig
  /** Pre-seed scope pickers (drill-down hosts scope the matrix to a record). */
  initialScope?: Record<string, unknown>
  /** Scope fields supplied by initialScope render as fixed context, not pickers
   *  (a sheet already scoped to one project). */
  lockScope?: boolean
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [scope, setScope] = useState<Record<string, unknown>>(initialScope ?? {})
  const initScopeRef = useRef(initialScope)
  useEffect(() => {
    if (initScopeRef.current === initialScope) return
    initScopeRef.current = initialScope
    if (initialScope) setScope((p) => ({ ...p, ...initialScope }))
  }, [initialScope])
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const scopeReady = config.scope_fields.every(
    (s) => scope[s.field] !== null && scope[s.field] !== undefined && scope[s.field] !== ''
  )
  const labelField = config.option_label ?? 'name'
  const scopeKey = JSON.stringify(scope)
  const groupCfg = config.group

  // Option label template needs dotted fields fetched.
  const optionFields = useMemo(() => {
    const templates = [
      config.option_label_template,
      config.option_section?.label_template,
      config.option_section?.row_label_template
    ].filter((t): t is string => !!t)
    if (templates.length === 0) return `id,${labelField}`
    const refs = templates.flatMap((t) =>
      [...t.matchAll(/\{\{\s*([\w.[\]]+)\s*\}\}/g)].map((m) => m[1].replace(/\[\d+\]/g, ''))
    )
    // labelField only when actually used as the option label — it may not be a
    // real column when templates drive all labels.
    if (!config.option_label_template) refs.push(labelField)
    return ['id', ...new Set(refs)].join(',')
  }, [config.option_label_template, config.option_section, labelField])

  const { data: options = [], isLoading: optsLoading } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['matrix-options', config.option_collection, optionFields, scopeKey],
    queryFn: () => {
      const filter = resolveScopeTokens(config.option_filter, scope)
      return client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${config.option_collection}`, {
            limit: 500,
            fields: optionFields,
            ...(filter ? { filter: JSON.stringify(filter) } : {})
          })
        )
        .then((r) => r.data ?? [])
    },
    enabled: scopeReady,
    staleTime: 30_000
  })

  const { data: groups = [] } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['matrix-groups', groupCfg?.collection, scopeKey],
    queryFn: () => {
      const filter = resolveScopeTokens(groupCfg?.filter, scope)
      return client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${groupCfg!.collection}`, {
            limit: 200,
            fields: [
              'id',
              groupCfg!.label_field ?? 'name',
              ...Object.values(config.group_seeds ?? {})
            ].join(','),
            ...(filter ? { filter: JSON.stringify(filter) } : {})
          })
        )
        .then((r) => r.data ?? [])
    },
    enabled: scopeReady && !!groupCfg,
    staleTime: 30_000
  })

  const targetFields = useMemo(() => {
    const f = ['id', config.key_field, config.value_field]
    if (groupCfg) f.push(groupCfg.field)
    if (config.specials?.bucket) f.push(config.specials.bucket.flag_field)
    return f.join(',')
  }, [config, groupCfg])

  const { data: targets = [], isLoading: tgtLoading } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['matrix-targets', config.target_collection, scopeKey],
    queryFn: () => {
      const filter: Record<string, unknown> = {}
      for (const s of config.scope_fields) filter[s.field] = { _eq: scope[s.field] }
      return client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${config.target_collection}`, {
            limit: 2000,
            fields: targetFields,
            filter: JSON.stringify(filter)
          })
        )
        .then((r) => r.data ?? [])
    },
    enabled: scopeReady,
    staleTime: 0
  })

  // Scope records needed for seeds + cap.
  const seedScopeFields = useMemo(() => {
    const map = new Map<string, Set<string>>()
    const register = (expr: unknown) => {
      if (typeof expr !== 'string') return
      const m = /^\$(\w+)\.(.+)$/.exec(expr)
      if (!m || m[1] === 'scope') return
      const set = map.get(m[1]) ?? new Set<string>()
      set.add(m[2].replace(/\[\d+\]/g, ''))
      map.set(m[1], set)
    }
    for (const expr of Object.values(config.scope_seeds ?? {})) register(expr)
    for (const expr of Object.values(config.scope_defaults ?? {})) register(expr)
    for (const expr of Object.values(config.metrics?.params ?? {})) register(expr)
    if (config.cap) {
      const set = map.get(config.cap.scope_field) ?? new Set<string>()
      set.add(config.cap.field)
      map.set(config.cap.scope_field, set)
    }
    return map
  }, [config.scope_seeds, config.scope_defaults, config.metrics, config.cap])

  const { data: scopeRecords = {} } = useQuery<Record<string, Record<string, unknown>>>({
    queryKey: ['matrix-scope-records', scopeKey, [...seedScopeFields.keys()].join(',')],
    queryFn: async () => {
      const out: Record<string, Record<string, unknown>> = {}
      for (const [scopeField, fields] of seedScopeFields) {
        const sf = config.scope_fields.find((s) => s.field === scopeField)
        const id = scope[scopeField]
        if (!sf || id == null) continue
        const plain = [...fields].filter((f) => !f.includes('.'))
        const dotted = [...fields].filter((f) => f.includes('.'))
        const rec = await client
          .request<{ data: Record<string, unknown> }>(
            get(`/items/${sf.collection}/${id}`, { fields: ['id', ...plain].join(',') })
          )
          .then((r) => r.data)
          .catch(() => null)
        if (!rec) continue
        if (dotted.length > 0) {
          // Dotted alias paths (funding_years.funding_year) can't ride the
          // items fields param — resolve-paths handles to-many tails. Stored
          // flat under the literal path; walkPath checks that first. Prefer
          // ids (raw FK values) over the joined display string.
          const resolved = await client
            .request<{ data: Record<string, { value: unknown; ids?: unknown[] }> }>(
              get(`/items/${sf.collection}/${id}/resolve-paths`, { paths: dotted.join(',') })
            )
            .then((r) => r.data ?? {})
            .catch(() => ({}) as Record<string, { value: unknown; ids?: unknown[] }>)
          for (const [path, entry] of Object.entries(resolved)) {
            rec[path] = entry?.ids && entry.ids.length > 0 ? entry.ids[0] : (entry?.value ?? null)
          }
        }
        out[scopeField] = rec
      }
      return out
    },
    // Per-field, not scopeReady — scope_defaults must resolve while other
    // pickers are still empty (project → default sub type).
    enabled:
      seedScopeFields.size > 0 &&
      [...seedScopeFields.keys()].some(
        (f) => scope[f] !== null && scope[f] !== undefined && scope[f] !== ''
      ),
    staleTime: 30_000
  })

  // Auto-fill empty scope pickers from loaded scope records (EFP: sub type
  // defaults to the project's default_sub_type).
  useEffect(() => {
    if (!config.scope_defaults) return
    for (const [field, expr] of Object.entries(config.scope_defaults)) {
      if (scope[field] != null && scope[field] !== '') continue
      const m = /^\$(\w+)\.(.+)$/.exec(expr)
      if (!m) continue
      const v = walkPath(scopeRecords[m[1]] ?? {}, m[2])
      if (v != null && v !== '') setScope((p) => ({ ...p, [field]: v }))
    }
  }, [scopeRecords, config.scope_defaults, scope])

  // Metrics from a custom query, matched per (option, group).
  const { data: metricRows = [] } = useQuery<Array<Record<string, unknown>>>({
    queryKey: [
      'matrix-metrics',
      config.metrics?.query_slug,
      scopeKey,
      Object.keys(scopeRecords).length
    ],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          post(`/custom-queries/${config.metrics!.query_slug}/execute`, {
            params: Object.fromEntries(
              Object.entries(config.metrics?.params ?? {}).map(([k, v]) => {
                if (typeof v === 'string' && v.startsWith('$scope.'))
                  return [k, scope[v.slice('$scope.'.length)]]
                if (typeof v === 'string' && v.startsWith('$')) {
                  const m = /^\$(\w+)\.(.+)$/.exec(v)
                  if (m) return [k, walkPath(scopeRecords[m[1]] ?? {}, m[2])]
                }
                return [k, v]
              })
            )
          })
        )
        .then((r) => r.data ?? []),
    enabled:
      scopeReady &&
      !!config.metrics &&
      (seedScopeFields.size === 0 || Object.keys(scopeRecords).length > 0),
    staleTime: 30_000
  })

  // Cell key: `${groupId}|${optionKey}` (group '' when ungrouped).
  const cellKeyOf = (t: Record<string, unknown>): string => {
    const g = groupCfg ? String(t[groupCfg.field] ?? '') : ''
    const bucket = config.specials?.bucket
    if (bucket && (t[bucket.flag_field] === true || t[bucket.flag_field] === 1))
      return `${g}|${BUCKET}`
    const k = t[config.key_field]
    return `${g}|${k == null ? UNCAT : String(k)}`
  }

  const cells = useMemo(() => {
    const m = new Map<string, Cell>()
    for (const t of targets) {
      const k = cellKeyOf(t)
      const c = m.get(k) ?? { ids: [], total: 0 }
      c.ids.push(t.id)
      c.total += Number(t[config.value_field]) || 0
      m.set(k, c)
    }
    return m
    // biome-ignore lint/correctness/useExhaustiveDependencies: cellKeyOf derives from config (stable per mount)
  }, [targets, config.value_field])

  const metricFor = (groupId: string, optionKey: string): Record<string, number> => {
    const mc = config.metrics
    const out: Record<string, number> = {}
    if (!mc) return out
    const wantOption =
      optionKey === UNCAT
        ? (config.specials?.uncategorized?.metric_value ?? null)
        : optionKey === BUCKET
          ? (config.specials?.bucket?.metric_value ?? null)
          : optionKey
    for (const r of metricRows) {
      if (mc.match_group_field && String(r[mc.match_group_field] ?? '') !== groupId) continue
      const mv = r[mc.match_option_field]
      // A special's metric_value of null OR 0 both mean "the query's
      // uncategorized rows" (category_id NULL, or 0 from a COALESCE).
      const wantsEmpty = wantOption === null || wantOption === 0 || wantOption === '0'
      const isEmpty = mv == null || mv === 0 || mv === '0' || mv === ''
      const matches = wantsEmpty ? isEmpty : String(mv ?? '') === String(wantOption)
      if (!matches) continue
      for (const col of mc.columns)
        out[col.field] = (out[col.field] ?? 0) + (Number(r[col.field]) || 0)
    }
    return out
  }

  // Rows model: per group → option rows (+ specials + misallocated line).
  const optionRows = useMemo(() => {
    const label = (o: Record<string, unknown>) =>
      config.option_label_template
        ? applyTemplate(config.option_label_template, o)
        : String(o[labelField] ?? o.id)
    const sec = config.option_section
    return [...options]
      .map((o) => {
        const full = label(o)
        const section = sec ? applyTemplate(sec.label_template, o) : ''
        const rowLabel = sec?.row_label_template
          ? applyTemplate(sec.row_label_template, o) || full
          : full
        return { key: String(o.id), label: sec ? rowLabel : full, section }
      })
      .sort((a, b) => a.section.localeCompare(b.section) || a.label.localeCompare(b.label))
  }, [options, config.option_label_template, config.option_section, labelField])

  const optionSections = useMemo(() => {
    if (!config.option_section) return []
    const m = new Map<string, typeof optionRows>()
    for (const o of optionRows) {
      const arr = m.get(o.section) ?? []
      arr.push(o)
      m.set(o.section, arr)
    }
    return [...m.entries()].map(([name, rows]) => ({ name, rows }))
  }, [optionRows, config.option_section])

  // Groups start collapsed except those already holding target rows (EFP
  // allocate-drawer behavior); re-init when the scope changes.
  const collapseInitRef = useRef<string | null>(null)
  useEffect(() => {
    if (!groupCfg || groups.length === 0 || tgtLoading) return
    // Sections arrive with the (slower) options query — re-init once when they
    // land so sub-sections also start collapsed.
    const initKey = `${scopeKey}#${config.option_section && optionSections.length > 0 ? 1 : 0}`
    if (collapseInitRef.current === initKey) return
    collapseInitRef.current = initKey
    const withRows = new Set([...cells.keys()].map((k) => k.split('|')[0]))
    const next = new Set(groups.map((g) => String(g.id)).filter((id) => !withRows.has(id)))
    // Sub-sections: collapsed unless one of their options holds a target row.
    if (config.option_section) {
      const cellKeys = new Set(cells.keys())
      for (const g of groups) {
        const gid = String(g.id)
        for (const sec of optionSections) {
          if (!sec.rows.some((o) => cellKeys.has(`${gid}|${o.key}`)))
            next.add(`s:${gid}|${sec.name}`)
        }
      }
    }
    setCollapsed(next)
  }, [groups, cells, tgtLoading, scopeKey, groupCfg, optionSections, config.option_section])

  const groupRows = useMemo(() => {
    if (!groupCfg) return [{ id: '', label: '' }]
    return [...groups]
      .map((g) => ({ id: String(g.id), label: String(g[groupCfg.label_field ?? 'name'] ?? g.id) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [groups, groupCfg])

  // Misallocated: target rows whose cell doesn't map to a rendered row.
  const renderedKeys = useMemo(() => {
    const set = new Set<string>()
    for (const g of groupRows) {
      for (const o of optionRows) set.add(`${g.id}|${o.key}`)
      if (config.specials?.uncategorized) set.add(`${g.id}|${UNCAT}`)
      if (config.specials?.bucket) set.add(`${g.id}|${BUCKET}`)
    }
    return set
  }, [groupRows, optionRows, config.specials])

  const misallocatedTotal = useMemo(() => {
    let sum = 0
    for (const [k, c] of cells) if (!renderedKeys.has(k)) sum += c.total
    return sum
  }, [cells, renderedKeys])

  // Cap math — live over inputs.
  const capValue = config.cap
    ? Number(walkPath(scopeRecords[config.cap.scope_field] ?? {}, config.cap.field)) || 0
    : null
  const totalCurrent = useMemo(() => [...cells.values()].reduce((s, c) => s + c.total, 0), [cells])
  const totalWithEdits = useMemo(() => {
    let sum = misallocatedTotal
    for (const g of groupRows) {
      const keys = [
        ...optionRows.map((o) => o.key),
        ...(config.specials?.uncategorized ? [UNCAT] : []),
        ...(config.specials?.bucket ? [BUCKET] : [])
      ]
      for (const k of keys) {
        const ck = `${g.id}|${k}`
        const raw = edits[ck]
        if (raw !== undefined && raw.trim() !== '' && !Number.isNaN(Number(raw))) sum += Number(raw)
        else sum += cells.get(ck)?.total ?? 0
      }
    }
    return sum
  }, [edits, cells, groupRows, optionRows, misallocatedTotal, config.specials])
  const available = capValue !== null ? capValue - totalWithEdits : null

  /** Live value of a cell: the edit when set, else the saved total. */
  const liveValue = (cellKey: string): number => {
    const e = edits[cellKey]
    if (e !== undefined && e.trim() !== '' && !Number.isNaN(Number(e))) return Number(e)
    return cells.get(cellKey)?.total ?? 0
  }

  /** Input entry: absolute ("1200"), or relative to the saved value with a
   *  leading sign ("+500" / "-250"). Clamped so the grand total never passes
   *  the cap. */
  function commitEdit(cellKey: string, raw: string) {
    const trimmed = raw.trim()
    if (trimmed === '') {
      setEdits((p) => ({ ...p, [cellKey]: raw }))
      return
    }
    const relative = /^[+-]/.test(trimmed) && trimmed !== '-' && trimmed !== '+'
    let num = Number(trimmed)
    if (Number.isNaN(num)) {
      // keep the keystrokes ("-", "+", "1.") so typing isn't fought
      setEdits((p) => ({ ...p, [cellKey]: raw }))
      return
    }
    if (relative) num = (cells.get(cellKey)?.total ?? 0) + num
    if (num < 0) num = 0
    if (capValue !== null) {
      const othersTotal = totalWithEdits - liveValue(cellKey)
      const max = Math.max(0, capValue - othersTotal)
      num = Math.min(num, max)
    }
    setEdits((p) => ({ ...p, [cellKey]: relative ? String(num) : raw }))
  }

  async function save() {
    setSaving(true)
    setStatus(null)
    let updated = 0
    let created = 0
    try {
      // Resolve seeds once.
      const seeds: Record<string, unknown> = {}
      for (const [field, expr] of Object.entries(config.scope_seeds ?? {})) {
        const m = /^\$(\w+)\.(.+)$/.exec(expr)
        if (!m) continue
        seeds[field] = walkPath(scopeRecords[m[1]] ?? {}, m[2])
      }
      for (const [cellKey, raw] of Object.entries(edits)) {
        if (raw.trim() === '') continue
        const num = Number(raw)
        if (Number.isNaN(num) || num < 0) continue
        const existing = cells.get(cellKey)
        if (existing && existing.total === num) continue
        if (existing) {
          await client.request(
            patch(`/items/${config.target_collection}/${existing.ids[0]}`, {
              [config.value_field]: num
            })
          )
          updated++
        } else {
          const [groupId, optionKey] = cellKey.split('|')
          const seed: Record<string, unknown> = { [config.value_field]: num, ...seeds }
          for (const s of config.scope_fields) seed[s.field] = scope[s.field]
          if (groupCfg && groupId) {
            seed[groupCfg.field] = groupId
            const groupRec = groups.find((g) => String(g.id) === groupId)
            for (const [field, src] of Object.entries(config.group_seeds ?? {})) {
              const v = groupRec?.[src]
              if (v !== null && v !== undefined) seed[field] = v
            }
          }
          if (optionKey === BUCKET && config.specials?.bucket) {
            seed[config.key_field] = null
            seed[config.specials.bucket.flag_field] = true
          } else if (optionKey === UNCAT) {
            seed[config.key_field] = null
          } else {
            seed[config.key_field] = optionKey
          }
          await client.request(post(`/items/${config.target_collection}`, seed))
          created++
        }
      }
      setEdits({})
      await qc.invalidateQueries({ queryKey: ['matrix-targets', config.target_collection] })
      setStatus(`Saved — ${updated} updated, ${created} created`)
    } catch (err) {
      setStatus(`Save failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  const dirty = Object.values(edits).some((v) => v.trim() !== '')
  const metricCols = config.metrics?.columns ?? []
  const derivedCols = config.metrics?.derived ?? []
  const valueLabel = config.value_label ?? config.value_field
  const numCols = 1 + metricCols.length + derivedCols.length + 1

  // ── Unmatched metric rows: kept, shown read-only, so totals reconcile ──
  const unmatchedCfg =
    config.metrics?.unmatched === false ? null : (config.metrics?.unmatched ?? {})
  const unmatched = useMemo(() => {
    const perGroup = new Map<string, Record<string, number>>()
    const otherGroup: Record<string, number> = {}
    let otherGroupCount = 0
    const mc = config.metrics
    if (!mc || !unmatchedCfg) return { perGroup, otherGroup, otherGroupCount }
    const groupIds = new Set(groupRows.map((g) => g.id))
    const optionKeys = new Set(optionRows.map((o) => o.key))
    const specialValues = new Set<string>()
    const norm = (v: unknown) => (v == null || v === 0 || v === '0' || v === '' ? '' : String(v))
    if (config.specials?.uncategorized)
      specialValues.add(norm(config.specials.uncategorized.metric_value))
    if (config.specials?.bucket) specialValues.add(norm(config.specials.bucket.metric_value))
    for (const r of metricRows) {
      const g = mc.match_group_field ? String(r[mc.match_group_field] ?? '') : ''
      const mv = r[mc.match_option_field]
      const optionMatched = optionKeys.has(String(mv ?? '')) || specialValues.has(norm(mv))
      const target =
        !groupCfg || groupIds.has(g) ? (optionMatched ? null : (perGroup.get(g) ?? {})) : otherGroup
      if (!target) continue
      for (const c of mc.columns)
        target[c.field] = (target[c.field] ?? 0) + (Number(r[c.field]) || 0)
      if (!groupCfg || groupIds.has(g)) perGroup.set(g, target)
      else otherGroupCount++
    }
    return { perGroup, otherGroup, otherGroupCount }
  }, [metricRows, config.metrics, config.specials, groupRows, optionRows, groupCfg, unmatchedCfg])

  const derive = (current: number, next: number, metrics: Record<string, number>) =>
    derivedCols.map((d) =>
      evaluateNumeric(
        d.formula,
        { ...metrics, __current__: current, __new__: next },
        { missing: 'zero' }
      )
    )

  const sumMetrics = (list: Array<Record<string, number>>): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const m of list)
      for (const c of metricCols) out[c.field] = (out[c.field] ?? 0) + (m[c.field] ?? 0)
    return out
  }

  const allKeysFor = () => [
    ...optionRows.map((o) => o.key),
    ...(config.specials?.uncategorized ? [UNCAT] : []),
    ...(config.specials?.bucket ? [BUCKET] : [])
  ]

  // Grand totals across every rendered group (+ unmatched rows).
  const grand = useMemo(() => {
    let current = 0
    let next = 0
    const metricsList: Array<Record<string, number>> = []
    for (const g of groupRows) {
      for (const k of allKeysFor()) {
        const ck = `${g.id}|${k}`
        current += cells.get(ck)?.total ?? 0
        next += liveValue(ck)
        metricsList.push(metricFor(g.id, k))
      }
      const um = unmatched.perGroup.get(g.id)
      if (um) metricsList.push(um)
    }
    metricsList.push(unmatched.otherGroup)
    current += misallocatedTotal
    next += misallocatedTotal
    return { current, next, metrics: sumMetrics(metricsList) }
    // biome-ignore lint/correctness/useExhaustiveDependencies: liveValue/metricFor close over edits/cells/metricRows which are listed
  }, [
    groupRows,
    optionRows,
    cells,
    edits,
    metricRows,
    misallocatedTotal,
    unmatched,
    config.specials
  ])

  const numCell = (
    v: unknown,
    format: 'currency' | 'number' | undefined,
    opts?: { strong?: boolean; tone?: 'muted' | 'neg' }
  ) => (
    <td
      className={cn(
        'py-1.5 pr-3 text-right tabular-nums',
        opts?.strong
          ? 'font-semibold text-slate-800 dark:text-slate-100'
          : 'text-slate-600 dark:text-slate-300',
        opts?.tone === 'muted' && 'text-slate-400 dark:text-slate-500',
        opts?.tone === 'neg' && 'text-red-600 dark:text-red-400'
      )}
    >
      {fmtVal(v, format)}
    </td>
  )

  const aggregateCells = (
    current: number,
    next: number,
    metrics: Record<string, number>,
    strong: boolean
  ) => {
    const derived = derive(current, next, metrics)
    return (
      <>
        {numCell(current, config.value_format, { strong })}
        {metricCols.map((c) => (
          <td
            key={c.field}
            className={cn(
              'py-1.5 pr-3 text-right tabular-nums',
              strong
                ? 'font-semibold text-slate-800 dark:text-slate-100'
                : 'text-slate-600 dark:text-slate-300'
            )}
          >
            {fmtVal(metrics[c.field], c.format)}
          </td>
        ))}
        {derivedCols.map((d, i) => {
          const v = derived[i]
          return (
            <td
              key={d.label}
              className={cn(
                'py-1.5 pr-3 text-right tabular-nums',
                strong ? 'font-semibold' : '',
                v != null && v < 0
                  ? 'text-red-600 dark:text-red-400'
                  : strong
                    ? 'text-slate-800 dark:text-slate-100'
                    : 'text-slate-600 dark:text-slate-300'
              )}
            >
              {fmtVal(v, d.format ?? config.value_format)}
            </td>
          )
        })}
        {numCell(next, config.value_format, {
          strong,
          tone: next !== current ? undefined : 'muted'
        })}
      </>
    )
  }

  const renderRow = (groupId: string, key: string, label: string, italic = false, indent = 0) => {
    const cellKey = `${groupId}|${key}`
    const cur = cells.get(cellKey)?.total ?? 0
    const metrics = metricFor(groupId, key)
    const raw = edits[cellKey] ?? ''
    const next = liveValue(cellKey)
    const edited = raw.trim() !== '' && !Number.isNaN(Number(raw))
    const delta = edited ? next - cur : 0
    const derived = derive(cur, next, metrics)
    return (
      <tr
        key={cellKey}
        className={cn(
          'border-b border-slate-100 dark:border-border/50',
          edited && 'bg-nvr-cyan/[0.04]'
        )}
      >
        <td
          className={cn(
            'py-1 pr-3 text-slate-700 dark:text-slate-200',
            italic && 'italic text-slate-500'
          )}
          style={indent ? { paddingLeft: indent * 18 } : undefined}
        >
          {label}
        </td>
        {numCell(cur, config.value_format, { tone: cur === 0 ? 'muted' : undefined })}
        {metricCols.map((c) => numCellKeyed(c.field, metrics[c.field], c.format))}
        {derivedCols.map((d, i) => {
          const v = derived[i]
          return (
            <td
              key={d.label}
              className={cn(
                'py-1.5 pr-3 text-right tabular-nums',
                v != null && v < 0
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-slate-600 dark:text-slate-300'
              )}
            >
              {fmtVal(v, d.format ?? config.value_format)}
            </td>
          )
        })}
        <td className='py-1 pr-3 text-right'>
          <span className='inline-flex items-center justify-end gap-1.5'>
            {edited && delta !== 0 && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-px text-[10.5px] font-medium tabular-nums',
                  delta > 0
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                    : 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                )}
              >
                {delta > 0 ? '+' : '−'}
                {fmtVal(Math.abs(delta), config.value_format)}
              </span>
            )}
            <span className='relative'>
              {config.value_format === 'currency' && (
                <span className='pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-slate-400'>
                  $
                </span>
              )}
              <input
                type='text'
                inputMode='decimal'
                value={raw}
                placeholder={fmtVal(
                  cur,
                  config.value_format === 'currency' ? 'number' : config.value_format
                )}
                onChange={(e) => commitEdit(cellKey, e.target.value)}
                title='Type a new amount, or +500 / -250 to adjust the current one'
                className={cn(
                  'h-7 w-32 rounded-md border bg-white text-right text-[12px] tabular-nums outline-none transition-colors placeholder:text-slate-300 focus:border-nvr-cyan dark:bg-background dark:placeholder:text-slate-600',
                  config.value_format === 'currency' ? 'pl-5 pr-2' : 'px-2',
                  edited
                    ? 'border-nvr-cyan bg-nvr-cyan/[0.06]'
                    : 'border-slate-200 dark:border-border'
                )}
              />
            </span>
          </span>
        </td>
      </tr>
    )
  }
  const numCellKeyed = (key: string, v: unknown, format: 'currency' | 'number' | undefined) => (
    <td
      key={key}
      className='py-1.5 pr-3 text-right tabular-nums text-slate-600 dark:text-slate-300'
    >
      {fmtVal(v, format)}
    </td>
  )

  const unmatchedRow = (groupId: string) => {
    const um = unmatched.perGroup.get(groupId)
    if (!um || !unmatchedCfg) return null
    if (!metricCols.some((c) => (um[c.field] ?? 0) !== 0)) return null
    return (
      <tr key={`${groupId}|__other__`} className='border-b border-slate-100 dark:border-border/50'>
        <td
          className='py-1 pr-3 pl-[18px] italic text-slate-400'
          title='Spend and commitments on categories outside this project’s list — nothing to allocate here, but they count toward the project total'
        >
          {unmatchedCfg.option_label ?? 'Other categories'}
        </td>
        {numCell(null, config.value_format, { tone: 'muted' })}
        {metricCols.map((c) => numCellKeyed(c.field, um[c.field], c.format))}
        {derivedCols.map((d) => (
          <td key={d.label} className='py-1.5 pr-3 text-right tabular-nums text-slate-400'>
            —
          </td>
        ))}
        <td />
      </tr>
    )
  }

  const scopeLabel = (s: MatrixEditorConfig['scope_fields'][number]) =>
    s.label ?? s.field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  const lockedFields = new Set(lockScope ? Object.keys(initialScope ?? {}) : [])
  const toggle = (key: string) =>
    setCollapsed((p) => {
      const n = new Set(p)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  return (
    <div className='flex h-full min-h-0 flex-col' data-matrix-editor>
      {/* ── Scope + actions ── */}
      <div className='flex shrink-0 flex-wrap items-end gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
        {config.scope_fields
          .filter((s) => !lockedFields.has(s.field))
          .map((s) => {
            const resolved = resolveScopeTokens(s.filter, scope)
            const extraFilter = resolved && !hasUnresolved(resolved) ? resolved : undefined
            return (
              <div key={s.field} className='w-56'>
                <p className='mb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400'>
                  {scopeLabel(s)}
                </p>
                <RelationCombobox
                  collection={s.collection}
                  value={scope[s.field] ?? null}
                  onChange={(v) => {
                    setScope((p) => ({ ...p, [s.field]: v }))
                    setEdits({})
                  }}
                  extraFilter={extraFilter}
                  placeholder='Select…'
                />
              </div>
            )
          })}
        <span className='flex-1' />
        {status && <span className='pb-2 text-[12px] text-slate-500'>{status}</span>}
        {dirty && (
          <button
            type='button'
            onClick={() => setEdits({})}
            className='h-9 rounded-md px-3 text-[13px] font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-muted'
          >
            Discard
          </button>
        )}
        <button
          type='button'
          disabled={!scopeReady || !dirty || saving}
          onClick={() => void save()}
          data-matrix-save
          className='inline-flex h-9 items-center gap-1.5 rounded-md bg-nvr-cyan px-3.5 text-[13px] font-semibold text-[#172940] hover:bg-[#00b8e0] disabled:opacity-50'
        >
          {saving && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
          Save changes
        </button>
      </div>

      {/* ── Cap tiles ── */}
      {capValue !== null && scopeReady && (
        <div className='grid shrink-0 grid-cols-2 gap-px border-b border-slate-200 bg-slate-200 dark:border-border dark:bg-border sm:grid-cols-4'>
          {[
            { label: config.cap?.label ?? 'Cap', value: capValue, tone: 'plain' as const },
            {
              label: 'Allocated',
              value: grand.next,
              tone: grand.next !== totalCurrent ? ('edited' as const) : ('plain' as const),
              sub:
                grand.next !== totalCurrent ? `was ${fmtVal(totalCurrent, 'currency')}` : undefined
            },
            {
              label: 'Available to allocate',
              value: available,
              tone: available !== null && available < 0 ? ('neg' as const) : ('ok' as const)
            },
            {
              label: 'Misallocated',
              value: misallocatedTotal,
              tone: misallocatedTotal > 0 ? ('neg' as const) : ('muted' as const),
              hint: 'Allocations on categories or regions outside this project’s current lists'
            }
          ].map((t) => (
            <div key={t.label} className='bg-white px-4 py-2.5 dark:bg-card' title={t.hint}>
              <p className='text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
                {t.label}
              </p>
              <p
                className={cn(
                  'mt-0.5 text-[17px] font-semibold tabular-nums tracking-[-0.01em]',
                  t.tone === 'neg'
                    ? 'text-red-600 dark:text-red-400'
                    : t.tone === 'ok'
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : t.tone === 'muted'
                        ? 'text-slate-400'
                        : t.tone === 'edited'
                          ? 'text-nvr-navy dark:text-nvr-cyan'
                          : 'text-slate-900 dark:text-white'
                )}
              >
                {fmtVal(t.value, 'currency')}
              </p>
              {t.sub && <p className='text-[11px] text-slate-400'>{t.sub}</p>}
            </div>
          ))}
        </div>
      )}

      {/* ── Grid ── */}
      <div className='min-h-0 flex-1 overflow-auto bg-slate-50/60 dark:bg-transparent'>
        {!scopeReady ? (
          <div className='flex h-full flex-col items-center justify-center gap-1 p-8 text-center'>
            <p className='text-[13px] font-medium text-slate-600 dark:text-slate-300'>
              Choose{' '}
              {config.scope_fields
                .filter((s) => !lockedFields.has(s.field))
                .map(scopeLabel)
                .join(' and ')}{' '}
              to load allocations
            </p>
            <p className='text-[12px] text-slate-400'>
              Amounts are grouped by{' '}
              {groupCfg?.label_field ? groupCfg.collection.replace(/_/g, ' ') : 'section'} and saved
              together.
            </p>
          </div>
        ) : optsLoading || tgtLoading ? (
          <div className='flex items-center gap-2 p-4 text-[12px] text-slate-400'>
            <Loader2 className='h-4 w-4 animate-spin' /> Loading…
          </div>
        ) : (
          <table className='w-full text-[12px]'>
            <thead className='sticky top-0 z-[1] bg-slate-50 dark:bg-background'>
              <tr className='border-b border-slate-200 text-left dark:border-border'>
                <th className='px-3 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                  {config.option_collection
                    .replace(/_/g, ' ')
                    .replace(/\b\w/g, (c) => c.toUpperCase())}
                </th>
                <th className='w-32 py-2 pr-3 text-right text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                  {valueLabel}
                </th>
                {metricCols.map((c) => (
                  <th
                    key={c.field}
                    className='w-32 py-2 pr-3 text-right text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'
                  >
                    {c.label ?? c.field}
                  </th>
                ))}
                {derivedCols.map((d) => (
                  <th
                    key={d.label}
                    className='w-32 py-2 pr-3 text-right text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'
                  >
                    {d.label}
                  </th>
                ))}
                <th className='w-44 py-2 pr-3 text-right text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                  New {valueLabel}
                </th>
              </tr>
            </thead>
            <tbody className='bg-white dark:bg-transparent'>
              {groupRows.map((g) => {
                const isCollapsed = collapsed.has(g.id)
                const groupCurrent = [...cells.entries()]
                  .filter(([k]) => k.startsWith(`${g.id}|`))
                  .reduce((s, [, c]) => s + c.total, 0)
                const keys = allKeysFor()
                const groupMetrics = sumMetrics([
                  ...keys.map((k) => metricFor(g.id, k)),
                  ...(unmatched.perGroup.get(g.id)
                    ? [unmatched.perGroup.get(g.id) as Record<string, number>]
                    : [])
                ])
                const groupNew =
                  keys.reduce((t, k) => t + liveValue(`${g.id}|${k}`), 0) +
                  (groupCurrent -
                    keys.reduce((t, k) => t + (cells.get(`${g.id}|${k}`)?.total ?? 0), 0))
                return (
                  <FragmentRows
                    key={g.id || '__all__'}
                    header={
                      groupCfg ? (
                        <tr
                          className='cursor-pointer border-y border-slate-200 bg-slate-100/70 hover:bg-slate-100 dark:border-border dark:bg-muted/60'
                          onClick={() => toggle(g.id)}
                          data-matrix-group={g.id}
                        >
                          <td className='px-3 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
                            <span className='inline-flex items-center gap-1.5'>
                              <ChevronRight
                                className={cn(
                                  'h-3.5 w-3.5 text-slate-400 transition-transform',
                                  !isCollapsed && 'rotate-90'
                                )}
                              />
                              {g.label}
                            </span>
                          </td>
                          {aggregateCells(groupCurrent, groupNew, groupMetrics, true)}
                        </tr>
                      ) : null
                    }
                  >
                    {!isCollapsed && (
                      <>
                        {config.option_section
                          ? optionSections.map((sec) => {
                              const secKey = `s:${g.id}|${sec.name}`
                              const secCollapsed = collapsed.has(secKey)
                              const secCurrent = sec.rows.reduce(
                                (t, o) => t + (cells.get(`${g.id}|${o.key}`)?.total ?? 0),
                                0
                              )
                              const secNew = sec.rows.reduce(
                                (t, o) => t + liveValue(`${g.id}|${o.key}`),
                                0
                              )
                              const secMetrics = sumMetrics(
                                sec.rows.map((o) => metricFor(g.id, o.key))
                              )
                              return (
                                <FragmentRows
                                  key={secKey}
                                  header={
                                    <tr
                                      className='cursor-pointer border-b border-slate-100 bg-slate-50/80 hover:bg-slate-50 dark:border-border/50 dark:bg-muted/30'
                                      onClick={() => toggle(secKey)}
                                    >
                                      <td className='py-1 pr-3 pl-[22px] text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>
                                        <span className='inline-flex items-center gap-1.5'>
                                          <ChevronRight
                                            className={cn(
                                              'h-3 w-3 text-slate-400 transition-transform',
                                              !secCollapsed && 'rotate-90'
                                            )}
                                          />
                                          {sec.name || '—'}
                                        </span>
                                      </td>
                                      {aggregateCells(secCurrent, secNew, secMetrics, false)}
                                    </tr>
                                  }
                                >
                                  {!secCollapsed &&
                                    sec.rows.map((o) =>
                                      renderRow(g.id, o.key, o.label, false, 2.4)
                                    )}
                                </FragmentRows>
                              )
                            })
                          : optionRows.map((o) => renderRow(g.id, o.key, o.label, false, 1))}
                        {config.specials?.uncategorized &&
                          renderRow(
                            g.id,
                            UNCAT,
                            config.specials.uncategorized.label ?? 'Uncategorized',
                            true,
                            1
                          )}
                        {config.specials?.bucket &&
                          renderRow(
                            g.id,
                            BUCKET,
                            config.specials.bucket.label ?? 'Inventory',
                            true,
                            1
                          )}
                        {unmatchedRow(g.id)}
                      </>
                    )}
                  </FragmentRows>
                )
              })}
              {unmatchedCfg && groupCfg && unmatched.otherGroupCount > 0 && (
                <tr
                  className='border-y border-slate-200 bg-slate-100/70 dark:border-border dark:bg-muted/60'
                  title='Spend and commitments on regions outside this project’s list'
                >
                  <td className='px-3 py-1.5 text-[12px] font-semibold italic text-slate-500'>
                    {unmatchedCfg.group_label ?? 'Other regions'}
                  </td>
                  {numCell(null, config.value_format, { tone: 'muted' })}
                  {metricCols.map((c) =>
                    numCellKeyed(c.field, unmatched.otherGroup[c.field], c.format)
                  )}
                  {derivedCols.map((d) => (
                    <td key={d.label} className='py-1.5 pr-3 text-right text-slate-400'>
                      —
                    </td>
                  ))}
                  <td />
                </tr>
              )}
            </tbody>
            <tfoot className='sticky bottom-0 bg-white dark:bg-card'>
              <tr className='border-t-2 border-slate-300 dark:border-border'>
                <td className='px-3 py-2 text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
                  Total
                </td>
                {aggregateCells(grand.current, grand.next, grand.metrics, true)}
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  )
}

function FragmentRows({
  header,
  children
}: {
  header: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <>
      {header}
      {children}
    </>
  )
}
