import { useMutation, useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  Copy,
  FlaskConical,
  Play,
  Plug,
  Search,
  ShieldAlert,
  Wrench
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ContractTestsPanel, SaveTestButton, useContractTests } from './McpContractTests'

/**
 * MCP console (#2468) — the tools a connected AI app signed in as this administrator would
 * get (GET /mcp-console/tools applies the /api/mcp rule), a form built from each tool's input
 * schema, and a run that goes through the real MCP server in-process. Writes default to dry
 * run: a tool that can rehearse rehearses; any other change is held and listed, never sent.
 * #3215: a run can be saved as a contract test (McpContractTests.tsx); ?view=tests lists them all.
 */

interface JsonSchema {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  items?: JsonSchema
  anyOf?: JsonSchema[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  default?: unknown
  minimum?: number
  maximum?: number
}

interface ToolRow {
  name: string
  title: string | null
  description: string | null
  input_schema: JsonSchema
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }
  write: boolean
  dry_run_arg: boolean
  group: 'admin' | 'everyday'
}

interface ConsoleCall {
  method: string
  path: string
  status: number
  ms: number
  held?: true
  body?: unknown
}

interface RunResult {
  tool: string
  arguments: Record<string, unknown>
  is_error: boolean
  ms: number
  chars: number
  compact: unknown
  result: unknown
  calls: ConsoleCall[]
  dry_run: 'not_needed' | 'off' | 'tool' | 'held'
}

type FieldKind = 'string' | 'number' | 'boolean' | 'enum' | 'list' | 'json'

/** How a property is edited. Unions the MCP tools use: object-or-JSON-string, list-or-CSV. */
function kindOf(s: JsonSchema): FieldKind {
  if (s.enum?.length) return 'enum'
  const types = new Set<string>()
  const collect = (x: JsonSchema) => {
    if (Array.isArray(x.type)) for (const t of x.type) types.add(t)
    else if (x.type) types.add(x.type)
    if (x.type === 'array' && x.items?.type === 'string') types.add('string-array')
    for (const a of x.anyOf ?? []) collect(a)
  }
  collect(s)
  if (types.has('object')) return 'json'
  if (types.has('string-array')) return 'list'
  if (types.has('array')) return 'json'
  if (types.has('boolean')) return 'boolean'
  if (types.has('number') || types.has('integer')) return 'number'
  return 'string'
}

/** The form's text values → tool arguments. Throws with the field name on bad JSON. */
function toArguments(schema: JsonSchema, values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const raw = values[name]
    if (raw === undefined || raw.trim() === '') continue
    const kind = kindOf(prop)
    if (kind === 'boolean') out[name] = raw === 'true'
    else if (kind === 'number') {
      const n = Number(raw)
      if (!Number.isFinite(n)) throw new Error(`${name} must be a number`)
      out[name] = n
    } else if (kind === 'list')
      out[name] = raw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    else if (kind === 'json') {
      try {
        out[name] = JSON.parse(raw)
      } catch {
        throw new Error(`${name} is not valid JSON`)
      }
    } else if (kind === 'enum') {
      const match = prop.enum?.find((e) => String(e) === raw)
      out[name] = match ?? raw
    } else out[name] = raw
  }
  return out
}

/** Tool arguments → the form's text values (the JSON editor switching back to the form). */
function fromArguments(schema: JsonSchema, args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const v = args[name]
    if (v === undefined || v === null) continue
    const kind = kindOf(prop)
    if (kind === 'list' && Array.isArray(v)) out[name] = v.join(', ')
    else if (kind === 'json' || (typeof v === 'object' && v !== null))
      out[name] = JSON.stringify(v, null, 2)
    else out[name] = String(v)
  }
  return out
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2) ?? 'null'

// ─── Left list ────────────────────────────────────────────────────────────────

function ToolList({
  tools,
  selected,
  onSelect
}: {
  tools: ToolRow[]
  selected: string | null
  onSelect: (name: string) => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q
    ? tools.filter(
        (t) =>
          t.name.includes(q) ||
          (t.title ?? '').toLowerCase().includes(q) ||
          (t.description ?? '').toLowerCase().includes(q)
      )
    : tools
  const groups: Array<{ key: string; label: string; rows: ToolRow[] }> = [
    { key: 'everyday', label: 'Everyday tools', rows: shown.filter((t) => t.group !== 'admin') },
    { key: 'admin', label: 'Administrator tools', rows: shown.filter((t) => t.group === 'admin') }
  ]
  return (
    <>
      <div className='shrink-0 border-b border-slate-200 p-3 dark:border-border'>
        <div className='relative'>
          <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Find a tool'
            aria-label='Find a tool'
            className='h-8 pl-8 text-[13px]'
          />
        </div>
      </div>
      <div className='flex-1 overflow-y-auto pb-3'>
        {shown.length === 0 && (
          <p className='px-4 py-6 text-[12px] text-slate-500 dark:text-muted-foreground'>
            No tool matches “{query}”.
          </p>
        )}
        {groups
          .filter((g) => g.rows.length > 0)
          .map((g) => (
            <div key={g.key}>
              <p className='px-4 pb-1 pt-4 text-[12px] font-medium text-slate-500 dark:text-muted-foreground'>
                {g.label}
              </p>
              <ul>
                {g.rows.map((t) => (
                  <li key={t.name}>
                    <button
                      type='button'
                      onClick={() => onSelect(t.name)}
                      aria-current={selected === t.name ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors duration-150',
                        selected === t.name
                          ? 'bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
                          : 'text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-muted'
                      )}
                    >
                      <span className='min-w-0 flex-1 truncate font-mono text-[12px]'>
                        {t.name}
                      </span>
                      {t.write && (
                        <span
                          className={cn(
                            'shrink-0 rounded px-1.5 py-px text-[10px] font-medium',
                            t.annotations.destructiveHint
                              ? 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'
                              : 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
                          )}
                        >
                          {t.annotations.destructiveHint ? 'deletes' : 'writes'}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>
    </>
  )
}

// ─── Form ─────────────────────────────────────────────────────────────────────

function FieldInput({
  name,
  schema,
  required,
  value,
  onChange
}: {
  name: string
  schema: JsonSchema
  required: boolean
  value: string
  onChange: (v: string) => void
}) {
  const kind = kindOf(schema)
  const id = `mcp-arg-${name}`
  const hint = kind === 'list' ? 'Comma-separated.' : kind === 'json' ? 'JSON.' : null
  return (
    <div className='space-y-1.5'>
      <div className='flex items-baseline gap-2'>
        <Label htmlFor={id} className='font-mono text-[12px] font-medium'>
          {name}
        </Label>
        {required ? (
          <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>required</span>
        ) : null}
      </div>
      {kind === 'boolean' ? (
        <SimpleSelect
          value={value}
          onChange={onChange}
          ariaLabel={name}
          className='h-8 w-[160px] text-[13px]'
          options={[
            { value: '', label: 'Not set' },
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' }
          ]}
        />
      ) : kind === 'enum' ? (
        <SimpleSelect
          value={value}
          onChange={onChange}
          ariaLabel={name}
          className='h-8 w-full max-w-[320px] text-[13px]'
          options={[
            ...(required ? [] : [{ value: '', label: 'Not set' }]),
            ...(schema.enum ?? []).map((e) => ({ value: String(e), label: String(e) }))
          ]}
        />
      ) : kind === 'json' ? (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          rows={4}
          placeholder='{ }'
          className='font-mono text-[12px]'
        />
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode={kind === 'number' ? 'decimal' : undefined}
          spellCheck={false}
          className={cn('h-8 text-[13px]', kind !== 'number' && 'font-mono text-[12px]')}
        />
      )}
      {(schema.description || hint) && (
        <p className='max-w-[72ch] text-[12px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
          {[schema.description, hint].filter(Boolean).join(' ')}
        </p>
      )}
    </div>
  )
}

// ─── Result ───────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      variant='ghost'
      size='sm'
      className='h-7 px-2 text-[12px]'
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }}
    >
      {done ? <Check className='mr-1 h-3.5 w-3.5' /> : <Copy className='mr-1 h-3.5 w-3.5' />}
      {done ? 'Copied' : 'Copy'}
    </Button>
  )
}

const RESULT_VIEWS = [
  { key: 'compact', label: 'Result' },
  { key: 'raw', label: 'Raw JSON' },
  { key: 'calls', label: 'API calls' }
] as const
type ResultView = (typeof RESULT_VIEWS)[number]['key']

const DRY_RUN_NOTE: Record<RunResult['dry_run'], string | null> = {
  not_needed: null,
  off: 'Ran for real.',
  tool: 'Rehearsed by the tool (dry_run: true). Nothing was stored.',
  held: 'Dry run. The changes the tool tried to make were held, not sent.'
}

function ResultPanel({ run }: { run: RunResult }) {
  const [view, setView] = useState<ResultView>('compact')
  const held = run.calls.filter((c) => c.held).length
  const ref = useRef<HTMLElement>(null)
  // A new result lands below the form: bring it into view (the panel mounts once per run —
  // the skeleton replaces it while a run is pending).
  useEffect(() => {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ref.current?.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' })
  }, [])
  // A dry run whose held change made the tool answer an error is the expected outcome.
  const verdict = held > 0 && run.dry_run === 'held' ? 'held' : run.is_error ? 'error' : 'ok'
  const text = view === 'raw' ? pretty(run.result) : pretty(run.compact)
  const note = DRY_RUN_NOTE[run.dry_run]
  return (
    <section
      ref={ref}
      aria-label='Result'
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <div className='flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-slate-200 px-4 py-3 dark:border-border'>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[11px] font-medium',
            verdict === 'error'
              ? 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'
              : verdict === 'held'
                ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
                : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
          )}
        >
          {verdict === 'error' ? 'Error' : verdict === 'held' ? 'Held' : 'OK'}
        </span>
        <Stat label='Time' value={`${run.ms.toLocaleString()} ms`} />
        <Stat
          label='Size'
          value={`${run.chars.toLocaleString()} chars`}
          tip={`About ${Math.ceil(run.chars / 4).toLocaleString()} tokens for a model`}
        />
        <Stat
          label='API calls'
          value={held ? `${run.calls.length - held} sent · ${held} held` : String(run.calls.length)}
        />
        {note && (
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>{note}</span>
        )}
        <span className='ml-auto'>
          <SaveTestButton
            tool={run.tool}
            args={run.arguments}
            output={run.compact}
            isError={run.is_error}
          />
        </span>
      </div>
      <div className='flex items-center justify-between gap-2 px-4 pt-3'>
        <div role='tablist' aria-label='Result views' className='flex gap-1'>
          {RESULT_VIEWS.map((v) => (
            <button
              key={v.key}
              type='button'
              role='tab'
              aria-selected={view === v.key}
              onClick={() => setView(v.key)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors duration-150',
                view === v.key
                  ? 'bg-accent text-slate-900 dark:text-foreground'
                  : 'text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
        {view !== 'calls' && <CopyButton text={text} />}
      </div>
      <div className='p-4 pt-3'>
        {view === 'calls' ? (
          <CallsTable calls={run.calls} />
        ) : (
          <pre className='max-h-[560px] overflow-auto rounded-md bg-slate-50 p-3 font-mono text-[12px] leading-relaxed text-slate-800 dark:bg-muted/50 dark:text-slate-200'>
            {text}
          </pre>
        )}
      </div>
    </section>
  )
}

function Stat({ label, value, tip }: { label: string; value: string; tip?: string }) {
  return (
    <span className='text-[12px] text-slate-500 dark:text-muted-foreground' data-tip={tip}>
      {label}{' '}
      <span className='font-mono text-[12px] font-medium text-slate-900 dark:text-foreground'>
        {value}
      </span>
    </span>
  )
}

function CallsTable({ calls }: { calls: ConsoleCall[] }) {
  if (calls.length === 0)
    return (
      <p className='py-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
        The tool answered without calling the API.
      </p>
    )
  return (
    <div className='overflow-x-auto'>
      <table className='w-full text-[12px]'>
        <thead>
          <tr className='border-b border-slate-200 text-left text-[11px] font-medium text-slate-500 dark:border-border dark:text-muted-foreground'>
            <th className='py-1.5 pr-3 font-medium'>Method</th>
            <th className='py-1.5 pr-3 font-medium'>Path</th>
            <th className='py-1.5 pr-3 font-medium'>Status</th>
            <th className='py-1.5 text-right font-medium'>Time</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c, i) => (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: calls are an ordered log
              key={i}
              className='border-b border-slate-100 align-top last:border-0 dark:border-border'
            >
              <td className='py-1.5 pr-3 font-mono'>{c.method}</td>
              <td className='py-1.5 pr-3 font-mono break-all'>
                {c.path}
                {c.held && c.body !== undefined && (
                  <pre className='mt-1 max-h-48 overflow-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700 dark:bg-muted/50 dark:text-slate-300'>
                    {pretty(c.body)}
                  </pre>
                )}
              </td>
              <td className='py-1.5 pr-3'>
                {c.held ? (
                  <span className='rounded bg-amber-50 px-1.5 py-px text-[11px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'>
                    Not sent
                  </span>
                ) : (
                  <span
                    className={cn(
                      'font-mono',
                      c.status >= 400
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-slate-700 dark:text-slate-300'
                    )}
                  >
                    {c.status}
                  </span>
                )}
              </td>
              <td className='py-1.5 text-right font-mono text-slate-600 dark:text-slate-400'>
                {c.held ? '—' : `${c.ms} ms`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Detail ───────────────────────────────────────────────────────────────────

function ToolDetail({ tool }: { tool: ToolRow }) {
  const properties = Object.entries(tool.input_schema.properties ?? {}).filter(
    ([name]) => !(tool.dry_run_arg && name === 'dry_run')
  )
  const required = new Set(tool.input_schema.required ?? [])
  const [values, setValues] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('{}')
  const [formError, setFormError] = useState<string | null>(null)
  const [dryRun, setDryRun] = useState(true)
  const [confirmReal, setConfirmReal] = useState(false)

  const run = useMutation({
    mutationFn: async (args: Record<string, unknown>) =>
      (
        await api.post<RunResult>('/mcp-console/run', {
          tool: tool.name,
          arguments: args,
          dry_run: tool.write ? dryRun : true
        })
      ).data
  })

  const collect = (): Record<string, unknown> | null => {
    try {
      if (mode === 'json') {
        const parsed = JSON.parse(jsonText || '{}')
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('Arguments must be a JSON object')
        return parsed
      }
      return toArguments(tool.input_schema, values)
    } catch (err) {
      setFormError((err as Error).message)
      return null
    }
  }

  const switchMode = (next: 'form' | 'json') => {
    if (next === mode) return
    setFormError(null)
    if (next === 'json') {
      const args = collect()
      if (!args) return
      setJsonText(pretty(args))
    } else {
      try {
        const parsed = JSON.parse(jsonText || '{}')
        setValues(fromArguments(tool.input_schema, parsed))
      } catch {
        setFormError('Fix the JSON before going back to the form')
        return
      }
    }
    setMode(next)
  }

  const submit = () => {
    setFormError(null)
    const args = collect()
    if (!args) return
    const missing = [...required].filter((r) => args[r] === undefined && r !== 'dry_run')
    if (missing.length) {
      setFormError(`Fill in ${missing.join(', ')}`)
      return
    }
    if (tool.write && !dryRun && !confirmReal) {
      setConfirmReal(true)
      return
    }
    setConfirmReal(false)
    run.mutate(args)
  }

  const errorText =
    (run.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
    (run.error as Error | null)?.message

  return (
    <div className='space-y-6 px-6 py-5'>
      <header className='space-y-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <h2 className='font-mono text-[15px] font-semibold text-slate-900 dark:text-foreground'>
            {tool.name}
          </h2>
          {tool.title && (
            <span className='text-[13px] text-slate-500 dark:text-muted-foreground'>
              {tool.title}
            </span>
          )}
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[11px] font-medium',
              !tool.write
                ? 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
                : tool.annotations.destructiveHint
                  ? 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'
                  : 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
            )}
          >
            {!tool.write ? 'Read only' : tool.annotations.destructiveHint ? 'Deletes' : 'Writes'}
          </span>
        </div>
        {tool.description && (
          <p className='max-w-[80ch] text-[13px] leading-relaxed text-slate-600 dark:text-slate-300'>
            {tool.description}
          </p>
        )}
      </header>

      <section
        aria-label='Arguments'
        className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      >
        <div className='flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-border'>
          <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            Arguments
          </h3>
          <div role='tablist' aria-label='Edit arguments as' className='flex gap-1'>
            {(['form', 'json'] as const).map((m) => (
              <button
                key={m}
                type='button'
                role='tab'
                aria-selected={mode === m}
                onClick={() => switchMode(m)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors duration-150',
                  mode === m
                    ? 'bg-accent text-slate-900 dark:text-foreground'
                    : 'text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
                )}
              >
                {m === 'form' ? 'Form' : 'JSON'}
              </button>
            ))}
          </div>
        </div>
        <div className='space-y-4 p-4'>
          {mode === 'json' ? (
            <Textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              spellCheck={false}
              rows={10}
              aria-label='Arguments as JSON'
              className='font-mono text-[12px]'
            />
          ) : properties.length === 0 ? (
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              This tool takes no arguments.
            </p>
          ) : (
            properties.map(([name, prop]) => (
              <FieldInput
                key={name}
                name={name}
                schema={prop}
                required={required.has(name)}
                value={values[name] ?? ''}
                onChange={(v) => {
                  setValues((prev) => ({ ...prev, [name]: v }))
                  setConfirmReal(false)
                }}
              />
            ))
          )}
        </div>
        <div className='flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-slate-200 px-4 py-3 dark:border-border'>
          {tool.write ? (
            <div className='flex min-w-0 flex-1 items-start gap-2.5'>
              <Switch
                id='mcp-dry-run'
                checked={dryRun}
                onCheckedChange={(v) => {
                  setDryRun(v)
                  setConfirmReal(false)
                }}
                className='mt-0.5 scale-90'
              />
              <div className='min-w-0'>
                <Label htmlFor='mcp-dry-run' className='text-[13px] font-medium'>
                  Dry run
                </Label>
                <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                  {dryRun
                    ? tool.dry_run_arg
                      ? 'The tool rehearses: rules and validation run, nothing is stored.'
                      : 'Nothing is changed: every change the tool tries to make is held and listed under API calls.'
                    : 'Off: the tool runs for real, as you.'}
                </p>
              </div>
            </div>
          ) : (
            <p className='flex-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Read only. Runs as you, the way a connected app signed in as you would.
            </p>
          )}
          <Button
            onClick={submit}
            disabled={run.isPending}
            variant={confirmReal ? 'destructive' : 'default'}
            className={cn(
              'h-8 text-[12px]',
              !confirmReal && 'bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            )}
          >
            {confirmReal ? (
              <ShieldAlert className='mr-1.5 h-3.5 w-3.5' />
            ) : tool.write && dryRun ? (
              <FlaskConical className='mr-1.5 h-3.5 w-3.5' />
            ) : (
              <Play className='mr-1.5 h-3.5 w-3.5' />
            )}
            {run.isPending
              ? 'Running…'
              : confirmReal
                ? 'Run for real'
                : tool.write && dryRun
                  ? 'Dry run'
                  : 'Run'}
          </Button>
        </div>
        {(formError || confirmReal) && (
          <p
            role='alert'
            className={cn(
              'border-t px-4 py-2.5 text-[12px]',
              formError
                ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
                : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
            )}
          >
            {formError ?? 'Dry run is off. Click Run for real to change data as yourself.'}
          </p>
        )}
      </section>

      {run.isPending ? (
        <div className='space-y-2 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
          <Skeleton className='h-4 w-1/3' />
          <Skeleton className='h-24 w-full' />
        </div>
      ) : run.isError ? (
        <div
          role='alert'
          className='flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
        >
          <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0' />
          <span>{errorText || 'The run failed'}</span>
        </div>
      ) : run.data ? (
        <ResultPanel run={run.data} />
      ) : null}

      <ContractTestsPanel tool={tool.name} />
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function McpConsolePage() {
  const [params, setParams] = useSearchParams()
  const selected = params.get('tool')
  const showTests = params.get('view') === 'tests'
  const tests = useContractTests()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['mcp-console', 'tools'],
    queryFn: async () =>
      (await api.get<{ tools: ToolRow[]; admin_tools: boolean }>('/mcp-console/tools')).data,
    staleTime: 60_000
  })
  const tools = useMemo(() => data?.tools ?? [], [data])
  const tool = tools.find((t) => t.name === selected) ?? null

  const select = (name: string) => {
    const next = new URLSearchParams(params)
    next.set('tool', name)
    next.delete('view')
    setParams(next, { replace: true })
  }
  const toggleTests = () => {
    const next = new URLSearchParams(params)
    if (showTests) next.delete('view')
    else next.set('view', 'tests')
    setParams(next, { replace: true })
  }
  const failing = (tests.data ?? []).filter(
    (t) => t.enabled && (t.last_status === 'fail' || t.last_status === 'error')
  ).length

  // Open on the first tool so the page never starts on an empty panel.
  useEffect(() => {
    if (!selected && tools.length > 0) {
      const next = new URLSearchParams(params)
      next.set('tool', tools[0].name)
      setParams(next, { replace: true })
    }
  }, [selected, tools, params, setParams])

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description='The tools an AI app connected as you would get. Try one here, with writes as a dry run if you like, before an assistant does.'
        actions={
          data && (
            <span className='flex items-center gap-2'>
              <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-muted dark:text-muted-foreground'>
                {tools.length} {tools.length === 1 ? 'tool' : 'tools'}
              </span>
              <Button
                size='sm'
                variant={showTests ? 'secondary' : 'outline'}
                className='h-8 text-[12px]'
                aria-pressed={showTests}
                onClick={toggleTests}
              >
                <FlaskConical className='mr-1 h-3.5 w-3.5' />
                Contract tests
                {failing > 0 && (
                  <span className='ml-1.5 rounded-full bg-red-50 px-1.5 text-[10.5px] font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-300'>
                    {failing}
                  </span>
                )}
              </Button>
            </span>
          )
        }
      />

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='flex w-[272px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          {isLoading ? (
            <div className='space-y-2 p-4'>
              {[0, 1, 2, 3, 4, 5].map((k) => (
                <Skeleton key={k} className='h-5 w-full' />
              ))}
            </div>
          ) : (
            <ToolList tools={tools} selected={selected} onSelect={select} />
          )}
        </aside>

        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {isError ? (
            <div className='flex items-start gap-2 px-6 py-5 text-[13px] text-red-700 dark:text-red-300'>
              <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0' />
              <span>
                {(error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
                  'Could not load the MCP tools.'}
              </span>
            </div>
          ) : isLoading ? (
            <div className='space-y-3 px-6 py-5'>
              <Skeleton className='h-5 w-48' />
              <Skeleton className='h-4 w-2/3' />
              <Skeleton className='h-40 w-full' />
            </div>
          ) : showTests ? (
            <div className='px-6 py-5'>
              <ContractTestsPanel />
            </div>
          ) : tool ? (
            <ToolDetail key={tool.name} tool={tool} />
          ) : (
            <div className='flex flex-col items-start gap-2 px-6 py-8 text-[13px] text-slate-500 dark:text-muted-foreground'>
              {tools.length === 0 ? (
                <>
                  <Plug className='h-6 w-6 text-slate-300 dark:text-slate-600' />
                  <p>No MCP tools are available to you.</p>
                </>
              ) : (
                <>
                  <Wrench className='h-6 w-6 text-slate-300 dark:text-slate-600' />
                  <p>“{selected}” is not one of your tools. Pick one on the left.</p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
