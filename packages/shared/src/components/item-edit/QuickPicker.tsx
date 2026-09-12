import { useQueries, useQuery } from '@tanstack/react-query'
import { Check, ChevronLeft, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, titleCase } from '../../lib/utils'
import { Skeleton } from '../ui/skeleton'
import { resolveOptionFilterTokens } from './FieldRenderer'
import { applyDisplayTemplate, buildCascadeFilter, getCascadeFilters, parseJson } from './helpers'
import { resolveM2MRelatedCollection } from './M2MCombobox'
import type { CMSField, CMSRelation } from './types'

/**
 * Quick picker — a guided walk down a record's dependency tree, one field at
 * a time (workflows: Funding Year → Zone → Region → Project Type → Project →
 * Sub Type). Each step's options come through the SAME cascade compiler the
 * form's pickers use (helpers.buildCascadeFilter), so a step can never offer a
 * record the field's own picker would refuse, and every pick goes through the
 * host's normal change path — dirty tracking, cascades, auto-select, row rules
 * and validation behave exactly as with hand entry.
 *
 * It renders as SLIDES — one step at a time with a clickable track above and
 * Back / Skip / Next below — inside a modal: ItemEditForm opens it from the
 * header's "Quick pick" button bound to the live draft, and QuickPickerDialog
 * opens it from the "+ New" menus before a record exists.
 */

const CHIP_LIMIT = 12
const OPTION_PAGE = 200

export interface QuickPickerProps {
  collection: string
  /** 'new' for an unsaved record. */
  itemId: string
  /** Ordered field keys (the layout's quick_picker). */
  steps: string[]
  fieldConfig: CMSField[]
  relations: CMSRelation[]
  draft: Record<string, unknown>
  /** Effective ids for an M2M alias (committed ± staged); undefined = unknown. */
  getM2M: (field: string) => string[] | undefined
  onChange: (field: string, value: unknown) => void
  onM2MChange: (field: string, ids: string[]) => void
  /** Layout-effective labels + option filters (ParentDraftContext shape). */
  fieldLabels?: Record<string, string>
  fieldOptionFilters?: Record<string, Record<string, unknown>>
  /** Fires whenever completeness changes. */
  onCompleteChange?: (complete: boolean) => void
  /**
   * Primary action rendered in the Next slot once the chain is complete (or on
   * the last slide): "Done" in the form, "Create workflow" before a record
   * exists. Disabled until complete unless `finishRequiresComplete` is false.
   */
  onFinish?: () => void
  finishLabel?: string
  finishRequiresComplete?: boolean
  className?: string
}

type StepDef = {
  field: string
  label: string
  required: boolean
  kind: 'm2o' | 'm2m'
  /** M2M with max_values 1 behaves as a single pick. */
  multi: boolean
  target: string | null
  fc: CMSField | null
}

type Item = Record<string, unknown>

/** `fields=` for a target's display template; undefined = full rows (no
 *  template known — never guess column names, a missing one 500s the read). */
const templateFields = (tmpl: string | null | undefined): string | undefined => {
  if (!tmpl) return undefined
  const tokens = [...tmpl.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1])
  return ['id', ...new Set(tokens)].join(',')
}

const isEmptyVal = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0)

export function useQuickPickerStepDefs(
  steps: string[],
  fieldConfig: CMSField[],
  relations: CMSRelation[],
  collection: string,
  fieldLabels?: Record<string, string>
): StepDef[] {
  return useMemo(() => {
    const out: StepDef[] = []
    for (const field of steps) {
      const fc = fieldConfig.find((f) => f.field === field) ?? null
      const label = fieldLabels?.[field] ?? fc?.label ?? titleCase(field)
      const m2o = relations.find(
        (r) => r.many_collection === collection && r.many_field === field && !r.junction_field
      )
      if (m2o?.one_collection) {
        out.push({
          field,
          label,
          required: !!fc?.required,
          kind: 'm2o',
          multi: false,
          target: m2o.one_collection,
          fc
        })
        continue
      }
      const alias = relations.find((r) => r.one_collection === collection && r.one_field === field)
      if (alias?.many_collection) {
        const junctionField =
          alias.junction_field ??
          relations.find((c) => c.many_collection === alias.many_collection && c.id !== alias.id)
            ?.many_field ??
          null
        const companion = junctionField
          ? relations.find(
              (c) => c.many_collection === alias.many_collection && c.many_field === junctionField
            )
          : undefined
        const target = resolveM2MRelatedCollection(companion)
        const opts = parseJson<{ max_values?: number | null }>(fc?.options ?? null)
        out.push({
          field,
          label,
          required: !!fc?.required,
          kind: 'm2m',
          multi: opts?.max_values !== 1,
          target,
          fc
        })
      }
      // Not a relation on this collection — the layout names a field the
      // picker cannot walk; skip it rather than render a dead step.
    }
    return out.filter((s) => s.target)
  }, [steps, fieldConfig, relations, collection, fieldLabels])
}

export function QuickPicker({
  collection,
  itemId,
  steps,
  fieldConfig,
  relations,
  draft,
  getM2M,
  onChange,
  onM2MChange,
  fieldLabels,
  fieldOptionFilters,
  onCompleteChange,
  onFinish,
  finishLabel = 'Done',
  finishRequiresComplete = true,
  className
}: QuickPickerProps) {
  const client = useNivaroClient()
  const defs = useQuickPickerStepDefs(steps, fieldConfig, relations, collection, fieldLabels)

  const stepValue = (d: StepDef): unknown => (d.kind === 'm2m' ? getM2M(d.field) : draft[d.field])
  const hasValue = (d: StepDef) => !isEmptyVal(stepValue(d))

  const [skipped, setSkipped] = useState<Set<string>>(() => new Set())
  const [manual, setManual] = useState<string | null>(null)
  const firstOpen = defs.find((d) => !hasValue(d) && !skipped.has(d.field))
  // Everything filled → start at the first step so Back/Next still walk the chain.
  const activeField = manual ?? firstOpen?.field ?? defs[0]?.field ?? null
  const activeIdx = defs.findIndex((d) => d.field === activeField)
  const active = activeIdx >= 0 ? defs[activeIdx] : null
  const complete =
    defs.length > 0 && defs.every((d) => hasValue(d) || (!d.required && skipped.has(d.field)))
  const completeRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (completeRef.current !== complete) {
      completeRef.current = complete
      onCompleteChange?.(complete)
    }
  }, [complete, onCompleteChange])

  // ── Options for the active step (same compiler as the form's pickers) ──
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompiles when the step or any parent value moves; helpers are stable closures
  const activeFilterStr = useMemo(() => {
    if (!active?.fc) return undefined
    const rules = getCascadeFilters(active.fc.dependency_config as Record<string, unknown> | null)
    const compiled = buildCascadeFilter({
      rules,
      parentValue: (p) => {
        const pd = defs.find((d) => d.field === p)
        if (pd?.kind === 'm2m') {
          const ids = getM2M(p) ?? []
          return ids.length === 0 ? null : ids.length === 1 ? ids[0] : ids
        }
        const v = draft[p]
        if (v != null) return v
        const ids = getM2M(p)
        if (ids?.length) return ids.length === 1 ? ids[0] : ids
        return null
      },
      parentOptionFilter: (p) => {
        const raw = fieldOptionFilters?.[p]
        return raw ? resolveOptionFilterTokens(raw, draft, itemId) : undefined
      }
    })
    const own = parseJson<{ option_filter?: Record<string, unknown> }>(active.fc.options ?? null)
    const ownFilter = own?.option_filter
      ? resolveOptionFilterTokens(own.option_filter, draft, itemId)
      : undefined
    const parts = [compiled.filter, ownFilter].filter(
      (f): f is Record<string, unknown> => !!f && Object.keys(f).length > 0
    )
    const merged = parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { _and: parts }
    return merged ? JSON.stringify(merged) : undefined
  }, [active?.field, active?.fc, draft, defs, fieldOptionFilters, itemId, getM2M])
  // biome-ignore lint/correctness/useExhaustiveDependencies: same inputs as the filter above
  const activeMissingRequired = useMemo(() => {
    if (!active?.fc) return [] as string[]
    const rules = getCascadeFilters(active.fc.dependency_config as Record<string, unknown> | null)
    return rules
      .filter((r) => r.show_all_if_no_parent === false)
      .map((r) => r.parent_field)
      .filter((p) => {
        const pd = defs.find((d) => d.field === p)
        return pd ? !hasValue(pd) : isEmptyVal(draft[p] ?? getM2M(p))
      })
  }, [active?.field, active?.fc, draft, defs, getM2M])

  // Display templates per target collection (one small fetch each, shared
  // cache key with the grids) — drives option labels AND the `fields=` of
  // every read, so a table without a `name` column never 500s.
  const targets = useMemo(
    () => [...new Set(defs.map((d) => d.target).filter((t): t is string => !!t))],
    [defs]
  )
  const targetMetas = useQueries({
    queries: targets.map((t) => ({
      queryKey: ['collection-display-meta', t],
      queryFn: () =>
        client
          .request<{ data: { display_template?: string | null } }>(get(`/collections/${t}`))
          .then((r) => r.data),
      staleTime: 10 * 60_000
    }))
  })
  const tmplFor = (target: string | null): string | null => {
    const i = target ? targets.indexOf(target) : -1
    return i >= 0 ? (targetMetas[i]?.data?.display_template ?? null) : null
  }
  const tmpl = tmplFor(active?.target ?? null)
  const fields = templateFields(tmpl)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 180)
    return () => window.clearTimeout(t)
  }, [search])
  // biome-ignore lint/correctness/useExhaustiveDependencies: search resets on step change
  useEffect(() => {
    setSearch('')
    setDebounced('')
  }, [active?.field])

  const optionsEnabled = !!active?.target && activeMissingRequired.length === 0
  const {
    data: options,
    isLoading: optionsLoading,
    isError: optionsError,
    refetch
  } = useQuery<Item[]>({
    queryKey: ['quick-picker-opts', active?.target ?? '', activeFilterStr ?? '', fields, debounced],
    queryFn: () =>
      client
        .request<{ data: Item[] }>(
          get(`/items/${active!.target}`, {
            limit: OPTION_PAGE,
            picker: '1',
            ...(fields ? { fields } : {}),
            ...(activeFilterStr ? { filter: activeFilterStr } : {}),
            ...(debounced ? { search: debounced } : {})
          })
        )
        .then((r) => r.data ?? []),
    enabled: optionsEnabled,
    staleTime: 30_000
  })
  const labelOf = (it: Item) => applyDisplayTemplate(tmpl, it) || `#${String(it.id)}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: labelOf is a closure over tmpl, which IS listed
  const sortedOptions = useMemo(
    () => [...(options ?? [])].sort((a, b) => labelOf(a).localeCompare(labelOf(b))),
    [options, tmpl]
  )
  const listMode = !debounced && (options?.length ?? 0) > CHIP_LIMIT ? true : !!debounced
  const [autoPicked, setAutoPicked] = useState<Set<string>>(() => new Set())
  const [userCleared, setUserCleared] = useState<Set<string>>(() => new Set())

  // Sole option → auto-pick (the form's auto_select_single rule), once per
  // step, never after the user cleared it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires when the step's option set settles; the guards read the latest sets
  useEffect(() => {
    if (!active || !options || options.length !== 1 || debounced) return
    if (hasValue(active) || userCleared.has(active.field) || autoPicked.has(active.field)) return
    const id = String(options[0].id)
    setAutoPicked((s) => new Set(s).add(active.field))
    if (active.kind === 'm2m') onM2MChange(active.field, [id])
    else onChange(active.field, options[0].id)
  }, [active?.field, options, debounced])

  const pick = (d: StepDef, item: Item) => {
    const id = String(item.id)
    if (d.kind === 'm2m') {
      const cur = getM2M(d.field) ?? []
      if (d.multi) {
        onM2MChange(d.field, cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
        return
      }
      onM2MChange(d.field, [id])
    } else {
      onChange(d.field, item.id)
    }
    setManual(null)
  }
  const clearStep = (d: StepDef) => {
    setUserCleared((s) => new Set(s).add(d.field))
    if (d.kind === 'm2m') onM2MChange(d.field, [])
    else onChange(d.field, null)
    setManual(d.field)
  }
  const goTo = (d: StepDef) => setManual(d.field)
  const back = () => {
    if (activeIdx > 0) setManual(defs[activeIdx - 1].field)
  }
  const next = () => {
    // Prefer the next step still needing a value; otherwise just the next slide.
    const open = defs.findIndex(
      (d, idx) => idx > activeIdx && !hasValue(d) && !skipped.has(d.field)
    )
    const i = open >= 0 ? open : Math.min(activeIdx + 1, defs.length - 1)
    setManual(defs[i]?.field ?? null)
  }
  const skip = (d: StepDef) => {
    setSkipped((s) => new Set(s).add(d.field))
    setManual(null)
  }

  // ── Labels for chosen values (one small fetch per step with a value) ──
  const chosen = defs.map((d) => ({ d, v: stepValue(d) }))
  const labelQueries = useQueries({
    queries: chosen.map(({ d, v }) => {
      const ids = Array.isArray(v) ? v.map(String) : isEmptyVal(v) ? [] : [String(v)]
      const f = templateFields(tmplFor(d.target))
      return {
        queryKey: ['quick-picker-labels', d.target ?? '', ids.join(','), f ?? '*'],
        queryFn: () =>
          client
            .request<{ data: Item[] }>(
              get(`/items/${d.target}`, {
                filter: JSON.stringify({ id: { _in: ids } }),
                ...(f ? { fields: f } : {}),
                limit: ids.length
              })
            )
            .then((r) => r.data ?? []),
        enabled: !!d.target && ids.length > 0,
        staleTime: 60_000
      }
    })
  })
  const valueLabel = (i: number): string | null => {
    const { d, v } = chosen[i]
    if (isEmptyVal(v)) return null
    const rows = labelQueries[i]?.data
    if (!rows?.length) return Array.isArray(v) ? `${v.length} selected` : '…'
    return rows
      .map((r) => applyDisplayTemplate(tmplFor(d.target), r) || `#${String(r.id)}`)
      .join(', ')
  }

  if (defs.length === 0) return null

  const summary = defs
    .map((d, i) => (hasValue(d) ? valueLabel(i) : null))
    .filter((x): x is string => !!x)
  const cur = active ? stepValue(active) : null
  const curIds = Array.isArray(cur) ? cur.map(String) : isEmptyVal(cur) ? [] : [String(cur)]
  const isLast = activeIdx === defs.length - 1
  const nextEnabled = active ? hasValue(active) || (!active.required && true) : false
  const advance = () => {
    if (!active || isLast) return
    if (!hasValue(active) && !active.required) skip(active)
    else next()
  }

  return (
    <div data-quick-picker className={cn('space-y-3', className)}>
      {/* Track — every step, done ones showing their value; click to jump. */}
      <ol className='flex flex-wrap items-center gap-x-1 gap-y-1' aria-label='Quick picker steps'>
        {defs.map((d, i) => {
          const done = hasValue(d)
          const isActive = d.field === active?.field
          const lbl = done ? valueLabel(i) : null
          const wasSkipped = !done && skipped.has(d.field)
          return (
            <li key={d.field} className='flex items-center gap-1'>
              <button
                type='button'
                onClick={() => goTo(d)}
                aria-current={isActive ? 'step' : undefined}
                className={cn(
                  'flex max-w-[220px] items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] transition-colors duration-150',
                  isActive
                    ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                    : done
                      ? 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 dark:border-border dark:bg-muted dark:text-slate-200'
                      : 'border-dashed border-slate-200 text-slate-400 hover:border-slate-300 dark:border-border'
                )}
              >
                <span
                  className={cn(
                    'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[8px] font-bold',
                    done || isActive
                      ? 'bg-nvr-cyan text-[#172940]'
                      : 'bg-slate-200 text-slate-500 dark:bg-white/[0.12] dark:text-slate-400'
                  )}
                >
                  {done ? <Check className='h-2 w-2' strokeWidth={3} /> : i + 1}
                </span>
                <span className='truncate'>
                  <span className={cn(done && 'text-slate-400 dark:text-slate-500')}>
                    {d.label}
                  </span>
                  {done && lbl && (
                    <span className='ml-1 font-medium text-slate-700 dark:text-slate-200'>
                      {lbl}
                    </span>
                  )}
                  {wasSkipped && <span className='ml-1 italic text-slate-400'>skipped</span>}
                </span>
              </button>
              {i < defs.length - 1 && (
                <span className='h-px w-2 bg-slate-200 dark:bg-border' aria-hidden />
              )}
            </li>
          )
        })}
      </ol>

      {/* Slide — the active step */}
      {active ? (
        <fieldset
          key={active.field}
          className='nvr-fade-in m-0 min-w-0 border-0 p-0'
          aria-label={active.label}
        >
          <div className='mb-2 flex items-baseline gap-2'>
            <span className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
              {active.label}
              {active.required && <span className='ml-0.5 text-destructive'>*</span>}
            </span>
            <span className='text-[11px] text-slate-400'>
              {activeIdx + 1} of {defs.length}
              {active.multi ? ' · pick one or more' : ''}
              {autoPicked.has(active.field) && hasValue(active) ? ' · only option' : ''}
            </span>
            <span className='flex-1' />
            {hasValue(active) && (
              <button
                type='button'
                onClick={() => clearStep(active)}
                className='flex items-center gap-0.5 text-[11.5px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
              >
                <X className='h-3 w-3' /> Clear
              </button>
            )}
          </div>

          <div className='min-h-[120px]'>
            {activeMissingRequired.length > 0 ? (
              <p className='text-[12.5px] text-slate-500 dark:text-slate-400'>
                Pick{' '}
                {activeMissingRequired
                  .map(
                    (p) =>
                      defs.find((d) => d.field === p)?.label ?? fieldLabels?.[p] ?? titleCase(p)
                  )
                  .join(' and ')}{' '}
                first.
              </p>
            ) : optionsError ? (
              <p className='text-[12.5px] text-destructive'>
                Could not load options.{' '}
                <button type='button' onClick={() => void refetch()} className='underline'>
                  Retry
                </button>
              </p>
            ) : optionsLoading && !options ? (
              <div className='flex gap-1.5'>
                <Skeleton className='h-8 w-24 rounded-full' />
                <Skeleton className='h-8 w-28 rounded-full' />
                <Skeleton className='h-8 w-20 rounded-full' />
              </div>
            ) : (
              <>
                {listMode && (
                  <div className='relative mb-2'>
                    <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
                    <input
                      // biome-ignore lint/a11y/noAutofocus: the slide IS the focus target
                      autoFocus
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && sortedOptions[0]) pick(active, sortedOptions[0])
                        if (e.key === 'Backspace' && !search && activeIdx > 0) back()
                      }}
                      placeholder={`Search ${active.label.toLowerCase()}…`}
                      className='h-9 w-full rounded-md border border-slate-200 bg-white pl-8 pr-2 text-[13px] focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-card'
                    />
                  </div>
                )}
                {sortedOptions.length === 0 ? (
                  <p className='text-[12.5px] text-slate-500 dark:text-slate-400'>
                    No {active.label.toLowerCase()} match
                    {summary.length ? ` ${summary.join(' · ')}` : ''}
                    {debounced ? ` and “${debounced}”` : ''}.
                  </p>
                ) : listMode ? (
                  <div className='max-h-72 overflow-y-auto rounded-md border border-slate-200 dark:border-border'>
                    {sortedOptions.map((it) => {
                      const sel = curIds.includes(String(it.id))
                      return (
                        <button
                          key={String(it.id)}
                          type='button'
                          aria-pressed={sel}
                          onClick={() => pick(active, it)}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-muted',
                            sel && 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                          )}
                        >
                          <span
                            className={cn(
                              'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                              sel
                                ? 'border-nvr-cyan bg-nvr-cyan'
                                : 'border-slate-300 dark:border-slate-600'
                            )}
                          >
                            {sel && (
                              <Check className='h-2.5 w-2.5 text-[#172940]' strokeWidth={3} />
                            )}
                          </span>
                          <span className='truncate'>{labelOf(it)}</span>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <div
                    role={active.multi ? 'group' : 'radiogroup'}
                    className='flex flex-wrap gap-2'
                  >
                    {sortedOptions.map((it) => {
                      const sel = curIds.includes(String(it.id))
                      return (
                        <button
                          key={String(it.id)}
                          type='button'
                          aria-pressed={sel}
                          onClick={() => pick(active, it)}
                          className={cn(
                            'h-8 rounded-full border px-3 text-[13px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                            sel
                              ? 'border-nvr-cyan bg-nvr-cyan/10 font-medium text-nvr-navy dark:text-nvr-cyan'
                              : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-border dark:bg-card dark:text-slate-200'
                          )}
                        >
                          {labelOf(it)}
                        </button>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Slide navigation */}
          <div className='mt-3 flex items-center gap-2'>
            <button
              type='button'
              onClick={back}
              disabled={activeIdx === 0}
              className='flex h-8 items-center gap-1 rounded-md px-2 text-[12.5px] text-slate-600 hover:bg-muted disabled:opacity-40 dark:text-slate-300'
            >
              <ChevronLeft className='h-3.5 w-3.5' /> Back
            </button>
            <span className='flex-1' />
            {!active.required && !hasValue(active) && !isLast && (
              <button
                type='button'
                onClick={() => skip(active)}
                className='h-8 rounded-md px-2 text-[12.5px] text-slate-500 hover:bg-muted dark:text-slate-400'
              >
                Skip
              </button>
            )}
            {onFinish && (isLast || complete) ? (
              <button
                type='button'
                onClick={onFinish}
                disabled={finishRequiresComplete && !complete}
                data-quick-picker-create
                className='h-8 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-[#172940] hover:bg-[#00b8e0] disabled:opacity-40'
              >
                {finishLabel}
              </button>
            ) : !isLast ? (
              <button
                type='button'
                onClick={advance}
                disabled={!nextEnabled}
                className='h-8 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-[#172940] hover:bg-[#00b8e0] disabled:opacity-40'
              >
                Next
              </button>
            ) : null}
          </div>
        </fieldset>
      ) : (
        <p className='text-[12.5px] text-slate-500 dark:text-slate-400'>
          All steps done — pick any step above to change it.
        </p>
      )}
    </div>
  )
}
