import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { DaysSelect, Empty, ErrorNote, Loading, tdCls, thCls, whole } from './shared'

interface Row {
  tool: string
  calls: number
  errors: number
  error_rate: number
  empty: number
  empty_rate: number
  retries: number
  recovered: number
  read_as_none: number
  answers: number
  avg_rounds: number | null
  avg_ms: number | null
  slowest: Array<{ ms: number; request_id: string | null; at: string }>
  failures: Array<{ request_id: string | null; at: string; summary: string; input: string }>
  flags: string[]
}

export function ToolsTab() {
  const [days, setDays] = useState(14)
  const [open, setOpen] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['ai-quality', 'tools', days],
    queryFn: async () =>
      (await api.get('/ai/tool-reliability', { params: { days } })).data.data as {
        answers: number
        capped: boolean
        tools: Row[]
      }
  })
  if (q.isLoading) return <Loading />
  if (q.error || !q.data) return <ErrorNote error={q.error} />
  const d = q.data
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-3'>
        <DaysSelect value={days} onChange={setDays} options={[7, 14, 30, 90]} />
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          From the tool steps saved with {whole(d.answers)} Ask AI answers
          {d.capped ? ' (the newest ones)' : ''}. A retry is the same tool called again straight
          after an error.
        </p>
      </div>
      {d.tools.length === 0 ? (
        <Empty>No Ask AI answers with tool steps in this period.</Empty>
      ) : (
        <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <table className='w-full text-[12px]'>
            <thead className='border-b border-slate-200 dark:border-border'>
              <tr>
                <th className={thCls}>Tool</th>
                <th className={cn(thCls, 'text-right')}>Calls</th>
                <th className={cn(thCls, 'text-right')}>Errors</th>
                <th className={cn(thCls, 'text-right')}>Empty</th>
                <th className={cn(thCls, 'text-right')}>Retries (worked)</th>
                <th className={cn(thCls, 'text-right')}>Read as “none”</th>
                <th className={cn(thCls, 'text-right')}>Rounds an answer</th>
                <th className={cn(thCls, 'text-right')}>Average time</th>
                <th className={thCls}>
                  <span className='sr-only'>Flags</span>
                </th>
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-100 dark:divide-border'>
              {d.tools.map((r) => (
                <ToolRow
                  key={r.tool}
                  r={r}
                  open={open === r.tool}
                  toggle={() => setOpen(open === r.tool ? null : r.tool)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ToolRow({ r, open, toggle }: { r: Row; open: boolean; toggle: () => void }) {
  const detail = r.failures.length > 0 || r.slowest.length > 0 || r.flags.length > 0
  return (
    <>
      <tr
        className={cn(detail && 'cursor-pointer hover:bg-muted')}
        onClick={detail ? toggle : undefined}
      >
        <td className={cn(tdCls, 'font-mono')}>
          {detail ? (
            <button type='button' className='text-left' aria-expanded={open}>
              {r.tool}
            </button>
          ) : (
            r.tool
          )}
        </td>
        <td className={cn(tdCls, 'text-right tabular-nums')}>{whole(r.calls)}</td>
        <td
          className={cn(
            tdCls,
            'text-right tabular-nums',
            r.error_rate >= 20 && 'text-red-700 dark:text-red-400'
          )}
        >
          {r.errors} ({r.error_rate}%)
        </td>
        <td className={cn(tdCls, 'text-right tabular-nums')}>
          {r.empty} ({r.empty_rate}%)
        </td>
        <td className={cn(tdCls, 'text-right tabular-nums')}>
          {r.retries} ({r.recovered})
        </td>
        <td className={cn(tdCls, 'text-right tabular-nums')}>{r.read_as_none}</td>
        <td className={cn(tdCls, 'text-right tabular-nums')}>{r.avg_rounds ?? '—'}</td>
        <td className={cn(tdCls, 'text-right tabular-nums')}>
          {r.avg_ms == null ? '—' : `${(r.avg_ms / 1000).toFixed(1)} s`}
        </td>
        <td className={tdCls}>
          {r.flags.length > 0 && (
            <AlertTriangle
              className='h-3.5 w-3.5 text-amber-600 dark:text-amber-400'
              aria-label='Needs a look'
            />
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} className='space-y-3 bg-slate-50 px-3 py-3 dark:bg-background'>
            {r.flags.map((f) => (
              <p key={f} className='text-amber-800 dark:text-amber-300'>
                {f}
              </p>
            ))}
            {r.failures.length > 0 && (
              <div>
                <p className='mb-1 font-medium'>Recent failing calls</p>
                <ul className='space-y-1.5'>
                  {r.failures.map((f, i) => (
                    <li
                      key={i}
                      className='rounded border border-slate-200 bg-white p-2 dark:border-border dark:bg-card'
                    >
                      <p>{f.summary}</p>
                      <p className='break-all font-mono text-slate-500 dark:text-muted-foreground'>
                        {f.input}
                      </p>
                      <p className='text-slate-500 dark:text-muted-foreground'>
                        {new Date(f.at).toLocaleString()}
                        {f.request_id && (
                          <>
                            {' · request '}
                            <span className='font-mono'>{f.request_id}</span>
                          </>
                        )}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {r.slowest.length > 0 && (
              <div>
                <p className='mb-1 font-medium'>Slowest runs</p>
                <ul>
                  {r.slowest.map((s, i) => (
                    <li key={i} className='tabular-nums'>
                      {(s.ms / 1000).toFixed(1)} s · {new Date(s.at).toLocaleString()}
                      {s.request_id && <span className='font-mono'> · {s.request_id}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
