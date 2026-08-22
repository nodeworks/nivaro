import { useMutation } from '@tanstack/react-query'
import { Play, TerminalSquare } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

/**
 * Admin SQL scratchpad (#68) — read-only ad-hoc queries. The server rejects
 * anything but SELECT/WITH and logs every run; this page is a textarea, a Run
 * button (Cmd+Enter), the result grid, and a per-browser history.
 */

const HISTORY_KEY = 'nvr_sql_scratchpad_history'

interface RunResult {
  rows: Array<Record<string, unknown>>
  total: number
  truncated: boolean
  duration_ms: number
}

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export default function SqlScratchpad() {
  const [sql, setSql] = useState('SELECT TOP 25 * FROM ')
  const [history, setHistory] = useState<string[]>(loadHistory)
  const [result, setResult] = useState<RunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const run = useMutation({
    mutationFn: (q: string) =>
      api.post<{ data: RunResult }>('/sql-scratchpad/run', { sql: q }).then((r) => r.data.data),
    onSuccess: (d, q) => {
      setResult(d)
      setError(null)
      setHistory((h) => {
        const next = [q, ...h.filter((x) => x !== q)].slice(0, 20)
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
        return next
      })
    },
    onError: (e: { response?: { data?: { error?: string } } }) => {
      setResult(null)
      setError(e.response?.data?.error ?? 'Query failed')
    }
  })

  useEffect(() => {
    const el = taRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (sql.trim()) run.mutate(sql)
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [sql, run])

  const cols = result?.rows[0] ? Object.keys(result.rows[0]) : []

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <TerminalSquare className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              SQL Scratchpad
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Read-only queries against the live database. SELECT only — writes are rejected —
              and every run lands in the activity log.
            </p>
          </div>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <div className='flex min-w-0 flex-1 flex-col overflow-y-auto p-6'>
          <textarea
            ref={taRef}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={7}
            spellCheck={false}
            className='w-full rounded-lg border border-slate-200 bg-white p-3 font-mono text-[12.5px] leading-relaxed shadow-sm outline-none focus:border-nvr-cyan dark:border-border dark:bg-card'
          />
          <div className='mt-2 flex items-center gap-3'>
            <button
              type='button'
              disabled={run.isPending || !sql.trim()}
              onClick={() => run.mutate(sql)}
              className='flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-white disabled:opacity-50'
            >
              <Play className='h-3.5 w-3.5' />
              {run.isPending ? 'Running…' : 'Run'}
            </button>
            <span className='text-[11.5px] text-slate-400'>⌘↵ runs · results cap at 500 rows</span>
            {result && (
              <span className='ml-auto text-[12px] tabular-nums text-slate-500 dark:text-muted-foreground'>
                {result.total.toLocaleString()} row{result.total === 1 ? '' : 's'}
                {result.truncated && ' (showing 500)'} · {result.duration_ms}ms
              </span>
            )}
          </div>

          {error && (
            <div className='mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-[12px] text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-400'>
              {error}
            </div>
          )}

          {result && (
            <div className='mt-4 overflow-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
              <table className='w-full text-[11.5px] tabular-nums'>
                <thead>
                  <tr className='border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-400 dark:border-border/60'>
                    {cols.map((c) => (
                      <th key={c} className='whitespace-nowrap px-3 py-2 font-semibold'>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className='divide-y divide-slate-50 font-mono dark:divide-border/40'>
                  {result.rows.map((r, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no stable id
                    <tr key={i}>
                      {cols.map((c) => (
                        <td
                          key={c}
                          className='max-w-[320px] truncate whitespace-nowrap px-3 py-1.5 text-slate-700 dark:text-foreground'
                        >
                          {r[c] == null ? (
                            <span className='text-slate-300 dark:text-slate-600'>NULL</span>
                          ) : (
                            String(r[c])
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {result.rows.length === 0 && (
                    <tr>
                      <td className='px-3 py-6 text-center text-slate-400' colSpan={Math.max(1, cols.length)}>
                        Query returned no rows.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <aside className='w-[280px] shrink-0 overflow-y-auto border-l border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
          <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
            History
          </p>
          <div className='mt-2 space-y-1.5'>
            {history.length === 0 && (
              <p className='text-[12px] text-slate-400'>Queries you run appear here.</p>
            )}
            {history.map((h) => (
              <button
                key={h}
                type='button'
                onClick={() => setSql(h)}
                className='block w-full truncate rounded-md border border-slate-100 px-2 py-1.5 text-left font-mono text-[11px] text-slate-600 hover:border-nvr-cyan/40 hover:bg-nvr-cyan/5 dark:border-border/60 dark:text-muted-foreground'
                title={h}
              >
                {h}
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}
