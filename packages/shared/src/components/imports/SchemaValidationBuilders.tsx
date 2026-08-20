import { Braces, Plus, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { ChipPick, LookupFieldPick, PickList, SectionTitle } from './ServiceConfigBuilder'

/**
 * Structured editors for the other two config documents on an import
 * definition — the declared staging schema and the pre-flight validation.
 * Same contract as ServiceConfigBuilder: the stored value stays the exact
 * JSON the server parses, "Edit JSON" shows the raw document, and unknown
 * keys survive a builder round-trip untouched.
 */

const IDENT_CHARS = /[^A-Za-z0-9_]/g

function useCollections() {
  const client = useNivaroClient()
  return useQuery<Array<{ collection: string; display_name?: string }>>({
    queryKey: ['svc-builder-collections'],
    queryFn: () =>
      client
        .request<{ data: Array<{ collection: string; display_name?: string }> }>(get('/collections'))
        .then((r) => (r.data ?? []).filter((c) => !/^nivaro_|^directus_/i.test(c.collection))),
    staleTime: 5 * 60_000
  }).data
}

/** Shared JSON-mode shell: textarea + "Use the builder" return path, shown
 *  whenever the document can't be modeled (or on demand). */
function JsonShell({
  value,
  onChange,
  onParsed,
  canBuild,
  rows,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  onParsed: () => void
  canBuild: boolean
  rows: number
  placeholder: string
}) {
  return (
    <div className='space-y-1.5'>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className='font-mono text-[11.5px]'
        placeholder={placeholder}
      />
      <div className='flex items-center justify-between'>
        {!canBuild && value.trim() && (
          <p className='text-[11px] text-amber-600 dark:text-amber-400'>
            The builder needs valid JSON — fix it here to switch back.
          </p>
        )}
        <Button
          variant='ghost'
          size='sm'
          className='ml-auto h-6 gap-1 px-2 text-[11px] text-slate-500'
          disabled={!canBuild}
          onClick={onParsed}
        >
          Use the builder
        </Button>
      </div>
    </div>
  )
}

function JsonToggleFooter({ onClick }: { onClick: () => void }) {
  return (
    <div className='flex justify-end border-t border-slate-200/70 pt-2 dark:border-border'>
      <Button
        variant='ghost'
        size='sm'
        className='h-6 gap-1 px-2 text-[11px] text-slate-500'
        onClick={onClick}
      >
        <Braces className='h-3 w-3' /> Edit JSON
      </Button>
    </div>
  )
}

// ─── Declared staging columns ────────────────────────────────────────────────

interface ColDef {
  name: string
  from_header: string
  type: '' | 'text' | 'decimal' | 'int' | 'date'
  required: boolean
}

function parseCols(raw: string): ColDef[] | null {
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) return null
    const out: ColDef[] = []
    for (const c of parsed) {
      if (!c || typeof c !== 'object') return null
      const name = String((c as { name?: unknown }).name ?? '')
      if (!name) return null
      const type = String((c as { type?: unknown }).type ?? '')
      out.push({
        name,
        from_header: String((c as { from_header?: unknown }).from_header ?? ''),
        type: type === 'text' || type === 'decimal' || type === 'int' || type === 'date' ? type : '',
        required: (c as { required?: unknown }).required === true
      })
    }
    return out
  } catch {
    return null
  }
}

function serializeCols(cols: ColDef[]): string {
  if (cols.length === 0) return ''
  return JSON.stringify(
    cols.map((c) => ({
      name: c.name,
      ...(c.type ? { type: c.type } : {}),
      ...(c.from_header && c.from_header !== c.name ? { from_header: c.from_header } : {}),
      ...(c.required ? { required: true } : {})
    })),
    null,
    2
  )
}

export function StagingColumnsBuilder({
  value,
  onChange
}: {
  value: string
  onChange: (json: string) => void
}) {
  const [jsonMode, setJsonMode] = useState(false)
  const lastEmitted = useRef<string | null>(null)
  const [cols, setCols] = useState<ColDef[] | null>(() => parseCols(value))
  if (value !== lastEmitted.current) {
    lastEmitted.current = value
    const next = parseCols(value)
    setCols(next)
    if (!next) setJsonMode(true)
  }
  const commit = (next: ColDef[]) => {
    setCols(next)
    const json = serializeCols(next)
    lastEmitted.current = json
    onChange(json)
  }
  const [newName, setNewName] = useState('')

  if (jsonMode || !cols) {
    return (
      <JsonShell
        value={value}
        onChange={(v) => {
          lastEmitted.current = v
          onChange(v)
          setCols(parseCols(v))
        }}
        onParsed={() => setJsonMode(false)}
        canBuild={!!parseCols(value)}
        rows={7}
        placeholder='Empty = derive the schema from each file (historic behavior)'
      />
    )
  }

  return (
    <div className='space-y-2'>
      <div className='overflow-hidden rounded-md border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <table className='w-full border-collapse text-[12px]'>
          <thead>
            <tr className='border-b border-slate-100 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border'>
              <th className='px-2.5 py-1.5 font-medium'>Column</th>
              <th className='px-2 py-1.5 font-medium'>Fills from sheet header</th>
              <th className='px-2 py-1.5 font-medium'>Type</th>
              <th className='px-2 py-1.5 font-medium'>Required</th>
              <th className='w-8' />
            </tr>
          </thead>
          <tbody>
            {cols.length === 0 && (
              <tr>
                <td colSpan={5} className='px-3 py-4 text-center text-[11.5px] text-slate-400'>
                  No declared columns — the staging table derives its schema from each file.
                </td>
              </tr>
            )}
            {cols.map((c, i) => {
              const update = (patch: Partial<ColDef>) =>
                commit(cols.map((row, j) => (j === i ? { ...row, ...patch } : row)))
              return (
                <tr key={i} className='border-b border-slate-50 dark:border-border/50'>
                  <td className='px-2.5 py-1'>
                    <Input
                      value={c.name}
                      onChange={(e) => update({ name: e.target.value.replace(IDENT_CHARS, '') })}
                      className='h-6 w-[160px] font-mono text-[11.5px]'
                    />
                  </td>
                  <td className='px-2 py-1'>
                    <Input
                      value={c.from_header}
                      onChange={(e) => update({ from_header: e.target.value })}
                      placeholder={c.name}
                      className='h-6 w-[170px] text-[11.5px]'
                    />
                  </td>
                  <td className='px-2 py-1'>
                    <SimpleSelect
                      value={c.type}
                      onChange={(v) => update({ type: v as ColDef['type'] })}
                      options={[
                        { value: '', label: 'Text' },
                        { value: 'decimal', label: 'Decimal' },
                        { value: 'int', label: 'Whole number' },
                        { value: 'date', label: 'Date' }
                      ]}
                      className='h-6 w-[120px] text-[11.5px]'
                    />
                  </td>
                  <td className='px-2 py-1'>
                    <Switch
                      checked={c.required}
                      onCheckedChange={(v) => update({ required: v })}
                      className='scale-[0.8]'
                    />
                  </td>
                  <td className='px-2 py-1 text-right'>
                    <button
                      type='button'
                      className='text-slate-300 transition-colors hover:text-red-500'
                      onClick={() => commit(cols.filter((_, j) => j !== i))}
                    >
                      <X className='h-3.5 w-3.5' />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className='flex items-center gap-2 border-t border-slate-100 px-2.5 py-1.5 dark:border-border'>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value.replace(IDENT_CHARS, ''))}
            placeholder='column_name'
            className='h-6 w-[160px] font-mono text-[11px]'
          />
          <Button
            variant='ghost'
            size='sm'
            className='h-6 gap-1 px-2 text-[11px]'
            disabled={!newName.trim() || cols.some((c) => c.name === newName.trim())}
            onClick={() => {
              commit([...cols, { name: newName.trim(), from_header: '', type: '', required: false }])
              setNewName('')
            }}
          >
            <Plus className='h-3 w-3' /> Add column
          </Button>
        </div>
      </div>
      <JsonToggleFooter onClick={() => setJsonMode(true)} />
    </div>
  )
}

// ─── Pre-flight validation ───────────────────────────────────────────────────

interface ValState {
  keyColumns: string[]
  targetTable: string
  targetMatch: Array<{ column: string; target: string }>
  required: string[]
  numeric: string[]
  lookups: Array<{ column: string; collection: string; match_field: string; label: string }>
  extras: Record<string, unknown>
}

const VAL_KEYS = new Set([
  'key_columns',
  'target_table',
  'target_match',
  'required',
  'numeric',
  'lookups'
])

function parseVal(raw: string): ValState | null {
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
  const strArr = (v: unknown) => (Array.isArray(v) ? v.map(String) : [])
  const tm = cfg.target_match
  const targetMatch: Array<{ column: string; target: string }> = []
  if (tm && typeof tm === 'object' && !Array.isArray(tm)) {
    for (const [column, target] of Object.entries(tm as Record<string, unknown>)) {
      targetMatch.push({ column, target: String(target) })
    }
  }
  const lookups: ValState['lookups'] = []
  if (Array.isArray(cfg.lookups)) {
    for (const l of cfg.lookups) {
      if (!l || typeof l !== 'object') return null
      const o = l as Record<string, unknown>
      lookups.push({
        column: String(o.column ?? ''),
        collection: String(o.collection ?? ''),
        match_field: String(o.match_field ?? ''),
        label: String(o.label ?? '')
      })
    }
  }
  const extras: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(cfg)) {
    if (!VAL_KEYS.has(k)) extras[k] = v
  }
  return {
    keyColumns: strArr(cfg.key_columns),
    targetTable: String(cfg.target_table ?? ''),
    targetMatch,
    required: strArr(cfg.required),
    numeric: strArr(cfg.numeric),
    lookups,
    extras
  }
}

function serializeVal(s: ValState): string {
  const cfg: Record<string, unknown> = { ...s.extras }
  if (s.keyColumns.length) cfg.key_columns = s.keyColumns
  if (s.targetTable) cfg.target_table = s.targetTable
  const tm: Record<string, string> = {}
  for (const m of s.targetMatch) {
    if (m.column && m.target) tm[m.column] = m.target
  }
  if (Object.keys(tm).length) cfg.target_match = tm
  if (s.required.length) cfg.required = s.required
  if (s.numeric.length) cfg.numeric = s.numeric
  const lookups = s.lookups
    .filter((l) => l.column && l.collection && l.match_field)
    .map((l) => ({
      column: l.column,
      collection: l.collection,
      match_field: l.match_field,
      ...(l.label ? { label: l.label } : {})
    }))
  if (lookups.length) cfg.lookups = lookups
  return Object.keys(cfg).length ? JSON.stringify(cfg, null, 2) : ''
}

export function ValidationBuilder({
  value,
  onChange,
  stagingColumns
}: {
  value: string
  onChange: (json: string) => void
  /** Declared staging column names — what the checks can reference. */
  stagingColumns: string[]
}) {
  const collections = useCollections() ?? []
  const [jsonMode, setJsonMode] = useState(false)
  const lastEmitted = useRef<string | null>(null)
  const [state, setState] = useState<ValState | null>(() => parseVal(value))
  if (value !== lastEmitted.current) {
    lastEmitted.current = value
    const next = parseVal(value)
    setState(next)
    if (!next) setJsonMode(true)
  }
  const commit = (next: ValState) => {
    setState(next)
    const json = serializeVal(next)
    lastEmitted.current = json
    onChange(json)
  }

  if (jsonMode || !state) {
    return (
      <JsonShell
        value={value}
        onChange={(v) => {
          lastEmitted.current = v
          onChange(v)
          setState(parseVal(v))
        }}
        onParsed={() => setJsonMode(false)}
        canBuild={!!parseVal(value)}
        rows={8}
        placeholder='Empty = no pre-flight checks'
      />
    )
  }

  const colChips = stagingColumns
  const columnOptions = stagingColumns.map((c) => ({ value: c }))

  return (
    <div className='space-y-4 rounded-md border border-slate-200 bg-slate-50/60 p-3.5 dark:border-border dark:bg-background/40'>
      <div className='space-y-1.5'>
        <SectionTitle sub='Rows repeating these values within one file are flagged — the last occurrence would silently win.'>
          Duplicate detection — a row&rsquo;s identity is
        </SectionTitle>
        <ChipPick
          values={state.keyColumns}
          options={colChips}
          onChange={(v) => commit({ ...state, keyColumns: v })}
          emptyHint='Declare staging columns first.'
        />
      </div>

      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <div className='space-y-1.5'>
          <SectionTitle sub='Rows with these empty are hard errors — the file cannot queue.'>
            Required values
          </SectionTitle>
          <ChipPick
            values={state.required}
            options={colChips}
            onChange={(v) => commit({ ...state, required: v })}
            emptyHint='None.'
          />
        </div>
        <div className='space-y-1.5'>
          <SectionTitle sub='Non-numeric values in these columns are hard errors.'>
            Must be numeric
          </SectionTitle>
          <ChipPick
            values={state.numeric}
            options={colChips}
            onChange={(v) => commit({ ...state, numeric: v })}
            emptyHint='None.'
          />
        </div>
      </div>

      <div className='space-y-1.5'>
        <SectionTitle sub='The preview counts which file rows would create new records vs update existing ones, by matching these columns against the table.'>
          New-vs-update preview
        </SectionTitle>
        <div className='flex flex-wrap items-center gap-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          <span>Target table</span>
          <PickList
            value={state.targetTable}
            onChange={(v) => commit({ ...state, targetTable: v })}
            options={collections.map((c) => ({
              value: c.collection,
              label: c.display_name || c.collection
            }))}
            placeholder='none'
            className='w-[200px]'
            allowClear
          />
        </div>
        {state.targetTable && (
          <div className='space-y-1'>
            {state.targetMatch.map((m, i) => (
              <div
                key={i}
                className='flex flex-wrap items-center gap-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'
              >
                <span>File column</span>
                <PickList
                  value={m.column}
                  onChange={(v) =>
                    commit({
                      ...state,
                      targetMatch: state.targetMatch.map((row, j) =>
                        j === i ? { ...row, column: v } : row
                      )
                    })
                  }
                  options={columnOptions}
                  placeholder='column…'
                  className='w-[150px]'
                />
                <span>matches target column</span>
                <LookupFieldPick
                  collection={state.targetTable}
                  value={m.target}
                  onChange={(v) =>
                    commit({
                      ...state,
                      targetMatch: state.targetMatch.map((row, j) =>
                        j === i ? { ...row, target: v } : row
                      )
                    })
                  }
                />
                <button
                  type='button'
                  className='text-slate-300 transition-colors hover:text-red-500'
                  onClick={() =>
                    commit({ ...state, targetMatch: state.targetMatch.filter((_, j) => j !== i) })
                  }
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              </div>
            ))}
            <Button
              variant='ghost'
              size='sm'
              className='h-6 gap-1 px-2 text-[11px]'
              onClick={() =>
                commit({ ...state, targetMatch: [...state.targetMatch, { column: '', target: '' }] })
              }
            >
              <Plus className='h-3 w-3' /> Add match column
            </Button>
          </div>
        )}
      </div>

      <div className='space-y-1.5'>
        <SectionTitle sub='Warns about rows whose value matches nothing the import can join to — the rows a procedure would silently drop.'>
          Join-miss checks
        </SectionTitle>
        <div className='space-y-1'>
          {state.lookups.map((l, i) => {
            const update = (patch: Partial<ValState['lookups'][number]>) =>
              commit({
                ...state,
                lookups: state.lookups.map((row, j) => (j === i ? { ...row, ...patch } : row))
              })
            return (
              <div
                key={i}
                className='flex flex-wrap items-center gap-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'
              >
                <PickList
                  value={l.column}
                  onChange={(v) => update({ column: v })}
                  options={columnOptions}
                  placeholder='file column…'
                  className='w-[140px]'
                />
                <span>must match a</span>
                <PickList
                  value={l.collection}
                  onChange={(v) => update({ collection: v })}
                  options={collections.map((c) => ({
                    value: c.collection,
                    label: c.display_name || c.collection
                  }))}
                  placeholder='collection…'
                  className='w-[160px]'
                />
                <span>record&rsquo;s</span>
                <LookupFieldPick
                  collection={l.collection}
                  value={l.match_field}
                  onChange={(v) => update({ match_field: v })}
                />
                <Input
                  value={l.label}
                  onChange={(e) => update({ label: e.target.value })}
                  placeholder='label (optional)'
                  className='h-7 w-[120px] text-[11.5px]'
                />
                <button
                  type='button'
                  className='text-slate-300 transition-colors hover:text-red-500'
                  onClick={() =>
                    commit({ ...state, lookups: state.lookups.filter((_, j) => j !== i) })
                  }
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              </div>
            )
          })}
          <Button
            variant='ghost'
            size='sm'
            className='h-6 gap-1 px-2 text-[11px]'
            onClick={() =>
              commit({
                ...state,
                lookups: [...state.lookups, { column: '', collection: '', match_field: '', label: '' }]
              })
            }
          >
            <Plus className='h-3 w-3' /> Add check
          </Button>
        </div>
      </div>

      <JsonToggleFooter onClick={() => setJsonMode(true)} />
    </div>
  )
}
