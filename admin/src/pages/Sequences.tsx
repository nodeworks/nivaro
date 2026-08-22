import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ListOrdered } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'

/**
 * Auto-id sequences console (#66) — every nivaro_sequences counter with the
 * pattern it feeds, and a raise-only bump. The go-live "re-seed above the
 * legacy max" chore as a page instead of a scratchpad script.
 */

interface SeqRow {
  id: string
  next_val: number
  pattern: string | null
}

export default function Sequences() {
  const qc = useQueryClient()
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const { data: rows = [] } = useQuery<SeqRow[]>({
    queryKey: ['sequences'],
    queryFn: () => api.get('/sequences').then((r) => r.data.data)
  })

  const bump = useMutation({
    mutationFn: ({ id, next_val }: { id: string; next_val: number }) =>
      api.post(`/sequences/${encodeURIComponent(id)}/bump`, { next_val }),
    onSuccess: (_d, v) => {
      toast.success(`${v.id} raised to ${v.next_val}`)
      setDrafts((d) => ({ ...d, [v.id]: '' }))
      void qc.invalidateQueries({ queryKey: ['sequences'] })
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Bump failed')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <ListOrdered className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              ID Sequences
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              The counters behind auto-generated IDs. Counters can only be raised — lowering one
              would mint duplicate IDs. Raise them after importing legacy data whose IDs run
              higher.
            </p>
          </div>
        </div>
      </header>

      <div className='flex-1 overflow-y-auto p-6'>
        <div className='max-w-[880px] overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <table className='w-full text-[12.5px] tabular-nums'>
            <thead>
              <tr className='border-b border-slate-100 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border/60'>
                <th className='px-4 py-2 font-semibold'>Sequence</th>
                <th className='px-4 py-2 font-semibold'>Pattern</th>
                <th className='px-4 py-2 text-right font-semibold'>Next value</th>
                <th className='w-[220px] px-4 py-2 text-right font-semibold'>Raise to</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-50 dark:divide-border/40'>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className='px-4 py-8 text-center text-[13px] text-slate-400'>
                    No sequences yet — they appear the first time an auto-ID field generates a
                    value.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className='px-4 py-2.5 font-mono text-[12px] font-medium text-slate-800 dark:text-foreground'>
                    {r.id}
                  </td>
                  <td className='max-w-[280px] truncate px-4 py-2.5 font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {r.pattern ?? '—'}
                  </td>
                  <td className='px-4 py-2.5 text-right font-semibold text-slate-900 dark:text-foreground'>
                    {r.next_val.toLocaleString()}
                  </td>
                  <td className='px-4 py-2.5'>
                    <div className='flex items-center justify-end gap-1.5'>
                      <input
                        value={drafts[r.id] ?? ''}
                        onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                        placeholder={String(r.next_val + 1)}
                        inputMode='numeric'
                        className='h-7 w-28 rounded-md border border-slate-200 bg-background px-2 text-right text-[12px] dark:border-border'
                      />
                      <button
                        type='button'
                        disabled={bump.isPending || !(Number(drafts[r.id]) > r.next_val)}
                        onClick={() => bump.mutate({ id: r.id, next_val: Number(drafts[r.id]) })}
                        className='h-7 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-semibold text-white disabled:opacity-40'
                      >
                        Raise
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
