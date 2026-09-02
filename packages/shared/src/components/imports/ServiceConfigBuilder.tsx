import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Braces, Check, ChevronsUpDown, KeyRound, Plus, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'

/**
 * Structured editor for a staged import's service-mode config. The stored
 * value stays the same JSON the server's parseServiceConfig reads — this
 * builder is a view over it, and an "Edit JSON" escape hatch shows the raw
 * document at any time (unknown keys survive a builder round-trip untouched).
 */

interface ColumnRow {
  /** Staging column name (the file column after header mapping). */
  col: string
  field: string
  type: '' | 'number' | 'int' | 'date' | 'datetime' | 'boolean'
  lookupOn: boolean
  lookupCollection: string
  lookupField: string
  /** What a lookup miss does: '' = skip the file row (historic default),
   *  'null' = keep the row with an empty link, 'create' = stub the record. */
  lookupOnMissing: '' | 'null' | 'create'
}

interface BuilderState {
  collection: string
  matchBy: string[]
  rows: ColumnRow[]
  monthOn: boolean
  monthField: string
  monthYearCol: string
  monthMonthCol: string
  requireValue: string[]
  tsCreate: string
  tsUpdate: string
  /** Keys we don't model — carried through serialization untouched. */
  extras: Record<string, unknown>
}

const KNOWN_KEYS = new Set([
  'collection',
  'match_by',
  'columns',
  'month_from',
  'require_value',
  'timestamps'
])

function parseState(raw: string, stagingCols: string[]): BuilderState | null {
  let cfg: Record<string, unknown> = {}
  const trimmed = raw.trim()
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      cfg = parsed as Record<string, unknown>
    } catch {
      return null
    }
  }
  const columns = (cfg.columns ?? {}) as Record<
    string,
    {
      field?: string
      type?: string
      lookup?: { collection?: string; match_field?: string; on_missing?: string }
    }
  >
  if (cfg.columns && (typeof cfg.columns !== 'object' || Array.isArray(cfg.columns))) return null

  const seen = new Set<string>()
  const rows: ColumnRow[] = []
  const toRow = (col: string): ColumnRow => {
    const c = columns[col]
    return {
      col,
      field: c?.field ?? '',
      type: ['number', 'int', 'date', 'datetime', 'boolean'].includes(c?.type ?? '')
        ? (c!.type as ColumnRow['type'])
        : '',
      lookupOn: !!c?.lookup,
      lookupCollection: c?.lookup?.collection ?? '',
      lookupField: c?.lookup?.match_field ?? '',
      lookupOnMissing:
        c?.lookup?.on_missing === 'create' || c?.lookup?.on_missing === 'null'
          ? c.lookup.on_missing
          : ''
    }
  }
  // Declared staging columns lead (file order); config-only keys follow so a
  // mapping outlives a declaration edit visibly instead of vanishing.
  for (const col of stagingCols) {
    rows.push(toRow(col))
    seen.add(col)
  }
  for (const col of Object.keys(columns)) {
    if (!seen.has(col)) rows.push(toRow(col))
  }

  const month = cfg.month_from as
    | { field?: string; year_column?: string; month_column?: string }
    | undefined
  const ts = cfg.timestamps as { create?: string; update?: string } | undefined
  const extras: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(cfg)) {
    if (!KNOWN_KEYS.has(k)) extras[k] = v
  }
  return {
    collection: String(cfg.collection ?? ''),
    matchBy: Array.isArray(cfg.match_by) ? cfg.match_by.map(String) : [],
    rows,
    monthOn: !!month,
    monthField: month?.field ?? '',
    monthYearCol: month?.year_column ?? '',
    monthMonthCol: month?.month_column ?? '',
    requireValue: Array.isArray(cfg.require_value) ? cfg.require_value.map(String) : [],
    tsCreate: ts?.create ?? '',
    tsUpdate: ts?.update ?? '',
    extras
  }
}

function serialize(s: BuilderState): string {
  const columns: Record<string, unknown> = {}
  for (const r of s.rows) {
    if (!r.field) continue
    const entry: Record<string, unknown> = { field: r.field }
    if (r.lookupOn && r.lookupCollection && r.lookupField) {
      entry.lookup = {
        collection: r.lookupCollection,
        match_field: r.lookupField,
        ...(r.lookupOnMissing ? { on_missing: r.lookupOnMissing } : {})
      }
    } else if (r.type) {
      entry.type = r.type
    }
    columns[r.col] = entry
  }
  const cfg: Record<string, unknown> = {
    collection: s.collection,
    match_by: s.matchBy,
    columns,
    ...s.extras
  }
  if (s.monthOn && s.monthField && s.monthYearCol && s.monthMonthCol) {
    cfg.month_from = {
      field: s.monthField,
      year_column: s.monthYearCol,
      month_column: s.monthMonthCol
    }
  }
  if (s.requireValue.length) cfg.require_value = s.requireValue
  if (s.tsCreate || s.tsUpdate) {
    cfg.timestamps = {
      ...(s.tsCreate ? { create: s.tsCreate } : {}),
      ...(s.tsUpdate ? { update: s.tsUpdate } : {})
    }
  }
  return JSON.stringify(cfg, null, 2)
}

/** Searchable picker in the console's control idiom — SimpleSelect can't
 *  carry 230 collections. */
export function PickList({
  value,
  onChange,
  options,
  placeholder,
  className,
  allowClear
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label?: string; hint?: string }>
  placeholder: string
  className?: string
  allowClear?: boolean
}) {
  const [open, setOpen] = useState(false)
  const active = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'flex h-7 w-full items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-background px-2 text-left text-[12px] dark:border-border',
            value ? 'text-slate-800 dark:text-foreground' : 'text-slate-400',
            className
          )}
        >
          <span className='min-w-0 truncate'>
            {active?.label ?? active?.value ?? (value || placeholder)}
          </span>
          <ChevronsUpDown className='h-3 w-3 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList className='max-h-[240px]'>
            <CommandEmpty className='py-4 text-center text-[11.5px] text-slate-400'>
              No match.
            </CommandEmpty>
            <CommandGroup>
              {allowClear && value && (
                <CommandItem
                  value='__clear__'
                  onSelect={() => {
                    onChange('')
                    setOpen(false)
                  }}
                  className='text-[12px] text-slate-400'
                >
                  <X className='h-3 w-3' /> Clear
                </CommandItem>
              )}
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={`${o.value} ${o.label ?? ''}`}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn('h-3 w-3', o.value === value ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className='min-w-0 truncate'>{o.label ?? o.value}</span>
                  {o.hint && <span className='ml-auto shrink-0 text-[10.5px] text-slate-400'>{o.hint}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function SectionTitle({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div>
      <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
        {children}
      </p>
      {sub && <p className='mt-0.5 text-[11px] leading-snug text-slate-400'>{sub}</p>}
    </div>
  )
}

interface CollectionMeta {
  fields?: Array<{ field: string; type?: string | null; hidden?: boolean }>
}

export function ServiceConfigBuilder({
  value,
  onChange,
  stagingColumns
}: {
  /** The service_config JSON string as stored in the definition draft. */
  value: string
  onChange: (json: string) => void
  /** Declared staging column names — the file columns available to map. */
  stagingColumns: string[]
}) {
  const client = useNivaroClient()
  const [jsonMode, setJsonMode] = useState(false)
  // Internal structured state, re-seeded only when the incoming value differs
  // from what this builder last emitted (JSON-mode edits, definition switch).
  const lastEmitted = useRef<string | null>(null)
  const [state, setState] = useState<BuilderState | null>(() => parseState(value, stagingColumns))
  if (value !== lastEmitted.current) {
    lastEmitted.current = value
    const next = parseState(value, stagingColumns)
    setState(next)
    if (!next) setJsonMode(true)
  }

  const commit = (next: BuilderState) => {
    setState(next)
    const json = serialize(next)
    lastEmitted.current = json
    onChange(json)
  }

  const { data: collections = [] } = useQuery<Array<{ collection: string; display_name?: string }>>({
    queryKey: ['svc-builder-collections'],
    queryFn: () =>
      client
        .request<{ data: Array<{ collection: string; display_name?: string }> }>(get('/collections'))
        .then((r) => (r.data ?? []).filter((c) => !/^nivaro_|^directus_/i.test(c.collection))),
    staleTime: 5 * 60_000
  })

  const targetCollection = state?.collection ?? ''
  const { data: targetMeta } = useQuery<CollectionMeta>({
    queryKey: ['svc-builder-fields', targetCollection],
    queryFn: () =>
      client
        .request<{ data: CollectionMeta }>(get(`/collections/${targetCollection}`))
        .then((r) => r.data),
    enabled: !!targetCollection,
    staleTime: 5 * 60_000
  })
  const targetFields = useMemo(
    () => (targetMeta?.fields ?? []).filter((f) => f.field !== 'id'),
    [targetMeta]
  )
  const fieldOptions = targetFields.map((f) => ({ value: f.field, hint: f.type ?? undefined }))
  const dateFieldOptions = targetFields
    .filter((f) => f.type === 'date' || f.type === 'timestamp' || f.type === 'dateTime')
    .map((f) => ({ value: f.field, hint: f.type ?? undefined }))

  // Fields the diff can key on / require: everything a mapping or the derived
  // month writes to.
  const writtenFields = useMemo(() => {
    if (!state) return []
    const out = new Set<string>()
    for (const r of state.rows) if (r.field) out.add(r.field)
    if (state.monthOn && state.monthField) out.add(state.monthField)
    return [...out]
  }, [state])

  const [newCol, setNewCol] = useState('')

  if (jsonMode || !state) {
    return (
      <div className='space-y-1.5'>
        <Textarea
          value={value}
          onChange={(e) => {
            lastEmitted.current = e.target.value
            onChange(e.target.value)
            setState(parseState(e.target.value, stagingColumns))
          }}
          rows={12}
          className='font-mono text-[11.5px]'
          placeholder='{"collection": "…", "match_by": […], "columns": {…}}'
        />
        <div className='flex items-center justify-between'>
          {!state && value.trim() && (
            <p className='text-[11px] text-amber-600 dark:text-amber-400'>
              The builder needs valid JSON — fix it here to switch back.
            </p>
          )}
          <Button
            variant='ghost'
            size='sm'
            className='ml-auto h-6 gap-1 px-2 text-[11px] text-slate-500'
            disabled={!state}
            onClick={() => setJsonMode(false)}
          >
            Use the builder
          </Button>
        </div>
      </div>
    )
  }

  const lookupProblemRows = state.rows.filter(
    (r) => r.field && r.lookupOn && (!r.lookupCollection || !r.lookupField)
  )

  return (
    <div className='space-y-4 rounded-md border border-slate-200 bg-slate-50/60 p-3.5 dark:border-border dark:bg-background/40'>
      {/* ── Target ─────────────────────────────────────────────────────── */}
      <div className='flex flex-wrap items-end gap-x-4 gap-y-2'>
        <div className='w-[240px] space-y-1'>
          <SectionTitle>Writes to</SectionTitle>
          <PickList
            value={state.collection}
            onChange={(v) =>
              commit({
                ...state,
                collection: v,
                // A different table means different fields — stale references
                // would fail server validation invisibly, so they clear.
                ...(v !== state.collection
                  ? { matchBy: [], requireValue: [], monthField: '', tsCreate: '', tsUpdate: '', rows: state.rows.map((r) => ({ ...r, field: '' })) }
                  : {})
              })
            }
            options={collections.map((c) => ({
              value: c.collection,
              label: c.display_name || c.collection
            }))}
            placeholder='Choose a collection…'
          />
        </div>
        <p className='pb-1 text-[11px] leading-snug text-slate-400'>
          Rows are matched against existing records and only real changes write — each one
          revisioned, attributed to the uploader.
        </p>
      </div>

      {/* ── Column mappings ────────────────────────────────────────────── */}
      <div className='space-y-1.5'>
        <SectionTitle sub='Each file column lands in a target field. Lookup columns resolve a value (a name, a number) to the matching record.'>
          Column mappings
        </SectionTitle>
        <div className='overflow-hidden rounded-md border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <table className='w-full border-collapse text-[12px]'>
            <thead>
              <tr className='border-b border-slate-100 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border'>
                <th className='px-2.5 py-1.5 font-medium'>File column</th>
                <th className='w-6' />
                <th className='px-2 py-1.5 font-medium'>Target field</th>
                <th className='px-2 py-1.5 font-medium'>Interpret as</th>
                <th className='px-2.5 py-1.5 text-right font-medium'>Actions</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.length === 0 && (
                <tr>
                  <td colSpan={5} className='px-3 py-4 text-center text-[11.5px] text-slate-400'>
                    No file columns yet — declare staging columns above, or add one below.
                  </td>
                </tr>
              )}
              {state.rows.map((r, i) => {
                const update = (patch: Partial<ColumnRow>) => {
                  const rows = state.rows.map((row, j) => (j === i ? { ...row, ...patch } : row))
                  commit({ ...state, rows })
                }
                const mapped = !!r.field
                return (
                  <RowGroup key={r.col}>
                    <tr
                      className={cn(
                        'border-b border-slate-50 dark:border-border/50',
                        !mapped && 'opacity-60'
                      )}
                    >
                      <td className='px-2.5 py-1.5 font-mono text-[11.5px] text-slate-600 dark:text-muted-foreground'>
                        {r.col}
                      </td>
                      <td className='text-slate-300'>
                        <ArrowRight className='h-3 w-3' />
                      </td>
                      <td className='px-2 py-1'>
                        <PickList
                          value={r.field}
                          onChange={(v) => update({ field: v })}
                          options={fieldOptions}
                          placeholder='Not imported'
                          className='w-[180px]'
                          allowClear
                        />
                      </td>
                      <td className='px-2 py-1'>
                        {r.lookupOn ? (
                          <span className='text-[11px] text-slate-400'>Lookup ↓</span>
                        ) : (
                          <SimpleSelect
                            value={r.type}
                            onChange={(v) => update({ type: v as ColumnRow['type'] })}
                            options={[
                              { value: '', label: 'Text' },
                              { value: 'number', label: 'Number' },
                              { value: 'int', label: 'Whole number' },
                              { value: 'date', label: 'Date' },
                              { value: 'datetime', label: 'Date & time' },
                              { value: 'boolean', label: 'Yes/No' }
                            ]}
                            className='h-7 w-[130px] text-[12px]'
                          />
                        )}
                      </td>
                      <td className='px-2.5 py-1 text-right'>
                        <label className='inline-flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                          Lookup
                          <Switch
                            checked={r.lookupOn}
                            onCheckedChange={(v) => update({ lookupOn: v })}
                            className='scale-[0.8]'
                          />
                        </label>
                      </td>
                    </tr>
                    {r.lookupOn && (
                      <tr className='border-b border-slate-50 bg-slate-50/70 dark:border-border/50 dark:bg-background/40'>
                        <td />
                        <td />
                        <td colSpan={3} className='px-2 py-1.5'>
                          <div className='flex flex-wrap items-center gap-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                            <span>Find the</span>
                            <PickList
                              value={r.lookupCollection}
                              onChange={(v) => update({ lookupCollection: v })}
                              options={collections.map((c) => ({
                                value: c.collection,
                                label: c.display_name || c.collection
                              }))}
                              placeholder='collection…'
                              className='w-[160px]'
                            />
                            <span>record whose</span>
                            <LookupFieldPick
                              collection={r.lookupCollection}
                              value={r.lookupField}
                              onChange={(v) => update({ lookupField: v })}
                            />
                            <span>equals the file value, and store its id.</span>
                            <span className='ml-1'>If no match:</span>
                            <SimpleSelect
                              value={r.lookupOnMissing}
                              onChange={(v) =>
                                update({ lookupOnMissing: v as ColumnRow['lookupOnMissing'] })
                              }
                              options={[
                                { value: '', label: 'skip the file row' },
                                { value: 'null', label: 'leave the link empty' },
                                { value: 'create', label: 'create a new record' }
                              ]}
                              className='h-6 w-[180px] text-[11.5px]'
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </RowGroup>
                )
              })}
            </tbody>
          </table>
          <div className='flex items-center gap-2 border-t border-slate-100 px-2.5 py-1.5 dark:border-border'>
            <Input
              value={newCol}
              onChange={(e) => setNewCol(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
              placeholder='extra_file_column'
              className='h-6 w-[170px] font-mono text-[11px]'
            />
            <Button
              variant='ghost'
              size='sm'
              className='h-6 gap-1 px-2 text-[11px]'
              disabled={!newCol.trim() || state.rows.some((r) => r.col === newCol.trim())}
              onClick={() => {
                commit({
                  ...state,
                  rows: [
                    ...state.rows,
                    { col: newCol.trim(), field: '', type: '', lookupOn: false, lookupCollection: '', lookupField: '', lookupOnMissing: '' }
                  ]
                })
                setNewCol('')
              }}
            >
              <Plus className='h-3 w-3' /> Add column
            </Button>
          </div>
        </div>
        {lookupProblemRows.length > 0 && (
          <p className='text-[11px] text-amber-600 dark:text-amber-400'>
            {lookupProblemRows.map((r) => r.col).join(', ')}: lookup needs both a collection and a
            match field.
          </p>
        )}
      </div>

      {/* ── Derived month ──────────────────────────────────────────────── */}
      <div className='space-y-1.5'>
        <div className='flex items-center justify-between'>
          <SectionTitle sub='Combines two numeric file columns into a first-of-month date (2026 + 7 → 2026-07-01).'>
            Calendar month from year + month columns
          </SectionTitle>
          <Switch
            checked={state.monthOn}
            onCheckedChange={(v) => commit({ ...state, monthOn: v })}
          />
        </div>
        {state.monthOn && (
          <div className='flex flex-wrap items-center gap-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            <span>Store in</span>
            <PickList
              value={state.monthField}
              onChange={(v) => commit({ ...state, monthField: v })}
              options={dateFieldOptions}
              placeholder='date field…'
              className='w-[150px]'
            />
            <span>from year column</span>
            <PickList
              value={state.monthYearCol}
              onChange={(v) => commit({ ...state, monthYearCol: v })}
              options={state.rows.map((r) => ({ value: r.col }))}
              placeholder='year…'
              className='w-[120px]'
            />
            <span>and month column</span>
            <PickList
              value={state.monthMonthCol}
              onChange={(v) => commit({ ...state, monthMonthCol: v })}
              options={state.rows.map((r) => ({ value: r.col }))}
              placeholder='month…'
              className='w-[120px]'
            />
          </div>
        )}
      </div>

      {/* ── Match keys ─────────────────────────────────────────────────── */}
      <div className='space-y-1.5'>
        <SectionTitle sub='A file row updates the existing record sharing these values, or creates one. Within a file, the last row per key wins.'>
          Match existing records on
        </SectionTitle>
        <ChipPick
          values={state.matchBy}
          options={writtenFields}
          onChange={(v) => commit({ ...state, matchBy: v })}
          icon={<KeyRound className='h-2.5 w-2.5' />}
          emptyHint='Map at least one column first.'
        />
        {state.matchBy.length === 0 && writtenFields.length > 0 && (
          <p className='text-[11px] text-amber-600 dark:text-amber-400'>
            Pick at least one key — without one, every import row creates a new record.
          </p>
        )}
      </div>

      {/* ── Row rules + timestamps ─────────────────────────────────────── */}
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <div className='space-y-1.5'>
          <SectionTitle sub='Rows where these end up empty are skipped and counted, never written.'>
            Skip rows with an empty…
          </SectionTitle>
          <ChipPick
            values={state.requireValue}
            options={writtenFields.filter((f) => !state.matchBy.includes(f))}
            onChange={(v) => commit({ ...state, requireValue: v })}
            emptyHint='None — every mapped row writes.'
          />
        </div>
        <div className='space-y-1.5'>
          <SectionTitle sub='Stamped on the rows this import creates or changes.'>
            Timestamps
          </SectionTitle>
          <div className='flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            <span className='inline-flex items-center gap-2 whitespace-nowrap'>
              Created
              <PickList
                value={state.tsCreate}
                onChange={(v) => commit({ ...state, tsCreate: v })}
                options={dateFieldOptions}
                placeholder='none'
                className='w-[130px]'
                allowClear
              />
            </span>
            <span className='inline-flex items-center gap-2 whitespace-nowrap'>
              Updated
              <PickList
                value={state.tsUpdate}
                onChange={(v) => commit({ ...state, tsUpdate: v })}
                options={dateFieldOptions}
                placeholder='none'
                className='w-[130px]'
                allowClear
              />
            </span>
          </div>
        </div>
      </div>

      <div className='flex justify-end border-t border-slate-200/70 pt-2 dark:border-border'>
        <Button
          variant='ghost'
          size='sm'
          className='h-6 gap-1 px-2 text-[11px] text-slate-500'
          onClick={() => setJsonMode(true)}
        >
          <Braces className='h-3 w-3' /> Edit JSON
        </Button>
      </div>
    </div>
  )
}

/** Fragment wrapper so a mapping row + its lookup row share one key. */
function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

export function LookupFieldPick({
  collection,
  value,
  onChange
}: {
  collection: string
  value: string
  onChange: (v: string) => void
}) {
  const client = useNivaroClient()
  const { data } = useQuery<CollectionMeta>({
    queryKey: ['svc-builder-fields', collection],
    queryFn: () =>
      client.request<{ data: CollectionMeta }>(get(`/collections/${collection}`)).then((r) => r.data),
    enabled: !!collection,
    staleTime: 5 * 60_000
  })
  return (
    <PickList
      value={value}
      onChange={onChange}
      options={(data?.fields ?? [])
        .filter((f) => f.field !== 'id')
        .map((f) => ({ value: f.field, hint: f.type ?? undefined }))}
      placeholder='field…'
      className='w-[150px]'
    />
  )
}

export function ChipPick({
  values,
  options,
  onChange,
  icon,
  emptyHint
}: {
  values: string[]
  options: string[]
  onChange: (v: string[]) => void
  icon?: React.ReactNode
  emptyHint?: string
}) {
  const all = [...new Set([...options, ...values])]
  if (all.length === 0) {
    return <p className='text-[11px] text-slate-400'>{emptyHint ?? '—'}</p>
  }
  return (
    <div className='flex flex-wrap gap-1.5'>
      {all.map((f) => {
        const on = values.includes(f)
        return (
          <button
            key={f}
            type='button'
            onClick={() => onChange(on ? values.filter((v) => v !== f) : [...values, f])}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors',
              on
                ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                : 'border-slate-200 bg-white text-slate-400 hover:text-slate-600 dark:border-border dark:bg-card dark:hover:text-muted-foreground'
            )}
          >
            {on && icon}
            {f}
          </button>
        )
      })}
    </div>
  )
}
