import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, put } from '../../lib/commands'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'

export interface DataGuideRow {
  collection: string
  hints: string | null
  examples: string[]
  updated_at: string | null
}

/**
 * A collection's Ask AI data guide (#1847): hints about how its data is
 * shaped and example questions it answers. Ask AI receives them only when a
 * question touches this collection (or it inspects the collection). Admin.
 */
export function DataGuideCard({
  collection,
  className
}: {
  collection: string
  className?: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['nvr-ai-data-guide', collection],
    queryFn: () =>
      client.request<{ data: DataGuideRow; ready: boolean }>(
        get(`/ai-knowledge/data-guides/${encodeURIComponent(collection)}`)
      )
  })
  const [hints, setHints] = useState('')
  const [examples, setExamples] = useState('')
  const loaded = q.data?.data
  useEffect(() => {
    if (!loaded) return
    setHints(loaded.hints ?? '')
    setExamples((loaded.examples ?? []).join('\n'))
  }, [loaded])

  const save = useMutation({
    mutationFn: () =>
      client.request(
        put(`/ai-knowledge/data-guides/${encodeURIComponent(collection)}`, {
          hints,
          examples: examples
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        })
      ),
    onSuccess: () => {
      toast.success('Data guide saved')
      void qc.invalidateQueries({ queryKey: ['nvr-ai-data-guide', collection] })
      void qc.invalidateQueries({ queryKey: ['nvr-ai-data-guides'] })
    },
    onError: (e: Error) => toast.error(e.message || 'Could not save the data guide')
  })

  const dirty =
    !!loaded && (hints !== (loaded.hints ?? '') || examples !== (loaded.examples ?? []).join('\n'))

  return (
    <div
      data-ai-data-guide={collection}
      className={
        className ??
        'rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
      }
    >
      <div className='mb-2 flex items-center gap-2'>
        <Sparkles className='h-4 w-4 text-nvr-cyan' />
        <h3 className='text-[13px] font-semibold'>Ask AI data guide</h3>
      </div>
      <p className='mb-3 text-[12px] text-muted-foreground'>
        Sent to Ask AI only when a question touches this collection. Say how the data is shaped and
        what business words mean in its columns — e.g. "one row per workflow and year", "'committed'
        means a PO exists".
      </p>
      {q.isLoading ? (
        <p className='text-[12px] text-muted-foreground'>Loading…</p>
      ) : q.data && !q.data.ready ? (
        <p className='text-[12px] text-amber-700 dark:text-amber-400'>
          The AI knowledge tables do not exist yet (migration 434).
        </p>
      ) : (
        <div className='flex flex-col gap-3'>
          <div className='flex flex-col gap-1'>
            <label
              htmlFor={`dg-hints-${collection}`}
              className='text-[11px] font-medium uppercase tracking-wide text-muted-foreground'
            >
              Hints
            </label>
            <Textarea
              id={`dg-hints-${collection}`}
              value={hints}
              onChange={(e) => setHints(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder='Forecasts are one row per workflow and fiscal year; sum amount across years for a total.'
              className='text-[12.5px]'
            />
          </div>
          <div className='flex flex-col gap-1'>
            <label
              htmlFor={`dg-examples-${collection}`}
              className='text-[11px] font-medium uppercase tracking-wide text-muted-foreground'
            >
              Example questions (one per line)
            </label>
            <Textarea
              id={`dg-examples-${collection}`}
              value={examples}
              onChange={(e) => setExamples(e.target.value)}
              rows={3}
              placeholder='What is the total forecast for next year?'
              className='text-[12.5px]'
            />
          </div>
          <div className='flex items-center gap-2'>
            <Button
              size='sm'
              className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save guide'}
            </Button>
            {loaded?.updated_at && (
              <span className='text-[11px] text-muted-foreground'>
                Last saved {new Date(loaded.updated_at).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
