import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronsUpDown, KeyRound, Loader2, Plug } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigation, useNivaroClient } from '../context'
import { del, get, patch } from '../lib/commands'
import { userErrorMessage } from '../lib/safe-error'
import { cn, formatDate, formatNumber, formatRelative } from '../lib/utils'
import { AgentBadge } from './AgentBadge'
import { McpKitsPanel, McpScopeSheet, ScopeBadge } from './McpConnectionScope'
import {
  CallFigures,
  CallsSparkline,
  KindPill,
  type McpConnection,
  type McpConnectionsAnswer,
  mcpConnectionsKey
} from './profile/AgentsPanel'
import { ConnectionRollback } from './profile/ConnectionRollback'
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
import { Skeleton } from './ui/skeleton'

/**
 * MCP connections across everyone (#2466 admin view, #2469 per-connection limit, #2497 idle
 * review): every AI assistant connected to this instance, its last 14 days of tool calls, the
 * idle review's state, a per-connection tool-call limit, and disconnect. Settings for the idle
 * review and the default limit sit at the top. Reads /api/mcp-connections (administrators).
 * #3205 / #3214: each connection's limits (tools, collections, actions, kit) with an editor, and
 * a Kits tab for the tool kits people pick when they connect an assistant.
 */

export type McpAdminTab = 'all' | 'idle' | 'kits'

interface IdleRow extends McpConnection {
  next_step: 'none' | 'clear' | 'flag' | 'notice' | 'revoke'
}

const NEXT_STEP: Record<IdleRow['next_step'], string> = {
  none: 'Waiting',
  clear: 'In use again',
  flag: 'Owner told next run',
  notice: 'Notice next run',
  revoke: 'Disconnects next run'
}

const inputCls =
  'h-8 w-20 rounded-md border border-slate-200 bg-white px-2 text-[12.5px] tabular-nums text-slate-800 outline-none transition-colors focus:border-nvr-cyan focus-visible:ring-2 focus-visible:ring-nvr-cyan/25 dark:border-border dark:bg-background dark:text-slate-100'

function SettingsStrip({
  settings,
  onSaved
}: {
  settings: McpConnectionsAnswer['settings']
  onSaved: () => void
}) {
  const client = useNivaroClient()
  const [d, setD] = useState({
    idle_flag_days: String(settings.idle_flag_days),
    idle_revoke_days: String(settings.idle_revoke_days),
    rate_limit_per_minute: String(settings.rate_limit_per_minute)
  })
  useEffect(() => {
    setD({
      idle_flag_days: String(settings.idle_flag_days),
      idle_revoke_days: String(settings.idle_revoke_days),
      rate_limit_per_minute: String(settings.rate_limit_per_minute)
    })
  }, [settings.idle_flag_days, settings.idle_revoke_days, settings.rate_limit_per_minute])
  const dirty =
    Number(d.idle_flag_days) !== settings.idle_flag_days ||
    Number(d.idle_revoke_days) !== settings.idle_revoke_days ||
    Number(d.rate_limit_per_minute) !== settings.rate_limit_per_minute
  const save = useMutation({
    mutationFn: () =>
      client.request(
        patch('/mcp-connections/settings', {
          idle_flag_days: Number(d.idle_flag_days),
          idle_revoke_days: Number(d.idle_revoke_days),
          rate_limit_per_minute: Number(d.rate_limit_per_minute)
        })
      ),
    onSuccess: onSaved
  })
  const field = (key: keyof typeof d, label: string, unit: string) => (
    <label className='flex shrink-0 items-center gap-2 whitespace-nowrap text-[12.5px] text-slate-600 dark:text-slate-300'>
      {label}
      <input
        inputMode='numeric'
        value={d[key]}
        onChange={(e) => setD({ ...d, [key]: e.target.value.replace(/[^0-9]/g, '') })}
        className={inputCls}
        aria-label={label}
      />
      <span className='text-slate-500 dark:text-slate-400'>{unit}</span>
    </label>
  )
  return (
    <section className='rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
      <div className='flex flex-wrap items-center gap-x-6 gap-y-3'>
        {field('idle_flag_days', 'Tell the owner after', 'days unused')}
        {field('idle_revoke_days', 'Disconnect after', 'days unused')}
        {field('rate_limit_per_minute', 'Tool calls per connection', 'a minute (0 = no limit)')}
        <button
          type='button'
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
          className='ml-auto inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3.5 text-[12.5px] font-medium text-white transition-colors hover:bg-nvr-cyan/90 disabled:opacity-40'
        >
          {save.isPending ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <Check className='h-3.5 w-3.5' />
          )}
          Save
        </button>
      </div>
      <p className='mt-2 text-[11.5px] text-slate-500 dark:text-slate-400'>
        Signed-in (OAuth) connections only: the owner is told once, warned seven days before the
        disconnect, then disconnected. API keys keep their own expiry.
        {save.isError && (
          <span className='ml-1 text-red-600 dark:text-red-400'>
            {userErrorMessage(save.error, 'Could not save')}
          </span>
        )}
      </p>
    </section>
  )
}

interface McpFullSettings {
  agent_label_mode: 'app' | 'fixed'
  agent_label: string
}

/**
 * The badge records show beside an agent's edits and comments (#3213): "via <app>" (the
 * connected app's own name) or one fixed label for every assistant.
 */
function BadgeSetting() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['nvr-mcp-connections', 'settings'],
    queryFn: () =>
      client
        .request(get<{ data: McpFullSettings }>('/mcp-connections/settings'))
        .then((r) => r.data)
  })
  const [mode, setMode] = useState<'app' | 'fixed'>('app')
  const [label, setLabel] = useState('via assistant')
  useEffect(() => {
    if (!q.data) return
    setMode(q.data.agent_label_mode ?? 'app')
    setLabel(q.data.agent_label ?? 'via assistant')
  }, [q.data])
  const dirty =
    !!q.data &&
    (mode !== (q.data.agent_label_mode ?? 'app') ||
      label.trim() !== (q.data.agent_label ?? 'via assistant'))
  const save = useMutation({
    mutationFn: () =>
      client.request(
        patch('/mcp-connections/settings', { agent_label_mode: mode, agent_label: label.trim() })
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nvr-mcp-connections'] })
  })
  if (!q.data) return null
  const example = mode === 'fixed' ? label.trim() || 'via assistant' : 'via Claude'
  return (
    <section
      className='rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'
      data-nvr-mcp-badge-setting
    >
      <div className='flex flex-wrap items-center gap-x-5 gap-y-3'>
        <span className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>
          Badge on agents’ changes
        </span>
        <div className='flex gap-1 rounded-md bg-slate-100 p-0.5 dark:bg-muted'>
          {(
            [
              ['app', 'Name the app'],
              ['fixed', 'One label']
            ] as const
          ).map(([v, text]) => (
            <button
              key={v}
              type='button'
              aria-pressed={mode === v}
              onClick={() => setMode(v)}
              className={cn(
                'h-7 rounded px-3 text-[12.5px] font-medium transition-colors',
                mode === v
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-white'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
              )}
            >
              {text}
            </button>
          ))}
        </div>
        <label className='flex min-w-0 items-center gap-2 text-[12.5px] text-slate-600 dark:text-slate-300'>
          {mode === 'fixed' ? 'Label' : 'When the app has no name'}
          <input
            value={label}
            maxLength={40}
            onChange={(e) => setLabel(e.target.value)}
            className={cn(inputCls, 'w-40')}
            aria-label='Badge label'
          />
        </label>
        <span className='inline-flex items-center gap-1.5 text-[12px] text-slate-500 dark:text-slate-400'>
          Shows as <AgentBadge label={example} />
        </span>
        <button
          type='button'
          disabled={!dirty || !label.trim() || save.isPending}
          onClick={() => save.mutate()}
          className='ml-auto inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3.5 text-[12.5px] font-medium text-white transition-colors hover:bg-nvr-cyan/90 disabled:opacity-40'
        >
          {save.isPending ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <Check className='h-3.5 w-3.5' />
          )}
          Save
        </button>
      </div>
      <p className='mt-2 text-[11.5px] text-slate-500 dark:text-slate-400'>
        Edits and comments an assistant makes through MCP carry this badge in the record’s history,
        comments and the activity log. Changing it relabels earlier changes too.
        {save.isError && (
          <span className='ml-1 text-red-600 dark:text-red-400'>
            {userErrorMessage(save.error, 'Could not save')}
          </span>
        )}
      </p>
    </section>
  )
}

function LimitCell({ c, onSaved }: { c: McpConnection; onSaved: () => void }) {
  const client = useNivaroClient()
  const [v, setV] = useState(c.rate_limit_custom ? String(c.rate_limit_per_minute) : '')
  const save = useMutation({
    mutationFn: (value: number | null) =>
      client.request(patch(`/mcp-connections/${c.conn}/limit`, { rate_limit_per_minute: value })),
    onSuccess: onSaved
  })
  const commit = () => {
    const next = v.trim() === '' ? null : Number(v)
    const cur = c.rate_limit_custom ? c.rate_limit_per_minute : null
    if (next !== cur) save.mutate(next)
  }
  return (
    <span className='inline-flex items-center gap-1.5'>
      <input
        inputMode='numeric'
        value={v}
        placeholder={String(c.rate_limit_per_minute)}
        onChange={(e) => setV(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        aria-label={`Tool calls a minute for ${c.name}`}
        aria-invalid={save.isError || undefined}
        data-tip={
          save.isError
            ? userErrorMessage(save.error, 'Could not save the limit')
            : 'Blank = the default limit'
        }
        className={cn(
          inputCls,
          'h-7 w-16',
          save.isError && 'border-red-400 dark:border-red-500/60'
        )}
      />
      {save.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin text-slate-400' />}
    </span>
  )
}

function ScopeCell({ c }: { c: McpConnection }) {
  const [open, setOpen] = useState(false)
  if (c.scope === undefined) return <span className='text-slate-400'>—</span>
  return (
    <span className='flex min-w-0 items-center gap-1.5'>
      <span className='min-w-0 max-w-[220px]'>
        <ScopeBadge scope={c.scope ?? null} />
      </span>
      {c.scope_editable && (
        <>
          <button
            type='button'
            onClick={() => setOpen(true)}
            aria-label={`Change the limits of ${c.name}`}
            className='h-6 shrink-0 rounded px-1.5 text-[11.5px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
          >
            {c.scope ? 'Edit' : 'Limit'}
          </button>
          <McpScopeSheet
            open={open}
            onClose={() => setOpen(false)}
            conn={c.conn}
            name={c.name}
            who={c.user_name}
            scope={c.scope ?? null}
            mode='admin'
          />
        </>
      )}
    </span>
  )
}

/** Limit an API key before it has made an MCP call (it is not in the list until then). */
function LimitKeyButton({ listed }: { listed: Set<string> }) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<{ id: number; name: string } | null>(null)
  const keys = useQuery({
    queryKey: ['nvr-mcp-api-keys'],
    queryFn: () =>
      client
        .request(
          get<{ data: Array<{ id: number; name: string; is_active?: boolean | number }> }>(
            '/api-keys'
          )
        )
        .then((r) => (r.data ?? []).filter((k) => k.is_active === true || k.is_active === 1)),
    enabled: open,
    staleTime: 30_000
  })
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] font-medium text-slate-700 transition-colors hover:bg-muted dark:border-border dark:bg-card dark:text-slate-200'
          >
            <KeyRound className='h-3.5 w-3.5' /> Limit an API key
            <ChevronsUpDown className='h-3 w-3 opacity-60' />
          </button>
        </PopoverTrigger>
        <PopoverContent align='end' className='w-72 p-0'>
          <Command>
            <CommandInput placeholder='Find a key' />
            <CommandList>
              <CommandEmpty>{keys.isLoading ? 'Loading…' : 'No active key matches.'}</CommandEmpty>
              <CommandGroup>
                {(keys.data ?? [])
                  .filter((k) => !listed.has(`k${k.id}`))
                  .map((k) => (
                    <CommandItem
                      key={k.id}
                      value={`${k.name} ${k.id}`}
                      onSelect={() => {
                        setPicked({ id: k.id, name: k.name })
                        setOpen(false)
                      }}
                    >
                      <span className='truncate'>{k.name}</span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {picked && (
        <McpScopeSheet
          open
          onClose={() => setPicked(null)}
          conn={`k${picked.id}`}
          name={picked.name}
          scope={null}
          mode='admin'
        />
      )}
    </>
  )
}

export function McpConnectionsAdminView({
  tab,
  onTabChange,
  consolePath
}: {
  tab: McpAdminTab
  onTabChange: (t: McpAdminTab) => void
  /** The host's MCP console; when given, a connection's top tools open it to save a test (#3215). */
  consolePath?: string
}) {
  const nav = useNavigation()
  const client = useNivaroClient()
  const qc = useQueryClient()
  const all = useQuery({
    queryKey: mcpConnectionsKey('all'),
    queryFn: () =>
      client.request(get<{ data: McpConnectionsAnswer }>('/mcp-connections')).then((r) => r.data)
  })
  const idle = useQuery({
    queryKey: ['nvr-mcp-connections', 'idle'],
    queryFn: () =>
      client
        .request(
          get<{ data: { settings: McpConnectionsAnswer['settings']; connections: IdleRow[] } }>(
            '/mcp-connections/idle'
          )
        )
        .then((r) => r.data),
    enabled: tab === 'idle'
  })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['nvr-mcp-connections'] })
  const disconnect = useMutation({
    mutationFn: (conn: string) => client.request(del(`/mcp-connections/${conn}`)),
    onSuccess: refresh
  })
  const [q, setQ] = useState('')
  const [rollbackConn, setRollbackConn] = useState<string | null>(null)
  const rows = useMemo(() => {
    const src: McpConnection[] =
      tab === 'idle' ? (idle.data?.connections ?? []) : (all.data?.connections ?? [])
    const needle = q.trim().toLowerCase()
    return needle
      ? src.filter((c) => `${c.name} ${c.user_name ?? ''}`.toLowerCase().includes(needle))
      : src
  }, [tab, all.data, idle.data, q])
  const totals = useMemo(() => {
    const cs = all.data?.connections ?? []
    return {
      n: cs.length,
      calls: cs.reduce((a, c) => a + (c.stats?.calls ?? 0), 0),
      idle: cs.filter((c) => c.idle && c.idle.status !== 'active').length
    }
  }, [all.data])
  const loading = tab === 'idle' ? idle.isLoading : all.isLoading
  const failed = tab === 'idle' ? idle.isError : all.isError

  return (
    <div className='flex flex-col gap-4' data-nvr-mcp-admin>
      {all.data?.settings && tab !== 'kits' && (
        <SettingsStrip settings={all.data.settings} onSaved={refresh} />
      )}
      {tab !== 'kits' && <BadgeSetting />}
      {all.data && !all.data.logged && (
        <p className='flex items-center gap-1.5 text-[12.5px] text-amber-700 dark:text-amber-400'>
          <AlertTriangle className='h-3.5 w-3.5' />
          Tool calls are not recorded on this database yet (migration 480). Connections still show;
          figures appear once it runs.
        </p>
      )}

      <div className='flex flex-wrap items-center gap-3'>
        <div role='tablist' className='flex gap-1 rounded-md bg-slate-100 p-0.5 dark:bg-muted'>
          {(
            [
              ['all', `All connections${totals.n ? ` · ${totals.n}` : ''}`],
              ['idle', `Idle${totals.idle ? ` · ${totals.idle}` : ''}`],
              ['kits', 'Kits']
            ] as Array<[McpAdminTab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type='button'
              role='tab'
              aria-selected={tab === key}
              onClick={() => onTabChange(key)}
              className={cn(
                'h-7 rounded px-3 text-[12.5px] font-medium transition-colors',
                tab === key
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-white'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {tab !== 'kits' && (
          <>
            <span className='text-[12px] text-slate-500 dark:text-slate-400'>
              {formatNumber(totals.calls)} tool calls in the last {all.data?.window_days ?? 14} days
            </span>
            <span className='ml-auto flex flex-wrap items-center gap-2'>
              {tab === 'all' && (
                <LimitKeyButton
                  listed={new Set((all.data?.connections ?? []).map((c) => c.conn))}
                />
              )}
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder='Find an app or person'
                aria-label='Find an app or person'
                className='h-8 w-56 max-w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] outline-none placeholder:text-slate-500 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-100 dark:placeholder:text-slate-400'
              />
            </span>
          </>
        )}
      </div>

      {tab === 'kits' ? (
        <McpKitsPanel />
      ) : (
        <section className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          {loading ? (
            <div className='space-y-2 p-4'>
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className='h-9' />
              ))}
            </div>
          ) : failed ? (
            <p className='p-4 text-[12.5px] text-slate-500 dark:text-slate-400'>
              Connections could not be loaded. Try again in a moment.
            </p>
          ) : rows.length === 0 ? (
            <div className='flex items-start gap-3 p-4'>
              <Plug className='mt-0.5 h-5 w-5 text-slate-400' />
              <p className='max-w-[70ch] text-[12.5px] text-slate-600 dark:text-slate-300'>
                {tab === 'idle'
                  ? 'No connection has gone unused long enough to be flagged.'
                  : q
                    ? 'Nothing matches that search.'
                    : 'Nobody has connected an AI assistant yet. When someone adds Nivaro as a connector and signs in, it appears here.'}
              </p>
            </div>
          ) : (
            <table className='w-full min-w-[1040px] text-left text-[12px]'>
              <thead>
                <tr className='border-b border-slate-200 text-[11px] text-slate-500 dark:border-border dark:text-slate-400'>
                  <th className='px-4 py-2 font-medium'>App</th>
                  <th className='py-2 pr-3 font-medium'>Person</th>
                  <th className='py-2 pr-3 font-medium'>Last used</th>
                  <th className='py-2 pr-3 font-medium'>
                    {tab === 'idle' ? 'Idle review' : 'Last 14 days'}
                  </th>
                  <th className='py-2 pr-3 font-medium'>Top tools</th>
                  <th className='py-2 pr-3 font-medium'>May use</th>
                  <th className='py-2 pr-3 font-medium'>Calls a minute</th>
                  <th className='py-2 pr-4' />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const last = c.stats?.last_call_at ?? c.last_used_at
                  return (
                    <Fragment key={c.conn}>
                      <tr className='border-b border-slate-100 align-middle last:border-0 hover:bg-muted/50 dark:border-border/60'>
                        <td className='px-4 py-2.5'>
                          <div className='flex items-center gap-2'>
                            <span className='font-medium text-slate-800 dark:text-slate-100'>
                              {c.name}
                            </span>
                            <KindPill kind={c.kind} />
                          </div>
                        </td>
                        <td className='py-2.5 pr-3 text-slate-700 dark:text-slate-200'>
                          {c.user_name ?? '—'}
                        </td>
                        <td className='whitespace-nowrap py-2.5 pr-3 text-slate-600 dark:text-slate-300'>
                          {last ? formatRelative(last) : 'Never'}
                        </td>
                        <td className='py-2.5 pr-3'>
                          {tab === 'idle' && c.idle ? (
                            <span className='flex flex-wrap items-center gap-1.5'>
                              <Pill tone={c.idle.status === 'notice' ? 'red' : 'amber'}>
                                {c.idle.idle_days} days unused
                              </Pill>
                              <span className='text-slate-600 dark:text-slate-300'>
                                {NEXT_STEP[(c as IdleRow).next_step]} · disconnects{' '}
                                {formatDate(`${c.idle.revoke_on}T12:00:00Z`, {
                                  month: 'short',
                                  day: 'numeric'
                                })}
                              </span>
                            </span>
                          ) : (
                            <span className='flex items-center gap-3'>
                              {c.stats && <CallsSparkline days={c.stats.days} />}
                              <CallFigures s={c.stats} />
                            </span>
                          )}
                        </td>
                        <td className='py-2.5 pr-3'>
                          <span className='flex flex-wrap gap-1'>
                            {(c.stats?.top_tools ?? []).slice(0, 3).map((t) =>
                              consolePath && t.tool !== 'unknown' ? (
                                <button
                                  key={t.tool}
                                  type='button'
                                  onClick={() =>
                                    nav.navigate(
                                      `${consolePath}?tool=${encodeURIComponent(t.tool)}`
                                    )
                                  }
                                  data-tip={`${formatNumber(t.calls)} calls · open in the console to save a contract test`}
                                  className='rounded bg-slate-100 px-1.5 py-px font-mono text-[11px] text-slate-600 transition-colors hover:bg-slate-200 hover:text-slate-900 dark:bg-muted dark:text-slate-300 dark:hover:bg-border dark:hover:text-white'
                                >
                                  {t.tool}
                                </button>
                              ) : (
                                <span
                                  key={t.tool}
                                  data-tip={`${formatNumber(t.calls)} calls`}
                                  className='rounded bg-slate-100 px-1.5 py-px font-mono text-[11px] text-slate-600 dark:bg-muted dark:text-slate-300'
                                >
                                  {t.tool}
                                </span>
                              )
                            )}
                          </span>
                        </td>
                        <td className='py-2.5 pr-3'>
                          <ScopeCell c={c} />
                        </td>
                        <td className='py-2.5 pr-3'>
                          <LimitCell c={c} onSaved={refresh} />
                        </td>
                        <td className='py-2.5 pr-4 text-right'>
                          <span className='inline-flex items-center justify-end gap-1.5'>
                            <button
                              type='button'
                              onClick={() =>
                                setRollbackConn(rollbackConn === c.conn ? null : c.conn)
                              }
                              aria-expanded={rollbackConn === c.conn}
                              data-tip='Undo what this app changed in a time window'
                              className='h-7 rounded-md px-2 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:text-slate-300 dark:hover:text-white'
                            >
                              Roll back…
                            </button>
                            {c.kind !== 'token' && (c.kind !== 'oauth' || c.created_at) && (
                              <ConfirmButton
                                onConfirm={() => disconnect.mutate(c.conn)}
                                disabled={disconnect.isPending}
                                confirmLabel={
                                  c.kind === 'api_key' ? 'Switch key off?' : 'Disconnect?'
                                }
                                title={
                                  c.kind === 'api_key'
                                    ? `Switch off ${c.name}`
                                    : `Disconnect ${c.name}`
                                }
                                className='h-7 rounded-md border border-slate-200 px-2.5 text-[12px] font-medium text-slate-700 transition-colors hover:border-red-300 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40 disabled:opacity-40 dark:border-border dark:text-slate-200 dark:hover:border-red-500/50 dark:hover:text-red-400'
                                armedClassName='border-red-300 bg-red-50 text-red-700 dark:border-red-500/50 dark:bg-red-500/10 dark:text-red-400'
                              >
                                {c.kind === 'api_key' ? 'Switch off' : 'Disconnect'}
                              </ConfirmButton>
                            )}
                          </span>
                        </td>
                      </tr>
                      {rollbackConn === c.conn && (
                        <tr className='border-b border-slate-100 dark:border-border/60'>
                          <td colSpan={8} className='px-4 pb-3 pt-1'>
                            <ConnectionRollback
                              conn={c.conn}
                              name={c.name}
                              scope='admin'
                              onClose={() => setRollbackConn(null)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>
      )}
      {disconnect.isError && (
        <p className='text-[12px] text-red-600 dark:text-red-400'>
          {userErrorMessage(disconnect.error, 'Could not disconnect')}
        </p>
      )}
    </div>
  )
}
