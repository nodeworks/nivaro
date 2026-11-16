import { queryKeys, toastError, useDebounced } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  CopyCheck,
  ExternalLink,
  Plus,
  SearchCheck,
  X
} from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { renderDisplayTemplate } from '@/lib/relations'
import { cn, formatNumber, titleCase } from '@/lib/utils'

/**
 * Duplicate warnings for one collection (Rob 2026-11-14) — `browser_config.duplicate_check`,
 * judged by api services/duplicate-rules.ts. On by default for every collection; the
 * criteria are the label's text fields unless custom rules (AND) are given. The server's
 * plan for the DRAFT says which rules run on this table and why the others are skipped
 * (big tables never scan); "Test with a record" shows what a record would match.
 */

type RuleMatch =
  | 'exact'
  | 'close'
  | 'contains'
  | 'equal'
  | 'percent'
  | 'within'
  | 'same_day'
  | 'days'
  | 'same'
  | 'shared'
type RuleKind = 'text' | 'number' | 'date' | 'relation' | 'lines'

export interface DuplicateRule {
  field: string
  match: RuleMatch
  amount?: number
  line_field?: string
}

export interface DuplicateCheckValue {
  mode?: 'on' | 'off'
  /** Legacy (2026-11-13): text fields, each checked on its own. */
  fields?: string[]
  rules?: DuplicateRule[]
  within_days?: number
  ignore_states?: string[]
  block_exact?: boolean
}

const MATCHES: Record<RuleKind, Array<{ value: RuleMatch; label: string }>> = {
  text: [
    { value: 'exact', label: 'Exact (ignoring case and spaces)' },
    { value: 'close', label: 'Close (allows typos)' },
    { value: 'contains', label: 'Contains' }
  ],
  number: [
    { value: 'equal', label: 'Equal' },
    { value: 'percent', label: 'Within ± %' },
    { value: 'within', label: 'Within ±' }
  ],
  date: [
    { value: 'same_day', label: 'Same day' },
    { value: 'days', label: 'Within days' }
  ],
  relation: [{ value: 'same', label: 'Same record' }],
  lines: [{ value: 'shared', label: 'Share line values' }]
}
const KIND_OF: Record<RuleMatch, RuleKind> = {
  exact: 'text',
  close: 'text',
  contains: 'text',
  equal: 'number',
  percent: 'number',
  within: 'number',
  same_day: 'date',
  days: 'date',
  same: 'relation',
  shared: 'lines'
}
const KIND_WORD: Record<RuleKind, string> = {
  text: 'text',
  number: 'number',
  date: 'date',
  relation: 'link',
  lines: 'lines'
}

interface FieldMeta {
  field: string
  type: string | null
  hidden?: boolean | null
  label?: string | null
}
interface RelationMeta {
  many_collection: string | null
  many_field: string | null
  one_collection: string | null
  one_field?: string | null
  junction_field: string | null
}
interface CollectionMeta {
  browser_config: (Record<string, unknown> & { duplicate_check?: DuplicateCheckValue }) | null
  display_template?: string | null
  singular?: string | null
  fields?: FieldMeta[]
  relations?: RelationMeta[]
}

interface PlanRule extends DuplicateRule {
  kind: RuleKind
  status: 'ok' | 'limited' | 'residual' | 'skipped'
  indexed: boolean
  note: string | null
  child?: string | null
}
interface Plan {
  enabled: boolean
  source: 'default' | 'configured' | 'off'
  reason: string | null
  rows: number | null
  big: boolean
  close: boolean
  block_exact: boolean
  within_days: number | null
  created_field: string | null
  within_note: string | null
  invalid: Array<{ rule: DuplicateRule; note: string }>
  groups: Array<{
    anchor: string
    runs: boolean
    trimmed: boolean
    note: string | null
    rules: PlanRule[]
  }>
}
interface TestMatch {
  id: string
  label: string
  value: string
  match: 'exact' | 'close'
}
interface TestAnswer {
  values: Record<string, unknown>
  answer: { enabled: boolean; matches: Record<string, TestMatch[]>; partial?: boolean }
  plan: Plan
}

const NUMBER_TYPES = new Set(['integer', 'bigInteger', 'float', 'decimal'])
const DATE_TYPES = new Set(['date', 'dateTime', 'timestamp'])

function kindOf(collection: string, f: FieldMeta, relations: RelationMeta[]): RuleKind | null {
  if (f.field === 'id') return null
  if (
    relations.some(
      (r) => r.one_collection === collection && r.one_field === f.field && !r.junction_field
    )
  )
    return 'lines'
  if (relations.some((r) => r.many_collection === collection && r.many_field === f.field))
    return 'relation'
  if (f.type === 'string' || f.type === 'text') return 'text'
  if (NUMBER_TYPES.has(String(f.type))) return 'number'
  if (DATE_TYPES.has(String(f.type))) return 'date'
  return null
}

const labelOf = (f: FieldMeta | undefined, name: string) => f?.label?.trim() || titleCase(name)

/** The stored JSON: minimal, ON implied. Undefined = the default (no key at all). */
export function duplicateCheckForStorage(v: DuplicateCheckValue): DuplicateCheckValue | undefined {
  const out: DuplicateCheckValue = {}
  if (v.mode === 'off') out.mode = 'off'
  if (v.rules?.length) out.rules = v.rules
  else if (v.fields?.length) out.fields = v.fields
  if (v.within_days && v.within_days > 0) out.within_days = Math.round(v.within_days)
  if (v.ignore_states?.length) out.ignore_states = v.ignore_states
  if (v.block_exact) out.block_exact = true
  return Object.keys(out).length ? out : undefined
}

const defaultMatch = (kind: RuleKind): DuplicateRule['match'] => MATCHES[kind][0].value

export function DuplicateCheckCard({ tableName }: { tableName: string }) {
  const qc = useQueryClient()
  const id = useId()
  const { data: col } = useQuery({
    queryKey: queryKeys.collectionMeta(tableName),
    queryFn: () =>
      api.get<{ data: CollectionMeta }>(`/collections/${tableName}`).then((r) => r.data.data),
    enabled: !!tableName,
    staleTime: 10 * 60 * 1000
  })
  const saved = (col?.browser_config?.duplicate_check ?? {}) as DuplicateCheckValue
  const savedKey = JSON.stringify(duplicateCheckForStorage(saved) ?? null)
  const [draft, setDraft] = useState<DuplicateCheckValue | null>(null)
  // A save (or another tab's) lands: drop the draft when it now equals what is stored.
  useEffect(() => {
    if (draft && JSON.stringify(duplicateCheckForStorage(draft) ?? null) === savedKey)
      setDraft(null)
  }, [savedKey, draft])
  const value = draft ?? saved
  const stored = duplicateCheckForStorage(value)
  const storedKey = JSON.stringify(stored ?? null)
  const dirty = draft != null && storedKey !== savedKey
  const on = value.mode !== 'off'
  const custom = Array.isArray(value.rules)
  const edit = (patch: Partial<DuplicateCheckValue>) => setDraft({ ...value, ...patch })

  const fields = useMemo(() => {
    const rel = col?.relations ?? []
    return (col?.fields ?? [])
      .map((f) => ({ ...f, kind: kindOf(tableName, f, rel) }))
      .filter((f): f is FieldMeta & { kind: RuleKind } => f.kind != null)
  }, [col, tableName])
  const fieldMap = useMemo(() => new Map(fields.map((f) => [f.field, f])), [fields])
  const name = (f: string) => labelOf(fieldMap.get(f), f)

  // The server's plan for the draft (debounced while typing amounts).
  const planKey = useDebounced(storedKey, 300)
  const planQuery = useQuery({
    queryKey: ['duplicate-check-plan', tableName, planKey],
    queryFn: () =>
      api
        .get<{ data: Plan }>(`/duplicates/${tableName}/plan`, {
          params: { config: planKey === 'null' ? '{}' : planKey }
        })
        .then((r) => r.data.data),
    enabled: !!tableName,
    placeholderData: (prev) => prev,
    staleTime: 30_000
  })
  const plan = planQuery.data

  const states = useQuery<Array<{ key: string; label: string; color?: string }>>({
    queryKey: ['collection-states-dup', tableName],
    queryFn: () => api.get(`/queues/collection-states/${tableName}`).then((r) => r.data.data ?? []),
    enabled: !!tableName,
    staleTime: 5 * 60_000
  })

  const save = useMutation({
    mutationFn: async () => {
      const bc = { ...(col?.browser_config ?? {}) } as Record<string, unknown>
      if (stored) bc.duplicate_check = stored
      else delete bc.duplicate_check
      await api.patch(`/collections/${tableName}`, {
        browser_config: Object.keys(bc).length ? bc : null
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.collectionMeta(tableName) })
      void qc.invalidateQueries({ queryKey: ['duplicate-check-config', tableName] })
      toast.success('Duplicate warnings saved')
    },
    onError: (e) => toastError(e, 'Could not save the duplicate warnings')
  })

  const startCustom = () => {
    // Seed with what runs now, so switching keeps the same behaviour to edit from.
    const seed: DuplicateRule[] = (plan?.source !== 'off' ? (plan?.groups ?? []) : [])
      .slice(0, 1)
      .flatMap((g) => g.rules.map((r) => ({ field: r.field, match: r.match })))
    const first = fields.find((f) => f.kind === 'text')
    edit({
      rules: seed.length ? seed : first ? [{ field: first.field, match: 'close' }] : [],
      fields: undefined
    })
  }
  const setRule = (i: number, next: DuplicateRule) =>
    edit({ rules: (value.rules ?? []).map((r, j) => (j === i ? next : r)) })
  const removeRule = (i: number) => edit({ rules: (value.rules ?? []).filter((_, j) => j !== i) })
  const addRule = () => {
    const used = new Set((value.rules ?? []).map((r) => r.field))
    const f = fields.find((x) => !used.has(x.field) && x.kind !== 'lines') ?? fields[0]
    if (!f) return
    edit({ rules: [...(value.rules ?? []), { field: f.field, match: defaultMatch(f.kind) }] })
  }

  const planRuleFor = (r: DuplicateRule): PlanRule | undefined =>
    plan?.groups[0]?.rules.find((p) => p.field === r.field && p.match === r.match)
  const invalidFor = (r: DuplicateRule) =>
    plan?.invalid.find((x) => x.rule.field === r.field && x.rule.match === r.match)?.note

  const statusLine = !plan
    ? null
    : !on
      ? 'Off — new records here are never compared'
      : plan.enabled
        ? `On — ${plan.groups.filter((g) => g.runs).length === 1 ? 'one check' : `${plan.groups.filter((g) => g.runs).length} checks`} while a record is created`
        : plan.reason || 'Nothing to compare'

  // A big table compares only on indexed fields: name the ones that are not, and how to fix it.
  const unindexed = plan?.big
    ? [
        ...new Set(
          plan.groups
            .flatMap((g) => g.rules)
            .filter((r) => !r.indexed)
            .map((r) => name(r.field))
        )
      ]
    : []
  const indexNote = !plan?.big
    ? ''
    : unindexed.length > 0
      ? ` — add an index on ${unindexed.slice(0, 2).join(' and ')}${unindexed.length > 2 ? ` and ${unindexed.length - 2} more` : ''} to compare on ${unindexed.length === 1 ? 'it' : 'them'} (Fields → ${unindexed.length === 1 ? unindexed[0] : 'the field'} → Index)`
      : on
        ? ''
        : ' — a table this big compares only fields that have an index'

  return (
    <section
      aria-labelledby={`dup-title-${id}`}
      className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-duplicate-check-card={on ? 'on' : 'off'}
    >
      <div className='flex items-start justify-between gap-4 px-4 pt-3'>
        <div className='min-w-0'>
          <h3
            id={`dup-title-${id}`}
            className='flex items-center gap-1.5 text-[13px] font-medium text-slate-800 dark:text-foreground'
          >
            <CopyCheck
              className='h-3.5 w-3.5 text-slate-500 dark:text-muted-foreground'
              aria-hidden
            />
            Duplicate warnings
          </h3>
          <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            While someone creates a record, show existing records that look the same — before they
            save. Only records they may read are shown.
          </p>
          {statusLine && (
            <p
              data-duplicate-check-status
              className={cn(
                'mt-1 text-[11.5px]',
                on && plan?.enabled
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-slate-500 dark:text-muted-foreground'
              )}
            >
              {statusLine}
              {plan?.rows != null && (
                <span className='text-slate-500 dark:text-muted-foreground'>
                  {' · '}
                  {formatNumber(plan.rows)} records
                  {indexNote}
                </span>
              )}
            </p>
          )}
        </div>
        <Switch
          checked={on}
          onCheckedChange={(v) => edit({ mode: v ? undefined : 'off' })}
          aria-label='Warn about duplicates'
          className='mt-0.5 shrink-0'
        />
      </div>

      {on && (
        <div className='space-y-3 px-4 pb-3 pt-3'>
          <div className='space-y-2'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <p className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
                Two records are duplicates when
              </p>
              <fieldset className='inline-flex shrink-0 rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-border dark:bg-muted/40'>
                <legend className='sr-only'>Criteria</legend>
                {(
                  [
                    ['default', 'Label fields'],
                    ['custom', 'Custom rules']
                  ] as const
                ).map(([k, label]) => {
                  const active = (k === 'custom') === custom
                  return (
                    <button
                      key={k}
                      type='button'
                      aria-pressed={active}
                      onClick={() => {
                        if (active) return
                        if (k === 'custom') startCustom()
                        else edit({ rules: undefined })
                      }}
                      className={cn(
                        'rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
                        active
                          ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-foreground'
                          : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
                      )}
                    >
                      {label}
                    </button>
                  )
                })}
              </fieldset>
            </div>

            {!custom ? (
              <DefaultCriteria plan={plan} name={name} legacy={value.fields} />
            ) : (
              <ol className='space-y-1.5' data-duplicate-rules>
                {(value.rules ?? []).map((r, i) => (
                  <RuleRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional; a field may repeat
                    key={i}
                    first={i === 0}
                    rule={r}
                    fields={fields}
                    collection={tableName}
                    relations={col?.relations ?? []}
                    planned={planRuleFor(r)}
                    invalid={invalidFor(r)}
                    name={name}
                    onChange={(next) => setRule(i, next)}
                    onRemove={() => removeRule(i)}
                  />
                ))}
                {(value.rules ?? []).length === 0 && (
                  <li className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    No rules yet — nothing is compared until you add one.
                  </li>
                )}
                <li>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    className='h-7 gap-1 px-2 text-[12px] font-normal'
                    onClick={addRule}
                    disabled={(value.rules ?? []).length >= 8 || fields.length === 0}
                  >
                    <Plus className='h-3 w-3' aria-hidden />
                    {(value.rules ?? []).length ? 'And…' : 'Add a rule'}
                  </Button>
                </li>
              </ol>
            )}
          </div>

          <div className='space-y-2 border-t border-slate-100 pt-3 dark:border-border'>
            <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5'>
              <label
                htmlFor={`dup-days-${id}`}
                className='flex min-w-0 items-center gap-2 text-[12.5px] text-slate-700 dark:text-foreground'
              >
                <Switch
                  id={`dup-days-${id}`}
                  checked={!!value.within_days}
                  onCheckedChange={(v) => edit({ within_days: v ? 365 : undefined })}
                />
                Only records created in the last
              </label>
              {!!value.within_days && (
                <span className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
                  <Input
                    type='number'
                    min={1}
                    max={3650}
                    value={value.within_days}
                    onChange={(e) =>
                      edit({ within_days: Math.max(1, Number(e.target.value) || 1) })
                    }
                    aria-label='Days'
                    className='h-7 w-20 text-[12px] tabular-nums'
                  />
                  days
                </span>
              )}
            </div>
            {!!value.within_days && plan?.within_note && (
              <Note tone='warn'>{plan.within_note}</Note>
            )}

            <StatesPicker
              states={states.data ?? []}
              value={value.ignore_states ?? []}
              onChange={(next) => edit({ ignore_states: next.length ? next : undefined })}
            />

            <div className='flex items-start justify-between gap-4'>
              <div className='min-w-0'>
                <p className='text-[12.5px] text-slate-700 dark:text-foreground'>
                  Block exact duplicates
                </p>
                <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                  {value.block_exact
                    ? 'Saving a record that matches an existing one exactly is refused.'
                    : 'Warn only — people can still save.'}
                </p>
              </div>
              <Switch
                checked={value.block_exact === true}
                onCheckedChange={(v) => edit({ block_exact: v || undefined })}
                aria-label='Block exact duplicates'
                className='mt-0.5 shrink-0'
              />
            </div>
          </div>

          <TestWithRecord
            collection={tableName}
            template={col?.display_template ?? null}
            config={storedKey}
          />
        </div>
      )}

      {dirty && (
        <div className='flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-4 py-2 dark:border-border dark:bg-muted/30'>
          <span className='mr-auto text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            Not saved yet
          </span>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='h-7 text-[12px]'
            onClick={() => setDraft(null)}
          >
            Cancel
          </Button>
          <Button
            type='button'
            size='sm'
            className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </section>
  )
}

function Note({ tone, children }: { tone: 'warn' | 'quiet'; children: React.ReactNode }) {
  return (
    <p
      data-duplicate-note={tone}
      className={cn(
        'flex items-start gap-1 text-[11.5px] leading-snug',
        tone === 'warn'
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-slate-500 dark:text-muted-foreground'
      )}
    >
      {tone === 'warn' && <AlertTriangle className='mt-[2px] h-3 w-3 shrink-0' aria-hidden />}
      <span>{children}</span>
    </p>
  )
}

const DEFAULT_WORDS = 'same text, ignoring case, spacing and punctuation, or a typo or two'

function DefaultCriteria({
  plan,
  name,
  legacy
}: {
  plan: Plan | undefined
  name: (f: string) => string
  legacy?: string[]
}) {
  if (!plan)
    return <p className='h-4 w-40 animate-pulse rounded bg-[var(--nvr-skeleton,#e2e8f0)]' />
  if (plan.groups.length === 0)
    return <Note tone='quiet'>{plan.reason || 'The label has no text field to compare.'}</Note>
  return (
    <ul className='space-y-1' data-duplicate-default>
      {plan.groups.map((g) => {
        const r = g.rules[0]
        return (
          <li key={g.anchor} className='space-y-0.5'>
            <p className='text-[12px] text-slate-700 dark:text-foreground'>
              <span className='font-medium'>{name(g.anchor)}</span>
              <span className='text-slate-500 dark:text-muted-foreground'> — {DEFAULT_WORDS}</span>
            </p>
            {r?.note && <Note tone={r.status === 'skipped' ? 'warn' : 'quiet'}>{r.note}</Note>}
          </li>
        )
      })}
      <li className='text-[11px] text-slate-500 dark:text-muted-foreground'>
        {legacy?.length
          ? 'Fields chosen earlier; each is checked on its own.'
          : 'The text fields of the display template, each checked on its own.'}
      </li>
    </ul>
  )
}

function FieldPicker({
  value,
  fields,
  name,
  onChange,
  label
}: {
  value: string
  fields: Array<FieldMeta & { kind: RuleKind }>
  name: (f: string) => string
  onChange: (f: string) => void
  label: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          role='combobox'
          aria-expanded={open}
          aria-label={label}
          className='flex h-7 min-w-0 max-w-[220px] flex-1 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 text-left text-[12px] text-slate-800 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:hover:bg-muted'
        >
          <span className='min-w-0 truncate'>{value ? name(value) : 'Choose a field'}</span>
          <ChevronsUpDown className='ml-auto h-3 w-3 shrink-0 text-slate-400' aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[260px] p-0'>
        <Command>
          <CommandInput placeholder='Find a field…' className='h-8 text-[12.5px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No field matches
            </CommandEmpty>
            <CommandGroup>
              {fields.map((f) => (
                <CommandItem
                  key={f.field}
                  value={`${name(f.field)} ${f.field}`}
                  onSelect={() => {
                    onChange(f.field)
                    setOpen(false)
                  }}
                  className='text-[12.5px]'
                >
                  <Check
                    className={cn(
                      'mr-1.5 h-3.5 w-3.5',
                      value === f.field ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className='min-w-0 truncate'>{name(f.field)}</span>
                  <span className='ml-auto pl-2 text-[10.5px] text-muted-foreground'>
                    {KIND_WORD[f.kind]}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function RuleRow({
  first,
  rule,
  fields,
  collection,
  relations,
  planned,
  invalid,
  name,
  onChange,
  onRemove
}: {
  first: boolean
  rule: DuplicateRule
  fields: Array<FieldMeta & { kind: RuleKind }>
  collection: string
  relations: RelationMeta[]
  planned: PlanRule | undefined
  invalid: string | undefined
  name: (f: string) => string
  onChange: (next: DuplicateRule) => void
  onRemove: () => void
}) {
  const kind = KIND_OF[rule.match]
  const child =
    kind === 'lines'
      ? (relations.find(
          (r) => r.one_collection === collection && r.one_field === rule.field && !r.junction_field
        )?.many_collection ?? null)
      : null
  const childMeta = useQuery({
    queryKey: queryKeys.collectionMeta(child ?? ''),
    queryFn: () =>
      api.get<{ data: CollectionMeta }>(`/collections/${child}`).then((r) => r.data.data),
    enabled: !!child,
    staleTime: 10 * 60 * 1000
  })
  // A line field: text, number or a link — never the link back to this record.
  const childRels = childMeta.data?.relations ?? []
  const lineFields = (childMeta.data?.fields ?? []).filter((f) => {
    if (f.field === 'id') return false
    const m2o = childRels.find(
      (r) => r.many_collection === child && r.many_field === f.field && r.one_collection
    )
    if (m2o) return m2o.one_collection !== collection
    return f.type === 'string' || NUMBER_TYPES.has(String(f.type))
  })
  const amountInput = (label: string, suffix: string, step = 1) => (
    <span className='flex items-center gap-1 text-[12px] text-slate-600 dark:text-muted-foreground'>
      <Input
        type='number'
        min={0}
        step={step}
        value={rule.amount ?? ''}
        onChange={(e) => onChange({ ...rule, amount: Math.max(0, Number(e.target.value) || 0) })}
        aria-label={label}
        className='h-7 w-20 text-[12px] tabular-nums'
      />
      {suffix}
    </span>
  )
  const note = invalid ?? planned?.note
  const tone: 'warn' | 'quiet' = invalid || planned?.status === 'skipped' ? 'warn' : 'quiet'
  return (
    <li
      className='space-y-1'
      data-duplicate-rule={rule.field}
      data-rule-status={planned?.status ?? (invalid ? 'invalid' : 'pending')}
    >
      <div className='flex flex-wrap items-center gap-1.5'>
        <span className='w-9 shrink-0 text-right text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {first ? 'when' : 'and'}
        </span>
        <FieldPicker
          value={rule.field}
          fields={fields}
          name={name}
          label='Field'
          onChange={(f) => {
            const k = fields.find((x) => x.field === f)?.kind ?? 'text'
            onChange(
              k === KIND_OF[rule.match]
                ? { ...rule, field: f }
                : { field: f, match: defaultMatch(k), ...(k === 'lines' ? { amount: 1 } : {}) }
            )
          }}
        />
        {MATCHES[kind].length > 1 ? (
          <SimpleSelect
            value={rule.match}
            onChange={(m) => {
              const match = m as RuleMatch
              onChange({
                field: rule.field,
                match,
                ...(match === 'percent' ? { amount: rule.amount ?? 5 } : {}),
                ...(match === 'within' ? { amount: rule.amount ?? 1 } : {}),
                ...(match === 'days' ? { amount: rule.amount ?? 7 } : {})
              })
            }}
            options={MATCHES[kind]}
            ariaLabel='How it matches'
            className='h-7 w-auto min-w-[150px] text-[12px]'
          />
        ) : (
          <span className='px-1 text-[12px] text-slate-600 dark:text-muted-foreground'>
            {MATCHES[kind][0].label}
          </span>
        )}
        {rule.match === 'percent' && amountInput('Percent', '%')}
        {rule.match === 'within' && amountInput('Amount', '', 0.01)}
        {rule.match === 'days' && amountInput('Days', 'days')}
        {rule.match === 'shared' && (
          <>
            <span className='text-[12px] text-slate-600 dark:text-muted-foreground'>at least</span>
            {amountInput('Shared values', 'of')}
            <SimpleSelect
              value={rule.line_field ?? ''}
              onChange={(lf) => onChange({ ...rule, line_field: lf || undefined })}
              options={[
                { value: '', label: childMeta.isLoading ? 'Loading…' : 'Choose a line field' },
                ...lineFields.map((f) => ({ value: f.field, label: labelOf(f, f.field) }))
              ]}
              ariaLabel='Line field'
              className='h-7 w-auto min-w-[150px] text-[12px]'
            />
          </>
        )}
        <button
          type='button'
          onClick={onRemove}
          aria-label={`Remove the ${name(rule.field)} rule`}
          className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted dark:hover:text-foreground'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      {note && (
        <div className='pl-[2.65rem]'>
          <Note tone={tone}>{note}</Note>
        </div>
      )}
    </li>
  )
}

function StatesPicker({
  states,
  value,
  onChange
}: {
  states: Array<{ key: string; label: string; color?: string }>
  value: string[]
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  if (states.length === 0 && value.length === 0) return null
  const labelOf = (k: string) => states.find((s) => s.key === k)?.label ?? k
  const toggle = (k: string) =>
    onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k])
  return (
    <div className='flex flex-wrap items-center gap-1.5'>
      <span className='text-[12.5px] text-slate-700 dark:text-foreground'>Ignore records in</span>
      {value.map((k) => (
        <span
          key={k}
          className='inline-flex h-6 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 pl-2 pr-1 text-[12px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-foreground'
        >
          {labelOf(k)}
          <button
            type='button'
            onClick={() => toggle(k)}
            aria-label={`Stop ignoring ${labelOf(k)}`}
            className='rounded p-0.5 text-slate-500 hover:bg-slate-200 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
          >
            <X className='h-3 w-3' />
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type='button'
            variant='outline'
            size='sm'
            role='combobox'
            aria-expanded={open}
            className='h-6 gap-1 px-2 text-[12px] font-normal'
          >
            <Plus className='h-3 w-3' aria-hidden />
            {value.length ? 'State' : 'Choose states'}
          </Button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-[240px] p-0'>
          <Command>
            <CommandInput placeholder='Find a state…' className='h-8 text-[12.5px]' />
            <CommandList>
              <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
                No state matches
              </CommandEmpty>
              <CommandGroup>
                {states.map((s) => (
                  <CommandItem
                    key={s.key}
                    value={`${s.label} ${s.key}`}
                    onSelect={() => toggle(s.key)}
                    className='text-[12.5px]'
                  >
                    <Check
                      className={cn(
                        'mr-1.5 h-3.5 w-3.5',
                        value.includes(s.key) ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    {s.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function TestWithRecord({
  collection,
  template,
  config
}: {
  collection: string
  template: string | null
  config: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim(), 250)
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null)
  const templateFields = useMemo(
    () => [...String(template ?? '').matchAll(/\{\{\s*([\w]+)\s*\}\}/g)].map((m) => m[1]),
    [template]
  )
  const search = useQuery({
    queryKey: ['duplicate-test-records', collection, dq],
    enabled: open,
    staleTime: 30_000,
    queryFn: () =>
      api
        .get<{ data: Array<Record<string, unknown>> }>(`/items/${collection}`, {
          params: {
            limit: 8,
            sort: '-id',
            fields: ['id', ...templateFields].join(','),
            ...(dq ? { search: dq } : {})
          }
        })
        .then((r) =>
          (r.data.data ?? []).map((row) => ({
            id: String(row.id),
            label: (template ? renderDisplayTemplate(template, row) : '') || `#${row.id}`
          }))
        )
  })
  const test = useQuery({
    queryKey: ['duplicate-test', collection, picked?.id, config],
    enabled: !!picked,
    retry: false,
    queryFn: () =>
      api
        .get<{ data: TestAnswer }>(`/duplicates/${collection}/test`, {
          params: { record: picked?.id, config: config === 'null' ? '{}' : config }
        })
        .then((r) => r.data.data)
  })
  const matches = Object.values(test.data?.answer.matches ?? {}).flat()
  return (
    <div
      className='space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-muted/30'
      data-duplicate-test
    >
      <div className='flex flex-wrap items-center gap-2'>
        <SearchCheck
          className='h-3.5 w-3.5 text-slate-500 dark:text-muted-foreground'
          aria-hidden
        />
        <span className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
          Test with a record
        </span>
        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o)
            if (!o) setQ('')
          }}
        >
          <PopoverTrigger asChild>
            <button
              type='button'
              role='combobox'
              aria-expanded={open}
              aria-label='Sample record'
              className='flex h-7 min-w-0 max-w-[280px] flex-1 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 text-left text-[12px] hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-background dark:hover:bg-muted'
            >
              <span
                className={cn(
                  'min-w-0 truncate',
                  picked
                    ? 'text-slate-800 dark:text-foreground'
                    : 'text-slate-500 dark:text-muted-foreground'
                )}
              >
                {picked ? picked.label : 'Pick a record'}
              </span>
              <ChevronsUpDown className='ml-auto h-3 w-3 shrink-0 text-slate-400' aria-hidden />
            </button>
          </PopoverTrigger>
          <PopoverContent align='start' className='w-[300px] p-0'>
            <Command shouldFilter={false}>
              <CommandInput
                value={q}
                onValueChange={setQ}
                placeholder='Search records…'
                className='h-8 text-[12.5px]'
              />
              <CommandList>
                <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
                  {search.isLoading ? 'Looking…' : 'No record matches'}
                </CommandEmpty>
                <CommandGroup>
                  {(search.data ?? []).map((r) => (
                    <CommandItem
                      key={r.id}
                      value={r.id}
                      onSelect={() => {
                        setPicked(r)
                        setOpen(false)
                      }}
                      className='text-[12.5px]'
                    >
                      <span className='min-w-0 truncate'>{r.label}</span>
                      <span className='ml-auto pl-2 font-mono text-[10.5px] text-muted-foreground'>
                        #{r.id}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      {!picked && (
        <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          As if this record were being created now, with the rules above (saved or not).
        </p>
      )}
      {picked && test.isLoading && (
        <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>Checking…</p>
      )}
      {picked && test.isError && <Note tone='warn'>The test could not run for this record.</Note>}
      {picked && test.data && (
        <div className='space-y-1' data-duplicate-test-result={matches.length}>
          {matches.length === 0 ? (
            <p className='text-[12px] text-slate-600 dark:text-muted-foreground'>
              {test.data.answer.enabled
                ? 'No other record matches it.'
                : 'Nothing is compared for this record — fill the fields the rules use.'}
            </p>
          ) : (
            <>
              <p className='text-[12px] text-slate-700 dark:text-foreground'>
                Would warn about {matches.length} {matches.length === 1 ? 'record' : 'records'}:
              </p>
              <ul className='space-y-0.5'>
                {matches.map((m) => (
                  <li key={m.id} className='flex items-baseline gap-2 text-[12px]'>
                    <span
                      className={cn(
                        'w-14 shrink-0 text-[11px] font-medium',
                        m.match === 'exact'
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-slate-500 dark:text-muted-foreground'
                      )}
                    >
                      {m.match === 'exact' ? 'Exact' : 'Similar'}
                    </span>
                    <a
                      href={`/collections/${collection}/${encodeURIComponent(m.id)}`}
                      target='_blank'
                      rel='noopener noreferrer'
                      className='inline-flex min-w-0 items-center gap-1 truncate text-slate-800 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-foreground dark:decoration-slate-600'
                    >
                      {m.label}
                      <ExternalLink className='h-2.5 w-2.5 shrink-0' aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
          {test.data.answer.partial && (
            <Note tone='quiet'>A check ran out of time — the answer may miss a match.</Note>
          )}
        </div>
      )}
    </div>
  )
}
