import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Hammer, Plus, Puzzle, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
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
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Assistant tools (#2464, #2465) — the tools this instance adds to MCP
 * clients beyond the built-in set: saved queries and flows an administrator
 * exposes under their own names, and the tools extensions register.
 */

type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'date'
interface ToolParam {
  name: string
  type: ParamType
  required?: boolean
  description?: string
}
interface NamedTool {
  name: string
  title?: string
  description: string
  kind: 'custom_query' | 'flow'
  ref: string
  access: 'admin' | 'authenticated'
  read_only: boolean
  enabled: boolean
  params?: ToolParam[]
}
interface ExtTool {
  name: string
  title: string
  extension: string
  description: string
  read_only: boolean
  enabled: boolean
  stats: { calls: number; errors: number; last_used_at: string | null; last_error: string | null }
}
interface Config {
  ready: boolean
  tools: NamedTool[]
  extension_tools: ExtTool[]
  builtin_names: string[]
}
interface QueryRow {
  slug: string
  name: string
  access: string
  enabled: boolean | number
  params: Array<{ name: string; type: string; required?: boolean; default?: unknown }> | string
}
interface FlowRow {
  id: string
  name: string
  status: string
}

type Selection = { kind: 'named'; index: number } | { kind: 'new' } | { kind: 'ext'; name: string }

const NAME_RE = /^[a-z][a-z0-9_]{2,47}$/
const PARAM_TYPES: Array<{ value: ParamType; label: string }> = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Whole number' },
  { value: 'boolean', label: 'Yes / no' },
  { value: 'date', label: 'Date' }
]
const errMsg = (e: unknown) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
  'Something went wrong'
const blank = (): NamedTool => ({
  name: '',
  description: '',
  kind: 'custom_query',
  ref: '',
  access: 'admin',
  read_only: true,
  enabled: true
})
const queryParams = (q?: QueryRow) => {
  if (!q) return []
  if (Array.isArray(q.params)) return q.params
  try {
    const v = JSON.parse(q.params || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function McpToolsPage() {
  const qc = useQueryClient()
  const [sel, setSel] = useState<Selection | null>(null)
  const config = useQuery({
    queryKey: ['mcp-tools', 'config'],
    queryFn: async () => (await api.get('/mcp-tools/config')).data.data as Config
  })
  const queries = useQuery({
    queryKey: ['mcp-tools', 'custom-queries'],
    queryFn: async () => (await api.get('/custom-queries')).data.data as QueryRow[],
    staleTime: 60_000
  })
  const flows = useQuery({
    queryKey: ['mcp-tools', 'flows'],
    queryFn: async () => (await api.get('/flows')).data.data as FlowRow[],
    staleTime: 60_000
  })
  const save = useMutation({
    mutationFn: async (tools: NamedTool[]) =>
      (await api.put('/mcp-tools/config', { tools })).data.data.tools as NamedTool[],
    onSuccess: (tools) => {
      qc.setQueryData<Config>(['mcp-tools', 'config'], (c) => (c ? { ...c, tools } : c))
    }
  })

  const tools = config.data?.tools ?? []
  const ext = config.data?.extension_tools ?? []
  const current =
    sel?.kind === 'named' ? tools[sel.index] : sel?.kind === 'new' ? blank() : undefined
  const extSel = sel?.kind === 'ext' ? ext.find((t) => t.name === sel.name) : undefined

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <header className='flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex h-9 w-9 items-center justify-center rounded-lg bg-nvr-cyan/15'>
          <Hammer className='h-4.5 w-4.5 text-nvr-navy dark:text-nvr-cyan' />
        </div>
        <div className='min-w-0 flex-1'>
          <h1 className='text-base font-semibold'>Assistant tools</h1>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Tools that MCP clients (Claude, ChatGPT, Codex) can call on this instance, beyond the
            built-in set. Each one runs as the person calling it.
          </p>
        </div>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!config.data?.ready}
          onClick={() => setSel({ kind: 'new' })}
        >
          <Plus className='mr-1 h-3.5 w-3.5' /> New tool
        </Button>
      </header>
      {config.data && !config.data.ready && (
        <div className='shrink-0 border-b border-amber-200 bg-amber-50 px-6 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
          Named tools need database migration 473. Extension tools below work already; you can add
          named tools once the migration has run.
        </div>
      )}
      <div className='flex min-h-0 flex-1 overflow-hidden'>
        <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          {config.isLoading ? (
            <div className='space-y-2 p-3'>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className='h-10 w-full' />
              ))}
            </div>
          ) : config.isError ? (
            <p className='p-4 text-[12px] text-red-600 dark:text-red-400'>{errMsg(config.error)}</p>
          ) : (
            <>
              <ListGroup label='Named tools' count={tools.length}>
                {tools.length === 0 && sel?.kind !== 'new' && (
                  <p className='px-3 pb-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
                    None yet. Expose a saved query or a flow so an assistant can call it by name.
                  </p>
                )}
                {sel?.kind === 'new' && (
                  <ListRow active title='New tool' sub='Not saved yet' onClick={() => {}} />
                )}
                {tools.map((t, i) => (
                  <ListRow
                    key={t.name}
                    active={sel?.kind === 'named' && sel.index === i}
                    title={t.name}
                    mono
                    sub={`${t.kind === 'flow' ? 'Flow' : 'Saved query'} · ${t.access === 'admin' ? 'Administrators' : 'Everyone signed in'}`}
                    off={!t.enabled}
                    onClick={() => setSel({ kind: 'named', index: i })}
                  />
                ))}
              </ListGroup>
              <ListGroup label='From extensions' count={ext.length}>
                {ext.length === 0 && (
                  <p className='px-3 pb-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
                    No extension registers MCP tools. An extension adds one with
                    ctx.mcp.registerTool.
                  </p>
                )}
                {ext.map((t) => (
                  <ListRow
                    key={t.name}
                    active={sel?.kind === 'ext' && sel.name === t.name}
                    title={t.name}
                    mono
                    sub={t.extension}
                    off={!t.enabled}
                    onClick={() => setSel({ kind: 'ext', name: t.name })}
                  />
                ))}
              </ListGroup>
              <p className='px-3 py-3 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                {config.data?.builtin_names.length ?? 0} built-in tools are always offered as well.
              </p>
            </>
          )}
        </aside>
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {current ? (
            <ToolEditor
              key={sel?.kind === 'named' ? `n${sel.index}` : 'new'}
              initial={current}
              isNew={sel?.kind === 'new'}
              taken={
                new Set([
                  ...(config.data?.builtin_names ?? []),
                  ...ext.map((t) => t.name),
                  ...tools
                    .filter((_, i) => !(sel?.kind === 'named' && sel.index === i))
                    .map((t) => t.name)
                ])
              }
              queries={queries.data ?? []}
              flows={flows.data ?? []}
              saving={save.isPending}
              onCancel={() => setSel(null)}
              onSave={(t) => {
                const next =
                  sel?.kind === 'named'
                    ? tools.map((x, i) => (i === sel.index ? t : x))
                    : [...tools, t]
                save.mutate(next, {
                  onSuccess: () => {
                    toast.success(`Saved ${t.name}`)
                    setSel({ kind: 'named', index: next.findIndex((x) => x.name === t.name) })
                  },
                  onError: (e) => toast.error(errMsg(e))
                })
              }}
              onDelete={
                sel?.kind === 'named'
                  ? () =>
                      save.mutate(
                        tools.filter((_, i) => i !== sel.index),
                        {
                          onSuccess: () => {
                            toast.success('Tool removed')
                            setSel(null)
                          },
                          onError: (e) => toast.error(errMsg(e))
                        }
                      )
                  : undefined
              }
            />
          ) : extSel ? (
            <ExtensionToolDetail tool={extSel} />
          ) : (
            <NothingSelected />
          )}
        </div>
      </div>
    </div>
  )
}

function ListGroup({
  label,
  count,
  children
}: {
  label: string
  count: number
  children: React.ReactNode
}) {
  return (
    <section className='pt-3'>
      <h2 className='flex items-center justify-between px-3 pb-1.5 text-[12px] font-medium text-slate-500 dark:text-muted-foreground'>
        {label}
        <span className='tabular-nums'>{count}</span>
      </h2>
      <ul className='space-y-px px-1.5'>{children}</ul>
    </section>
  )
}

function ListRow({
  title,
  sub,
  active,
  mono,
  off,
  onClick
}: {
  title: string
  sub: string
  active?: boolean
  mono?: boolean
  off?: boolean
  onClick: () => void
}) {
  return (
    <li>
      <button
        type='button'
        onClick={onClick}
        className={cn(
          'flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
          active ? 'bg-nvr-cyan/10' : 'hover:bg-muted'
        )}
      >
        <span className='flex w-full items-center gap-1.5'>
          <span
            className={cn(
              'truncate text-[12.5px] text-slate-900 dark:text-foreground',
              mono && 'font-mono text-[12px]'
            )}
          >
            {title}
          </span>
          {off && (
            <span className='shrink-0 rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-500 dark:bg-muted dark:text-muted-foreground'>
              Off
            </span>
          )}
        </span>
        <span className='truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {sub}
        </span>
      </button>
    </li>
  )
}

function NothingSelected() {
  return (
    <div className='flex h-full flex-col items-start justify-center gap-2 px-10 py-16'>
      <Hammer className='h-6 w-6 text-slate-400' />
      <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
        Give assistants your own tools
      </h2>
      <p className='max-w-[60ch] text-[13px] text-slate-600 dark:text-muted-foreground'>
        A named tool turns a saved query or a flow into a tool an assistant can find and call by
        name, with the query's parameters as its inputs. It runs as the person asking, so the
        query's own access level and user scopes still decide what comes back. Pick a tool on the
        left, or start a new one.
      </p>
    </div>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className='grid gap-1.5 border-t border-slate-100 py-4 first:border-t-0 first:pt-0 md:grid-cols-[200px_1fr] md:gap-6 dark:border-border'>
      <div>
        <Label className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
          {label}
        </Label>
        {hint && (
          <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>{hint}</p>
        )}
      </div>
      <div className='min-w-0'>{children}</div>
    </div>
  )
}

function RefCombobox({
  value,
  onChange,
  options,
  placeholder,
  empty
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string; sub?: string }>
  placeholder: string
  empty: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-full max-w-[420px] justify-between px-2 text-[12.5px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : value || placeholder}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[360px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              {empty}
            </CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={`${o.label} ${o.value}`}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3 w-3 shrink-0',
                      value === o.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className='min-w-0 flex-1 truncate'>{o.label}</span>
                  {o.sub && (
                    <span className='ml-2 shrink-0 font-mono text-[11px] text-muted-foreground'>
                      {o.sub}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ToolEditor({
  initial,
  isNew,
  taken,
  queries,
  flows,
  saving,
  onSave,
  onCancel,
  onDelete
}: {
  initial: NamedTool
  isNew: boolean
  taken: Set<string>
  queries: QueryRow[]
  flows: FlowRow[]
  saving: boolean
  onSave: (t: NamedTool) => void
  onCancel: () => void
  onDelete?: () => void
}) {
  const [d, setD] = useState<NamedTool>(initial)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = (patch: Partial<NamedTool>) => setD((x) => ({ ...x, ...patch }))
  const query = d.kind === 'custom_query' ? queries.find((q) => q.slug === d.ref) : undefined
  const flow =
    d.kind === 'flow' ? flows.find((f) => f.id.toLowerCase() === d.ref.toLowerCase()) : undefined
  const inputs: ToolParam[] =
    d.kind === 'flow'
      ? (d.params ?? [])
      : queryParams(query).map((p) => ({
          name: String(p.name),
          type: (PARAM_TYPES.some((t) => t.value === p.type) ? p.type : 'string') as ParamType,
          required: p.required === true && (p.default === undefined || p.default === '')
        }))

  const nameError = !d.name
    ? null
    : !NAME_RE.test(d.name)
      ? 'Use 3–48 lower-case letters, digits or _, starting with a letter.'
      : taken.has(d.name)
        ? 'Another tool already has this name.'
        : null
  const problem =
    !d.name || nameError
      ? 'Give the tool a valid name.'
      : !d.description.trim()
        ? 'Describe what it does — the assistant reads this to decide when to call it.'
        : !d.ref
          ? `Pick the ${d.kind === 'flow' ? 'flow' : 'saved query'} it runs.`
          : (d.params ?? []).some((p) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(p.name))
            ? 'Every input needs a name (letters, digits, _).'
            : null
  const queryAdminOnly = d.kind === 'custom_query' && query?.access === 'admin'
  const flowOff = d.kind === 'flow' && flow && flow.status !== 'active'
  const queryOff = d.kind === 'custom_query' && query && !query.enabled
  const dirty = JSON.stringify(d) !== JSON.stringify(initial)

  return (
    <div className='px-6 py-5'>
      <div className='mb-4 flex items-center gap-3'>
        <h2 className='min-w-0 flex-1 truncate text-[15px] font-semibold text-slate-900 dark:text-foreground'>
          {isNew ? 'New tool' : <span className='font-mono'>{initial.name}</span>}
        </h2>
        {onDelete &&
          (confirmDelete ? (
            <span className='flex items-center gap-1.5 text-[12px]'>
              <span className='text-slate-600 dark:text-muted-foreground'>
                Remove this tool from every assistant?
              </span>
              <Button size='sm' variant='destructive' className='h-7' onClick={onDelete}>
                Remove
              </Button>
              <Button
                size='sm'
                variant='ghost'
                className='h-7'
                onClick={() => setConfirmDelete(false)}
              >
                Keep
              </Button>
            </span>
          ) : (
            <Button
              size='sm'
              variant='ghost'
              className='h-7 text-slate-500 hover:text-red-600'
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className='mr-1 h-3.5 w-3.5' /> Remove
            </Button>
          ))}
      </div>

      <div className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
        <Row label='Name' hint='What the assistant calls. Lower-case, digits and _.'>
          <Input
            value={d.name}
            onChange={(e) => set({ name: e.target.value.trim().toLowerCase() })}
            placeholder='open_spend_by_zone'
            className='h-8 max-w-[420px] font-mono text-[12px]'
            aria-invalid={!!nameError}
          />
          {nameError && (
            <p className='mt-1 text-[11.5px] text-red-600 dark:text-red-400'>{nameError}</p>
          )}
        </Row>
        <Row
          label='What it does'
          hint='Plain words. Say when to use it — the assistant picks tools by this text.'
        >
          <Textarea
            value={d.description}
            onChange={(e) => set({ description: e.target.value })}
            rows={3}
            placeholder='Open spend per zone for a budget year. Use when someone asks how much is left to spend.'
            className='max-w-[640px] text-[12.5px]'
          />
        </Row>
        <Row label='Runs'>
          <div className='flex max-w-[420px] flex-col gap-2'>
            <div className='inline-flex w-fit rounded-md border border-slate-200 p-0.5 dark:border-border'>
              {(
                [
                  ['custom_query', 'A saved query'],
                  ['flow', 'A flow']
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type='button'
                  onClick={() =>
                    set({ kind: k, ref: '', params: k === 'flow' ? (d.params ?? []) : undefined })
                  }
                  className={cn(
                    'rounded px-2.5 py-1 text-[12px] font-medium transition-colors',
                    d.kind === k
                      ? 'bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
                      : 'text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {d.kind === 'custom_query' ? (
              <RefCombobox
                value={d.ref}
                onChange={(ref) => set({ ref })}
                placeholder='Pick a saved query…'
                empty='No saved queries'
                options={queries.map((q) => ({
                  value: q.slug,
                  label: q.name,
                  sub: q.slug
                }))}
              />
            ) : (
              <RefCombobox
                value={d.ref}
                onChange={(ref) => set({ ref })}
                placeholder='Pick a flow…'
                empty='No flows'
                options={flows.map((f) => ({
                  value: f.id,
                  label: f.name,
                  sub: f.status === 'active' ? undefined : f.status
                }))}
              />
            )}
            {queryOff && (
              <p className='text-[11.5px] text-amber-700 dark:text-amber-300'>
                This query is turned off, so the tool is hidden until it is turned on again.
              </p>
            )}
            {flowOff && (
              <p className='text-[11.5px] text-amber-700 dark:text-amber-300'>
                This flow is not active, so the tool is hidden until the flow is activated.
              </p>
            )}
          </div>
        </Row>
        {d.kind === 'flow' && (
          <Row
            label='Inputs'
            hint='What the assistant passes in. They arrive in the flow’s payload by name.'
          >
            <FlowParams params={d.params ?? []} onChange={(params) => set({ params })} />
          </Row>
        )}
        <Row
          label='Who can call it'
          hint={
            queryAdminOnly
              ? 'This query is for administrators only, so the tool is too.'
              : d.kind === 'flow'
                ? 'The flow runs with the caller as the person who triggered it.'
                : 'The query’s own access level and user scopes still apply.'
          }
        >
          <SimpleSelect
            value={d.access}
            onChange={(v) => set({ access: v as NamedTool['access'] })}
            ariaLabel='Who can call it'
            className='h-8 w-[240px] text-[12.5px]'
            disabled={queryAdminOnly}
            options={[
              { value: 'admin', label: 'Administrators' },
              { value: 'authenticated', label: 'Everyone signed in' }
            ]}
          />
        </Row>
        <Row
          label='Only reads'
          hint='Clients that ask before a change skip the question for a read. Leave off if the query calls a procedure that writes.'
        >
          <Switch
            checked={d.read_only}
            onCheckedChange={(v) => set({ read_only: v })}
            aria-label='Only reads'
          />
        </Row>
        <Row label='Offered' hint='Off keeps the tool here without offering it to anyone.'>
          <Switch
            checked={d.enabled}
            onCheckedChange={(v) => set({ enabled: v })}
            aria-label='Offered'
          />
        </Row>
      </div>

      <ToolPreview name={d.name} description={d.description} inputs={inputs} kind={d.kind} />

      <div className='mt-4 flex items-center gap-2'>
        <Button
          size='sm'
          className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={!!problem || saving || (!isNew && !dirty)}
          onClick={() =>
            onSave({
              ...d,
              description: d.description.trim(),
              ...(d.kind === 'custom_query' ? { params: undefined } : {})
            })
          }
        >
          {saving ? 'Saving…' : isNew ? 'Add tool' : 'Save changes'}
        </Button>
        <Button size='sm' variant='ghost' className='h-8' onClick={onCancel}>
          {isNew ? 'Cancel' : 'Close'}
        </Button>
        {problem && (dirty || isNew) && (
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>{problem}</span>
        )}
      </div>
    </div>
  )
}

function FlowParams({
  params,
  onChange
}: {
  params: ToolParam[]
  onChange: (p: ToolParam[]) => void
}) {
  const update = (i: number, patch: Partial<ToolParam>) =>
    onChange(params.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  return (
    <div className='max-w-[720px] space-y-2'>
      {params.length === 0 && (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          No inputs — the flow runs with an empty payload.
        </p>
      )}
      {params.map((p, i) => (
        <div key={i} className='flex flex-wrap items-center gap-2'>
          <Input
            value={p.name}
            onChange={(e) => update(i, { name: e.target.value.trim() })}
            placeholder='name'
            aria-label='Input name'
            className='h-8 w-[160px] font-mono text-[12px]'
          />
          <SimpleSelect
            value={p.type}
            onChange={(v) => update(i, { type: v as ParamType })}
            ariaLabel='Input type'
            className='h-8 w-[140px] text-[12px]'
            options={PARAM_TYPES}
          />
          <Input
            value={p.description ?? ''}
            onChange={(e) => update(i, { description: e.target.value })}
            placeholder='What it means (optional)'
            aria-label='Input description'
            className='h-8 min-w-[180px] flex-1 text-[12px]'
          />
          <span className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
            <Switch
              checked={p.required === true}
              onCheckedChange={(v) => update(i, { required: v })}
              aria-label='Required'
              className='h-5 w-9 [&>span]:h-4 [&>span]:w-4 [&>span]:data-[state=checked]:translate-x-4'
            />
            Required
          </span>
          <Button
            size='sm'
            variant='ghost'
            className='h-7 w-7 p-0 text-slate-400 hover:text-red-600'
            aria-label='Remove input'
            onClick={() => onChange(params.filter((_, j) => j !== i))}
          >
            <X className='h-3.5 w-3.5' />
          </Button>
        </div>
      ))}
      <Button
        size='sm'
        variant='outline'
        className='h-7 text-[12px]'
        disabled={params.length >= 30}
        onClick={() => onChange([...params, { name: '', type: 'string' }])}
      >
        <Plus className='mr-1 h-3 w-3' /> Add input
      </Button>
    </div>
  )
}

function ToolPreview({
  name,
  description,
  inputs,
  kind
}: {
  name: string
  description: string
  inputs: ToolParam[]
  kind: NamedTool['kind']
}) {
  const typeLabel = useMemo(() => new Map(PARAM_TYPES.map((t) => [t.value, t.label])), [])
  return (
    <section className='mt-4 rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
      <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
        What the assistant sees
      </h3>
      <p className='mt-2 font-mono text-[12px] text-slate-900 dark:text-foreground'>
        {name || 'tool_name'}
      </p>
      <p className='mt-1 max-w-[70ch] text-[12.5px] text-slate-600 dark:text-muted-foreground'>
        {description.trim() || 'No description yet.'}
      </p>
      {inputs.length > 0 ? (
        <ul className='mt-3 divide-y divide-slate-100 border-t border-slate-100 dark:divide-border dark:border-border'>
          {inputs.map((p) => (
            <li key={p.name} className='flex items-baseline gap-3 py-1.5 text-[12px]'>
              <span className='w-[180px] shrink-0 truncate font-mono text-slate-900 dark:text-foreground'>
                {p.name || '—'}
              </span>
              <span className='w-[110px] shrink-0 text-slate-500 dark:text-muted-foreground'>
                {typeLabel.get(p.type) ?? p.type}
                {p.required ? ', required' : ''}
              </span>
              <span className='min-w-0 truncate text-slate-500 dark:text-muted-foreground'>
                {p.description ?? ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className='mt-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          {kind === 'custom_query' ? 'The query takes no parameters.' : 'No inputs.'}
        </p>
      )}
    </section>
  )
}

function ExtensionToolDetail({ tool }: { tool: ExtTool }) {
  return (
    <div className='px-6 py-5'>
      <div className='mb-4 flex items-center gap-2'>
        <Puzzle className='h-4 w-4 text-slate-400' />
        <h2 className='truncate font-mono text-[15px] font-semibold text-slate-900 dark:text-foreground'>
          {tool.name}
        </h2>
        {!tool.enabled && (
          <span className='rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-muted dark:text-muted-foreground'>
            Extension off
          </span>
        )}
      </div>
      <p className='mb-4 max-w-[70ch] text-[13px] text-slate-700 dark:text-foreground/80'>
        {tool.description}
      </p>
      <div className='grid max-w-[720px] grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 md:grid-cols-4 dark:border-border dark:bg-border'>
        <Meta label='Extension' value={<span className='font-mono'>{tool.extension}</span>} />
        <Meta label='Only reads' value={tool.read_only ? 'Yes' : 'No'} />
        <Meta label='Calls since start' value={tool.stats.calls.toLocaleString()} />
        <Meta
          label='Last used'
          value={tool.stats.last_used_at ? formatRelative(tool.stats.last_used_at) : 'Never'}
        />
      </div>
      {tool.stats.errors > 0 && (
        <p className='mt-3 max-w-[70ch] text-[12px] text-red-600 dark:text-red-400'>
          {tool.stats.errors} failed call{tool.stats.errors === 1 ? '' : 's'} since start
          {tool.stats.last_error ? ` — last: ${tool.stats.last_error}` : ''}
        </p>
      )}
      <p className='mt-4 max-w-[70ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
        Registered by the extension, so it is changed in the extension's code. It runs as the person
        calling it; turning the extension off removes it from every assistant.
      </p>
    </div>
  )
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className='bg-white px-3 py-2 dark:bg-card'>
      <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</p>
      <p className='mt-0.5 truncate text-[13px] text-slate-900 dark:text-foreground'>{value}</p>
    </div>
  )
}
