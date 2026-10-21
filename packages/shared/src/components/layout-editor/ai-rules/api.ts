import type { LayoutOp } from '../../../lib/layout-ops'

/**
 * Answers of the AI rule writers (POST /ai-design/layouts/:id/rule | cascade |
 * field-rule | validation — admin only; api/src/routes/ai-design-rules.ts).
 * Every answer is a PROPOSAL: the editor applies it through its own seams.
 */

export interface RuleTest {
  checked: number
  matched: number
  current: number | null
  roles: string[]
}

export interface RuleAnswer {
  proposal:
    | { kind: 'step'; group: string; conditions: unknown[] }
    | { kind: 'lock'; field: string; conditions: unknown[] }
  ops: LayoutOp[]
  sentence: string
  replaces: string | null
  explanation: string | null
  dropped: string[]
  notes: string[]
  test: RuleTest
}

export interface CascadeRuleDraft {
  parent_field: string
  filter_column: string
  filter_is_m2m?: boolean
  clear_on_parent_change: boolean
  clear_on_unavailable: boolean
  show_all_if_no_parent?: boolean
}

export interface CascadeAnswer {
  related: string
  cascade_filters: CascadeRuleDraft[]
  option_filter: Record<string, unknown> | null
  sentences: string[]
  explanation: string | null
  dropped: string[]
}

export interface DraftFieldRule {
  collection: string
  trigger_field: string
  trigger_op: string
  trigger_value: string | null
  target_field: string
  target_type: string
  target_value: string | null
  only_when_empty: boolean
  dynamic_config: Record<string, unknown> | null
}

export interface FieldRuleAnswer {
  rule: DraftFieldRule
  sentence: string
  explanation: string | null
  dry_run: Array<{
    id: string
    label: string
    before_label: string | null
    after_label: string | null
    new_record_label: string | null
  }>
}

export interface ValidationRuleDraft {
  type: string
  value?: unknown
  message?: string
}

export interface ValidationAnswer {
  field: string
  label: string
  kind: 'text' | 'number' | 'other'
  checked: number
  empty: number
  capped: boolean
  current: ValidationRuleDraft[]
  suggestions: Array<{
    rule: ValidationRuleDraft
    sentence: string
    source: 'pattern' | 'ai'
    fails: number
  }>
  ai_configured: boolean
  ai_error: string | null
}

/** "12 of the newest 500" / "all 37". */
export function ofChecked(n: number, checked: number, cap?: number): string {
  if (checked === 0) return 'no records yet'
  return `${n.toLocaleString()} of ${cap && checked >= cap ? `the newest ${checked.toLocaleString()}` : checked.toLocaleString()}`
}
