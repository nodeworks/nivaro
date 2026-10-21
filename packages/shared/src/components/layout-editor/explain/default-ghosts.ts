import type { ChoiceLabels, DescribeField } from '../overview/describe-conditions'
import { fieldLabel } from './field-sources'
import { asObj, type RuleFieldRule } from './rule-graph'

/**
 * Default-value ghosts (#2633): the value a new record on this form would
 * start with, shown as grey placeholder text in the canvas inputs. Pure: the
 * hook (use-explain.ts) asks the server what field rules and cross-record
 * defaults make of the layout's defaults; this file decides the order and
 * the words. Nothing here writes.
 *
 * The order is the new-record form's: the layout's default_values first, then
 * the field rules those values trigger (only-when-empty is judged by the
 * server against the defaults), then cross-record defaults read from a record
 * a default picks (a pick overwrites, as on the form).
 */

export type GhostVia = 'layout' | 'rule' | 'cross'

export interface Ghost {
  value: unknown
  via: GhostVia
  /** cross: the field whose picked record supplied the value. */
  from?: string
}

/** The draft's `default_values` (JSON text or an object), without empty keys. */
export function layoutDefaults(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(asObj(raw))) if (v !== undefined) out[k] = v
  return out
}

/** Defaults that trigger at least one active field rule: what to ask /field-rules/evaluate. */
export function ruleTriggers(
  defaults: Record<string, unknown>,
  rules: RuleFieldRule[]
): Array<{ field: string; value: unknown; targets: string[] }> {
  const out: Array<{ field: string; value: unknown; targets: string[] }> = []
  for (const [field, value] of Object.entries(defaults)) {
    if (value == null || value === '') continue
    const targets = rules
      .filter(
        (r) =>
          r.trigger_field === field &&
          (r.is_active === true || r.is_active === 1 || r.is_active == null)
      )
      .map((r) => r.target_field)
    if (targets.length > 0) out.push({ field, value, targets: [...new Set(targets)] })
  }
  return out
}

export interface CrossDefaultConfig {
  /** The field holding the cross_record_defaults config. */
  field: string
  source_collection: string
  /** The field whose value is the source record's id. */
  fk: string
  field_map: Record<string, string>
}

/** cross_record_defaults of each field row that names a source collection and a map. */
export function crossConfigs(
  rows: Array<{ field: string; cross_record_defaults?: unknown }>
): CrossDefaultConfig[] {
  const out: CrossDefaultConfig[] = []
  for (const r of rows) {
    const cfg = asObj(r.cross_record_defaults)
    const source = typeof cfg.source_collection === 'string' ? cfg.source_collection : ''
    const map = asObj(cfg.field_map)
    if (!source || Object.keys(map).length === 0) continue
    const fk =
      typeof cfg.source_fk_field === 'string' && cfg.source_fk_field ? cfg.source_fk_field : r.field
    out.push({
      field: r.field,
      source_collection: source,
      fk,
      field_map: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, String(v)]))
    })
  }
  return out
}

/** The values a source record gives, per the map ("a||b": the first that is filled). */
export function crossValues(
  cfg: CrossDefaultConfig,
  source: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [target, spec] of Object.entries(cfg.field_map)) {
    for (const col of spec.split('||').map((c) => c.trim())) {
      const v = source[col]
      if (v == null || v === '' || typeof v === 'object') continue
      out[target] = v
      break
    }
  }
  return out
}

/** Layout defaults, then rule results, then cross-record values: the last writer wins. */
export function mergeGhosts(
  defaults: Record<string, unknown>,
  ruleResults: Array<Record<string, unknown>>,
  cross: Array<{ from: string; values: Record<string, unknown> }>
): Map<string, Ghost> {
  const out = new Map<string, Ghost>()
  for (const [f, v] of Object.entries(defaults)) out.set(f, { value: v, via: 'layout' })
  for (const res of ruleResults)
    for (const [f, v] of Object.entries(res)) {
      if (v == null || v === '') out.delete(f)
      else out.set(f, { value: v, via: 'rule' })
    }
  for (const c of cross)
    for (const [f, v] of Object.entries(c.values))
      out.set(f, { value: v, via: 'cross', from: c.from })
  return out
}

/** A stored value as people read it: choice and record labels, yes/no, a count of links. */
export function ghostValueText(
  field: string,
  value: unknown,
  type: string | null | undefined,
  choices: ChoiceLabels
): string | null {
  if (value == null || value === '') return null
  if (Array.isArray(value)) return value.length === 0 ? null : `${value.length} linked`
  if (typeof value === 'boolean' || type === 'boolean') {
    if (value === true || value === 'true' || value === 1 || value === '1') return 'Yes'
    if (value === false || value === 'false' || value === 0 || value === '0') return 'No'
  }
  if (typeof value === 'object') return null
  const s = String(value)
  return choices[field]?.[s] ?? s
}

/** "Default: Open", "By rule: Open", "From Project: Open". */
export function ghostText(
  field: string,
  ghost: Ghost,
  describe: DescribeField[],
  choices: ChoiceLabels,
  type?: string | null
): string | null {
  const v = ghostValueText(field, ghost.value, type, choices)
  if (v == null) return null
  if (ghost.via === 'rule') return `By rule: ${v}`
  if (ghost.via === 'cross') return `From ${fieldLabel(ghost.from ?? '', describe)}: ${v}`
  return `Default: ${v}`
}
