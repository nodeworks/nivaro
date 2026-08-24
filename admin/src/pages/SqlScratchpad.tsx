import { useMutation } from '@tanstack/react-query'
import { Play, Plus, Sparkles, TerminalSquare, Wand2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { formatSql } from '@/lib/format-sql'

/**
 * Admin SQL scratchpad (#68) — read-only ad-hoc queries. The server rejects
 * anything but SELECT/WITH and logs every run. This page adds tabs with
 * independent histories (#430), the /ai/sql copilot bar (#111), prettify
 * (#237), promote-to-custom-query (#115) and save-as-widget-preset (#341).
 */

const TABS_KEY = 'nvr_sql_scratchpad_tabs'
const LEGACY_HISTORY_KEY = 'nvr_sql_scratchpad_history'

interface RunResult {
  rows: Array<Record<string, unknown>>
  total: number
  truncated: boolean
  duration_ms: number
}

interface ScratchTab {
  id: string
  name: string
  sql: string
  history: string[]
}

function loadTabs(): ScratchTab[] {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    const parsed = raw ? (JSON.parse(raw) as ScratchTab[]) : null
    if (Array.isArray(parsed) && parsed.length > 0) return parsed
  } catch {
    /* fall through */
  }
  // Migrate the pre-tabs single history once.
  let legacy: string[] = []
  try {
    const raw = localStorage.getItem(LEGACY_HISTORY_KEY)
    const p = raw ? JSON.parse(raw) : []
    legacy = Array.isArray(p) ? p.filter((x) => typeof x === 'string') : []
  } catch {
    legacy = []
  }
  return [{ id: 't1', name: 'Query 1', sql: legacy[0] ?? 'SELECT TOP 25 * FROM ', history: legacy }]
}

export default function SqlScratchpad() {
  const navigate = useNavigate()
  const [tabs, setTabs] = useState<ScratchTab[]>(loadTabs)
  const [activeId, setActiveId] = useState(() => loadTabs()[0]?.id ?? 't1')
  const [result, setResult] = useState<RunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiBusy, setAiBusy] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  const sql = active?.sql ?? ''

  const persist = (next: ScratchTab[]) => {
    setTabs(next)
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(next))
    } catch {
      /* private mode */
    }
  }
  const patchActive = (patch: Partial<ScratchTab>) =>
    persist(tabs.map((t) => (t.id === active?.id ? { ...t, ...patch } : t)))

  const run = useMutation({
    mutationFn: (q: string) =>
      api.post<{ data: RunResult }>('/sql-scratchpad/run', { sql: q }).then((r) => r.data.data),
    onSuccess: (d, q) => {
      setResult(d)
      setError(null)
      patchActive({ history: [q, ...(active?.history ?? []).filter((x) => x !== q)].slice(0, 20) })
    },
    onError: (e: { response?: { data?: { error?: string } } }) => {
      setResult(null)
      setError(e.response?.data?.error ?? 'Query failed')
    }
  })

  // SQL copilot (#111): the same /ai/sql bar CustomQueryEdit carries.
  const runAi = async (mode: 'generate' | 'explain' | 'fix') => {
    if (aiBusy) return
    if (mode === 'generate' && !aiPrompt.trim()) return
    setAiBusy(mode)
    try {
      const r = await api.post<{ data: { sql: string | null; text: string } }>('/ai/sql', {
        mode,
        prompt: aiPrompt.trim() || undefined,
        current_sql: sql || undefined,
        error: mode === 'fix' ? (error ?? undefined) : undefined
      })
      if (r.data.data.sql) {
        patchActive({ sql: r.data.data.sql })
        setAiPrompt('')
      }
      if (r.data.data.text) toast.info(r.data.data.text, { duration: 9000 })
    } catch (e) {
      toast.error(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'AI call failed'
      )
    } finally {
      setAiBusy(null)
    }
  }

  // Promote to custom query (#115): prefill the editor via sessionStorage.
  const promote = () => {
    const params = [...new Set([...sql.matchAll(/:(\w+)/g)].map((m) => m[1]))]
    try {
      sessionStorage.setItem(
        'nvr-cq-prefill',
        JSON.stringify({ sql_text: sql, params, name: active?.name ?? 'Scratchpad query' })
      )
    } catch {
      /* handoff best-effort */
    }
    navigate('/custom-queries/new')
  }

  // Save as widget preset (#341): custom query + a catalog preset in one go —
  // usable in Report Studio's catalog and on dashboards (Prebuilt tab).
  const saveWidget = useMutation({
    mutationFn: async () => {
      const slug = `scratch-${Date.now().toString(36)}`
      await api.post('/custom-queries', {
        name: active?.name ?? 'Scratchpad widget',
        slug,
        sql_text: sql,
        enabled: true,
        access: 'admin'
      })
      const columns = result?.rows[0] ? Object.keys(result.rows[0]).slice(0, 8) : []
      await api.post('/report-studio/widget-presets', {
        name: `${active?.name ?? 'Scratchpad'} (widget)`,
        category: 'Custom',
        description: 'Saved from the SQL scratchpad',
        widget_type: 'query',
        config: {
          query: { query_slug: slug, table: { columns: columns.map((c) => ({ field: c })) } }
        },
        w: 6,
        h: 3
      })
      return slug
    },
    onSuccess: (slug) =>
      toast.success(`Widget preset saved (query "${slug}") — find it in the report catalog`),
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Save failed')
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
          {/* Tabs (#430) */}
          <div className='mb-2 flex items-center gap-1'>
            {tabs.map((t) => (
              <span
                key={t.id}
                className={`inline-flex items-center overflow-hidden rounded-t-md border border-b-0 text-[12px] ${
                  t.id === active?.id
                    ? 'border-slate-200 bg-white font-medium text-slate-800 dark:border-border dark:bg-card dark:text-slate-100'
                    : 'border-transparent text-slate-400 hover:text-slate-600'
                }`}
              >
                <button
                  type='button'
                  onClick={() => {
                    setActiveId(t.id)
                    setResult(null)
                    setError(null)
                  }}
                  className='px-2.5 py-1'
                >
                  {t.name}
                </button>
                {tabs.length > 1 && (
                  <button
                    type='button'
                    onClick={() => {
                      const next = tabs.filter((x) => x.id !== t.id)
                      persist(next)
                      if (t.id === active?.id) setActiveId(next[0].id)
                    }}
                    className='pr-1.5 text-slate-300 hover:text-red-500'
                    aria-label={`Close ${t.name}`}
                  >
                    <X className='h-3 w-3' />
                  </button>
                )}
              </span>
            ))}
            <button
              type='button'
              onClick={() => {
                const id = `t${Date.now().toString(36)}`
                persist([
                  ...tabs,
                  { id, name: `Query ${tabs.length + 1}`, sql: 'SELECT TOP 25 * FROM ', history: [] }
                ])
                setActiveId(id)
                setResult(null)
              }}
              className='ml-1 rounded p-1 text-slate-400 hover:bg-muted hover:text-slate-600'
              aria-label='New tab'
            >
              <Plus className='h-3.5 w-3.5' />
            </button>
          </div>

          <textarea
            ref={taRef}
            value={sql}
            onChange={(e) => patchActive({ sql: e.target.value })}
            rows={7}
            spellCheck={false}
            className='w-full rounded-lg rounded-tl-none border border-slate-200 bg-white p-3 font-mono text-[12.5px] leading-relaxed shadow-sm outline-none focus:border-nvr-cyan dark:border-border dark:bg-card'
          />

          {/* Copilot bar (#111) */}
          <div className='mt-2 flex items-center gap-1.5'>
            <span className='flex h-8 min-w-[220px] flex-1 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 dark:border-border dark:bg-card'>
              <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' />
              <input
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void runAi('generate')
                  }
                }}
                placeholder='Describe the query… (e.g. "open workflows per zone with total amount")'
                className='h-full flex-1 bg-transparent text-[12px] outline-none'
              />
            </span>
            <button
              type='button'
              disabled={!!aiBusy || !aiPrompt.trim()}
              onClick={() => void runAi('generate')}
              className='h-8 rounded-md border border-slate-200 px-2.5 text-[12px] hover:bg-muted disabled:opacity-50 dark:border-border'
            >
              {aiBusy === 'generate' ? '…' : 'Generate'}
            </button>
            <button
              type='button'
              disabled={!!aiBusy || !sql.trim()}
              onClick={() => void runAi('explain')}
              className='h-8 rounded-md border border-slate-200 px-2.5 text-[12px] hover:bg-muted disabled:opacity-50 dark:border-border'
            >
              {aiBusy === 'explain' ? '…' : 'Explain'}
            </button>
            {error && (
              <button
                type='button'
                disabled={!!aiBusy}
                onClick={() => void runAi('fix')}
                className='h-8 rounded-md border border-amber-300 px-2.5 text-[12px] text-amber-700 hover:bg-amber-50 disabled:opacity-50'
              >
                {aiBusy === 'fix' ? '…' : 'Fix'}
              </button>
            )}
          </div>

          <div className='mt-2 flex flex-wrap items-center gap-2'>
            <button
              type='button'
              disabled={run.isPending || !sql.trim()}
              onClick={() => run.mutate(sql)}
              className='flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-white disabled:opacity-50'
            >
              <Play className='h-3.5 w-3.5' />
              {run.isPending ? 'Running…' : 'Run'}
            </button>
            <button
              type='button'
              disabled={!sql.trim()}
              onClick={() => patchActive({ sql: formatSql(sql) })}
              title='Prettify (#237): uppercase keywords, clause-per-line'
              className='flex h-8 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-[12px] hover:bg-muted disabled:opacity-50 dark:border-border'
            >
              <Wand2 className='h-3.5 w-3.5' /> Prettify
            </button>
            <button
              type='button'
              disabled={!sql.trim()}
              onClick={promote}
              title='Promote to a saved custom query (#115) — SQL, name and :params prefill the editor'
              className='h-8 rounded-md border border-slate-200 px-2.5 text-[12px] hover:bg-muted disabled:opacity-50 dark:border-border'
            >
              Promote to custom query
            </button>
            <button
              type='button'
              disabled={!sql.trim() || !result || saveWidget.isPending}
              onClick={() => saveWidget.mutate()}
              title='Save as a report/dashboard widget preset (#341) — run it first so columns are known'
              className='h-8 rounded-md border border-slate-200 px-2.5 text-[12px] hover:bg-muted disabled:opacity-50 dark:border-border'
            >
              {saveWidget.isPending ? 'Saving…' : 'Save as widget'}
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
            History — {active?.name}
          </p>
          <div className='mt-2 space-y-1.5'>
            {(active?.history ?? []).length === 0 && (
              <p className='text-[12px] text-slate-400'>Queries you run appear here.</p>
            )}
            {(active?.history ?? []).map((h) => (
              <button
                key={h}
                type='button'
                onClick={() => patchActive({ sql: h })}
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
