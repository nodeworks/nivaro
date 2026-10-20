import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, Globe2 } from 'lucide-react'
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
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

export interface GlobalPending {
  /** Parity key of the setting being changed. */
  key: string
  /** What the control shows while the confirm is open. */
  value: unknown
  /** Body of PATCH /field-config/:collection/:field. */
  patch: Record<string, unknown>
  /** Plain words: "Show Amount as currency". */
  label: string
}

export interface GlobalWriter {
  collection: string
  field: string
  fieldLabel: string
  pending: GlobalPending | null
  saving: boolean
  error: string | null
  propose(p: GlobalPending): void
  cancel(): void
  confirm(): void
}

export const GlobalWriterContext = createContext<GlobalWriter | null>(null)

/** The value a global control shows: the proposal while it waits, else what is stored. */
export function useGlobalValue<T>(key: string, stored: T): T {
  const w = useContext(GlobalWriterContext)
  return w?.pending?.key === key ? (w.pending.value as T) : stored
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
      {isLoading ? (
        <p className='text-[11px] opacity-80'>Finding where {w.fieldLabel} is used…</p>
      ) : (
        <div className='space-y-1 text-[11px]'>
          {shown.length > 0 && (
            <p>
              Forms of <span className='font-mono'>{w.collection}</span>: {shown.join(', ')}
              {layouts.length > shown.length && ` and ${layouts.length - shown.length} more`}
            </p>
          )}
          <p>Also the {w.collection} list and any API reader of this field.</p>
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

export function ScopeTag({ scope }: { scope: Scope }) {
  return scope === 'field' ? (
    <span
      data-scope='field'
      data-tip='Saved on the field itself: every form that shows this field changes'
      className='inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300 px-1.5 text-[11px] font-medium text-amber-700 dark:border-amber-700/60 dark:text-amber-300'
    >
      <Globe2 className='h-3 w-3' />
      Every form
    </span>
  ) : (
    <span data-scope='form' className='shrink-0 text-[11px] text-muted-foreground'>
      This form only
    </span>
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
      className={cn('text-[11px] text-amber-700 dark:text-amber-300', className)}
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
  children,
  className
}: {
  /** Parity key (data-setting). */
  k: string
  label: ReactNode
  /** One sentence: what this does. */
  effect?: ReactNode
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
    <div data-setting={k} className={cn('space-y-1', className)}>
      <div className='flex min-h-6 items-center justify-between gap-2'>
        <span className='min-w-0 text-[12px] font-medium text-foreground'>{label}</span>
        <span className='flex shrink-0 items-center gap-2'>
          <ScopeTag scope={scope} />
          {inline && children}
        </span>
      </div>
      {!inline && children}
      {effect && <p className='text-[11px] leading-snug text-muted-foreground'>{effect}</p>}
      {enforced && <EnforcementNote />}
      {scope === 'field' && w?.pending?.key === k && <GlobalConfirm />}
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
  disabled
}: {
  k: string
  label: ReactNode
  effect?: ReactNode
  scope?: Scope
  enforced?: boolean
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <Setting k={k} label={label} effect={effect} scope={scope} enforced={enforced} inline>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={typeof label === 'string' ? label : undefined}
        className='h-5 w-9 [&>span]:h-4 [&>span]:w-4 [&>span]:data-[state=checked]:translate-x-4'
      />
    </Setting>
  )
}

export const inputCls =
  'h-7 w-full rounded-md border border-slate-200 bg-white px-2 text-[12px] text-foreground placeholder:text-slate-400 focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-card'

/** A text input that saves while typing (coalesced by the draft) and sends on blur. */
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
  return (
    <input
      type={type}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => env?.flush()}
      className={cn(inputCls, mono && 'font-mono')}
    />
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
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(e) => {
        setDraft(e.target.value)
        onCommit(e.target.value)
      }}
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
    <div className='inline-flex w-full overflow-hidden rounded-md border border-slate-200 dark:border-border'>
      {options.map((o, i) => (
        <button
          key={o.value}
          type='button'
          aria-pressed={o.value === value}
          disabled={disabled}
          data-tip={o.tip}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex-1 px-2 py-1 text-[12px] transition-colors disabled:opacity-40',
            i > 0 && 'border-l border-slate-200 dark:border-border',
            o.value === value
              ? 'bg-nvr-cyan/10 font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted'
          )}
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
  disabled
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (v: string) => void
  ariaLabel?: string
  disabled?: boolean
}) {
  return (
    <SimpleSelect
      value={value}
      onChange={onChange}
      options={options}
      ariaLabel={ariaLabel}
      disabled={disabled}
      className='h-7 w-full rounded-md border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card'
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
  useEffect(() => {
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
        onBlur={commit}
        className={cn(
          'w-full rounded-md border bg-white px-2 py-1.5 font-mono text-[11px] leading-snug text-foreground placeholder:text-slate-400 focus:outline-none dark:bg-card',
          error
            ? 'border-red-400 dark:border-red-500'
            : 'border-slate-200 focus:border-nvr-cyan dark:border-border'
        )}
      />
      {error && <p className='text-[11px] text-red-600 dark:text-red-400'>{error}</p>}
    </div>
  )
}

export function Section({
  title,
  children,
  className
}: {
  title: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn('space-y-3 border-t border-slate-200 pt-3 dark:border-border', className)}
    >
      <h3 className='text-[12px] font-semibold text-foreground'>{title}</h3>
      {children}
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
          className='flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-left text-[12px] hover:border-slate-300 dark:border-border dark:bg-card'
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
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className='shrink-0 px-1 text-[12px] text-slate-400 hover:text-red-500'
            >
              ✕
            </button>
          </div>
        )
      })}
      <button
        type='button'
        onClick={() => onChange([...value, { field: '', op: 'eq', value: '' }])}
        className='text-[12px] text-nvr-cyan hover:underline'
      >
        + Add condition
      </button>
    </div>
  )
}

export function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type='button' onClick={onClick} className='text-[12px] text-nvr-cyan hover:underline'>
      {children}
    </button>
  )
}
