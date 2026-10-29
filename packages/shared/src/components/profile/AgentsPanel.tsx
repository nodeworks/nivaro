import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Bot,
  ChevronRight,
  KeyRound,
  ListChecks,
  Loader2,
  Plug,
  Undo2
} from 'lucide-react'
import { Fragment, useMemo, useRef, useState } from 'react'
import { useItemNavigation, useNivaroClient } from '../../context'
import { del, get, post } from '../../lib/commands'
import {
  cn,
  formatDate,
  formatDateTime,
  formatFileSize,
  formatNumber,
  formatRelative
} from '../../lib/utils'
import { McpScopeSheet, type McpScopeSummary, ScopeBadge } from '../McpConnectionScope'
import { SimpleSelectXs } from '../ui/SimpleSelect'
import { Skeleton } from '../ui/skeleton'
import { ConfirmButton, EmptyLine, Pill, SectionCard } from './primitives'

/**
 * "What my agents did" (#2498) and the person's connected apps with their tool-call figures
 * (#2466): every AI assistant that signed in to Nivaro's MCP server as this person, what each
 * did over the last 14 days, the writes it left (each with an undo while nothing has changed
 * since), and a disconnect. Reads /api/mcp-connections/mine*.
 */

export type McpConnKind = 'oauth' | 'api_key' | 'token'

export interface McpConnectionStats {
  calls: number
  errors: number
  refused: number
  bytes: number
  last_call_at: string | null
  days: Array<{ day: string; calls: number; errors: number; refused: number }>
  top_tools: Array<{ tool: string; calls: number; errors: number; refused: number }>
}

export interface McpConnection {
  conn: string
  kind: McpConnKind
  name: string
  user_id: string
  user_name?: string
  created_at: string | null
  last_used_at: string | null
  rate_limit_per_minute: number
  rate_limit_custom: boolean
  idle: {
    idle_days: number
    flagged_at: string | null
    notice_at: string | null
    revoke_on: string
    status: 'active' | 'idle' | 'notice'
  } | null
  stats: McpConnectionStats | null
  /** #3205 / #3214 — the connection's limits (null = none) and whether this caller may change them. */
  scope?: McpScopeSummary | null
  scope_editable?: boolean
}

export interface McpConnectionsAnswer {
  logged: boolean
  window_days: number
  settings: { idle_flag_days: number; idle_revoke_days: number; rate_limit_per_minute: number }
  connections: McpConnection[]
}

interface AgentWrite {
  activity_id: number
  action: string
  collection: string | null
  item: string | null
  revision_id: number | null
  undoable: boolean
  undone: boolean
  reason?: string
}

interface AgentCall {
  id: number
  at: string
  conn: string
  app: string
  tool: string | null
  outcome: 'ok' | 'error' | 'refused'
  message: string | null
  bytes: number | null
  ms: number
  record: { collection: string; id: string } | null
  api_calls: number
  writes: AgentWrite[]
}

const KIND_LABEL: Record<McpConnKind, string> = {
  oauth: 'Signed in',
  api_key: 'API key',
  token: 'Personal token'
}

export const mcpConnectionsKey = (scope: 'mine' | 'all') => ['nvr-mcp-connections', scope] as const

// ── Small pieces (shared with the admin view) ────────────────────────────────

/** Fourteen bars: calls a day, the failed share darker. Tooltip per day. */
export function CallsSparkline({ days }: { days: McpConnectionStats['days'] }) {
  const max = Math.max(1, ...days.map((d) => d.calls))
  return (
    <div className='flex h-6 items-end gap-[2px]' aria-hidden>
      {days.map((d) => {
        const h = d.calls ? Math.max(3, Math.round((d.calls / max) * 24)) : 2
        const bad = d.errors + d.refused
        return (
          <span
            key={d.day}
            data-tip={`${formatDate(`${d.day}T12:00:00Z`, { month: 'short', day: 'numeric' })}: ${formatNumber(d.calls)} call${d.calls === 1 ? '' : 's'}${bad ? `, ${bad} not ok` : ''}`}
            className={cn(
              'relative w-[5px] overflow-hidden rounded-[1px]',
              d.calls ? 'bg-nvr-cyan/50 dark:bg-nvr-cyan/40' : 'bg-slate-200 dark:bg-muted'
            )}
            style={{ height: h }}
          >
            {bad > 0 && (
              <span
                className='absolute inset-x-0 bottom-0 bg-amber-500 dark:bg-amber-400'
                style={{ height: `${Math.round((bad / d.calls) * 100)}%` }}
              />
            )}
          </span>
        )
      })}
    </div>
  )
}

export function CallFigures({ s }: { s: McpConnectionStats | null }) {
  if (!s || s.calls === 0)
    return <span className='text-[12px] text-slate-500 dark:text-slate-400'>No tool calls</span>
  return (
    <span className='text-[12px] tabular-nums text-slate-600 dark:text-slate-300'>
      <b className='font-semibold text-slate-800 dark:text-slate-100'>{formatNumber(s.calls)}</b>{' '}
      call{s.calls === 1 ? '' : 's'}
      {s.refused > 0 && (
        <span className='text-amber-700 dark:text-amber-400'>
          {' '}
          · {formatNumber(s.refused)} refused
        </span>
      )}
      {s.errors > 0 && (
        <span className='text-red-600 dark:text-red-400'> · {formatNumber(s.errors)} failed</span>
      )}
      <span className='text-slate-500 dark:text-slate-400'> · {formatFileSize(s.bytes)}</span>
    </span>
  )
}

export function KindPill({ kind }: { kind: McpConnKind }) {
  return <Pill tone={kind === 'oauth' ? 'brand' : 'neutral'}>{KIND_LABEL[kind]}</Pill>
}

/** The idle review's word on a connection, or nothing while it is in use. */
export function IdleNote({ c }: { c: McpConnection }) {
  if (!c.idle || c.idle.status === 'active') return null
  const on = formatDate(`${c.idle.revoke_on}T12:00:00Z`, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  return (
    <p className='mt-1.5 flex items-center gap-1.5 text-[12px] text-amber-700 dark:text-amber-400'>
      <AlertTriangle className='h-3.5 w-3.5 shrink-0' />
      Unused for {c.idle.idle_days} days — it will be disconnected on {on} unless it is used.
    </p>
  )
}

const OUTCOME: Record<AgentCall['outcome'], { label: string; tone: 'green' | 'amber' | 'red' }> = {
  ok: { label: 'Done', tone: 'green' },
  refused: { label: 'Refused', tone: 'amber' },
  error: { label: 'Failed', tone: 'red' }
}

const ACTION_LABEL: Record<string, string> = {
  create: 'Created',
  update: 'Changed',
  delete: 'Deleted'
}

function RowSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className='space-y-3' aria-busy='true'>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className='h-10 rounded-md' />
      ))}
    </div>
  )
}

// ── Connected apps ───────────────────────────────────────────────────────────

function ConnectionRow({
  c,
  onShowCalls,
  onDisconnect,
  disconnecting
}: {
  c: McpConnection
  onShowCalls: () => void
  onDisconnect: () => void
  disconnecting: boolean
}) {
  const last = c.stats?.last_call_at ?? c.last_used_at
  const [limits, setLimits] = useState(false)
  return (
    <li className='flex flex-wrap items-center gap-x-6 gap-y-3 py-3 first:pt-0 last:pb-0'>
      <div className='min-w-[220px] flex-1'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
            {c.name}
          </span>
          <KindPill kind={c.kind} />
        </div>
        <p className='mt-0.5 text-[12px] text-slate-500 dark:text-slate-400'>
          {c.created_at ? `Connected ${formatDate(c.created_at)}` : 'Seen in the request log'}
          {' · '}
          {last ? `last used ${formatRelative(last)}` : 'never used'}
        </p>
        <IdleNote c={c} />
        {c.scope !== undefined && (
          <p className='mt-1 flex min-w-0 items-center gap-1.5'>
            <span className='shrink-0 text-[12px] text-slate-500 dark:text-slate-400'>
              May use:
            </span>
            <ScopeBadge scope={c.scope ?? null} />
            {c.scope?.locked && (
              <span className='shrink-0 text-[11.5px] text-slate-500 dark:text-slate-400'>
                · set by an administrator
              </span>
            )}
          </p>
        )}
      </div>
      <div className='flex min-w-[180px] flex-col gap-1'>
        {c.stats && <CallsSparkline days={c.stats.days} />}
        <CallFigures s={c.stats} />
      </div>
      <div className='hidden min-w-[160px] flex-wrap gap-1 lg:flex'>
        {(c.stats?.top_tools ?? []).slice(0, 4).map((t) => (
          <span
            key={t.tool}
            data-tip={`${formatNumber(t.calls)} call${t.calls === 1 ? '' : 's'}`}
            className='rounded bg-slate-100 px-1.5 py-px font-mono text-[11px] text-slate-600 dark:bg-muted dark:text-slate-300'
          >
            {t.tool}
          </span>
        ))}
      </div>
      <div className='ml-auto flex items-center gap-1.5'>
        {c.scope_editable && (
          <>
            <button
              type='button'
              onClick={() => setLimits(true)}
              className='h-7 rounded-md px-2 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:text-slate-300 dark:hover:text-white'
            >
              Limits
            </button>
            <McpScopeSheet
              open={limits}
              onClose={() => setLimits(false)}
              conn={c.conn}
              name={c.name}
              scope={c.scope ?? null}
              mode='mine'
            />
          </>
        )}
        {(c.stats?.calls ?? 0) > 0 && (
          <button
            type='button'
            onClick={onShowCalls}
            className='h-7 rounded-md px-2 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:text-slate-300 dark:hover:text-white'
          >
            View calls
          </button>
        )}
        {c.kind === 'oauth' && c.created_at ? (
          <ConfirmButton
            onConfirm={onDisconnect}
            disabled={disconnecting}
            confirmLabel='Disconnect now?'
            title={`Disconnect ${c.name}`}
            className='h-7 rounded-md border border-slate-200 px-2.5 text-[12px] font-medium text-slate-700 transition-colors hover:border-red-300 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40 disabled:opacity-40 dark:border-border dark:text-slate-200 dark:hover:border-red-500/50 dark:hover:text-red-400'
            armedClassName='border-red-300 bg-red-50 text-red-700 dark:border-red-500/50 dark:bg-red-500/10 dark:text-red-400'
          >
            {disconnecting ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Disconnect'}
          </ConfirmButton>
        ) : c.kind !== 'oauth' ? (
          <span
            className='inline-flex items-center gap-1 text-[11.5px] text-slate-500 dark:text-slate-400'
            data-tip='Switch it off from API keys (administrators)'
          >
            <KeyRound className='h-3.5 w-3.5' /> Managed by an administrator
          </span>
        ) : null}
      </div>
    </li>
  )
}

// ── Tool calls ───────────────────────────────────────────────────────────────

function WriteLine({
  w,
  onUndo,
  undoing
}: {
  w: AgentWrite
  onUndo: () => void
  undoing: boolean
}) {
  const { urlFor, open } = useItemNavigation()
  const target = w.collection && w.item ? { collection: w.collection, itemId: w.item } : null
  return (
    <li className='flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5'>
      <span className='text-[12px] text-slate-700 dark:text-slate-200'>
        {ACTION_LABEL[w.action] ?? w.action}{' '}
        {target && w.action !== 'delete' ? (
          <a
            href={urlFor(target)}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) return
              e.preventDefault()
              open(target)
            }}
            className='font-mono text-[11.5px] text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
          >
            {w.collection} #{w.item}
          </a>
        ) : (
          <span className='font-mono text-[11.5px]'>
            {w.collection ?? ''} {w.item ? `#${w.item}` : ''}
          </span>
        )}
      </span>
      {w.undoable ? (
        <ConfirmButton
          onConfirm={onUndo}
          disabled={undoing}
          confirmLabel={w.action === 'create' ? 'Delete it?' : 'Put it back?'}
          title={
            w.action === 'create'
              ? 'Undo: delete the record the agent created'
              : 'Undo: put back the values from before'
          }
          className='inline-flex h-6 items-center gap-1 rounded-md border border-slate-200 px-2 text-[11.5px] font-medium text-slate-700 transition-colors hover:border-nvr-cyan hover:text-nvr-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 disabled:opacity-40 dark:border-border dark:text-slate-200 dark:hover:text-nvr-cyan'
          armedClassName='border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
        >
          {undoing ? <Loader2 className='h-3 w-3 animate-spin' /> : <Undo2 className='h-3 w-3' />}
          Undo
        </ConfirmButton>
      ) : (
        <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>{w.reason}</span>
      )}
    </li>
  )
}

function CallRow({
  call,
  onUndo,
  undoingId
}: {
  call: AgentCall
  onUndo: (w: AgentWrite) => void
  undoingId: number | null
}) {
  const [openRow, setOpenRow] = useState(false)
  const { urlFor, open } = useItemNavigation()
  const o = OUTCOME[call.outcome]
  const expandable = call.writes.length > 0 || !!call.message
  const rec = call.record
  const target = rec?.id ? { collection: rec.collection, itemId: rec.id } : null
  return (
    <Fragment>
      <tr
        className={cn(
          'border-b border-slate-100 align-middle last:border-0 dark:border-border/60',
          expandable && 'cursor-pointer hover:bg-muted/60'
        )}
        onClick={() => expandable && setOpenRow((v) => !v)}
      >
        <td className='w-5 py-2 pl-1 pr-0'>
          {expandable && (
            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation()
                setOpenRow((v) => !v)
              }}
              aria-expanded={openRow}
              aria-label={openRow ? 'Hide what this call changed' : 'Show what this call changed'}
              className='flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:hover:text-slate-200'
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 transition-transform duration-150',
                  openRow && 'rotate-90'
                )}
              />
            </button>
          )}
        </td>
        <td
          className='whitespace-nowrap py-2 pr-3 text-slate-500 dark:text-slate-400'
          data-tip={formatDateTime(call.at)}
        >
          {formatRelative(call.at)}
        </td>
        <td className='max-w-[160px] truncate py-2 pr-3 text-slate-700 dark:text-slate-200'>
          {call.app}
        </td>
        <td className='py-2 pr-3 font-mono text-[11.5px] text-slate-700 dark:text-slate-200'>
          {call.tool ?? '—'}
        </td>
        <td className='max-w-[220px] truncate py-2 pr-3'>
          {target ? (
            <a
              href={urlFor(target)}
              onClick={(e) => {
                e.stopPropagation()
                if (e.metaKey || e.ctrlKey) return
                e.preventDefault()
                open(target)
              }}
              className='font-mono text-[11.5px] text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
            >
              {rec?.collection} #{rec?.id}
            </a>
          ) : rec ? (
            <span className='font-mono text-[11.5px] text-slate-600 dark:text-slate-300'>
              {rec.collection}
            </span>
          ) : (
            <span className='text-slate-400 dark:text-slate-500'>—</span>
          )}
        </td>
        <td className='py-2 pr-3'>
          <span className='inline-flex items-center gap-1.5'>
            <Pill tone={o.tone}>{o.label}</Pill>
            {call.writes.length > 0 && (
              <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>
                {call.writes.length} write{call.writes.length === 1 ? '' : 's'}
              </span>
            )}
          </span>
        </td>
        <td className='whitespace-nowrap py-2 pr-1 text-right tabular-nums text-slate-500 dark:text-slate-400'>
          {call.bytes != null ? formatFileSize(call.bytes) : ''}
        </td>
      </tr>
      {openRow && (
        <tr className='border-b border-slate-100 dark:border-border/60'>
          <td />
          <td colSpan={6} className='pb-3 pr-3'>
            {call.message && (
              <p className='mb-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
                <span className='font-medium'>
                  {call.outcome === 'refused' ? 'Nivaro said no: ' : 'It failed: '}
                </span>
                {call.message}
              </p>
            )}
            {call.writes.length > 0 && (
              <ul className='divide-y divide-slate-100 dark:divide-border/60'>
                {call.writes.map((w) => (
                  <WriteLine
                    key={w.activity_id}
                    w={w}
                    onUndo={() => onUndo(w)}
                    undoing={undoingId === w.activity_id}
                  />
                ))}
              </ul>
            )}
            <p className='mt-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
              {call.api_calls} request{call.api_calls === 1 ? '' : 's'} into Nivaro · {call.ms} ms
            </p>
          </td>
        </tr>
      )}
    </Fragment>
  )
}

// ── The panel ────────────────────────────────────────────────────────────────

export function AgentsPanel({ className }: { className?: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [conn, setConn] = useState('')
  const callsRef = useRef<HTMLDivElement>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  const connections = useQuery({
    queryKey: mcpConnectionsKey('mine'),
    queryFn: () =>
      client
        .request(get<{ data: McpConnectionsAnswer }>('/mcp-connections/mine'))
        .then((r) => r.data)
  })

  const calls = useInfiniteQuery({
    queryKey: ['nvr-mcp-activity', conn],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      client
        .request(
          get<{ data: { logged: boolean; calls: AgentCall[]; next_before: string | null } }>(
            '/mcp-connections/mine/activity',
            { ...(conn ? { conn } : {}), ...(pageParam ? { before: pageParam } : {}), limit: 50 }
          )
        )
        .then((r) => r.data),
    getNextPageParam: (last) => last.next_before
  })

  const disconnect = useMutation({
    mutationFn: (c: string) => client.request(del(`/mcp-connections/mine/${c}`)),
    onSuccess: () => {
      setNotice({ tone: 'ok', text: 'Disconnected. Its tokens stopped working at once.' })
      void qc.invalidateQueries({ queryKey: mcpConnectionsKey('mine') })
    },
    onError: (e: unknown) =>
      setNotice({ tone: 'bad', text: (e as Error)?.message || 'Could not disconnect' })
  })

  const undo = useMutation({
    mutationFn: (w: AgentWrite) =>
      client.request(post(`/mcp-connections/mine/activity/${w.activity_id}/undo`)),
    onSuccess: (_r, w) => {
      setNotice({
        tone: 'ok',
        text:
          w.action === 'create'
            ? 'Undone — the record was deleted.'
            : 'Undone — the previous values are back.'
      })
      void qc.invalidateQueries({ queryKey: ['nvr-mcp-activity'] })
    },
    onError: (e: unknown) =>
      setNotice({ tone: 'bad', text: (e as Error)?.message || 'Could not undo that change' })
  })

  const list = connections.data?.connections ?? []
  const rows = useMemo(() => calls.data?.pages.flatMap((p) => p.calls) ?? [], [calls.data])
  const logged = connections.data?.logged !== false && calls.data?.pages[0]?.logged !== false
  const filterOptions = useMemo(
    () => [
      { value: '', label: 'Every app' },
      ...list
        .filter((c) => (c.stats?.calls ?? 0) > 0)
        .map((c) => ({ value: c.conn, label: c.name }))
    ],
    [list]
  )
  const s = connections.data?.settings

  return (
    <div className={cn('flex flex-col gap-4', className)} data-nvr-agents>
      {notice && (
        <div
          role='status'
          className={cn(
            'flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-[12.5px]',
            notice.tone === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
              : 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
          )}
        >
          {notice.text}
          <button
            type='button'
            onClick={() => setNotice(null)}
            className='text-[12px] font-medium underline-offset-2 hover:underline'
          >
            Dismiss
          </button>
        </div>
      )}

      <SectionCard
        icon={<Plug className='h-4 w-4' />}
        title='Connected apps'
        hint='AI assistants that act as you through Nivaro’s MCP server, with your permissions'
      >
        {connections.isLoading ? (
          <RowSkeleton />
        ) : connections.isError ? (
          <EmptyLine>Connected apps could not be loaded. Try again in a moment.</EmptyLine>
        ) : list.length === 0 ? (
          <div className='flex items-start gap-3'>
            <Bot className='mt-0.5 h-5 w-5 shrink-0 text-slate-400' />
            <p className='max-w-[70ch] text-[12.5px] text-slate-600 dark:text-slate-300'>
              No assistant is connected. Add Nivaro as a connector in Claude, ChatGPT, Claude Code
              or Codex and sign in — the app shows up here with what it did, and you can disconnect
              it at any time.
            </p>
          </div>
        ) : (
          <>
            <ul className='divide-y divide-slate-100 dark:divide-border/60'>
              {list.map((c) => (
                <ConnectionRow
                  key={c.conn}
                  c={c}
                  onShowCalls={() => {
                    setConn(c.conn)
                    callsRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                  }}
                  onDisconnect={() => disconnect.mutate(c.conn)}
                  disconnecting={disconnect.isPending && disconnect.variables === c.conn}
                />
              ))}
            </ul>
            {s && (
              <p className='mt-3 text-[11.5px] text-slate-500 dark:text-slate-400'>
                Figures cover the last {connections.data?.window_days ?? 14} days. A connection left
                unused for {s.idle_flag_days} days is pointed out to you, and disconnected after{' '}
                {s.idle_revoke_days} days with a week’s notice.
              </p>
            )}
          </>
        )}
      </SectionCard>

      <div ref={callsRef} className='scroll-mt-4'>
        <SectionCard
          icon={<ListChecks className='h-4 w-4' />}
          title='What my agents did'
          hint='Every tool call, newest first. Open one to see its changes and undo them.'
          actions={
            filterOptions.length > 2 ? (
              <SimpleSelectXs
                value={conn}
                onChange={setConn}
                options={filterOptions}
                ariaLabel='Show calls from'
              />
            ) : null
          }
        >
          {!logged ? (
            <EmptyLine>
              Tool calls are not recorded on this instance yet — it needs the latest update.
            </EmptyLine>
          ) : calls.isLoading ? (
            <RowSkeleton rows={5} />
          ) : calls.isError ? (
            <EmptyLine>The list could not be loaded. Try again in a moment.</EmptyLine>
          ) : rows.length === 0 ? (
            <EmptyLine>
              {conn
                ? 'This app made no tool calls in the last 14 days.'
                : 'Your agents made no tool calls in the last 14 days.'}
            </EmptyLine>
          ) : (
            <div className='-mx-1 overflow-x-auto'>
              <table className='w-full min-w-[640px] text-left text-[12px]'>
                <thead>
                  <tr className='border-b border-slate-200 text-[11px] font-medium text-slate-500 dark:border-border dark:text-slate-400'>
                    <th className='w-5' />
                    <th className='py-1.5 pr-3 font-medium'>When</th>
                    <th className='py-1.5 pr-3 font-medium'>App</th>
                    <th className='py-1.5 pr-3 font-medium'>Tool</th>
                    <th className='py-1.5 pr-3 font-medium'>Record</th>
                    <th className='py-1.5 pr-3 font-medium'>Result</th>
                    <th className='py-1.5 pr-1 text-right font-medium'>Answer size</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((call) => (
                    <CallRow
                      key={call.id}
                      call={call}
                      onUndo={(w) => undo.mutate(w)}
                      undoingId={undo.isPending ? (undo.variables?.activity_id ?? null) : null}
                    />
                  ))}
                </tbody>
              </table>
              {calls.hasNextPage && (
                <button
                  type='button'
                  onClick={() => void calls.fetchNextPage()}
                  disabled={calls.isFetchingNextPage}
                  className='mt-3 inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12px] font-medium text-slate-700 transition-colors hover:bg-muted disabled:opacity-40 dark:border-border dark:text-slate-200'
                >
                  {calls.isFetchingNextPage && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
                  Show older calls
                </button>
              )}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  )
}
