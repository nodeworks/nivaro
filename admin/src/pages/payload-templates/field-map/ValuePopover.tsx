import {
  AlertTriangle,
  Braces,
  CalendarClock,
  ChevronDown,
  GitBranch,
  KeyRound,
  Network,
  Plus,
  Rows3,
  Type,
  X
} from 'lucide-react'
import { memo, type ReactNode, useId, useState } from 'react'
import { Link } from 'react-router'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { ConditionRule, Field, Transform, ValueSpec } from '../api'
import { ConditionRules } from './ConditionRules'
import { BUILTINS, transformLabel, valueIsBlank, valueSourceText } from './labels'
import { RecordFieldSection, RelatedSection } from './PathPicker'
import { TransformChips } from './TransformChips'
import {
  FmField,
  FmLabel,
  FmPopoverContent,
  fmInput,
  Hint,
  type ItemScope,
  smallAction,
  TextField,
  useFieldMapEnv
} from './ui'

// The value chip on every row and the anchored popover behind it: where the
// value comes from (seven sources), the steps it goes through, and what to use
// when it comes out empty. Every input commits as it changes.

type Tab = 'fixed' | 'record' | 'related' | 'builtin' | 'secret' | 'switch' | 'formula'

const TABS: { id: Tab; label: string; icon: typeof Type }[] = [
  { id: 'fixed', label: 'Fixed', icon: Type },
  { id: 'record', label: 'Record field', icon: Rows3 },
  { id: 'related', label: 'Related', icon: Network },
  { id: 'builtin', label: 'Built-in', icon: CalendarClock },
  { id: 'secret', label: 'API secret', icon: KeyRound },
  { id: 'switch', label: 'If / then', icon: GitBranch },
  { id: 'formula', label: 'Formula', icon: Braces }
]

function tabOf(v: ValueSpec | undefined): Tab {
  if (!v) return 'fixed'
  if (v.source === 'path') return v.path.startsWith('context.') ? 'related' : 'record'
  return v.source
}

/** A value without its steps and fallbacks (those are carried over by withMeta). */
type Core = ValueSpec

/** Keep the steps and fallbacks when the source changes. */
function withMeta(core: Core, prev: ValueSpec | undefined): ValueSpec {
  const out = { ...core } as ValueSpec
  if (prev?.transforms?.length) out.transforms = prev.transforms
  else delete out.transforms
  if (prev?.fallbacks?.length) out.fallbacks = prev.fallbacks
  else delete out.fallbacks
  return out
}

export function sourceIcon(v: ValueSpec | undefined) {
  return TABS.find((t) => t.id === tabOf(v))?.icon ?? Type
}

// ─── Panels ──────────────────────────────────────────────────────────────────

function FixedPanel({
  value,
  type,
  onChange
}: {
  value: ValueSpec | undefined
  type: Field['type']
  onChange: (v: ValueSpec) => void
}) {
  const cur = value?.source === 'fixed' ? value.value : undefined
  const commit = (v: string | number | boolean | null) =>
    onChange(withMeta({ source: 'fixed', value: v }, value))
  const isNull = cur === null
  return (
    <div className='space-y-2.5'>
      {type === 'boolean' ? (
        <div className='flex gap-1'>
          {[true, false].map((b) => (
            <button
              key={String(b)}
              type='button'
              aria-pressed={cur === b}
              onClick={() => commit(b)}
              className={cn(
                'h-7 rounded-md border px-3 font-mono text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                cur === b
                  ? 'border-nvr-cyan bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-border dark:text-slate-300'
              )}
            >
              {String(b)}
            </button>
          ))}
        </div>
      ) : type === 'json' ? (
        <FmField label='Value'>
          <textarea
            value={cur == null ? '' : String(cur)}
            onChange={(e) => commit(e.target.value)}
            rows={4}
            spellCheck={false}
            className={cn(fmInput, 'h-auto py-1.5 font-mono text-[12px] leading-relaxed')}
            disabled={isNull}
          />
        </FmField>
      ) : (
        <FmField label='Value'>
          {type === 'number' ? (
            <FixedNumberInput value={cur} disabled={isNull} onCommit={commit} />
          ) : (
            <TextField
              mono
              autoFocus
              value={cur == null ? '' : String(cur)}
              disabled={isNull}
              onChange={commit}
              placeholder={type === 'date' ? 'YYYY-MM-DD' : 'Text to send'}
            />
          )}
          {type === 'number' && typeof cur === 'string' && cur.trim() !== '' && (
            <Hint className='mt-1 text-amber-700 dark:text-amber-300'>
              That is not a number — the preview will flag it.
            </Hint>
          )}
        </FmField>
      )}
      <label className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
        <input
          type='checkbox'
          checked={isNull}
          onChange={(e) => commit(e.target.checked ? null : type === 'boolean' ? false : '')}
          className='h-3.5 w-3.5 rounded border-slate-300 accent-[#00ceff]'
        />
        Send <span className='font-mono'>null</span>
      </label>
    </div>
  )
}

/**
 * A fixed number typed naturally: the box keeps exactly what was typed ("1.",
 * "0.250", "-") while the value it commits is the number it reads as. Text that
 * is not a number is committed as text, so the preview flags it.
 */
function FixedNumberInput({
  value,
  disabled,
  onCommit
}: {
  value: string | number | boolean | null | undefined
  disabled: boolean
  onCommit: (v: string | number) => void
}) {
  const shown = value == null ? '' : String(value)
  const [text, setText] = useState(shown)
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    // Our own echo (1.50 → 1.5) keeps the typed text; an undo or another control replaces it.
    const t = text.trim()
    const ours =
      typeof value === 'number' ? t !== '' && Number(t) === value : String(value ?? '') === text
    if (!ours) setText(shown)
  }
  return (
    <TextField
      mono
      autoFocus
      inputMode='decimal'
      value={text}
      disabled={disabled}
      onChange={(t) => {
        setText(t)
        const n = t.trim()
        onCommit(n !== '' && Number.isFinite(Number(n)) ? Number(n) : t)
      }}
      placeholder='0'
    />
  )
}

function BuiltinPanel({
  value,
  scope,
  onChange
}: {
  value: ValueSpec | undefined
  scope: ItemScope | null
  onChange: (v: ValueSpec) => void
}) {
  const cur = value?.source === 'builtin' ? value.name : null
  return (
    <div className='-mx-1 space-y-px'>
      {BUILTINS.map((b) => {
        const off = b.inList && !scope
        return (
          <button
            key={b.name}
            type='button'
            aria-pressed={cur === b.name}
            disabled={off}
            data-tip={off ? 'Only inside a list' : undefined}
            onClick={() => onChange(withMeta({ source: 'builtin', name: b.name }, value))}
            className={cn(
              'flex w-full items-baseline justify-between gap-3 rounded px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-40',
              cur === b.name ? 'bg-accent' : 'hover:bg-muted'
            )}
          >
            <span className='text-[12.5px] text-slate-800 dark:text-foreground'>{b.label}</span>
            <span className='truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              {b.hint}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function SecretPanel({
  value,
  onChange
}: {
  value: ValueSpec | undefined
  onChange: (v: ValueSpec) => void
}) {
  const env = useFieldMapEnv()
  const cur = value?.source === 'secret' ? value.name : null
  const missing = cur && !env.secretNames.includes(cur)
  const link = env.secretsHref ? (
    <Link to={env.secretsHref} className='font-medium underline underline-offset-2'>
      Body secrets
    </Link>
  ) : (
    'Body secrets'
  )
  return (
    <div className='space-y-2.5'>
      {env.secretNames.length ? (
        <div className='flex flex-wrap gap-1'>
          {env.secretNames.map((n) => (
            <button
              key={n}
              type='button'
              aria-pressed={cur === n}
              onClick={() => onChange(withMeta({ source: 'secret', name: n }, value))}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 font-mono text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                cur === n
                  ? 'border-nvr-cyan bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-border dark:text-slate-300'
              )}
            >
              <KeyRound className='h-3 w-3 opacity-60' />
              {n}
            </button>
          ))}
        </div>
      ) : (
        <Hint>
          {env.partner} has no body secrets yet. Add one in {link} on the API page.
        </Hint>
      )}
      {missing && (
        <p className='flex items-start gap-1.5 text-[11.5px] text-amber-700 dark:text-amber-300'>
          <AlertTriangle className='mt-px h-3.5 w-3.5 shrink-0' />
          <span>
            {env.partner} has no <span className='font-mono'>{cur}</span> secret yet. Add it in{' '}
            {link}.
          </span>
        </p>
      )}
      <Hint>
        The value never appears here, in previews or in stored pushes — it is filled in only as the
        call goes out.
      </Hint>
    </div>
  )
}

function SwitchPanel({
  value,
  type,
  scope,
  depth,
  onChange
}: {
  value: ValueSpec | undefined
  type: Field['type']
  scope: ItemScope | null
  depth: number
  onChange: (v: ValueSpec) => void
}) {
  const cur = value?.source === 'switch' ? value : null
  const cases = cur?.cases ?? []
  const commit = (next: {
    cases: { when: ConditionRule[]; value: ValueSpec }[]
    else?: ValueSpec
  }) => {
    const core: Core = { source: 'switch', cases: next.cases }
    if (next.else) (core as { else?: ValueSpec }).else = next.else
    onChange(withMeta(core, value))
  }
  const [fresh, setFresh] = useState<number | null>(null)
  return (
    <div className='space-y-3'>
      {cases.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: cases carry no id; order is the identity
        <div key={i} className='rounded-md border border-slate-200 p-2 dark:border-border'>
          <div className='mb-1.5 flex items-center justify-between'>
            <span className='text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
              {i === 0 ? 'If' : 'Else if'}
            </span>
            <button
              type='button'
              aria-label='Remove this case'
              onClick={() => commit({ cases: cases.filter((_, j) => j !== i), else: cur?.else })}
              className='inline-flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
            >
              <X className='h-3 w-3' />
            </button>
          </div>
          <ConditionRules
            rules={c.when}
            scope={scope}
            onChange={(when) =>
              commit({
                cases: cases.map((x, j) => (j === i ? { ...x, when } : x)),
                else: cur?.else
              })
            }
          />
          <div className='mt-2 flex items-center gap-2'>
            <span className='text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
              then
            </span>
            <ValueChip
              value={c.value}
              type={type}
              scope={scope}
              depth={depth + 1}
              defaultOpen={fresh === i}
              onChange={(v) =>
                v &&
                commit({
                  cases: cases.map((x, j) => (j === i ? { ...x, value: v } : x)),
                  else: cur?.else
                })
              }
            />
          </div>
        </div>
      ))}
      <button
        type='button'
        className={cn(smallAction, '-ml-2')}
        onClick={() => {
          setFresh(cases.length)
          // Turning a plain value into If/then keeps it as "Otherwise" — nothing is lost.
          const keep =
            !cur && value && !valueIsBlank(value) ? withMeta(value, undefined) : cur?.else
          commit({
            cases: [
              ...cases,
              { when: [{ field: '', op: 'eq', value: '' }], value: { source: 'fixed', value: '' } }
            ],
            else: keep
          })
        }}
      >
        <Plus className='h-3.5 w-3.5' />
        {cases.length ? 'Add another case' : 'Add a case'}
      </button>
      <div className='flex items-center gap-2'>
        <span className='text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
          Otherwise
        </span>
        <ValueChip
          value={cur?.else}
          type={type}
          scope={scope}
          depth={depth + 1}
          placeholder='Send nothing (null)'
          onChange={(v) => commit({ cases, else: v })}
          clearable
        />
      </div>
    </div>
  )
}

function FormulaPanel({
  value,
  onChange
}: {
  value: ValueSpec | undefined
  onChange: (v: ValueSpec) => void
}) {
  const cur = value?.source === 'formula' ? value.liquid : ''
  return (
    <FmField label='Liquid'>
      <textarea
        value={cur}
        // biome-ignore lint/a11y/noAutofocus: the popover opened to edit this formula
        autoFocus
        onChange={(e) => onChange(withMeta({ source: 'formula', liquid: e.target.value }, value))}
        rows={5}
        spellCheck={false}
        placeholder={'{{ record.po_number | pad_start: 9, "0" }}'}
        className={cn(fmInput, 'h-auto py-1.5 font-mono text-[12px] leading-relaxed')}
      />
      <Hint className='mt-1.5'>
        The escape hatch. Same Liquid engine and filters as before (add_days, iso_date, pad_start,
        next_open_day…). Paths read like <span className='font-mono'>record.x</span> and{' '}
        <span className='font-mono'>context.k[0].y</span>.
      </Hint>
    </FmField>
  )
}

// ─── Editor + chip ───────────────────────────────────────────────────────────

export function ValueEditor({
  value,
  type,
  scope,
  depth,
  onChange
}: {
  value: ValueSpec | undefined
  type: Field['type']
  scope: ItemScope | null
  depth: number
  onChange: (v: ValueSpec | undefined) => void
}) {
  const [tab, setTab] = useState<Tab>(() => tabOf(value))
  const uid = useId()
  const [freshFallback, setFreshFallback] = useState<number | null>(null)
  const fallbacks = value?.fallbacks ?? []
  const setFallbacks = (next: ValueSpec[]) => {
    if (!value) return
    const out: ValueSpec = { ...value, fallbacks: next }
    if (!next.length) delete out.fallbacks
    onChange(out)
  }
  const setTransforms = (next: Transform[]) => {
    if (!value) return
    const out: ValueSpec = { ...value, transforms: next }
    if (!next.length) delete out.transforms
    onChange(out)
  }
  const pathValue = value?.source === 'path' ? value.path : ''
  const panel: Record<Tab, ReactNode> = {
    fixed: <FixedPanel value={value} type={type} onChange={onChange} />,
    record: (
      <RecordFieldSection
        value={pathValue.startsWith('context.') ? '' : pathValue}
        scope={scope}
        onChange={(path) => onChange(withMeta({ source: 'path', path }, value))}
      />
    ),
    related: (
      <RelatedSection
        value={pathValue.startsWith('context.') ? pathValue : ''}
        onChange={(path) => onChange(withMeta({ source: 'path', path }, value))}
      />
    ),
    builtin: <BuiltinPanel value={value} scope={scope} onChange={onChange} />,
    secret: <SecretPanel value={value} onChange={onChange} />,
    switch: (
      <SwitchPanel value={value} type={type} scope={scope} depth={depth} onChange={onChange} />
    ),
    formula: <FormulaPanel value={value} onChange={onChange} />
  }
  const active = tabOf(value)
  return (
    <div className='flex max-h-[min(560px,calc(100vh-80px))] flex-col'>
      <div className='flex min-h-0 flex-1'>
        <div
          className='w-[136px] shrink-0 space-y-px border-r border-slate-100 p-1.5 dark:border-border'
          role='tablist'
          aria-orientation='vertical'
          aria-label='Where the value comes from'
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
            e.preventDefault()
            const i = TABS.findIndex((t) => t.id === tab)
            const next = TABS[(i + (e.key === 'ArrowDown' ? 1 : TABS.length - 1)) % TABS.length]
            setTab(next.id)
            ;(
              e.currentTarget.querySelector(`[data-vtab="${next.id}"]`) as HTMLElement | null
            )?.focus()
          }}
        >
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                type='button'
                role='tab'
                id={`${uid}-tab-${t.id}`}
                aria-controls={`${uid}-panel`}
                data-vtab={t.id}
                aria-selected={tab === t.id}
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
                  tab === t.id
                    ? 'bg-accent font-medium text-slate-900 dark:text-foreground'
                    : 'text-slate-600 hover:bg-muted dark:text-slate-300'
                )}
              >
                <Icon className='h-3.5 w-3.5 shrink-0 opacity-70' />
                <span className='min-w-0 flex-1 truncate'>{t.label}</span>
                {active === t.id && (
                  <span
                    role='img'
                    className='h-1.5 w-1.5 shrink-0 rounded-full bg-nvr-cyan'
                    data-tip='In use'
                    aria-label='In use'
                  />
                )}
              </button>
            )
          })}
        </div>
        <div
          className='min-w-0 flex-1 overflow-y-auto p-3'
          role='tabpanel'
          id={`${uid}-panel`}
          aria-labelledby={`${uid}-tab-${tab}`}
        >
          {panel[tab]}
          {tab !== active && value && !valueIsBlank(value) && (
            <Hint className='mt-3'>
              Choosing something here replaces the current{' '}
              {TABS.find((t) => t.id === active)?.label.toLowerCase()} value.
            </Hint>
          )}
        </div>
      </div>
      {value && (
        <div className='space-y-3 border-t border-slate-100 p-3 dark:border-border'>
          <div>
            <FmLabel>Steps</FmLabel>
            <TransformChips transforms={value.transforms ?? []} onChange={setTransforms} />
          </div>
          {depth === 0 && (
            <div>
              <FmLabel>If it comes out empty</FmLabel>
              <div className='flex flex-wrap items-center gap-1.5'>
                {fallbacks.map((fb, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: fallbacks carry no id; order is the identity
                  <span key={i} className='inline-flex items-center gap-1'>
                    <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                      {i === 0 ? 'use' : 'else'}
                    </span>
                    <ValueChip
                      value={fb}
                      type={type}
                      scope={scope}
                      depth={depth + 1}
                      defaultOpen={freshFallback === i}
                      onChange={(v) =>
                        setFallbacks(
                          v
                            ? fallbacks.map((x, j) => (j === i ? v : x))
                            : fallbacks.filter((_, j) => j !== i)
                        )
                      }
                      clearable
                    />
                  </span>
                ))}
                <button
                  type='button'
                  className={cn(smallAction, fallbacks.length ? '' : '-ml-2')}
                  onClick={() => {
                    setFreshFallback(fallbacks.length)
                    setFallbacks([...fallbacks, { source: 'fixed', value: '' }])
                  }}
                >
                  <Plus className='h-3.5 w-3.5' />
                  {fallbacks.length ? 'Else' : 'Use another value'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export interface ValueChipProps {
  value: ValueSpec | undefined
  type: Field['type']
  scope: ItemScope | null
  depth?: number
  onChange: (v: ValueSpec | undefined) => void
  placeholder?: string
  /** Show a × that clears the value (fallbacks, "otherwise"). */
  clearable?: boolean
  defaultOpen?: boolean
  /** Shown instead of the default trigger text (scalar list child with no value). */
  emptyText?: string
  className?: string
  id?: string
}

function ValueChipImpl({
  value,
  type,
  scope,
  depth = 0,
  onChange,
  placeholder = 'Choose a value',
  clearable,
  defaultOpen,
  emptyText,
  className,
  id
}: ValueChipProps) {
  const env = useFieldMapEnv()
  const [open, setOpen] = useState(!!defaultOpen)
  const Icon = sourceIcon(value)
  const blank = valueIsBlank(value)
  const text = value ? valueSourceText(value, scope?.alias, env.names) : (emptyText ?? placeholder)
  const machine =
    value?.source === 'fixed' || value?.source === 'formula' || value?.source === 'secret'
  const steps = value?.transforms ?? []
  const fb = value?.fallbacks ?? []
  return (
    <span className={cn('inline-flex min-w-0 max-w-full items-center', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            id={id}
            data-value-chip=''
            className={cn(
              'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 text-left text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
              blank
                ? 'border-dashed border-slate-300 text-slate-500 hover:border-slate-400 dark:border-slate-600 dark:text-muted-foreground'
                : 'border-slate-200 bg-white text-slate-800 hover:border-slate-300 dark:border-border dark:bg-background dark:text-foreground',
              open && 'border-nvr-cyan'
            )}
          >
            <Icon className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
            <span className={cn('min-w-0 truncate', machine && !blank && 'font-mono text-[12px]')}>
              {text}
            </span>
            {steps.length > 0 && (
              <span
                className='shrink-0 text-[11.5px] text-slate-500 dark:text-muted-foreground'
                data-tip={steps.map(transformLabel).join(' → ')}
              >
                · {steps.length === 1 ? transformLabel(steps[0]) : `${steps.length} steps`}
              </span>
            )}
            {fb.length > 0 && (
              <span className='min-w-0 shrink truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                · else {valueSourceText(fb[0], scope?.alias, env.names)}
                {fb.length > 1 ? ` +${fb.length - 1}` : ''}
              </span>
            )}
            <ChevronDown className='h-3 w-3 shrink-0 text-slate-400' aria-hidden />
          </button>
        </PopoverTrigger>
        <FmPopoverContent className='w-[460px]'>
          <ValueEditor value={value} type={type} scope={scope} depth={depth} onChange={onChange} />
        </FmPopoverContent>
      </Popover>
      {clearable && value && (
        <button
          type='button'
          aria-label='Remove this value'
          onClick={() => onChange(undefined)}
          className='ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted'
        >
          <X className='h-3 w-3' />
        </button>
      )}
    </span>
  )
}

export const ValueChip = memo(ValueChipImpl)
