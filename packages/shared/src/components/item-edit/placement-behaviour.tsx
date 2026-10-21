import { Loader2, Repeat2, Sigma } from 'lucide-react'
import { createContext, useContext, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { evaluateExpression, parseExpression, readPath } from '../../lib/expression'
import {
  type CounterConfig,
  confirmChangeApplies,
  counterError,
  counterOf,
  counterState,
  countValue,
  displayFormulaOf,
  formatDisplayValue,
  isDisplayFormulaField,
  isEmptyValue,
  isRecommended,
  resolvePlacementText,
  type TextContext,
  textRulesOf
} from '../../lib/placement-behaviour'
import { cn, formatRelative } from '../../lib/utils'
import { useFieldAffordances } from './FieldAffordances'
import type { CMSField } from './types'

// The record page's side of the placement behaviour settings (#2703 #2704
// #2705 #2706 #2709 #2712). The rules themselves live in
// lib/placement-behaviour.ts, shared with the server (PDF, field-config).

/**
 * The record's pipeline state and the viewer's role, for label rules. The
 * record form provides it (the layout editor's canvas: the previewed state
 * and role); null = no rules apply.
 */
export const PlacementTextContext = createContext<TextContext | null>(null)

/** The record form hands its context down with the field affordances; the
 *  read view on the editor canvas reads the canvas's provider. */
export function usePlacementTextContext(): TextContext | null {
  const affordances = useFieldAffordances()
  const outer = useContext(PlacementTextContext)
  return affordances?.placementText ?? outer
}

/** A field's label and help text after its state / role rules. */
export function placementFieldText(
  field: Pick<CMSField, 'label' | 'note' | '_overrides'>,
  ctx: TextContext | null
): { label: string | null; note: string | null } {
  const base = { label: field.label, note: field.note }
  if (!ctx || !field._overrides) return base
  const ruled = resolvePlacementText(field._overrides, ctx)
  return {
    // A hidden label ('') stays hidden: rules change words, not the layout.
    label: ruled.label !== undefined && field.label !== '' ? ruled.label : base.label,
    note: ruled.note ?? base.note
  }
}

/** Which lookups the form needs for its placements' rules. */
export function placementBehaviourNeeds(fields: Array<Pick<CMSField, '_overrides'>>): {
  role: boolean
  state: boolean
} {
  let role = false
  let state = false
  for (const f of fields) {
    if (!f._overrides) continue
    for (const r of textRulesOf(f._overrides)) {
      if (r.type === 'role') role = true
      else state = true
    }
    const cc = (f._overrides as { confirm_change?: { state_keys?: unknown } }).confirm_change
    if (cc && typeof cc === 'object' && Array.isArray(cc.state_keys) && cc.state_keys.length)
      state = true
    if (role && state) break
  }
  return { role, state }
}

export const fieldIsRecommended = (f: Pick<CMSField, 'required' | '_overrides'>) =>
  !f.required && isRecommended(f._overrides)

/** Recommended fields left empty, by label — the save nudge's list. */
export function missingRecommended(
  fields: CMSField[],
  draft: Record<string, unknown>,
  shown: (f: CMSField) => boolean,
  labelOf: (f: CMSField) => string
): string[] {
  return fields
    .filter((f) => fieldIsRecommended(f) && !f.hidden && !f.readonly && shown(f))
    .filter((f) => isEmptyValue(draft[f.field]))
    .map(labelOf)
}

/** Fields whose change on this existing record needs a confirm + reason. */
export function confirmChangeFields(
  fields: CMSField[],
  changed: Set<string>,
  stateKey: string | null
): string[] {
  return fields
    .filter((f) => changed.has(f.field) && confirmChangeApplies(f._overrides, stateKey))
    .map((f) => f.field)
}

/** A placement's counter limit as a save-blocking error, or null. */
export function fieldCounterError(f: CMSField, value: unknown, label: string): string | null {
  return f._overrides ? counterError(value, f._overrides, label) : null
}

export function isDisplayFormulaRow(f: Pick<CMSField, 'field' | 'interface'>): boolean {
  return f.interface === 'display-formula' || isDisplayFormulaField(f.field)
}

// ── Markers and controls ────────────────────────────────────────────────────

/** #2704: the amber marker beside a recommended field's label. */
export function RecommendedMarker() {
  return (
    <span
      data-recommended=''
      role='img'
      aria-label='Recommended'
      data-tip='Recommended — fill it in if you can; saving still works without it'
      className='ml-1 inline-block h-1.5 w-1.5 translate-y-[-1px] rounded-full bg-amber-500 align-middle dark:bg-amber-400'
    />
  )
}

/** #2706: fill the value this person entered on their previous record here. */
export function RepeatLastButton({
  collection,
  itemId,
  field,
  label,
  onFill
}: {
  collection: string
  itemId: string
  field: string
  label: string
  onFill: (value: unknown) => void
}) {
  const client = useNivaroClient()
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const r = await client.request<{
        data: { value: unknown; item: string; at: string | null } | null
      }>(
        get('/revisions/my-last-value', {
          collection,
          field,
          ...(itemId && itemId !== 'new' ? { exclude: itemId } : {})
        })
      )
      if (!r.data) {
        toast.info(`Nothing to repeat — you have not filled ${label} on another record yet`)
        return
      }
      onFill(r.data.value)
      toast.success(
        `Filled ${label} from your last record${r.data.at ? ` (${formatRelative(r.data.at)})` : ''}`
      )
    } catch (err) {
      toast.error((err as Error)?.message || 'Could not read your last value')
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type='button'
      onClick={() => void run()}
      disabled={busy}
      data-repeat-last={field}
      aria-label={`Repeat the last ${label} you entered`}
      data-tip='Fill in what you entered on your previous record'
      className='inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10.5px] font-medium text-slate-500 transition-colors hover:bg-muted hover:text-slate-800 disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground'
    >
      {busy ? <Loader2 className='h-3 w-3 animate-spin' /> : <Repeat2 className='h-3 w-3' />}
      Repeat last
    </button>
  )
}

/** #2709: "120 / 500 characters" under a long-text input. */
export function FieldCounter({ value, config }: { value: unknown; config: CounterConfig }) {
  const n = countValue(value, config.unit)
  const state = counterState(n, config.limit)
  const unit = config.unit === 'words' ? (n === 1 ? 'word' : 'words') : 'characters'
  return (
    <p
      data-field-counter={state}
      aria-live='polite'
      className={cn(
        'text-right text-[11px] tabular-nums',
        state === 'over'
          ? 'font-medium text-red-600 dark:text-red-400'
          : state === 'near'
            ? 'text-amber-700 dark:text-amber-300'
            : 'text-slate-500 dark:text-muted-foreground'
      )}
    >
      {n.toLocaleString()}
      {config.limit != null ? ` / ${config.limit.toLocaleString()}` : ''} {unit}
      {state === 'over' && ' — over the limit'}
    </p>
  )
}

export function fieldCounterConfig(f: Pick<CMSField, '_overrides'>): CounterConfig | null {
  return f._overrides ? counterOf(f._overrides) : null
}

/** The number a display formula gives for these values; null = no value. */
export function evaluateDisplayFormula(
  expr: string,
  values: Record<string, unknown>
): { value: number | null; error: string | null } {
  if (!expr.trim()) return { value: null, error: 'No formula yet' }
  const parsed = parseExpression(expr)
  if (!parsed.ok) return { value: null, error: parsed.error }
  // Every input empty: nothing to compute yet (a dash, not a confident 0).
  if (parsed.tokens.length && parsed.tokens.every((t) => isEmptyValue(readPath(values, t))))
    return { value: null, error: null }
  const v = evaluateExpression(expr, values)
  if (typeof v === 'boolean') return { value: v ? 1 : 0, error: null }
  return { value: typeof v === 'number' && Number.isFinite(v) ? v : null, error: null }
}

/** #2712: a read-only value computed from the form's fields; never stored. */
export function DisplayFormulaValue({
  field,
  values
}: {
  field: Pick<CMSField, 'field' | 'options' | '_overrides'>
  values: Record<string, unknown>
}) {
  const df = useMemo(() => {
    const opts =
      field.options && typeof field.options === 'object'
        ? (field.options as { display_formula?: unknown })
        : null
    return (
      displayFormulaOf(field._overrides) ??
      displayFormulaOf({ display_formula: opts?.display_formula })
    )
  }, [field._overrides, field.options])
  const expr = df?.expr ?? ''
  const { value, error } = evaluateDisplayFormula(expr, values)
  return (
    <div
      data-display-formula={field.field}
      className='flex h-9 items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 dark:border-border dark:bg-muted/40'
    >
      <span
        className={cn(
          'min-w-0 truncate text-sm tabular-nums',
          error
            ? 'text-[12px] text-amber-700 dark:text-amber-300'
            : 'font-medium text-slate-900 dark:text-foreground'
        )}
      >
        {error
          ? expr.trim()
            ? 'This formula needs fixing'
            : 'No formula yet'
          : formatDisplayValue(value, df ?? { format: '', currency: null })}
      </span>
      {expr.trim() && (
        <span
          data-tip={`Calculated on this page: ${expr}`}
          aria-label={`Calculated on this page: ${expr}`}
          role='img'
          className='shrink-0 text-slate-400 dark:text-muted-foreground'
        >
          <Sigma className='h-3.5 w-3.5' />
        </span>
      )}
    </div>
  )
}
