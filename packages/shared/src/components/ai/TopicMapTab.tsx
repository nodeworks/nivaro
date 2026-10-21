import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { SimpleSelect } from '../ui/SimpleSelect'

/**
 * Ask AI topic map (#2734): recent questions grouped by meaning, each topic
 * shown by role with volume, unanswered rate, thumbs-down rate and average
 * cost, and where a data guide, glossary term or playbook is missing. Topic
 * names are generated; the questions themselves stay hidden until an admin asks
 * to see samples (that look is logged).
 */

interface RoleStats {
  role: string
  volume: number
  unanswered_rate: number
  thumbs_down_rate: number
  avg_cost_usd: number
}

interface Topic {
  id: string
  name: string
  volume: number
  unanswered_rate: number
  thumbs_down_rate: number
  avg_cost_usd: number
  by_role: RoleStats[]
  gap: boolean
  missing: Array<'guide' | 'glossary' | 'playbook'>
  note: string | null
  questions?: string[]
}

interface TopicMapData {
  generated_at: string
  days: number
  total_questions: number
  provider: string
  named_by: 'ai' | 'keywords'
  topics: Topic[]
}

const pct = (n: number) => `${Math.round(n * 100)}%`
const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`
const MISSING_LABEL = { guide: 'data guide', glossary: 'glossary term', playbook: 'playbook' }

export function TopicMapTab({ onOpenSuggestions }: { onOpenSuggestions?: () => void }) {
  const client = useNivaroClient()
  const [days, setDays] = useState('30')
  const [showQuestions, setShowQuestions] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [gapsOnly, setGapsOnly] = useState(false)
  const q = useQuery({
    queryKey: ['nvr-ai-topic-map', days, showQuestions],
    staleTime: 5 * 60_000,
    queryFn: () =>
      client.request<{ data: TopicMapData }>(
        get('/ai-knowledge/topic-map', { days, ...(showQuestions ? { questions: '1' } : {}) })
      )
  })
  const d = q.data?.data
  const topics = (d?.topics ?? []).filter((t) => !gapsOnly || t.gap)
  return (
    <div className='flex flex-col gap-3' data-ai-topic-map>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='w-[140px]'>
          <SimpleSelect
            value={days}
            onChange={setDays}
            ariaLabel='Window'
            className='h-8 text-[12px]'
            options={[
              { value: '7', label: 'Last 7 days' },
              { value: '30', label: 'Last 30 days' },
              { value: '90', label: 'Last 90 days' }
            ]}
          />
        </div>
        <Button
          size='sm'
          variant='outline'
          className='h-8 text-[12px]'
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
        >
          <RotateCw className={cn('h-3.5 w-3.5', q.isFetching && 'animate-spin')} />
          Refresh
        </Button>
        <label className='inline-flex items-center gap-1.5 text-[12px]'>
          <input
            type='checkbox'
            checked={gapsOnly}
            onChange={(e) => setGapsOnly(e.target.checked)}
          />
          Only topics with a gap
        </label>
        <label
          className='inline-flex items-center gap-1.5 text-[12px]'
          data-tip='Shows a few of the questions behind each topic. Looking is logged.'
        >
          <input
            type='checkbox'
            checked={showQuestions}
            onChange={(e) => setShowQuestions(e.target.checked)}
          />
          Show sample questions
        </label>
        {d && (
          <span className='text-[11.5px] text-muted-foreground'>
            {d.total_questions} {d.total_questions === 1 ? 'question' : 'questions'} in{' '}
            {d.topics.length} {d.topics.length === 1 ? 'topic' : 'topics'}
          </span>
        )}
      </div>
      <p className='max-w-[75ch] text-[11.5px] text-muted-foreground'>
        Questions people asked Ask AI, grouped by meaning. A topic with many unanswered or
        thumbs-down questions and nothing in the glossary, data guides or playbooks covering it
        shows what to write next.
        {d?.named_by === 'keywords' &&
          ' Topic names come from common words because AI naming is unavailable.'}
      </p>
      {q.isLoading ? (
        <div className='h-24 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
      ) : q.isError ? (
        <div className='rounded-lg border border-red-200 p-4 text-[12.5px] text-red-700 dark:border-red-900 dark:text-red-300'>
          The topic map could not be built.{' '}
          <button type='button' className='underline' onClick={() => void q.refetch()}>
            Try again
          </button>
        </div>
      ) : !topics.length ? (
        <div className='rounded-lg border border-dashed border-slate-300 p-8 text-center text-[12.5px] text-muted-foreground dark:border-border'>
          {gapsOnly ? 'No topic has a gap in this window.' : 'No Ask AI questions in this window.'}
        </div>
      ) : (
        <ul className='flex flex-col gap-2'>
          {topics.map((t) => {
            const isOpen = open === t.id
            return (
              <li
                key={t.id}
                className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
              >
                <button
                  type='button'
                  onClick={() => setOpen(isOpen ? null : t.id)}
                  aria-expanded={isOpen}
                  className='flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-4 py-3 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted/40'
                >
                  {isOpen ? (
                    <ChevronDown className='h-3.5 w-3.5 shrink-0' />
                  ) : (
                    <ChevronRight className='h-3.5 w-3.5 shrink-0' />
                  )}
                  <span className='min-w-[180px] flex-1 text-[13px] font-semibold'>{t.name}</span>
                  <Fig label={t.volume === 1 ? 'question' : 'questions'} value={String(t.volume)} />
                  <Fig
                    label='unanswered'
                    value={pct(t.unanswered_rate)}
                    bad={t.unanswered_rate >= 0.2}
                  />
                  <Fig
                    label='thumbs-down'
                    value={pct(t.thumbs_down_rate)}
                    bad={t.thumbs_down_rate >= 0.2}
                  />
                  <Fig label='avg cost' value={usd(t.avg_cost_usd)} />
                  {t.gap && (
                    <span className='rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'>
                      Gap
                    </span>
                  )}
                </button>
                {isOpen && (
                  <div className='border-t border-slate-100 px-4 py-3 dark:border-border/60'>
                    {t.gap && (
                      <p className='mb-2 text-[12px] text-amber-800 dark:text-amber-300'>
                        {t.note}. Missing: {t.missing.map((m) => MISSING_LABEL[m]).join(', ')}.{' '}
                        {onOpenSuggestions && (
                          <button type='button' className='underline' onClick={onOpenSuggestions}>
                            Draft suggestions
                          </button>
                        )}
                      </p>
                    )}
                    <table className='w-full max-w-[640px] text-[12px]'>
                      <thead>
                        <tr className='text-left text-muted-foreground'>
                          <th className='py-1 font-medium'>Role</th>
                          <th className='py-1 text-right font-medium'>Questions</th>
                          <th className='py-1 text-right font-medium'>Unanswered</th>
                          <th className='py-1 text-right font-medium'>Thumbs-down</th>
                          <th className='py-1 text-right font-medium'>Avg cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {t.by_role.map((r) => (
                          <tr
                            key={r.role}
                            className='border-t border-slate-100 dark:border-border/60'
                          >
                            <td className='py-1'>{r.role}</td>
                            <td className='py-1 text-right tabular-nums'>{r.volume}</td>
                            <td className='py-1 text-right tabular-nums'>
                              {pct(r.unanswered_rate)}
                            </td>
                            <td className='py-1 text-right tabular-nums'>
                              {pct(r.thumbs_down_rate)}
                            </td>
                            <td className='py-1 text-right tabular-nums'>{usd(r.avg_cost_usd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {t.questions && t.questions.length > 0 && (
                      <ul className='mt-2 list-disc pl-5 text-[12px] text-slate-700 dark:text-slate-300'>
                        {t.questions.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function Fig({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <span className='text-[11.5px] text-muted-foreground'>
      <span
        className={cn(
          'mr-1 text-[12.5px] font-medium tabular-nums text-foreground',
          bad && 'text-amber-700 dark:text-amber-300'
        )}
      >
        {value}
      </span>
      {label}
    </span>
  )
}
