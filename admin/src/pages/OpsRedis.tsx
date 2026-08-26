import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Database, RotateCw, Search, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Redis key browser (#655) ────────────────────────────────────────────────
// SCAN-paged key list (never KEYS), type-aware peek, delete with inline
// confirm. Sensitive keys (sess:/token/secret) come back masked server-side.

interface RedisKeyRow {
  name: string
  type: string
  ttl_s: number | null
}

interface KeysPage {
  cursor: string
  done: boolean
  keys: RedisKeyRow[]
}

interface KeyPeek {
  name: string
  type: string
  ttl_s: number | null
  masked: boolean
  length?: number
  value?: string
  truncated?: boolean
  size?: number | null
  entries?: Array<{ field?: string; value: string; score?: number }>
}

const TYPE_COLORS: Record<string, string> = {
  string: 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  hash: 'bg-violet-500/15 text-violet-600 dark:text-violet-300',
  list: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  set: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  zset: 'bg-rose-500/15 text-rose-600 dark:text-rose-300'
}

function fmtTtl(ttl: number | null): string {
  if (ttl == null) return 'no expiry'
  if (ttl < 60) return `${ttl}s`
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`
  if (ttl < 86_400) return `${Math.floor(ttl / 3600)}h`
  return `${Math.floor(ttl / 86_400)}d`
}

export function OpsRedisPage() {
  const qc = useQueryClient()
  const [pattern, setPattern] = useState('*')
  const [applied, setApplied] = useState('*')
  // Accumulated pages: SCAN is cursor-based, "Load more" appends.
  const [rows, setRows] = useState<RedisKeyRow[]>([])
  const [cursor, setCursor] = useState('0')
  const [done, setDone] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const scanMut = useMutation({
    mutationFn: (args: { pattern: string; cursor: string }) =>
      api
        .get<{ data: KeysPage }>('/ops-redis/keys', {
          params: { pattern: args.pattern, cursor: args.cursor }
        })
        .then((r) => r.data.data),
    onError: () => toast.error('Scan failed')
  })

  const runScan = (fresh: boolean) => {
    const pat = pattern.trim() || '*'
    const cur = fresh ? '0' : cursor
    if (fresh) {
      setApplied(pat)
      setRows([])
      setSelected(null)
      setConfirmDelete(false)
    }
    scanMut.mutate(
      { pattern: pat, cursor: cur },
      {
        onSuccess: (page) => {
          setRows((prev) => {
            const seen = new Set(prev.map((r) => r.name))
            return fresh ? page.keys : [...prev, ...page.keys.filter((k) => !seen.has(k.name))]
          })
          setCursor(page.cursor)
          setDone(page.done)
        }
      }
    )
  }

  const { data: peek, isLoading: peekLoading } = useQuery<KeyPeek>({
    queryKey: ['ops-redis-peek', selected],
    queryFn: () =>
      api
        .get<{ data: KeyPeek }>('/ops-redis/key', { params: { name: selected } })
        .then((r) => r.data.data),
    enabled: !!selected
  })

  const deleteMut = useMutation({
    mutationFn: (name: string) => api.delete('/ops-redis/key', { params: { name } }),
    onSuccess: (_d, name) => {
      toast.success('Key deleted')
      setRows((prev) => prev.filter((r) => r.name !== name))
      setSelected(null)
      setConfirmDelete(false)
      qc.removeQueries({ queryKey: ['ops-redis-peek', name] })
    },
    onError: () => toast.error('Failed to delete key')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-background'>
        <div className='flex items-center gap-2.5'>
          <Database className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-[15px] font-semibold text-slate-900 dark:text-slate-100'>
            Redis Keys
          </h1>
        </div>
        <p className='mt-1 max-w-[72ch] text-[12px] text-slate-500'>
          Browse the live Redis with cursor-paged SCAN. Values of session/token/secret keys are
          masked — this answers what exists and how big, never what a secret is.
        </p>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* Left: pattern + key list */}
        <aside className='flex w-[420px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-background'>
          <div className='flex shrink-0 items-center gap-2 border-b border-slate-200 p-3 dark:border-border'>
            <Input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runScan(true)}
              placeholder='Pattern, e.g. sess:* or nvr:*'
              className='h-8 font-mono text-[12px]'
            />
            <Button size='sm' className='h-8 gap-1.5 text-[12px]' onClick={() => runScan(true)}>
              <Search className='h-3.5 w-3.5' />
              Scan
            </Button>
          </div>

          <div className='flex-1 overflow-y-auto'>
            {rows.length === 0 ? (
              <p className='p-4 text-[12px] text-slate-400'>
                {scanMut.isPending
                  ? 'Scanning…'
                  : applied !== pattern.trim() && rows.length === 0 && applied === '*'
                    ? 'Enter a pattern and Scan.'
                    : 'No keys matched this SCAN page — Redis SCAN pages can be sparse; load more or refine the pattern.'}
              </p>
            ) : (
              <ul>
                {rows.map((row) => (
                  <li key={row.name}>
                    <button
                      type='button'
                      onClick={() => {
                        setSelected(row.name)
                        setConfirmDelete(false)
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left dark:border-border/50',
                        selected === row.name
                          ? 'bg-[#00ceff]/10'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-900'
                      )}
                    >
                      <span
                        className={cn(
                          'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold',
                          TYPE_COLORS[row.type] ?? 'bg-slate-500/15 text-slate-500'
                        )}
                      >
                        {row.type}
                      </span>
                      <code className='min-w-0 flex-1 truncate font-mono text-[12px] text-slate-700 dark:text-slate-200'>
                        {row.name}
                      </code>
                      <span className='shrink-0 text-[11px] tabular-nums text-slate-400'>
                        {fmtTtl(row.ttl_s)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className='shrink-0 border-t border-slate-200 p-2 dark:border-border'>
            <Button
              variant='outline'
              size='sm'
              className='w-full gap-1.5 text-[12px]'
              disabled={done || scanMut.isPending || rows.length === 0}
              onClick={() => runScan(false)}
            >
              <RotateCw className={cn('h-3.5 w-3.5', scanMut.isPending && 'animate-spin')} />
              {done ? 'End of keyspace' : scanMut.isPending ? 'Scanning…' : 'Load more'}
            </Button>
          </div>
        </aside>

        {/* Right: peek panel */}
        <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
          {!selected ? (
            <div className='flex h-full flex-col items-center justify-center text-center'>
              <Database className='mb-3 h-10 w-10 text-muted-foreground' />
              <p className='mb-1 text-sm font-medium'>No key selected</p>
              <p className='text-xs text-muted-foreground'>
                Scan a pattern and pick a key to inspect it.
              </p>
            </div>
          ) : peekLoading || !peek ? (
            <div className='h-40 animate-pulse rounded-lg bg-muted' />
          ) : (
            <div className='max-w-3xl space-y-4'>
              <div className='flex items-start justify-between gap-4'>
                <div className='min-w-0'>
                  <code className='break-all font-mono text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
                    {peek.name}
                  </code>
                  <div className='mt-1.5 flex flex-wrap items-center gap-2'>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                        TYPE_COLORS[peek.type] ?? 'bg-slate-500/15 text-slate-500'
                      )}
                    >
                      {peek.type}
                    </span>
                    <Badge variant='outline' className='h-4 px-1.5 text-[10px] text-slate-400'>
                      TTL {fmtTtl(peek.ttl_s)}
                    </Badge>
                    {peek.size != null && (
                      <Badge variant='outline' className='h-4 px-1.5 text-[10px] text-slate-400'>
                        {peek.size.toLocaleString()} entries
                      </Badge>
                    )}
                    {peek.length != null && (
                      <Badge variant='outline' className='h-4 px-1.5 text-[10px] text-slate-400'>
                        {peek.length.toLocaleString()} bytes
                      </Badge>
                    )}
                    {peek.masked && (
                      <Badge className='h-4 bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-300'>
                        Masked
                      </Badge>
                    )}
                  </div>
                </div>
                {confirmDelete ? (
                  <div className='flex shrink-0 items-center gap-2'>
                    <span className='text-[12px] text-slate-500'>Delete this key?</span>
                    <Button
                      variant='destructive'
                      size='sm'
                      className='text-[12px]'
                      disabled={deleteMut.isPending}
                      onClick={() => deleteMut.mutate(peek.name)}
                    >
                      Confirm
                    </Button>
                    <Button
                      variant='outline'
                      size='sm'
                      className='text-[12px]'
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant='outline'
                    size='sm'
                    className='shrink-0 gap-1.5 text-[12px] text-red-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600'
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                    Delete
                  </Button>
                )}
              </div>

              {peek.type === 'string' && (
                <div className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
                  <pre className='max-h-[420px] overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] text-slate-700 dark:text-slate-200'>
                    {peek.value}
                  </pre>
                  {peek.truncated && (
                    <p className='mt-2 text-[11px] text-slate-400'>
                      Truncated to the first 2 KB of {peek.length?.toLocaleString()} bytes.
                    </p>
                  )}
                </div>
              )}

              {peek.entries && peek.entries.length > 0 && (
                <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
                  <table className='w-full bg-white text-[12px] dark:bg-card'>
                    <thead>
                      <tr className='border-b border-slate-200 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:border-border'>
                        {peek.type === 'hash' && <th className='px-3 py-1.5'>Field</th>}
                        <th className='px-3 py-1.5'>Value</th>
                        {peek.type === 'zset' && <th className='px-3 py-1.5 text-right'>Score</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {peek.entries.map((entry, i) => (
                        <tr
                          // biome-ignore lint/suspicious/noArrayIndexKey: peek rows are positional
                          key={i}
                          className='border-b border-slate-100 last:border-0 dark:border-border/50'
                        >
                          {peek.type === 'hash' && (
                            <td className='px-3 py-1.5'>
                              <code className='font-mono text-[11px] text-slate-500'>
                                {entry.field}
                              </code>
                            </td>
                          )}
                          <td className='px-3 py-1.5'>
                            <code className='break-all font-mono text-[11px] text-slate-700 dark:text-slate-200'>
                              {entry.value}
                            </code>
                          </td>
                          {peek.type === 'zset' && (
                            <td className='px-3 py-1.5 text-right tabular-nums'>{entry.score}</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {peek.size != null && peek.size > peek.entries.length && (
                    <p className='border-t border-slate-100 bg-white px-3 py-1.5 text-[11px] text-slate-400 dark:border-border/50 dark:bg-card'>
                      Showing first {peek.entries.length} of {peek.size.toLocaleString()} entries.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
