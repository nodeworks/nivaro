import type { ConditionRule } from '../workflow-conditions.js'

// ─── Partner payload templates: the field map ────────────────────────────────
// The stored JSON shape of a map-mode template (spec 2026-10-22 §5.1). The
// evaluator (evaluate.ts) turns it plus a render scope into the request body.

export type { ConditionRule }

/** A dotted path into the render scope: `record.x`, `context.k[0].y`, `line.a.b`. */
export type Path = string

export type MapSpec = { v: 1; fields: Field[] }

export type Field = {
  id: string // stable row id (nanoid) — UI + problem anchors
  key: string // output key; unique among siblings
  type: 'text' | 'number' | 'boolean' | 'date' | 'object' | 'list' | 'json'
  value?: ValueSpec // scalar types + json
  children?: Field[] // object, and list item shape
  list?: ListSpec // type = list
  include: 'always' | 'not_empty' | { when: ConditionRule[] }
  rules?: {
    required?: boolean
    max_length?: number
    min?: number
    max?: number
    allowed?: string[]
    pattern?: string
  }
  locked?: true // set from locked_keys; cannot rename/remove/retype
  note?: string // shown under the row ("Fusion wants 9 digits")
}

export type ListSpec = {
  source: Path // e.g. context.materials / lines / po_numbers
  item: string // alias inside the list, default 'line'
  where?: ConditionRule[] // e.g. quantity > 0
  sort?: string // '-field' = desc
  number_as?: string // alias for the 1-based index AFTER the where filter (default 'number')
  scalar?: true // list of plain values: one child, its value is the item
}

export type BuiltinName =
  | 'today'
  | 'now'
  | 'acting_user.email'
  | 'acting_user.name'
  | 'acting_user.employee_id'
  | 'list.number'
  | 'state.label'
  | 'state.external_label'

// The spec writes the trailing `& { transforms, fallbacks }` without
// parentheses, which in TypeScript binds to the formula variant only; the
// intent (every value source takes transforms and fallbacks) needs them.
export type ValueSpec = (
  | { source: 'fixed'; value: string | number | boolean | null }
  | { source: 'path'; path: Path } // record.x, context.k[0].y, line.cifa_data.cifa_number
  | { source: 'builtin'; name: BuiltinName }
  | { source: 'secret'; name: string } // body secret on the template's external API
  | { source: 'switch'; cases: { when: ConditionRule[]; value: ValueSpec }[]; else?: ValueSpec }
  | { source: 'formula'; liquid: string } // escape hatch; same engine + filters as today
) & { transforms?: Transform[]; fallbacks?: ValueSpec[] } // fallbacks: first non-empty wins

export type Transform =
  | { op: 'trim' | 'upper' | 'lower' | 'next_open_day' | 'editor_text' }
  | { op: 'truncate'; n: number }
  | { op: 'prefix' | 'suffix'; text: string }
  | { op: 'pad_start'; n: number; char: string }
  | { op: 'replace'; from: string; to: string }
  | { op: 'date'; format: string }
  | { op: 'add_days' | 'at_least_days_out'; n: number }
  | { op: 'join'; sep: string }

/** One thing wrong with a render, anchored to the field-map row that caused it. */
export type Problem = {
  field_id: string
  /** Where in the output body, e.g. `orderLines[0].quantity` (first occurrence). */
  path: string
  message: string
  severity: 'error' | 'warning'
}
