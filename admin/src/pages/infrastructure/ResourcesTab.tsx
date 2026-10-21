import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '@/lib/api'
import { cn, formatFileSize } from '@/lib/utils'
import { Code, NotConfigured, Pill, Sparkline } from './edge-ui'
import { matches, SearchBox } from './swarm-ui'
import { Banner, Dash, LoadError, PANEL, TABLE, TabSkeleton, TD, TH } from './ui'

interface Row {
  id: string
  host: string
  container: string
  cpu_cores: number | null
  throttled_share: number | null
  mem_bytes: number | null
  mem_limit_bytes: number | null
  mem_share: number | null
  oom_events: number | null
  rx_bps: number | null
  tx_bps: number | null
  read_bps: number | null
  write_bps: number | null
  flags: Array<'throttled' | 'memory'>
  cpu_spark: number[]
  mem_spark: number[]
}
interface Resp {
  configured: boolean
  error?: string | null
  containers?: Row[]
}

type SortKey =
  | 'container'
  | 'cpu_cores'
  | 'throttled_share'
  | 'mem_share'
  | 'mem_bytes'
  | 'oom_events'
  | 'rx_bps'
  | 'tx_bps'
  | 'read_bps'
  | 'write_bps'

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'container', label: 'Container' },
  { key: 'cpu_cores', label: 'CPU (cores)' },
  { key: 'throttled_share', label: 'Throttled' },
  { key: 'mem_bytes', label: 'Memory' },
  { key: 'oom_events', label: 'OOM kills' },
  { key: 'rx_bps', label: 'Net in' },
  { key: 'tx_bps', label: 'Net out' },
  { key: 'read_bps', label: 'Disk read' },
  { key: 'write_bps', label: 'Disk write' }
]

const rate = (v: number | null) => (v == null ? '—' : `${formatFileSize(v)}/s`)

const NUM = cn(TD, 'whitespace-nowrap text-right tabular-nums')

/** Per-container CPU, throttling, memory against limit, OOM kills, network and disk (#2835). */
export function ResourcesTab() {
  const [window, setWindow] = useState<'24h' | '7d'>('24h')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'cpu_cores', dir: -1 })
  const [q, setQ] = useState('')
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['infrastructure', 'resources', window],
    queryFn: async () =>
      (await api.get('/infrastructure/resources', { params: { window } })).data.data as Resp,
    refetchInterval: 60_000
  })
  const sortKey = sort.key === 'mem_bytes' ? 'mem_share' : sort.key
  const rows = useMemo(() => {
    const list = (data?.containers ?? []).filter((r) => matches(q, r.container, r.host))
    list.sort((a, b) => {
      if (sort.key === 'container') return sort.dir * a.container.localeCompare(b.container)
      // Memory sorts by share of limit first, then absolute size, so limited containers lead.
      const av = sort.key === 'mem_bytes' ? (a.mem_share ?? -1) : (a[sortKey] as number | null)
      const bv = sort.key === 'mem_bytes' ? (b.mem_share ?? -1) : (b[sortKey] as number | null)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return sort.dir * (av - bv) || sort.dir * ((a.mem_bytes ?? 0) - (b.mem_bytes ?? 0))
    })
    return list
  }, [data, sort, sortKey, q])

  if (isLoading) return <TabSkeleton />
  if (error || !data) return <LoadError what='container resources' onRetry={refetch} />
  if (!data.configured)
    return (
      <NotConfigured title='The telemetry store is not configured'>
        Container figures come from cAdvisor metrics in the telemetry store. Set{' '}
        <Code>TELEMETRY_STORE_URL</Code> and a read token on this instance.
      </NotConfigured>
    )
  const flagged = rows.filter((r) => r.flags.length).length
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <SearchBox value={q} onChange={setQ} placeholder='Filter containers and hosts' />
        <div
          role='toolbar'
          aria-label='Window'
          className='inline-flex rounded-md border border-slate-200 bg-white p-0.5 dark:border-border dark:bg-card'
        >
          {(['24h', '7d'] as const).map((w) => (
            <button
              key={w}
              type='button'
              aria-pressed={window === w}
              onClick={() => setWindow(w)}
              className={cn(
                'rounded px-2.5 py-1 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                window === w
                  ? 'bg-nvr-cyan/15 text-slate-900 dark:text-foreground'
                  : 'text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
              )}
            >
              {w === '24h' ? '24 hours' : '7 days'}
            </button>
          ))}
        </div>
      </div>
      <p className='max-w-prose text-[12px] leading-5 text-slate-500 dark:text-muted-foreground'>
        Throttled share and OOM kills cover the window; the other figures are current. Flags:
        throttled over 10 %, memory over 85 % of its limit.
        {flagged > 0 ? ` ${flagged} flagged.` : ''}
      </p>
      {data.error && (
        <Banner tone='warn'>
          <span className='font-medium'>Some figures are missing.</span> {data.error}
        </Banner>
      )}
      <div className={PANEL}>
        <table className={cn(TABLE, 'min-w-[1100px]')}>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={cn(TH, c.key !== 'container' && 'text-right')}
                  aria-sort={
                    sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'
                  }
                >
                  <button
                    type='button'
                    className={cn(
                      'inline-flex items-center gap-1 rounded hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:text-foreground',
                      c.key !== 'container' && 'flex-row-reverse'
                    )}
                    onClick={() =>
                      setSort((s) =>
                        s.key === c.key
                          ? { key: c.key, dir: s.dir === 1 ? -1 : 1 }
                          : { key: c.key, dir: c.key === 'container' ? 1 : -1 }
                      )
                    }
                  >
                    {c.label}
                    {sort.key === c.key &&
                      (sort.dir === 1 ? (
                        <ArrowUp className='h-3 w-3' />
                      ) : (
                        <ArrowDown className='h-3 w-3' />
                      ))}
                  </button>
                </th>
              ))}
              <th className={TH}>{window} trend (CPU, memory)</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  className={cn(TD, 'py-6 text-center text-slate-500 dark:text-muted-foreground')}
                  colSpan={COLUMNS.length + 1}
                >
                  {q
                    ? 'No container matches this filter.'
                    : 'No container metrics found. cAdvisor needs to feed the telemetry store.'}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className={cn(TD, 'max-w-[300px]')}>
                  <div
                    className='truncate font-mono font-medium text-slate-900 dark:text-foreground'
                    data-tip={r.container.length > 36 ? r.container : undefined}
                  >
                    {r.container}
                  </div>
                  <div className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {r.host}
                  </div>
                </td>
                <td className={NUM}>{r.cpu_cores == null ? <Dash /> : r.cpu_cores.toFixed(2)}</td>
                <td className={NUM}>
                  {r.throttled_share == null ? (
                    '—'
                  ) : r.flags.includes('throttled') ? (
                    <Pill tone='warn'>{(r.throttled_share * 100).toFixed(0)} % throttled</Pill>
                  ) : (
                    `${(r.throttled_share * 100).toFixed(1)} %`
                  )}
                </td>
                <td className={NUM}>
                  {r.mem_bytes == null ? <Dash /> : formatFileSize(r.mem_bytes)}
                  <div className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {r.mem_limit_bytes == null
                      ? 'no limit'
                      : `of ${formatFileSize(r.mem_limit_bytes)}`}
                    {r.mem_share != null && ` (${(r.mem_share * 100).toFixed(0)} %)`}
                  </div>
                  {r.flags.includes('memory') && <Pill tone='warn'>near limit</Pill>}
                </td>
                <td className={NUM}>
                  {r.oom_events == null ? (
                    '—'
                  ) : r.oom_events > 0 ? (
                    <Pill tone='bad'>{r.oom_events}</Pill>
                  ) : (
                    '0'
                  )}
                </td>
                <td className={NUM}>{rate(r.rx_bps)}</td>
                <td className={NUM}>{rate(r.tx_bps)}</td>
                <td className={NUM}>{rate(r.read_bps)}</td>
                <td className={NUM}>{rate(r.write_bps)}</td>
                <td className={TD}>
                  <div className='flex flex-col gap-1'>
                    <Sparkline values={r.cpu_spark} label={`${r.container} CPU over ${window}`} />
                    <Sparkline
                      values={r.mem_spark}
                      label={`${r.container} memory over ${window}`}
                      max={r.mem_limit_bytes ?? undefined}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
