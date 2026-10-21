import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronRight, Globe2, X } from 'lucide-react'
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { Switch } from '../../ui/switch'
import { useFocusBuffer } from '../focus-buffer'
import { effectText, groupTitle, inputBase, labelText, segOption, segTrack } from '../panel-style'
import type { ApplyOptions } from '../useLayoutDraft'

// ── Environment every inspector part reads ──────────────────────────────────

export interface InspectorEnv {
  bundle: LayoutBundle
  apply(ops: LayoutOp[], opts?: ApplyOptions): void
  /** Send typed text now (blur). */
  flush(): void
  collection: string
  layoutType: string
  /** The active grouped layout — the one the server enforces rules from. */
  defaultForm: boolean
}

export const InspectorEnvContext = createContext<InspectorEnv | null>(null)

export function useInspectorEnv(): InspectorEnv {
  const env = useContext(InspectorEnvContext)
  if (!env) throw new Error('Inspector parts render inside <Inspector>')
  return env
}

// ── Global (every-form) writes wait for an inline confirm ───────────────────

/** nivaro_fields as it will be saved: what is stored plus every pending change. */
export interface GlobalDraft {
  options: Record<string, unknown>
  dependency_config: Record<string, unknown>
  /** Other columns (deprecated, deprecation_note). */
  columns: Record<string, unknown>
}

export interface GlobalPending {
  /** Where the confirm shows: the setting changed last (its parity key, or
   *  its row key when the setting repeats per row — Setting `confirmAt`). */
  key: string
  /** What each changed control shows while the confirm is open, by parity key. */
  values: Record<string, unknown>
  /** Plain words, one per changed setting: "Show Amount as currency". */
  labels: string[]
  /** Body of PATCH /field-config/:collection/:field. */
  patch: Record<string, unknown>
}

export interface GlobalWriter {
  collection: string
  collectionLabel: string
  field: string
  fieldLabel: string
  pending: GlobalPending | null
  draft: GlobalDraft
  saving: boolean
  error: string | null
  /** Merge one change into the pending patch (one confirm for all of them).
   *  `labelKey` (default `key`) keeps one label per row of a repeated setting. */
  propose(
    key: string,
    value: unknown,
    label: string,
    change: (d: GlobalDraft) => GlobalDraft,
    labelKey?: string
  ): void
  cancel(): void
  confirm(): void
}

export const GlobalWriterContext = createContext<GlobalWriter | null>(null)

/** The value a global control shows: the proposal while it waits, else what is stored. */
export function useGlobalValue<T>(key: string, stored: T): T {
  const w = useContext(GlobalWriterContext)
  const values = w?.pending?.values
  return values && key in values ? (values[key] as T) : stored
}

interface FieldImpact {
  source: string
  label: string
  detail: string
}

/** "Changes every form that shows this field" — names where before saving. */
export function GlobalConfirm() {
  const w = useContext(GlobalWriterContext)
  const client = useNivaroClient()
  const pending = w?.pending
  const { data: impacts, isLoading } = useQuery({
    queryKey: ['layout-editor', 'field-impact', w?.collection, w?.field],
    queryFn: () =>
      client
        .request<{ data: FieldImpact[] }>(
          get(`/data-model/${w?.collection}/fields/${encodeURIComponent(w?.field ?? '')}/impact`)
        )
        .then((r) => r.data ?? []),
    enabled: !!pending && !!w,
    staleTime: 60_000
  })
  if (!w || !pending) return null
  const layouts = [
    ...new Set((impacts ?? []).filter((i) => i.source === 'layout').map((i) => i.label))
  ]
  const others = [
    ...new Set((impacts ?? []).filter((i) => i.source !== 'layout').map((i) => i.label))
  ]
  const shown = layouts.slice(0, 8)
  return (
    <div
      data-setting='inspector.global_confirm'
      data-global-confirm=''
      className='mt-1.5 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-[12px] text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100'
    >
      <p className='font-medium'>
        This changes {w.fieldLabel} on every form that shows it, not just this one.
      </p>
      {pending.labels.length > 1 && (
        <ul data-global-changes='' className='list-disc space-y-0.5 pl-4 text-[11px]'>
          {pending.labels.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {isLoading ? (
        <p className='text-[11px] opacity-80'>Finding where {w.fieldLabel} is used…</p>
      ) : (
        <div className='space-y-1 text-[11px]'>
          {shown.length > 0 && (
            <p>
              Forms of {w.collectionLabel}: {shown.join(', ')}
              {layouts.length > shown.length && ` and ${layouts.length - shown.length} more`}
            </p>
          )}
          <p>Also the {w.collectionLabel} list and any API reader of this field.</p>
          {others.length > 0 && (
            <p className='opacity-80'>
              Other references: {others.slice(0, 5).join(', ')}
              {others.length > 5 && ` and ${others.length - 5} more`}
            </p>
          )}
        </div>
      )}
      <p className='text-[11px] opacity-80'>Undo does not reverse this.</p>
      {w.error && <p className='text-[11px] text-red-700 dark:text-red-300'>{w.error}</p>}
      <div className='flex gap-2'>
        <button
          type='button'
          data-global-save=''
          disabled={w.saving}
          onClick={() => w.confirm()}
          className='rounded-md bg-nvr-cyan px-2.5 py-1 text-[12px] font-medium text-nvr-navy hover:bg-[#00b8e0] disabled:opacity-40'
        >
          {w.saving ? 'Saving…' : 'Save for every form'}
        </button>
        <button
          type='button'
          data-global-cancel=''
          onClick={() => w.cancel()}
          className='rounded-md px-2.5 py-1 text-[12px] text-amber-900 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-900/40'
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Setting rows ────────────────────────────────────────────────────────────

export type Scope = 'form' | 'field'

/** Where a setting applies. "This form only" is the rule and stays out of the
 *  way (screen readers still hear it); "Every form" is the exception and shows. */
export function ScopeTag({ scope }: { scope: Scope }) {
  return scope === 'field' ? (
    <span
      data-scope='field'
      data-tip='Saved on the field itself: every form that shows this field changes'
      className='inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300'
    >
      <Globe2 className='h-3 w-3' />
      Every form
    </span>
  ) : (
    <span data-scope='form' className='sr-only'>
      This form only
    </span>
  )
}

/** Said once per panel instead of on every row. */
export function ScopeLegend({ field }: { field?: boolean }) {
  return (
    <p data-scope-legend='' className={effectText}>
      {field ? (
        <>
          Changes here apply to this form only, except settings marked{' '}
          <span className='inline-flex items-center gap-1 whitespace-nowrap font-medium text-amber-700 dark:text-amber-300'>
            <Globe2 className='h-3 w-3' />
            Every form
          </span>
          .
        </>
      ) : (
        'Changes here apply to this form only.'
      )}
    </p>
  )
}

export const DEFAULT_FORM_ONLY = 'Enforced on the default form only'

/** Server enforcement runs from the active grouped layout only (spec §9.12). */
export function EnforcementNote({ className }: { className?: string }) {
  const env = useInspectorEnv()
  if (env.defaultForm) return null
  return (
    <p
      data-setting='inspector.enforcement_note'
      data-enforcement=''
      className={cn('text-[12px] leading-snug text-amber-700 dark:text-amber-300', className)}
      data-tip='The server applies this from the active grouped layout. On this form it only works in the browser.'
    >
      {DEFAULT_FORM_ONLY}
    </p>
  )
}

export function Setting({
  k,
  label,
  effect,
  scope = 'form',
  enforced,
  inline,
  confirmAt,
  children,
  className
}: {
  /** Parity key (data-setting). */
  k: string
  /** Row key of a setting repeated per row; the confirm shows under that row. */
  confirmAt?: string
  label: ReactNode
  /** One sentence: what this does. Every setting says it. */
  effect: ReactNode
  scope?: Scope
  /** Server-enforced only from the default form. */
  enforced?: boolean
  /** Control sits on the label line (switches). */
  inline?: boolean
  children?: ReactNode
  className?: string
}) {
  const w = useContext(GlobalWriterContext)
  return (
    <div data-setting={k} data-setting-row='' className={cn('space-y-1.5', className)}>
      <div className='flex min-h-5 items-center justify-between gap-3'>
        <span className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5'>
          <span className={labelText}>{label}</span>
          <ScopeTag scope={scope} />
        </span>
        {inline && <span className='flex shrink-0 items-center'>{children}</span>}
      </div>
      {!inline && children}
      <p data-effect='' className={effectText}>
        {effect}
      </p>
      {enforced && <EnforcementNote />}
      {scope === 'field' && w?.pending?.key === (confirmAt ?? k) && <GlobalConfirm />}
    </div>
  )
}

export function Toggle({
  k,
  label,
  effect,
  scope,
  enforced,
  checked,
  onChange,
  disabled,
  confirmAt
}: {
  k: string
  label: ReactNode
  effect: ReactNode
  scope?: Scope
  enforced?: boolean
  confirmAt?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <Setting
      k={k}
      label={label}
      effect={effect}
      scope={scope}
      enforced={enforced}
      confirmAt={confirmAt}
      inline
    >
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={typeof label === 'string' ? label : undefined}
        className='h-[18px] w-8 border-0 data-[state=checked]:bg-nvr-cyan data-[state=unchecked]:bg-slate-300 dark:data-[state=unchecked]:bg-slate-600 [&>span]:mx-0.5 [&>span]:h-3.5 [&>span]:w-3.5 [&>span]:bg-white [&>span]:shadow-sm [&>span]:data-[state=checked]:translate-x-3.5'
      />
    </Setting>
  )
}

export const inputCls = inputBase

/** A text input that saves while typing (coalesced by the draft) and sends on blur / Enter. */
export function TextInput({
  value,
  onChange,
  placeholder,
  mono,
  disabled,
  type = 'text',
  ariaLabel
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
  disabled?: boolean
  type?: 'text' | 'number'
  ariaLabel?: string
}) {
  const env = useContext(InspectorEnvContext)
  const buf = useFocusBuffer(value, () => env?.flush())
  return (
    <input
      type={type}
      value={buf.value}
      disabled={disabled}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(e) => {
        buf.set(e.target.value)
        onChange(e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') env?.flush()
      }}
      {...buf.props}
      className={cn(inputCls, mono && 'font-mono')}
    />
  )
}

/** A multi-line TextInput. */
export function TextArea({
  value,
  onChange,
  ariaLabel,
  rows = 4
}: {
  value: string
  onChange: (v: string) => void
  ariaLabel?: string
  rows?: number
}) {
  const env = useContext(InspectorEnvContext)
  const buf = useFocusBuffer(value, () => env?.flush())
  return (
    <textarea
      aria-label={ariaLabel}
      rows={rows}
      value={buf.value}
      onChange={(e) => {
        buf.set(e.target.value)
        onChange(e.target.value)
      }}
      {...buf.props}
      className={cn(inputBase, 'h-auto py-1.5 leading-snug')}
    />
  )
}

/**
 * Wraps an editor (row rules, inline display…) so it renders from what was
 * edited while focus is inside it — see useFocusBuffer. `children` gets the
 * value to render and `keep`, which records a change and returns it:
 * `onChange={(r) => save(keep(next(r)), label, true)}`. Blur and Enter send.
 */
export function Buffered<T>({
  value,
  children,
  className
}: {
  value: T
  children: (value: T, keep: (v: T) => T) => ReactNode
  className?: string
}) {
  const env = useContext(InspectorEnvContext)
  const buf = useFocusBuffer(value, () => env?.flush())
  return (
    <div
      className={className}
      {...buf.props}
      onKeyDownCapture={(e) => {
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') env?.flush()
      }}
    >
      {children(buf.value, (v) => {
        buf.set(v)
        return v
      })}
    </div>
  )
}

/** A text input whose value is held locally until confirmed (every-form settings). */
export function DraftInput({
  value,
  onCommit,
  placeholder,
  mono,
  ariaLabel
}: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  mono?: boolean
  ariaLabel?: string
}) {
  const buf = useFocusBuffer(value)
  return (
    <input
      value={buf.value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(e) => {
        buf.set(e.target.value)
        onCommit(e.target.value)
      }}
      {...buf.props}
      className={cn(inputCls, mono && 'font-mono')}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled
}: {
  value: T
  options: Array<{ value: T; label: string; tip?: string }>
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <div className={segTrack(options.length)}>
      {options.map((o) => (
        <button
          key={o.value}
          type='button'
          aria-pressed={o.value === value}
          disabled={disabled}
          data-tip={o.tip}
          onClick={() => onChange(o.value)}
          className={segOption(o.value === value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Choice({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  unknownLabel = (v: string) => v
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (v: string) => void
  ariaLabel?: string
  disabled?: boolean
  /** How a stored value this list does not offer is named. */
  unknownLabel?: (value: string) => string
}) {
  // A stored value this list does not offer still shows (and is kept) until changed.
  const shown =
    value && !options.some((o) => o.value === value)
      ? [...options, { value, label: unknownLabel(value) }]
      : options
  return (
    <SimpleSelect
      value={value}
      onChange={onChange}
      options={shown}
      ariaLabel={ariaLabel}
      disabled={disabled}
      className={cn(inputBase, 'focus:ring-0 focus:ring-offset-0')}
    />
  )
}

/**
 * JSON for settings with no editor yet. Kept as typed; saved on blur only when
 * it parses (and `validate` passes) — a typo never deletes what is stored.
 * Empty saves "not set".
 */
export function JsonInput({
  value,
  onCommit,
  placeholder,
  rows = 4,
  validate,
  ariaLabel
}: {
  value: unknown
  onCommit: (v: unknown) => void
  placeholder?: string
  rows?: number
  validate?: (v: unknown) => string | null
  ariaLabel?: string
}) {
  const stored = value == null ? '' : JSON.stringify(value, null, 2)
  const [text, setText] = useState(stored)
  const [error, setError] = useState<string | null>(null)
  // What is typed wins while the box has focus; the stored value shows again after.
  const focused = useRef(false)
  useEffect(() => {
    if (focused.current) return
    setText(stored)
    setError(null)
  }, [stored])
  const commit = () => {
    const t = text.trim()
    if (!t) {
      setError(null)
      if (value != null) onCommit(undefined)
      return
    }
    try {
      const parsed = JSON.parse(t) as unknown
      const problem = validate?.(parsed) ?? null
      if (problem) return setError(problem)
      setError(null)
      if (JSON.stringify(parsed) !== JSON.stringify(value)) onCommit(parsed)
    } catch {
      setError('Not valid JSON — nothing saved')
    }
  }
  return (
    <div className='space-y-1'>
      <textarea
        value={text}
        rows={rows}
        aria-label={ariaLabel}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => {
          focused.current = true
        }}
        onBlur={() => {
          focused.current = false
          commit()
        }}
        className={cn(
          'w-full rounded-md border bg-white px-2.5 py-1.5 font-mono text-[12px] leading-snug text-foreground placeholder:text-slate-400 focus:outline-none dark:bg-background',
          error
            ? 'border-red-400 dark:border-red-500'
            : 'border-slate-200 focus:border-nvr-cyan dark:border-border'
        )}
      />
      {error && <p className='text-[12px] text-red-600 dark:text-red-400'>{error}</p>}
    </div>
  )
}

/**
 * A named group of settings. `collapsible` folds it (closed unless
 * `defaultOpen`): for raw JSON and other rarely needed detail. Folded content
 * stays mounted, so what is typed in it survives a fold.
 */
export function Section({
  title,
  children,
  className,
  collapsible,
  defaultOpen = false
}: {
  title: ReactNode
  children: ReactNode
  className?: string
  collapsible?: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(!collapsible || defaultOpen)
  return (
    <section
      className={cn(
        'space-y-4 border-t border-slate-100 pt-5 dark:border-border/60',
        collapsible && !open && 'space-y-0',
        className
      )}
    >
      {collapsible ? (
        <button
          type='button'
          aria-expanded={open}
          data-section-toggle=''
          onClick={() => setOpen((v) => !v)}
          className={cn(
            groupTitle,
            '-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-1.5 rounded px-1 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted/60'
          )}
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150',
              open && 'rotate-90'
            )}
          />
          {title}
        </button>
      ) : (
        <h3 className={groupTitle}>{title}</h3>
      )}
      <div hidden={!open} className='space-y-5'>
        {children}
      </div>
    </section>
  )
}

/** Checkbox list of fields in a popover (labels first, key secondary). */
export function FieldMultiPicker({
  value,
  options,
  onChange,
  placeholder = 'None selected',
  ariaLabel
}: {
  value: string[]
  options: Array<{ value: string; label: string; hint?: string }>
  onChange: (v: string[]) => void
  placeholder?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const labelOf = (f: string) => options.find((o) => o.value === f)?.label ?? f
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={ariaLabel}
          className={cn(
            inputBase,
            'flex items-center justify-between text-left hover:border-slate-300'
          )}
        >
          <span className={cn('truncate', !value.length && 'text-slate-400')}>
            {value.length ? value.map(labelOf).join(', ') : placeholder}
          </span>
          <ChevronDown className='ml-1 h-3.5 w-3.5 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-64 p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search fields…' className='h-8 text-[12px]' />
          <CommandList className='max-h-[240px]'>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No fields
            </CommandEmpty>
            <CommandGroup>
              {options.map((o) => {
                const checked = value.includes(o.value)
                return (
                  <CommandItem
                    key={o.value}
                    value={`${o.label} ${o.value}`}
                    onSelect={() =>
                      onChange(checked ? value.filter((x) => x !== o.value) : [...value, o.value])
                    }
                    className='flex items-center gap-2 text-[12px]'
                  >
                    <Check
                      className={cn('h-3 w-3 shrink-0', checked ? 'opacity-100' : 'opacity-0')}
                    />
                    <span className='flex-1 truncate'>{o.label}</span>
                    <span className='shrink-0 font-mono text-[11px] text-slate-400'>
                      {o.hint ?? o.value}
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ── Record condition builder (field / op / value) ──────────────────────────

export interface RecordCondition {
  field: string
  op: string
  value?: unknown
}

/** Ops the server's matchesRecordConditions evaluates — nothing else is offered. */
export const CONDITION_OPS = [
  { value: 'eq', label: 'is' },
  { value: 'neq', label: 'is not' },
  { value: 'nnull', label: 'is set' }
]

export function ConditionBuilder({
  value,
  fields,
  onChange
}: {
  value: RecordCondition[]
  fields: Array<{ value: string; label: string }>
  onChange: (v: RecordCondition[]) => void
}) {
  const set = (i: number, patch: Partial<RecordCondition>) =>
    onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  return (
    <div className='space-y-1.5'>
      {value.map((c, i) => {
        // A stored op this builder does not offer stays visible (and kept) until changed.
        const ops = CONDITION_OPS.some((o) => o.value === c.op)
          ? CONDITION_OPS
          : [...CONDITION_OPS, { value: c.op, label: c.op }]
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: conditions are positional
          <div key={i} className='flex items-center gap-1' data-condition-row=''>
            <div className='min-w-0 flex-[3]'>
              <Choice
                value={c.field}
                ariaLabel='Field'
                options={[{ value: '', label: 'Field…' }, ...fields]}
                onChange={(v) => set(i, { field: v })}
              />
            </div>
            <div className='min-w-0 flex-[2]'>
              <Choice
                value={c.op}
                ariaLabel='Condition'
                options={ops}
                onChange={(v) => set(i, v === 'nnull' ? { op: v, value: undefined } : { op: v })}
              />
            </div>
            {c.op !== 'nnull' && c.op !== 'null' && (
              <div className='min-w-0 flex-[2]'>
                <TextInput
                  value={c.value == null ? '' : String(c.value)}
                  ariaLabel='Value'
                  placeholder='value'
                  onChange={(v) => set(i, { value: v })}
                />
              </div>
            )}
            <button
              type='button'
              aria-label='Remove condition'
              data-tip='Remove condition'
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className='inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-100 hover:text-red-600 dark:hover:bg-muted dark:hover:text-red-400'
            >
              <X className='h-3.5 w-3.5' />
            </button>
          </div>
        )
      })}
      <button
        type='button'
        onClick={() => onChange([...value, { field: '', op: 'eq', value: '' }])}
        className={addLinkCls}
      >
        + Add condition
      </button>
    </div>
  )
}

export const addLinkCls = 'text-[12px] font-medium text-sky-700 hover:underline dark:text-nvr-cyan'

export function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type='button' onClick={onClick} className={addLinkCls}>
      {children}
    </button>
  )
}
