import { useQueries, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useNivaroClient } from '../../../context'
import { get, post } from '../../../lib/commands'
import { parseVisibleWhen } from '../../../lib/visible-when'
import type { ActiveLayoutData } from '../../item-edit/types'
import { useCollectionBody } from '../collection-meta'
import type { DescribeField } from '../overview/describe-conditions'
import { useOverviewFields, useRoleNames, useValueLabels } from '../overview/overview-api'
import { useCollectionPipelines } from '../preview/preview-api'
import {
  crossConfigs,
  crossValues,
  type Ghost,
  ghostText,
  layoutDefaults,
  mergeGhosts,
  ruleTriggers
} from './default-ghosts'
import {
  fieldStateChips,
  type GroupChip,
  groupRuleChips,
  type SourceFieldRow,
  type StateChip
} from './field-sources'
import {
  findRuleLoops,
  type RuleDep,
  type RuleFieldRule,
  type RuleLayout,
  type RuleLoop,
  ruleDependencies,
  ruleLayoutFromActive
} from './rule-graph'

// Reads behind the canvas explanations (#2632 #2640 #2641 #2642 #2633). Every
// request here is a read; the field-rule evaluation is the new-record form's
// own (POST /field-rules/evaluate writes nothing and is not a config route).

type FieldRow = SourceFieldRow & {
  dependency_config?: unknown
  options?: unknown
  cross_record_defaults?: unknown
}

/** GET /field-rules?collection= — the same key and rows the record form reads. */
export function useFieldRuleRows(collection: string, enabled = true) {
  const client = useNivaroClient()
  return useQuery<RuleFieldRule[]>({
    queryKey: ['field-rules', collection],
    queryFn: () =>
      client
        .request<{ data: RuleFieldRule[] }>(get('/field-rules', { collection }))
        .then((r) => (Array.isArray(r?.data) ? r.data : [])),
    enabled: enabled && !!collection,
    staleTime: 60_000
  })
}

/** The collection's stored field rows (every form): GET /collections/:c. */
function useFieldRows(collection: string, enabled: boolean) {
  return useCollectionBody(collection, {
    enabled,
    select: (b) => (Array.isArray(b?.fields) ? (b.fields as FieldRow[]) : [])
  })
}

export interface CanvasExplain {
  layout: RuleLayout
  deps: RuleDep[]
  loops: RuleLoop[]
  fieldChips: Map<string, StateChip[]>
  groupChips: Map<string, GroupChip[]>
  describe: DescribeField[]
  groupLabel: (key: string) => string
}

const EMPTY_LAYOUT: RuleLayout = { groups: [], placements: [] }

/**
 * Why each field is required / read-only / hidden, the form's rules as
 * sentences, what each field drives and the loops among them, for the canvas
 * layout (`active`: the draft as /active answers it). `chips` off skips the
 * reads only the chips need (roles, pipelines, labels).
 */
export function useCanvasExplain(
  collection: string,
  active: ActiveLayoutData | null,
  chips: boolean
): CanvasExplain {
  const { data: rows = [] } = useFieldRows(collection, true)
  const { data: describe = [] } = useOverviewFields(collection)
  const { data: fieldRules = [] } = useFieldRuleRows(collection)
  const { data: roles = [] } = useRoleNames(chips)
  const { data: pipelines = [] } = useCollectionPipelines(collection, chips)

  const layout = useMemo(() => (active ? ruleLayoutFromActive(active) : EMPTY_LAYOUT), [active])
  const deps = useMemo(() => ruleDependencies(layout, rows, fieldRules), [layout, rows, fieldRules])
  const loops = useMemo(() => findRuleLoops(deps, layout), [deps, layout])

  // Record labels for the values the sentences name (a many-to-one's id → its name).
  const pairs = useMemo(() => {
    if (!chips) return []
    const out: Array<{ field: string; value: unknown }> = []
    for (const g of layout.groups)
      for (const r of parseVisibleWhen(g.visible_when))
        if (r.field)
          for (const v of r.op === 'in' ? String(r.value ?? '').split(',') : [r.value])
            out.push({ field: r.field, value: typeof v === 'string' ? v.trim() : v })
    for (const r of fieldRules) {
      out.push({ field: r.trigger_field, value: r.trigger_value })
      out.push({ field: r.target_field, value: r.target_value })
    }
    return out
  }, [chips, layout, fieldRules])
  const choices = useValueLabels(collection, describe, pairs)

  const roleNames = useMemo(() => new Map(roles.map((r) => [r.id.toUpperCase(), r.name])), [roles])
  const input = useMemo(
    () => ({
      collection,
      layout,
      fields: rows,
      describe,
      choices,
      fieldRules,
      pipelines,
      roleNames
    }),
    [collection, layout, rows, describe, choices, fieldRules, pipelines, roleNames]
  )
  const fieldChips = useMemo(
    () => (chips ? fieldStateChips(input) : new Map<string, StateChip[]>()),
    [chips, input]
  )
  const groupChips = useMemo(
    () => (chips ? groupRuleChips(input) : new Map<string, GroupChip[]>()),
    [chips, input]
  )
  const groupLabel = useMemo(() => {
    const byKey = new Map(layout.groups.map((g) => [g.key, g.label || g.key]))
    return (key: string) => byKey.get(key) ?? key
  }, [layout])

  return { layout, deps, loops, fieldChips, groupChips, describe, groupLabel }
}

/**
 * Default-value ghosts (#2633): field → the grey text its input shows on a
 * new record, for the draft's default_values and what they trigger. `enabled`
 * off (a saved record previewed, the Rules view off) asks nothing.
 */
export function useDefaultGhosts(
  collection: string,
  active: ActiveLayoutData | null,
  enabled: boolean
): Map<string, { text: string; type: string | null }> {
  const client = useNivaroClient()
  const { data: rows = [] } = useFieldRows(collection, enabled)
  const { data: describe = [] } = useOverviewFields(collection)
  const { data: fieldRules = [] } = useFieldRuleRows(collection, enabled)
  const defaults = useMemo(
    () => (enabled ? layoutDefaults(active?.layout?.default_values) : {}),
    [enabled, active]
  )

  // Field rules the defaults trigger, judged against the defaults (only-when-empty).
  const triggers = useMemo(() => ruleTriggers(defaults, fieldRules), [defaults, fieldRules])
  const ruleQs = useQueries({
    queries: triggers.map((t) => {
      const draft = Object.fromEntries(t.targets.map((f) => [f, defaults[f] ?? null]))
      return {
        queryKey: ['layout-editor', 'default-rule', collection, t.field, t.value, draft],
        queryFn: () =>
          client
            .request<{ data: Record<string, unknown> }>(
              post('/field-rules/evaluate', {
                collection,
                trigger_field: t.field,
                trigger_value: t.value,
                draft
              })
            )
            .then((r) => (r?.data && typeof r.data === 'object' ? r.data : {})),
        staleTime: 60_000,
        retry: false
      }
    })
  })
  const ruleKey = JSON.stringify(ruleQs.map((q) => q.data ?? null))
  const ruleResults = useMemo(
    () =>
      (JSON.parse(ruleKey) as Array<Record<string, unknown> | null>).filter(
        (r): r is Record<string, unknown> => !!r
      ),
    [ruleKey]
  )

  // Cross-record defaults: a record the defaults (or rules) pick supplies more values.
  const picks = useMemo(() => {
    const merged: Record<string, unknown> = { ...defaults }
    for (const r of ruleResults) Object.assign(merged, r)
    return crossConfigs(rows)
      .map((cfg) => ({ cfg, id: merged[cfg.fk] }))
      .filter(
        (p): p is { cfg: (typeof p)['cfg']; id: string | number } =>
          (typeof p.id === 'string' && p.id !== '') || typeof p.id === 'number'
      )
  }, [defaults, ruleResults, rows])
  const crossQs = useQueries({
    queries: picks.map((p) => ({
      queryKey: ['layout-editor', 'default-source', p.cfg.source_collection, String(p.id)],
      queryFn: () =>
        client
          .request<{ data: Record<string, unknown> | null }>(
            get(
              `/items/${encodeURIComponent(p.cfg.source_collection)}/${encodeURIComponent(String(p.id))}`
            )
          )
          .then((r) => r?.data ?? null),
      staleTime: 60_000,
      retry: false
    }))
  })
  const crossKey = JSON.stringify(crossQs.map((q) => q.data ?? null))
  const ghosts = useMemo(() => {
    const sources = JSON.parse(crossKey) as Array<Record<string, unknown> | null>
    const cross = picks.flatMap((p, i) =>
      sources[i]
        ? [{ from: p.cfg.fk, values: crossValues(p.cfg, sources[i] as Record<string, unknown>) }]
        : []
    )
    return mergeGhosts(defaults, ruleResults, cross)
  }, [defaults, ruleResults, picks, crossKey])

  const pairs = useMemo(
    () => [...ghosts.entries()].map(([field, g]: [string, Ghost]) => ({ field, value: g.value })),
    [ghosts]
  )
  const choices = useValueLabels(collection, describe, pairs)
  return useMemo(() => {
    const types = new Map(rows.map((r) => [r.field, r.type ?? null]))
    const out = new Map<string, { text: string; type: string | null }>()
    for (const [field, g] of ghosts) {
      const type = types.get(field) ?? null
      const text = ghostText(field, g, describe, choices, type)
      if (text) out.set(field, { text, type })
    }
    return out
  }, [ghosts, rows, describe, choices])
}
