import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatFileSize } from '@/lib/utils'
import { Code, NotConfigured, Pill, Sparkline, TABLE_WRAP, TD, TH } from './edge-ui'

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

/** Per-container CPU, throttling, memory against limit, OOM kills, network and disk (#2835). */
export function ResourcesTab() {
  const [window, setWindow] = useState<'24h' | '7d'>('24h')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'cpu_cores', dir: -1 })
  const { data, isLoading, error } = useQuery({
    queryKey: ['infrastructure', 'resources', window],
    queryFn: async () =>
      (await api.get('/infrastructure/resources', { params: { window } })).data.data as Resp,
    refetchInterval: 60_000
  })
  const sortKey = sort.key === 'mem_bytes' ? 'mem_share' : sort.key
  const rows = useMemo(() => {
    const list = [...(data?.containers ?? [])]
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
  }, [data, sort, sortKey])

  if (isLoading) return <Skeleton className='h-64' />
  if (error || !data)
    return (
      <p className='text-[13px] text-red-600 dark:text-red-400'>
        Could not read container resources.
      </p>
    )
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
      <div className='flex flex-wrap items-center gap-3'>
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
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Throttled share and OOM kills cover the window; the other figures are current. Flags:
          throttled over 10 %, memory over 85 % of its limit.
          {flagged > 0 ? ` ${flagged} flagged.` : ''}
        </p>
      </div>
      {data.error && <p className='text-[12px] text-red-600 dark:text-red-400'>{data.error}</p>}
      <div className={TABLE_WRAP}>
        <table className='w-full min-w-[1040px]'>
          <thead className='border-b border-slate-200 dark:border-border'>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={TH}
                  aria-sort={
                    sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'
                  }
                >
                  <button
                    type='button'
                    className='inline-flex items-center gap-1 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:text-foreground'
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
          <tbody className='divide-y divide-slate-100 dark:divide-border'>
            {rows.length === 0 && (
              <tr>
                <td className={TD} colSpan={COLUMNS.length + 1}>
                  No container metrics found. cAdvisor needs to feed the telemetry store.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className={`${TD} font-medium`}>
                  <span className='break-all'>{r.container}</span>
                  <div className='text-[11px] font-normal text-slate-500 dark:text-muted-foreground'>
                    {r.host}
                  </div>
                </td>
                <td className={TD}>{r.cpu_cores == null ? '—' : r.cpu_cores.toFixed(2)}</td>
                <td className={TD}>
                  {r.throttled_share == null ? (
                    '—'
                  ) : r.flags.includes('throttled') ? (
                    <Pill tone='warn'>{(r.throttled_share * 100).toFixed(0)} % throttled</Pill>
                  ) : (
                    `${(r.throttled_share * 100).toFixed(1)} %`
                  )}
                </td>
                <td className={TD}>
                  {r.mem_bytes == null ? '—' : formatFileSize(r.mem_bytes)}
                  <div className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {r.mem_limit_bytes == null
                      ? 'no limit'
                      : `of ${formatFileSize(r.mem_limit_bytes)}`}
                    {r.mem_share != null && ` (${(r.mem_share * 100).toFixed(0)} %)`}
                  </div>
                  {r.flags.includes('memory') && <Pill tone='warn'>near limit</Pill>}
                </td>
                <td className={TD}>
                  {r.oom_events == null ? (
                    '—'
                  ) : r.oom_events > 0 ? (
                    <Pill tone='bad'>{r.oom_events}</Pill>
                  ) : (
                    '0'
                  )}
                </td>
                <td className={TD}>{rate(r.rx_bps)}</td>
                <td className={TD}>{rate(r.tx_bps)}</td>
                <td className={TD}>{rate(r.read_bps)}</td>
                <td className={TD}>{rate(r.write_bps)}</td>
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
