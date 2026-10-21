import type { RecordCondition } from '../../../lib/record-conditions'

/**
 * Shapes of `GET /collection-layouts/overview` and `GET /collection-layouts/explain`
 * (api/src/services/layout-overview.ts). Mirrors the server types; keep the two in step.
 */

export type OverviewSection = 'forms' | 'link_only' | 'other_views' | 'unused'

export type LayoutType = 'grouped' | 'summary' | 'detail' | 'file' | 'addendum' | 'table'

export type OverviewReasonKind =
  | 'record_rule'
  | 'role'
  | 'default'
  | 'fallback'
  | 'slug'
  | 'type_use'
  | 'phone'

export interface OverviewReason {
  kind: OverviewReasonKind
  rules?: RecordCondition[]
  role_ids?: string[]
  role_names?: string[]
  type_use?: string
  /** kind 'phone' (#2715): the desktop form this phone version stands in for. */
  phone_of?: number
  phone_of_name?: string
  desktop_kind?: OverviewReasonKind
}

export interface OverviewReference {
  kind: string
  id: string | number
  label: string
}

export interface OverviewRow {
  layout_id: number
  name: string
  layout_type: string
  slug: string | null
  section: OverviewSection
  reason: OverviewReason
  is_default: boolean
  new_menu: { label: string; hidden: boolean } | null
  shape: {
    groups: number
    steps_or_tabs: number
    fields: number
    /** Whether `steps_or_tabs` counts tabs or steps; null/absent = steps. */
    container_mode?: 'tabs' | 'steps' | null
  }
  references: OverviewReference[]
  warnings: string[]
  /** Forms only: sections (with show-when rules) and field places, for the rule-loop check. */
  rule_shape?: {
    groups: Array<{
      key: string
      label: string | null
      parent_key: string | null
      visible_when: string | null
    }>
    placements: Array<{ field: string; group_key: string | null }>
  }
  /** #2714: the days the form resolves on, and where today falls. */
  active_window?: { from: string | null; until: string | null; state: 'before' | 'open' | 'after' }
  /** #2715: this form's phone version / the form this one is the phone version of. */
  phone_version?: { layout_id: number; name: string } | null
  phone_of?: number | null
  /** #2717: edits refused until this day. */
  frozen?: { until: string; reason: string } | null
}

export interface OverviewResponse {
  rows: OverviewRow[]
  warning: string | null
}

export interface ExplainResponse {
  layout_id: number | null
  reason: OverviewReason | null
  checked: Array<{ layout_id: number; matched: boolean; why: string }>
  /** The day and screen the answer is for (#2714 #2715). */
  at?: string | null
  viewport?: 'phone' | null
}
