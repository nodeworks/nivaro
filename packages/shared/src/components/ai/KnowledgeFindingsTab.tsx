import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCw, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { SimpleSelect } from '../ui/SimpleSelect'

/**
 * Conflicts between glossary terms and data guides (#2480): terms that
 * contradict each other, near-duplicate terms with different meanings, and
 * entries naming collections, fields or saved queries that are gone. Checked on
 * every save and nightly; a finding resolves by itself once its cause is fixed.
 */

export interface FindingSide {
  type: 'glossary' | 'guide'
  ref: string
  label: string
}

interface Finding {
  id: number
  kind: 'contradiction' | 'near_duplicate' | 'dead_reference' | 'ai_conflict'
  severity: 'high' | 'medium' | 'low'
  summary: string
  sides: FindingSide[]
  status: string
  first_seen_at: string | null
  last_seen_at: string | null
}

const KIND_LABEL: Record<Finding['kind'], string> = {
  contradiction: 'Contradiction',
  ai_conflict: 'Contradiction (AI read)',
  near_duplicate: 'Near-duplicate',
  dead_reference: 'Missing reference'
}

const SEVERITY_CLASS: Record<Finding['severity'], string> = {
  high: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  medium: 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  low: 'bg-slate-100 text-slate-700 dark:bg-muted dark:text-slate-300'
}

const errMsg = (e: unknown, fallback: string) => (e as { message?: string })?.message || fallback

export function KnowledgeFindingsTab({ onOpenSide }: { onOpenSide: (side: FindingSide) => void }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [status, setStatus] = useState('open')
  const q = useQuery({
    queryKey: ['nvr-ai-knowledge-findings', status],
    queryFn: () => client.request<{ data: Finding[] }>(get('/ai-knowledge/findings', { status }))
  })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['nvr-ai-knowledge-findings'] })
  const run = useMutation({
    mutationFn: (ai: boolean) =>
      client.request<{ data: { open: number; new: number; resolved: number } }>(
        post('/ai-knowledge/findings/run', { ai })
      ),
    onSuccess: (r) => {
      refresh()
      toast.success(`${r.data.open} open · ${r.data.new} new · ${r.data.resolved} resolved`)
    },
    onError: (e) => toast.error(errMsg(e, 'The check failed'))
  })
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'dismiss' | 'reopen' }) =>
      client.request(post(`/ai-knowledge/findings/${id}/${action}`)),
    onSuccess: refresh,
    onError: (e) => toast.error(errMsg(e, 'Could not update the finding'))
  })
  const rows = q.data?.data ?? []
  return (
    <div className='flex flex-col gap-3' data-ai-knowledge-findings>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='w-[150px]'>
          <SimpleSelect
            value={status}
            onChange={setStatus}
            ariaLabel='Show'
            className='h-8 text-[12px]'
            options={[
              { value: 'open', label: 'Open' },
              { value: 'dismissed', label: 'Dismissed' },
              { value: 'resolved', label: 'Resolved' }
            ]}
          />
        </div>
        <Button
          size='sm'
          variant='outline'
          className='h-8 text-[12px]'
          disabled={run.isPending}
          onClick={() => run.mutate(false)}
        >
          <RotateCw className={cn('h-3.5 w-3.5', run.isPending && 'animate-spin')} />
          Check now
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='h-8 text-[12px]'
          disabled={run.isPending}
          data-tip='Also asks the AI to read the definitions for contradictions the word match cannot see'
          onClick={() => run.mutate(true)}
        >
          Check with AI too
        </Button>
      </div>
      <p className='max-w-[75ch] text-[11.5px] text-muted-foreground'>
        Ask AI answers from the glossary and data guides, so two definitions that disagree, or a
        guide that names a field that no longer exists, make answers wrong. Checked on every save
        and every night.
      </p>
      {q.isLoading ? (
        <div className='h-16 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
      ) : q.isError ? (
        <div className='rounded-lg border border-red-200 p-4 text-[12.5px] text-red-700 dark:border-red-900 dark:text-red-300'>
          Could not load the findings.{' '}
          <button type='button' className='underline' onClick={() => void q.refetch()}>
            Try again
          </button>
        </div>
      ) : !rows.length ? (
        <div className='rounded-lg border border-dashed border-slate-300 p-8 text-center text-[12.5px] text-muted-foreground dark:border-border'>
          {status === 'open'
            ? 'No conflicts. The glossary and data guides agree with each other and with the data.'
            : `Nothing ${status}.`}
        </div>
      ) : (
        <ul className='flex flex-col gap-2'>
          {rows.map((f) => (
            <li
              key={f.id}
              className='rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'
            >
              <div className='flex flex-wrap items-center gap-2'>
                <ShieldAlert className='h-3.5 w-3.5 text-muted-foreground' />
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[11px] font-medium',
                    SEVERITY_CLASS[f.severity]
                  )}
                >
                  {KIND_LABEL[f.kind] ?? f.kind}
                </span>
                {f.last_seen_at && (
                  <span className='text-[11px] text-muted-foreground'>
                    seen {new Date(f.last_seen_at).toLocaleDateString()}
                  </span>
                )}
                {f.status !== 'resolved' && (
                  <Button
                    size='sm'
                    variant='ghost'
                    className='ml-auto h-7 px-2 text-[11.5px]'
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({
                        id: f.id,
                        action: f.status === 'dismissed' ? 'reopen' : 'dismiss'
                      })
                    }
                  >
                    {f.status === 'dismissed' ? 'Reopen' : 'Dismiss'}
                  </Button>
                )}
              </div>
              <p className='mt-1 text-[12.5px] text-slate-800 dark:text-slate-200'>{f.summary}</p>
              {f.sides.length > 0 && (
                <div className='mt-2 flex flex-wrap gap-1.5'>
                  {f.sides.map((s) => (
                    <button
                      key={`${s.type}:${s.ref}`}
                      type='button'
                      onClick={() => onOpenSide(s)}
                      className='rounded-md border border-border px-2 py-1 text-[11.5px] hover:bg-muted'
                    >
                      {s.type === 'glossary' ? 'Term' : 'Guide'}: {s.label}
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
