import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronsUpDown,
  Loader2,
  Lock,
  Plus,
  Search,
  SlidersHorizontal,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../context'
import { del, get, post, put } from '../lib/commands'
import { userErrorMessage } from '../lib/safe-error'
import { cn, formatNumber } from '../lib/utils'
import { ConfirmButton, Pill } from './profile/primitives'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from './ui/command'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { SimpleSelect } from './ui/SimpleSelect'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet'
import { Skeleton } from './ui/skeleton'
import { Switch } from './ui/switch'

/**
 * Per-connection limits (#3205) and tool kits (#3214) for an MCP connection: which tools an
 * assistant may use, which collections it may touch and what it may do there. Limits only ever
 * take away from what the person can do. The person edits their own signed-in connections
 * (/api/mcp-connections/mine/:conn/scope) unless an administrator locked them; administrators
 * edit any connection or API key (/api/mcp-connections/:conn/scope) and may lock it.
 */

export type ScopeAction = 'read' | 'create' | 'update' | 'delete'

export interface McpScopeSummary {
  kit: string | null
  kit_label: string | null
  kit_missing: boolean
  tools: string[] | null
  collections: string[] | null
  actions: ScopeAction[] | null
  own: { tools: string[] | null; collections: string[] | null; actions: ScopeAction[] | null }
  locked: boolean
  note: string | null
  updated_at: string | null
}

export interface McpToolKit {
  key: string
  label: string
  description: string
  tools: string[] | null
  collections: string[] | null
  actions: ScopeAction[] | null
  builtin: boolean
  sort: number
  connections?: number
}

export interface McpCatalogTool {
  name: string
  title: string
  description: string
  group: 'everyday' | 'chat' | 'admin' | 'instance'
  read_only: boolean
}

interface Catalog {
  ready: boolean
  tools: McpCatalogTool[]
  kits: McpToolKit[]
  actions: ScopeAction[]
}

export const mcpCatalogKey = ['nvr-mcp-catalog'] as const

export function useMcpCatalog(enabled = true) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: mcpCatalogKey,
    queryFn: () =>
      client.request(get<{ data: Catalog }>('/mcp-connections/catalog')).then((r) => r.data),
    staleTime: 60_000,
    enabled
  })
}

const ACTION_LABEL: Record<ScopeAction, string> = {
  read: 'Read',
  create: 'Create',
  update: 'Change',
  delete: 'Delete'
}

const GROUP_LABEL: Record<McpCatalogTool['group'], string> = {
  everyday: 'Everyday',
  chat: 'Chat',
  admin: 'Administration',
  instance: 'This instance’s own tools'
}

/** One line for a connection's limits: "Buyer kit · 31 tools · 2 collections · read only". */
export function scopeSummaryText(s: McpScopeSummary | null): string {
  if (!s) return 'Everything the person can do'
  if (s.kit_missing) return 'Its kit was removed — it can use nothing'
  const bits: string[] = []
  if (s.kit) bits.push(`${s.kit_label ?? s.kit} kit`)
  if (s.tools) bits.push(`${formatNumber(s.tools.length)} tool${s.tools.length === 1 ? '' : 's'}`)
  if (s.collections)
    bits.push(
      s.collections.length === 1
        ? s.collections[0]
        : `${formatNumber(s.collections.length)} collections`
    )
  if (s.actions) {
    if (s.actions.length === 1 && s.actions[0] === 'read') bits.push('read only')
    else if (s.actions.length === 0) bits.push('no actions')
    else if (s.actions.length < 4)
      bits.push(
        s.actions
          .map((a) => ACTION_LABEL[a])
          .join(', ')
          .toLowerCase()
      )
  }
  return bits.join(' · ') || 'No limits'
}

/** The compact summary used in connection lists, with a lock when an administrator set it. */
export function ScopeBadge({ scope }: { scope: McpScopeSummary | null }) {
  return (
    <span className='inline-flex min-w-0 items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
      {scope?.locked && (
        <Lock
          className='h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500'
          aria-label='Set by an administrator'
        />
      )}
      <span
        className={cn(
          'truncate',
          !scope && 'text-slate-500 dark:text-slate-400',
          scope?.kit_missing && 'text-red-600 dark:text-red-400'
        )}
        data-tip={scope?.note ?? undefined}
      >
        {scopeSummaryText(scope)}
      </span>
    </span>
  )
}

const sectionTitle = 'text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'
const hint = 'text-[12px] text-slate-500 dark:text-slate-400'

function ToggleRow({
  label,
  help,
  checked,
  onChange,
  disabled
}: {
  label: string
  help: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className='flex items-start justify-between gap-4'>
      <div className='min-w-0'>
        <p className={sectionTitle}>{label}</p>
        <p className={hint}>{help}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} />
    </div>
  )
}

function ToolChecklist({
  tools,
  picked,
  kitTools,
  onChange
}: {
  tools: McpCatalogTool[]
  picked: Set<string>
  kitTools: Set<string> | null
  onChange: (next: Set<string>) => void
}) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const groups = useMemo(() => {
    const out = new Map<McpCatalogTool['group'], McpCatalogTool[]>()
    for (const t of tools) {
      if (needle && !`${t.name} ${t.title}`.toLowerCase().includes(needle)) continue
      out.set(t.group, [...(out.get(t.group) ?? []), t])
    }
    return [...out]
  }, [tools, needle])
  const set = (names: string[], on: boolean) => {
    const next = new Set(picked)
    for (const n of names) {
      if (on && kitTools && !kitTools.has(n)) continue
      if (on) next.add(n)
      else next.delete(n)
    }
    onChange(next)
  }
  return (
    <div className='rounded-md border border-slate-200 dark:border-border'>
      <label className='flex items-center gap-2 border-b border-slate-200 px-2.5 dark:border-border'>
        <Search className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='Find a tool'
          aria-label='Find a tool'
          className='h-8 w-full bg-transparent text-[12.5px] text-slate-800 outline-none placeholder:text-slate-500 dark:text-slate-100 dark:placeholder:text-slate-400'
        />
      </label>
      <div className='max-h-[320px] overflow-y-auto overscroll-contain px-2.5 py-2'>
        {groups.length === 0 && <p className={cn(hint, 'py-2')}>No tool matches.</p>}
        {groups.map(([group, list]) => {
          const names = list.map((t) => t.name)
          return (
            <section key={group} className='pb-2 last:pb-0'>
              <div className='flex items-center justify-between py-1'>
                <span className='text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'>
                  {GROUP_LABEL[group]}
                </span>
                <span className='flex gap-2 text-[11.5px]'>
                  <button
                    type='button'
                    onClick={() => set(names, true)}
                    className='text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
                  >
                    All
                  </button>
                  <button
                    type='button'
                    onClick={() => set(names, false)}
                    className='text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
                  >
                    None
                  </button>
                </span>
              </div>
              <ul className='grid gap-0.5 sm:grid-cols-2'>
                {list.map((t) => {
                  const outside = kitTools ? !kitTools.has(t.name) : false
                  const on = picked.has(t.name) && !outside
                  return (
                    <li key={t.name}>
                      <label
                        className={cn(
                          'flex items-center gap-2 rounded px-1.5 py-1 text-[12px]',
                          outside
                            ? 'cursor-not-allowed opacity-50'
                            : 'cursor-pointer hover:bg-muted'
                        )}
                        data-tip={outside ? 'Not in the chosen kit' : t.description || undefined}
                      >
                        <input
                          type='checkbox'
                          checked={on}
                          disabled={outside}
                          onChange={(e) => set([t.name], e.target.checked)}
                          className='h-3.5 w-3.5 shrink-0 accent-nvr-cyan'
                        />
                        <span className='truncate font-mono text-[11.5px] text-slate-700 dark:text-slate-200'>
                          {t.name}
                        </span>
                        {!t.read_only && (
                          <span className='ml-auto shrink-0 text-[10.5px] text-amber-700 dark:text-amber-400'>
                            writes
                          </span>
                        )}
                      </label>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function CollectionPicker({
  value,
  onChange,
  options
}: {
  value: string[]
  onChange: (v: string[]) => void
  options: Array<{ collection: string; label: string }>
}) {
  const [open, setOpen] = useState(false)
  const label = new Map(options.map((o) => [o.collection, o.label]))
  return (
    <div className='flex flex-wrap items-center gap-1.5'>
      {value.map((c) => (
        <span
          key={c}
          className='inline-flex items-center gap-1 rounded bg-slate-100 py-0.5 pl-2 pr-1 text-[12px] text-slate-700 dark:bg-muted dark:text-slate-200'
        >
          {label.get(c) ?? c}
          <button
            type='button'
            onClick={() => onChange(value.filter((x) => x !== c))}
            aria-label={`Remove ${label.get(c) ?? c}`}
            className='rounded p-0.5 text-slate-500 hover:bg-slate-200 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-border dark:hover:text-white'
          >
            <X className='h-3 w-3' />
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 text-[12px] text-slate-600 hover:border-slate-400 hover:text-slate-900 dark:border-border dark:text-slate-300 dark:hover:text-white'
          >
            <Plus className='h-3.5 w-3.5' /> Add a collection
            <ChevronsUpDown className='h-3 w-3 opacity-60' />
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-64 p-0'>
          <Command>
            <CommandInput placeholder='Find a collection' />
            <CommandList>
              <CommandEmpty>No collection matches.</CommandEmpty>
              <CommandGroup>
                {options
                  .filter((o) => !value.includes(o.collection))
                  .map((o) => (
                    <CommandItem
                      key={o.collection}
                      value={`${o.label} ${o.collection}`}
                      onSelect={() => {
                        onChange([...value, o.collection])
                        setOpen(false)
                      }}
                    >
                      <span className='truncate'>{o.label}</span>
                      <span className='ml-auto truncate font-mono text-[10.5px] text-slate-500 dark:text-slate-400'>
                        {o.collection}
                      </span>
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

interface Draft {
  kit: string
  limitTools: boolean
  tools: Set<string>
  limitCollections: boolean
  collections: string[]
  actions: Set<ScopeAction>
  locked: boolean
  note: string
}

const ALL_ACTIONS: ScopeAction[] = ['read', 'create', 'update', 'delete']

function draftOf(s: McpScopeSummary | null): Draft {
  return {
    kit: s?.kit ?? '',
    limitTools: s?.own.tools != null,
    tools: new Set(s?.own.tools ?? []),
    limitCollections: s?.own.collections != null,
    collections: s?.own.collections ?? [],
    actions: new Set(s?.own.actions ?? ALL_ACTIONS),
    locked: s?.locked ?? false,
    note: s?.note ?? ''
  }
}

/** The editor, in a sheet. `mode` picks the routes: the person's own, or an administrator's. */
export function McpScopeSheet({
  open,
  onClose,
  conn,
  name,
  who,
  scope,
  mode,
  onSaved
}: {
  open: boolean
  onClose: () => void
  conn: string
  name: string
  who?: string
  scope: McpScopeSummary | null
  mode: 'mine' | 'admin'
  onSaved?: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const catalog = useMcpCatalog(open)
  const collections = useQuery({
    queryKey: ['nvr-mcp-scope-collections'],
    queryFn: () =>
      client
        .request(
          get<{
            data: Array<{ collection: string; display_name?: string | null; hidden?: unknown }>
          }>('/collections')
        )
        .then((r) =>
          (r.data ?? [])
            .filter((c) => !/^(nivaro_|directus_)/.test(c.collection))
            .map((c) => ({ collection: c.collection, label: c.display_name || c.collection }))
            .sort((a, b) => a.label.localeCompare(b.label))
        ),
    enabled: open,
    staleTime: 60_000
  })
  const [d, setD] = useState<Draft>(() => draftOf(scope))
  // Start from the stored limits each time the sheet opens — never while it is open, so a
  // background refetch of the list does not throw away what is being edited.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) setD(draftOf(scope))
    wasOpen.current = open
  }, [open, scope])
  const base =
    mode === 'mine' ? `/mcp-connections/mine/${conn}/scope` : `/mcp-connections/${conn}/scope`
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['nvr-mcp-connections'] })
    onSaved?.()
    onClose()
  }
  const save = useMutation({
    mutationFn: () =>
      client.request(
        put(base, {
          kit: d.kit || null,
          tools: d.limitTools ? [...d.tools] : null,
          collections: d.limitCollections ? d.collections : null,
          actions:
            d.actions.size === ALL_ACTIONS.length
              ? null
              : ALL_ACTIONS.filter((a) => d.actions.has(a)),
          ...(mode === 'admin' ? { locked: d.locked, note: d.note.trim() || null } : {})
        })
      ),
    onSuccess: done
  })
  const clear = useMutation({ mutationFn: () => client.request(del(base)), onSuccess: done })

  const kits = catalog.data?.kits ?? []
  const kit = kits.find((k) => k.key === d.kit) ?? null
  const kitTools = kit?.tools ? new Set(kit.tools) : null
  const tools = catalog.data?.tools ?? []
  const effectiveTools = d.limitTools
    ? [...d.tools].filter((t) => !kitTools || kitTools.has(t))
    : (kit?.tools ?? null)
  const noActions = d.actions.size === 0
  const emptyTools = effectiveTools != null && effectiveTools.length === 0
  const notReady = catalog.data && !catalog.data.ready

  const summary = (() => {
    const t =
      effectiveTools == null
        ? 'every tool it is offered'
        : `${effectiveTools.length} tool${effectiveTools.length === 1 ? '' : 's'}`
    const c = d.limitCollections
      ? d.collections.length
        ? `on ${d.collections.length === 1 ? d.collections[0] : `${d.collections.length} collections`}`
        : 'on no collection'
      : 'on every collection the person can reach'
    const a =
      d.actions.size === ALL_ACTIONS.length
        ? ''
        : d.actions.size === 1 && d.actions.has('read')
          ? ', read only'
          : `, only ${ALL_ACTIONS.filter((x) => d.actions.has(x))
              .map((x) => ACTION_LABEL[x].toLowerCase())
              .join(', ')}`
    return `${name} will use ${t} ${c}${a}.`
  })()

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className='flex w-[560px] max-w-[96vw] flex-col gap-0 p-0 sm:max-w-[560px]'>
        <SheetHeader className='shrink-0 border-b border-slate-200 px-5 py-4 text-left dark:border-border'>
          <SheetTitle className='flex items-center gap-2 pr-6 text-[15px]'>
            <SlidersHorizontal className='h-4 w-4 text-nvr-navy dark:text-nvr-cyan' />
            Limits for {name}
          </SheetTitle>
          <SheetDescription className='text-[12.5px]'>
            {who ? `${who} · ` : ''}Limits only take away: it never gets more than{' '}
            {mode === 'mine' ? 'you' : 'its person'} can do.
          </SheetDescription>
        </SheetHeader>

        <div className='flex-1 space-y-6 overflow-y-auto px-5 py-5'>
          {catalog.isLoading ? (
            <div className='space-y-3'>
              <Skeleton className='h-9' />
              <Skeleton className='h-40' />
            </div>
          ) : catalog.isError ? (
            <p className={hint}>The tool list could not be loaded. Try again in a moment.</p>
          ) : notReady ? (
            <p className='text-[12.5px] text-amber-700 dark:text-amber-400'>
              Connection limits need database migration 509. They can be set once it has run.
            </p>
          ) : (
            <>
              <section className='space-y-2'>
                <p className={sectionTitle}>Tool kit</p>
                <SimpleSelect
                  value={d.kit}
                  onChange={(v) => setD({ ...d, kit: v })}
                  ariaLabel='Tool kit'
                  className='h-9 w-full text-[12.5px]'
                  options={[
                    { value: '', label: 'No kit' },
                    ...kits.map((k) => ({ value: k.key, label: k.label }))
                  ]}
                />
                <p className={hint}>
                  {kit
                    ? `${kit.description} ${kit.tools ? `${kit.tools.length} tools.` : ''}`
                    : 'A kit is a ready set of tools for one kind of job. Without one, pick tools below or leave them open.'}
                </p>
              </section>

              <section className='space-y-3'>
                <ToggleRow
                  label='Only these tools'
                  help={
                    kit ? 'Narrow the kit further.' : 'Off = every tool it would otherwise get.'
                  }
                  checked={d.limitTools}
                  onChange={(v) =>
                    setD({
                      ...d,
                      limitTools: v,
                      tools: v && d.tools.size === 0 ? new Set(kit?.tools ?? []) : d.tools
                    })
                  }
                />
                {d.limitTools && (
                  <ToolChecklist
                    tools={tools}
                    picked={d.tools}
                    kitTools={kitTools}
                    onChange={(tools) => setD({ ...d, tools })}
                  />
                )}
              </section>

              <section className='space-y-3'>
                <ToggleRow
                  label='Only these collections'
                  help='Records elsewhere are out of reach, as for an API key limited to collections. Administrator tools are off while this is on.'
                  checked={d.limitCollections}
                  onChange={(v) => setD({ ...d, limitCollections: v })}
                />
                {d.limitCollections &&
                  (collections.isLoading ? (
                    <Skeleton className='h-7 w-48' />
                  ) : (
                    <CollectionPicker
                      value={d.collections}
                      onChange={(c) => setD({ ...d, collections: c })}
                      options={collections.data ?? []}
                    />
                  ))}
              </section>

              <section className='space-y-2'>
                <p className={sectionTitle}>What it may do</p>
                <fieldset className='flex flex-wrap gap-1.5' aria-label='What it may do'>
                  {ALL_ACTIONS.map((a) => {
                    const on = d.actions.has(a)
                    return (
                      <button
                        key={a}
                        type='button'
                        aria-pressed={on}
                        onClick={() => {
                          const next = new Set(d.actions)
                          if (on) next.delete(a)
                          else next.add(a)
                          setD({ ...d, actions: next })
                        }}
                        className={cn(
                          'inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[12px] font-medium transition-colors',
                          on
                            ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                            : 'border-slate-200 text-slate-500 hover:text-slate-800 dark:border-border dark:text-slate-400 dark:hover:text-white'
                        )}
                      >
                        {on && <Check className='h-3 w-3' />}
                        {ACTION_LABEL[a]}
                      </button>
                    )
                  })}
                </fieldset>
                <p className={hint}>
                  Held to these on every record it reads or writes, on top of the person’s own
                  access.
                </p>
              </section>

              {mode === 'admin' && (
                <section className='space-y-3 border-t border-slate-100 pt-5 dark:border-border/60'>
                  <ToggleRow
                    label='Lock'
                    help='Only administrators can change or remove these limits. The person still sees them.'
                    checked={d.locked}
                    onChange={(v) => setD({ ...d, locked: v })}
                  />
                  <label className='block space-y-1'>
                    <span className={sectionTitle}>Note</span>
                    <input
                      value={d.note}
                      onChange={(e) => setD({ ...d, note: e.target.value.slice(0, 300) })}
                      placeholder='Why it is limited (the person sees this)'
                      className='h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-500 focus:border-nvr-cyan focus-visible:ring-2 focus-visible:ring-nvr-cyan/25 dark:border-border dark:bg-background dark:text-slate-100 dark:placeholder:text-slate-400'
                    />
                  </label>
                </section>
              )}
            </>
          )}
        </div>

        <footer className='shrink-0 space-y-3 border-t border-slate-200 px-5 py-3 dark:border-border'>
          {!notReady && catalog.data && (
            <p
              className={cn(
                'text-[12px]',
                emptyTools || noActions
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-slate-600 dark:text-slate-300'
              )}
            >
              {emptyTools
                ? `${name} will have no tools at all.`
                : noActions
                  ? `${name} will not be able to read or change any record.`
                  : summary}
            </p>
          )}
          {(save.isError || clear.isError) && (
            <p className='text-[12px] text-red-600 dark:text-red-400'>
              {((save.error ?? clear.error) as Error)?.message || 'Could not save'}
            </p>
          )}
          <div className='flex items-center gap-2'>
            {scope && (
              <ConfirmButton
                onConfirm={() => clear.mutate()}
                disabled={clear.isPending}
                confirmLabel='Remove limits?'
                title='Remove every limit'
                className='h-8 rounded-md px-2.5 text-[12.5px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
                armedClassName='bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
              >
                Remove limits
              </ConfirmButton>
            )}
            <button
              type='button'
              onClick={onClose}
              className='ml-auto h-8 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-700 transition-colors hover:bg-muted dark:border-border dark:text-slate-200'
            >
              Cancel
            </button>
            <button
              type='button'
              disabled={save.isPending || !catalog.data || !!notReady}
              onClick={() => save.mutate()}
              className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3.5 text-[12.5px] font-medium text-white transition-colors hover:bg-nvr-cyan/90 disabled:opacity-40'
            >
              {save.isPending ? (
                <Loader2 className='h-3.5 w-3.5 animate-spin' />
              ) : (
                <Check className='h-3.5 w-3.5' />
              )}
              Save limits
            </button>
          </div>
        </footer>
      </SheetContent>
    </Sheet>
  )
}

// ── Kits (administrators) ─────────────────────────────────────────────────────

const KEY_RE = /^[a-z][a-z0-9_-]{1,47}$/

function KitEditor({
  initial,
  isNew,
  tools,
  onDone
}: {
  initial: McpToolKit
  isNew: boolean
  tools: McpCatalogTool[]
  onDone: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [k, setK] = useState(initial)
  const picked = new Set(k.tools ?? [])
  const save = useMutation({
    mutationFn: () =>
      client.request(
        isNew ? post('/mcp-connections/kits', k) : put(`/mcp-connections/kits/${k.key}`, k)
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: mcpCatalogKey })
      void qc.invalidateQueries({ queryKey: ['nvr-mcp-kits'] })
      onDone()
    }
  })
  const keyBad = isNew && k.key !== '' && !KEY_RE.test(k.key)
  const field =
    'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-500 focus:border-nvr-cyan focus-visible:ring-2 focus-visible:ring-nvr-cyan/25 dark:border-border dark:bg-background dark:text-slate-100 dark:placeholder:text-slate-400'
  return (
    <div className='space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='grid gap-3 sm:grid-cols-[1fr_200px]'>
        <label className='space-y-1'>
          <span className={sectionTitle}>Name</span>
          <input
            value={k.label}
            onChange={(e) => {
              const label = e.target.value
              setK((x) => ({
                ...x,
                label,
                ...(isNew && (x.key === '' || x.key === slug(x.label)) ? { key: slug(label) } : {})
              }))
            }}
            placeholder='Finance'
            className={field}
          />
        </label>
        <label className='space-y-1'>
          <span className={sectionTitle}>Key</span>
          <input
            value={k.key}
            disabled={!isNew}
            onChange={(e) => setK({ ...k, key: e.target.value.toLowerCase() })}
            aria-invalid={keyBad || undefined}
            className={cn(field, 'font-mono', keyBad && 'border-red-400 dark:border-red-500/60')}
          />
        </label>
      </div>
      <label className='block space-y-1'>
        <span className={sectionTitle}>What it is for</span>
        <input
          value={k.description}
          onChange={(e) => setK({ ...k, description: e.target.value.slice(0, 500) })}
          placeholder='Shown on the consent page when someone connects an assistant'
          className={field}
        />
      </label>
      <div className='space-y-2'>
        <p className={sectionTitle}>
          Tools{' '}
          <span className='font-normal text-slate-500 dark:text-slate-400'>
            · {picked.size} picked
          </span>
        </p>
        <ToolChecklist
          tools={tools}
          picked={picked}
          kitTools={null}
          onChange={(next) => setK({ ...k, tools: [...next] })}
        />
      </div>
      {save.isError && (
        <p className='text-[12px] text-red-600 dark:text-red-400'>
          {userErrorMessage(save.error, 'Could not save the kit')}
        </p>
      )}
      <div className='flex justify-end gap-2'>
        <button
          type='button'
          onClick={onDone}
          className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-700 hover:bg-muted dark:border-border dark:text-slate-200'
        >
          Cancel
        </button>
        <button
          type='button'
          disabled={save.isPending || !k.label.trim() || !KEY_RE.test(k.key) || picked.size === 0}
          onClick={() => save.mutate()}
          className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3.5 text-[12.5px] font-medium text-white hover:bg-nvr-cyan/90 disabled:opacity-40'
        >
          {save.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
          {isNew ? 'Add kit' : 'Save kit'}
        </button>
      </div>
    </div>
  )
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 48)

/** Administrators' kit list: the built-in ones (read only) and their own (add, change, remove). */
export function McpKitsPanel() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const catalog = useMcpCatalog()
  const kits = useQuery({
    queryKey: ['nvr-mcp-kits'],
    queryFn: () =>
      client
        .request(get<{ data: { ready: boolean; kits: McpToolKit[] } }>('/mcp-connections/kits'))
        .then((r) => r.data)
  })
  const [editing, setEditing] = useState<{ kit: McpToolKit; isNew: boolean } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const remove = useMutation({
    mutationFn: (key: string) => client.request(del(`/mcp-connections/kits/${key}`)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: mcpCatalogKey })
      void qc.invalidateQueries({ queryKey: ['nvr-mcp-kits'] })
    }
  })
  const tools = catalog.data?.tools ?? []
  if (kits.isLoading)
    return (
      <div className='space-y-2'>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className='h-14' />
        ))}
      </div>
    )
  if (kits.isError) return <p className={hint}>Kits could not be loaded. Try again in a moment.</p>
  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center gap-3'>
        <p className='max-w-[75ch] text-[12.5px] text-slate-600 dark:text-slate-300'>
          A kit is a ready set of tools for one job. People pick one when they connect an assistant,
          and you can put one on any connection. A kit only takes tools away.
        </p>
        <button
          type='button'
          disabled={!kits.data?.ready || !!editing}
          onClick={() =>
            setEditing({
              isNew: true,
              kit: {
                key: '',
                label: '',
                description: '',
                tools: [],
                collections: null,
                actions: null,
                builtin: false,
                sort: 100
              }
            })
          }
          data-tip={kits.data?.ready ? undefined : 'Needs database migration 509'}
          className='ml-auto inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white hover:bg-nvr-cyan/90 disabled:opacity-40'
        >
          <Plus className='h-3.5 w-3.5' /> New kit
        </button>
      </div>
      {editing && (
        <KitEditor
          key={editing.kit.key || 'new'}
          initial={editing.kit}
          isNew={editing.isNew}
          tools={tools}
          onDone={() => setEditing(null)}
        />
      )}
      <ul className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border/60 dark:border-border dark:bg-card'>
        {(kits.data?.kits ?? []).map((k) => (
          <li key={k.key} className='px-4 py-3'>
            <div className='flex flex-wrap items-center gap-x-3 gap-y-1.5'>
              <span className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
                {k.label}
              </span>
              <Pill tone={k.builtin ? 'neutral' : 'brand'}>{k.builtin ? 'Built in' : 'Yours'}</Pill>
              <span className='text-[12px] text-slate-500 dark:text-slate-400'>
                {k.tools?.length ?? 0} tools
                {k.connections
                  ? ` · ${k.connections} connection${k.connections === 1 ? '' : 's'}`
                  : ''}
              </span>
              <span className='ml-auto flex items-center gap-1'>
                <button
                  type='button'
                  onClick={() => setOpen(open === k.key ? null : k.key)}
                  aria-expanded={open === k.key}
                  className='h-7 rounded-md px-2 text-[12px] font-medium text-slate-600 hover:bg-muted hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
                >
                  {open === k.key ? 'Hide tools' : 'Show tools'}
                </button>
                {!k.builtin && (
                  <>
                    <button
                      type='button'
                      disabled={!!editing}
                      onClick={() => setEditing({ isNew: false, kit: k })}
                      className='h-7 rounded-md px-2 text-[12px] font-medium text-slate-600 hover:bg-muted hover:text-slate-900 disabled:opacity-40 dark:text-slate-300 dark:hover:text-white'
                    >
                      Edit
                    </button>
                    <ConfirmButton
                      onConfirm={() => remove.mutate(k.key)}
                      disabled={remove.isPending}
                      confirmLabel='Remove?'
                      title={`Remove ${k.label}`}
                      className='h-7 rounded-md px-2 text-[12px] font-medium text-slate-600 hover:text-red-600 dark:text-slate-300 dark:hover:text-red-400'
                      armedClassName='bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                    >
                      Remove
                    </ConfirmButton>
                  </>
                )}
              </span>
            </div>
            <p className='mt-1 max-w-[90ch] text-[12px] text-slate-600 dark:text-slate-300'>
              {k.description}
            </p>
            {open === k.key && (
              <div className='mt-2 flex flex-wrap gap-1'>
                {(k.tools ?? []).map((t) => (
                  <span
                    key={t}
                    className='rounded bg-slate-100 px-1.5 py-px font-mono text-[11px] text-slate-600 dark:bg-muted dark:text-slate-300'
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {remove.isError && (
        <p className='text-[12px] text-red-600 dark:text-red-400'>
          {userErrorMessage(remove.error, 'Could not remove the kit')}
        </p>
      )}
    </div>
  )
}
