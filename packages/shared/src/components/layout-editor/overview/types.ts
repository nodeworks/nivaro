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

export interface OverviewReason {
  kind: OverviewReasonKind
  rules?: RecordCondition[]
  role_ids?: string[]
  role_names?: string[]
  type_use?: string
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
  shape: { groups: number; steps_or_tabs: number; fields: number }
  references: OverviewReference[]
  warnings: string[]
}

export interface OverviewResponse {
  rows: OverviewRow[]
  warning: string | null
}

export interface ExplainResponse {
  layout_id: number | null
  reason: OverviewReason | null
  checked: Array<{ layout_id: number; matched: boolean; why: string }>
}
