import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, ChevronRight, Download, GitBranch } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'

/**
 * What one API caller depends on (#608): the collections and fields it read
 * and wrote, the GraphQL operations and REST endpoints it called — harvested
 * from the request log by GET /partner-dependencies/:key — with downloads for
 * the OpenAPI and GraphQL SDL subsets of exactly that surface, and the
 * caller's lines from the break check. Mounted under a picked caller card in
 * `InboundCallersView`. Needs `<NivaroProvider>` (admin routes).
 */

interface FieldUse {
  field: string
  calls: number
  last_seen: string
  via: Array<'rest' | 'graphql'>
}

interface CollectionUse {
  collection: string
  calls: number
  last_seen: string
  read_all: boolean
  writes: boolean
  read: FieldUse[]
  written: FieldUse[]
}

interface CallerDependencies {
  key: string
  label: string
  partner: boolean
  calls: number
  first_seen: string
  last_seen: string
  endpoints: Array<{
    method: string
    path: string
    calls: number
    errors: number
    last_seen: string
  }>
  operations: Array<{
    name: string
    kind: string
    calls: number
    errors: number
    last_seen: string
    root_fields: string[]
    persisted: boolean
  }>
  collections: CollectionUse[]
  evidence: {
    rows: number
    bodies_read: number
    documents_unreadable: number
    writes_without_body: number
  }
}

interface Finding {
  severity: 'break' | 'deprecated'
  caller_key: string
  collection: string
  field: string | null
  message: string
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

const DAY_OPTIONS: Array<[number, string]> = [
  [7, '7d'],
  [14, '14d'],
  [30, '30d']
]

function Chip({ tone, children }: { tone: 'read' | 'write' | 'muted'; children: string }) {
  return (
    <span
      className={cn(
        'inline-block rounded px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide',
        tone === 'read' && 'bg-sky-100 text-sky-800 dark:bg-sky-400/15 dark:text-sky-200',
        tone === 'write' && 'bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200',
        tone === 'muted' && 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300'
      )}
    >
      {children}
    </span>
  )
}

export function PartnerDependenciesPanel({
  callerKey,
  label
}: {
  callerKey: string
  label: string
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(true)
  const [days, setDays] = useState(14)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [allEndpoints, setAllEndpoints] = useState(false)
  const path = `/partner-dependencies/${encodeURIComponent(callerKey)}`

  const { data, isLoading, error } = useQuery({
    queryKey: ['partner-dependencies', callerKey, days],
    queryFn: () => client.request<{ data: CallerDependencies }>(get(path, { days })),
    enabled: open,
    staleTime: 60_000,
    retry: false
  })
  const { data: check } = useQuery({
    queryKey: ['partner-dependencies-check', days],
    queryFn: () =>
      client.request<{ data: { findings: Finding[] } }>(
        get('/partner-dependencies/check', { days, people: 1 })
      ),
    enabled: open,
    staleTime: 60_000,
    retry: false
  })
  const dep = data?.data
  const findings = useMemo(
    () =>
      (check?.data.findings ?? []).filter(
        (f) => f.caller_key.toUpperCase() === callerKey.toUpperCase()
      ),
    [check, callerKey]
  )
  const flagged = useMemo(() => {
    const m = new Map<string, Finding['severity']>()
    for (const f of findings) {
      const k = `${f.collection}.${f.field ?? ''}`
      if (m.get(k) !== 'break') m.set(k, f.severity)
    }
    return m
  }, [findings])

  const totals = useMemo(() => {
    const cols = dep?.collections ?? []
    return {
      collections: cols.length,
      read: cols.reduce((n, c) => n + c.read.length, 0),
      written: cols.reduce((n, c) => n + c.written.length, 0)
    }
  }, [dep])

  const download = async (kind: 'openapi' | 'graphql') => {
    try {
      const res = await client.request<{ data: { filename: string; content: string } }>(
        get(`${path}/${kind === 'openapi' ? 'openapi.json' : 'schema.graphql'}`, { days })
      )
      const blob = new Blob([res.data.content], {
        type: kind === 'openapi' ? 'application/json' : 'text/plain'
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.data.filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      toast.error(`Could not build the export: ${(err as Error).message}`)
    }
  }

  const toggle = (c: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  const endpoints = dep ? (allEndpoints ? dep.endpoints : dep.endpoints.slice(0, 12)) : []

  return (
    <div
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-partner-deps={callerKey}
    >
      <div className='flex flex-wrap items-center gap-2 px-3 py-2'>
        <button
          type='button'
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className='flex min-w-0 items-center gap-2 text-left'
        >
          <GitBranch className='h-4 w-4 shrink-0 text-slate-400' />
          <span className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
            Dependencies
          </span>
          <span className='truncate text-[11px] text-slate-500 dark:text-slate-400'>
            {dep
              ? `${plural(totals.collections, 'collection')} · ${plural(totals.read, 'field')} read · ${totals.written} written · ${plural(dep.operations.length, 'GraphQL operation')} · ${plural(dep.endpoints.length, 'endpoint')}`
              : `What ${label} uses of the API`}
          </span>
          {open ? (
            <ChevronDown className='h-4 w-4 shrink-0 text-slate-400' />
          ) : (
            <ChevronRight className='h-4 w-4 shrink-0 text-slate-400' />
          )}
        </button>
        {open && (
          <div className='ml-auto flex items-center gap-2'>
            <div className='inline-flex h-7 overflow-hidden rounded-md border border-slate-200 dark:border-border'>
              {DAY_OPTIONS.map(([v, text]) => (
                <button
                  key={v}
                  type='button'
                  onClick={() => setDays(v)}
                  data-partner-deps-days={v}
                  className={cn(
                    'px-2 text-[11px] font-medium transition-colors',
                    days === v
                      ? 'bg-[#1e293b] text-[#f2f2f2] dark:bg-nvr-cyan/20 dark:text-foreground dark:ring-1 dark:ring-inset dark:ring-nvr-cyan/40'
                      : 'text-slate-600 hover:bg-muted dark:text-slate-300'
                  )}
                >
                  {text}
                </button>
              ))}
            </div>
            <button
              type='button'
              disabled={!dep}
              onClick={() => download('openapi')}
              data-partner-deps-download='openapi'
              className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[11px] font-medium text-slate-700 hover:bg-muted disabled:opacity-50 dark:border-border dark:text-slate-200'
            >
              <Download className='h-3.5 w-3.5' /> OpenAPI subset
            </button>
            <button
              type='button'
              disabled={!dep || dep.operations.length === 0}
              onClick={() => download('graphql')}
              data-partner-deps-download='graphql'
              data-tip={dep && dep.operations.length === 0 ? 'No GraphQL calls in the window' : ''}
              className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[11px] font-medium text-slate-700 hover:bg-muted disabled:opacity-50 dark:border-border dark:text-slate-200'
            >
              <Download className='h-3.5 w-3.5' /> GraphQL SDL
            </button>
          </div>
        )}
      </div>

      {open && (
        <div className='space-y-3 border-t border-slate-100 px-3 py-3 dark:border-border/60'>
          {isLoading ? (
            <div className='h-24 animate-pulse rounded-md bg-[hsl(var(--nvr-skeleton))]' />
          ) : error || !dep ? (
            <p className='text-[12px] text-slate-500 dark:text-slate-400'>
              No logged calls from {label} in the last {days} days.
            </p>
          ) : (
            <>
              {findings.length > 0 && (
                <ul className='space-y-1'>
                  {findings.map((f) => (
                    <li
                      key={`${f.severity}|${f.collection}|${f.field}|${f.message}`}
                      data-partner-deps-finding={f.severity}
                      className={cn(
                        'flex items-start gap-1.5 rounded-md px-2 py-1 text-[11.5px]',
                        f.severity === 'break'
                          ? 'bg-red-50 text-red-900 dark:bg-red-400/10 dark:text-red-200'
                          : 'bg-amber-50 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200'
                      )}
                    >
                      <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
                      <span>{f.message}</span>
                    </li>
                  ))}
                </ul>
              )}

              <p className='text-[10.5px] text-slate-500 dark:text-slate-400'>
                From {dep.evidence.rows.toLocaleString()} logged calls
                {dep.first_seen && ` since ${formatDateTime(dep.first_seen)}`} · fields come from
                query strings, stored write bodies and GraphQL documents
                {dep.evidence.writes_without_body > 0 &&
                  ` · ${dep.evidence.writes_without_body} writes had no stored body`}
                {dep.evidence.documents_unreadable > 0 &&
                  ` · ${dep.evidence.documents_unreadable} GraphQL documents could not be read`}
              </p>

              <div>
                <h3 className='mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'>
                  Collections and fields
                </h3>
                {dep.collections.length === 0 ? (
                  <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
                    No item or GraphQL collection calls — only the endpoints below.
                  </p>
                ) : (
                  <ul className='divide-y divide-slate-100 rounded-md border border-slate-100 dark:divide-border/60 dark:border-border/60'>
                    {dep.collections.map((c) => {
                      const isOpen = expanded.has(c.collection)
                      const fields = new Map<string, { r?: FieldUse; w?: FieldUse }>()
                      for (const f of c.read) fields.set(f.field, { ...fields.get(f.field), r: f })
                      for (const f of c.written)
                        fields.set(f.field, { ...fields.get(f.field), w: f })
                      const gone = flagged.get(`${c.collection}.`)
                      return (
                        <li key={c.collection} data-partner-deps-collection={c.collection}>
                          <button
                            type='button'
                            onClick={() => toggle(c.collection)}
                            aria-expanded={isOpen}
                            className='flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted'
                          >
                            {isOpen ? (
                              <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                            ) : (
                              <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                            )}
                            <span
                              className={cn(
                                'font-mono text-[12px] text-slate-800 dark:text-slate-100',
                                gone === 'break' && 'text-red-700 line-through dark:text-red-300'
                              )}
                            >
                              {c.collection}
                            </span>
                            {c.read.length > 0 && <Chip tone='read'>{`R ${c.read.length}`}</Chip>}
                            {c.written.length > 0 && (
                              <Chip tone='write'>{`W ${c.written.length}`}</Chip>
                            )}
                            {c.read_all && <Chip tone='muted'>every field</Chip>}
                            <span className='ml-auto shrink-0 text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
                              {c.calls.toLocaleString()} calls ·{' '}
                              <span data-tip={formatDateTime(c.last_seen)}>
                                {formatRelative(c.last_seen)}
                              </span>
                            </span>
                          </button>
                          {isOpen && (
                            <div className='px-2 pb-2 pl-7'>
                              {fields.size === 0 ? (
                                <p className='text-[11px] text-slate-500 dark:text-slate-400'>
                                  {c.read_all
                                    ? 'Reads records without naming fields — every field is in play.'
                                    : 'Addressed without naming fields (a delete or an action).'}
                                </p>
                              ) : (
                                <table className='w-full text-[11.5px] tabular-nums'>
                                  <tbody>
                                    {[...fields.entries()]
                                      .sort((a, b) => a[0].localeCompare(b[0]))
                                      .map(([name, u]) => {
                                        const flag = flagged.get(`${c.collection}.${name}`)
                                        const calls = (u.r?.calls ?? 0) + (u.w?.calls ?? 0)
                                        const last = [u.r?.last_seen, u.w?.last_seen]
                                          .filter(Boolean)
                                          .sort()
                                          .pop() as string
                                        const via = [
                                          ...new Set([...(u.r?.via ?? []), ...(u.w?.via ?? [])])
                                        ]
                                        return (
                                          <tr
                                            key={name}
                                            data-partner-deps-field={`${c.collection}.${name}`}
                                            data-partner-deps-flag={flag}
                                            className='border-t border-slate-50 first:border-t-0 dark:border-border/40'
                                          >
                                            <td className='py-0.5 pr-2'>
                                              <span
                                                className={cn(
                                                  'font-mono text-slate-700 dark:text-slate-200',
                                                  flag === 'break' &&
                                                    'text-red-700 line-through dark:text-red-300',
                                                  flag === 'deprecated' &&
                                                    'text-amber-800 dark:text-amber-300'
                                                )}
                                              >
                                                {name}
                                              </span>
                                            </td>
                                            <td className='space-x-1 py-0.5 pr-2 whitespace-nowrap'>
                                              {u.r && <Chip tone='read'>read</Chip>}
                                              {u.w && <Chip tone='write'>write</Chip>}
                                            </td>
                                            <td className='py-0.5 pr-2 text-[10.5px] text-slate-500 dark:text-slate-400'>
                                              {via
                                                .map((v) => (v === 'graphql' ? 'GraphQL' : 'REST'))
                                                .join(' · ')}
                                            </td>
                                            <td className='py-0.5 pr-2 text-right text-slate-600 dark:text-slate-300'>
                                              {calls.toLocaleString()}
                                            </td>
                                            <td
                                              className='py-0.5 text-right whitespace-nowrap text-slate-500 dark:text-slate-400'
                                              data-tip={formatDateTime(last)}
                                            >
                                              {formatRelative(last)}
                                            </td>
                                          </tr>
                                        )
                                      })}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>

              {dep.operations.length > 0 && (
                <div>
                  <h3 className='mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'>
                    GraphQL operations
                  </h3>
                  <ul className='space-y-0.5'>
                    {dep.operations.map((o) => (
                      <li
                        key={o.name}
                        data-partner-deps-operation={o.name}
                        className='flex items-center gap-2 text-[11.5px]'
                      >
                        <Chip tone={o.kind === 'mutation' ? 'write' : 'read'}>{o.kind}</Chip>
                        <span className='font-mono text-slate-800 dark:text-slate-100'>
                          {o.name}
                        </span>
                        {o.persisted && <Chip tone='muted'>persisted</Chip>}
                        <span className='min-w-0 truncate font-mono text-[10.5px] text-slate-500 dark:text-slate-400'>
                          {o.root_fields.join(', ')}
                        </span>
                        <span className='ml-auto shrink-0 tabular-nums text-slate-500 dark:text-slate-400'>
                          {o.calls.toLocaleString()}
                          {o.errors > 0 && (
                            <span className='text-red-700 dark:text-red-400'> · {o.errors}✕</span>
                          )}{' '}
                          · {formatRelative(o.last_seen)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {dep.endpoints.length > 0 && (
                <div>
                  <h3 className='mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'>
                    Endpoints
                  </h3>
                  <ul className='space-y-0.5'>
                    {endpoints.map((e) => (
                      <li
                        key={`${e.method} ${e.path}`}
                        className='flex items-center gap-2 text-[11.5px]'
                      >
                        <span className='w-12 shrink-0 font-mono text-slate-500 dark:text-slate-400'>
                          {e.method}
                        </span>
                        <span className='min-w-0 flex-1 truncate font-mono text-slate-700 dark:text-slate-200'>
                          {e.path}
                        </span>
                        <span className='shrink-0 tabular-nums text-slate-500 dark:text-slate-400'>
                          {e.calls.toLocaleString()}
                          {e.errors > 0 && (
                            <span className='text-red-700 dark:text-red-400'> · {e.errors}✕</span>
                          )}{' '}
                          · {formatRelative(e.last_seen)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {dep.endpoints.length > 12 && (
                    <button
                      type='button'
                      onClick={() => setAllEndpoints((v) => !v)}
                      className='mt-1 text-[11px] font-medium text-slate-600 underline-offset-2 hover:underline dark:text-slate-300'
                    >
                      {allEndpoints ? 'Show fewer' : `Show all ${dep.endpoints.length}`}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
