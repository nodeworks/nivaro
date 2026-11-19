import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleSlash,
  FileQuestion,
  GitMerge,
  Library,
  Pencil,
  RotateCw,
  Search,
  ThumbsDown,
  ThumbsUp,
  Undo2,
  Wand2
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, get, post } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import { invalidateGlossary } from '../../lib/glossary'
import { cn } from '../../lib/utils'
import { Segmented } from '../delivery-analytics/ui'
import { QueryErrorState } from '../QueryErrorState'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Skeleton } from '../ui/skeleton'
import { CallDrawer } from './call-log/CallDrawer'
import { Fold } from './call-log/TranscriptView'
import { DataGuideCard } from './DataGuideCard'
import { blankDraft, fromDraft, type TermDraft, TermForm } from './GlossaryTermForm'

/**
 * Ask AI topic map (#2734, made actionable 2026-11-18): recent questions
 * grouped by meaning. Sort and filter the topics (gaps, unanswered,
 * thumbs-down, cost, volume, trend against the window before), open one to
 * its questions and each question to its call and whole conversation, and
 * act on it: add a glossary term or data guide prefilled from its questions
 * (with how many of them it would cover, before saving), keep an answered
 * question's plan as a playbook, see the docs searches that came up empty,
 * mark the topic handled or ignored, rename it, merge it into another.
 * Decisions follow the topic through re-clustering and can be undone.
 * Reading a topic's questions is logged.
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
  prev_volume: number
  daily: number[]
  collections: string[]
  coverage: { glossary: number; guides: number; playbooks: number }
  status: 'open' | 'handled' | 'ignored'
  status_note: string | null
  status_at: string | null
  status_by: string | null
  new_since_status: number
  renamed_from: string | null
  merged: number
  overrides: Array<{ id: string; kind: 'status' | 'rename' | 'merge'; label: string }>
}

interface TopicMapData {
  generated_at: string
  days: number
  total_questions: number
  provider: string
  named_by: 'ai' | 'keywords'
  topics: Topic[]
}

interface TopicQuestion {
  request_id: string
  call_id: number | null
  question: string
  role: string
  asked_by: string | null
  at: string | null
  unanswered: boolean
  thumbs_up: boolean
  thumbs_down: boolean
  cost: number
  collections: string[]
  since_status: boolean
}

interface Coverage {
  total: number
  covered: number
  covered_before: number
  sample_covered: string[]
  sample_missed: string[]
}

interface PlaybookPreview {
  question: string
  plan: Array<{ tool: string; input: Record<string, unknown> }>
  skipped_errors: number
  answered: boolean
  replaces: number | null
  saved: boolean
}

const pct = (n: number) => `${Math.round(n * 100)}%`
const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`
const MISSING_LABEL = { guide: 'data guide', glossary: 'glossary term', playbook: 'playbook' }

type SortKey = 'volume' | 'unanswered' | 'down' | 'cost' | 'trend'
type StatusFilter = 'open' | 'handled' | 'ignored' | 'all'
type Action = null | 'glossary' | 'guide' | 'status' | 'rename' | 'merge'

const SORTS: Record<SortKey, (t: Topic) => number> = {
  volume: (t) => t.volume,
  unanswered: (t) => t.unanswered_rate,
  down: (t) => t.thumbs_down_rate,
  cost: (t) => t.avg_cost_usd,
  trend: (t) => t.volume - t.prev_volume
}

/** Questions per day as a tiny bar strip (the trend the brief asked for). */
function Spark({ daily, label }: { daily: number[]; label: string }) {
  const max = Math.max(1, ...daily)
  return (
    <span
      className='inline-flex h-5 w-[84px] items-end gap-px'
      role='img'
      aria-label={label}
      data-tip={label}
    >
      {daily.map((n, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: one bar per day, in order
          key={i}
          className={cn(
            'min-w-px flex-1 rounded-[1px]',
            n ? 'bg-nvr-cyan/70' : 'bg-slate-200 dark:bg-muted'
          )}
          style={{ height: `${n ? Math.max(18, (n / max) * 100) : 10}%` }}
        />
      ))}
    </span>
  )
}

function Trend({ t }: { t: Topic }) {
  const d = t.volume - t.prev_volume
  if (t.prev_volume === 0 && t.volume > 0)
    return <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>new</span>
  if (d === 0) return <span className='text-[11px] text-slate-500'>same</span>
  const Up = d > 0
  return (
    <span
      className={cn(
        'inline-flex items-center text-[11px] tabular-nums',
        Up ? 'text-amber-700 dark:text-[#e2b192]' : 'text-slate-500 dark:text-muted-foreground'
      )}
      data-tip={`${t.prev_volume} in the window before`}
    >
      {Up ? (
        <ArrowUpRight className='h-3 w-3' aria-hidden />
      ) : (
        <ArrowDownRight className='h-3 w-3' aria-hidden />
      )}
      {Math.abs(d)}
    </span>
  )
}

function Fig({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <span className='whitespace-nowrap text-[11.5px] text-muted-foreground'>
      <span
        className={cn(
          'mr-1 text-[12.5px] font-medium tabular-nums text-foreground',
          bad && 'text-amber-700 dark:text-[#e2b192]'
        )}
      >
        {value}
      </span>
      {label}
    </span>
  )
}

function StatusBadge({ t }: { t: Topic }) {
  if (t.status === 'open') return null
  return (
    <span
      className='inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-px text-[10.5px] font-medium text-slate-600 dark:border-border dark:bg-muted dark:text-muted-foreground'
      data-tip={`${t.status === 'handled' ? 'Handled' : 'Ignored'} by ${t.status_by ?? 'an administrator'}${t.status_note ? ` — ${t.status_note}` : ''}`}
    >
      {t.status === 'handled' ? (
        <Check className='h-3 w-3' aria-hidden />
      ) : (
        <CircleSlash className='h-3 w-3' aria-hidden />
      )}
      {t.status}
      {t.new_since_status > 0 && (
        <span className='text-amber-700 dark:text-[#e2b192]'>· {t.new_since_status} new since</span>
      )}
    </span>
  )
}

/** "This would cover N of M questions (now K)" with a few of each. */
function CoverageNote({ c, noun }: { c: Coverage | undefined; noun: string }) {
  if (!c) return null
  return (
    <div className='rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] dark:border-border dark:bg-muted/40'>
      <p className='font-medium text-slate-800 dark:text-slate-100'>
        This {noun} would reach {c.covered} of {c.total} questions in this topic
        <span className='font-normal text-slate-500 dark:text-muted-foreground'>
          {' '}
          (now {c.covered_before} {c.covered_before === 1 ? 'is' : 'are'} covered by one)
        </span>
      </p>
      {c.sample_covered.length > 0 && (
        <ul className='mt-1 list-disc pl-4 text-[11.5px] text-slate-600 dark:text-slate-300'>
          {c.sample_covered.slice(0, 3).map((q) => (
            <li key={q} className='truncate'>
              {q}
            </li>
          ))}
        </ul>
      )}
      {c.sample_missed.length > 0 && (
        <p className='mt-1 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          Still not reached, e.g. “{c.sample_missed[0].slice(0, 120)}”
        </p>
      )}
    </div>
  )
}

function useCoverage(topicId: string, days: string, body: Record<string, unknown> | null) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['nvr-ai-topic-coverage', topicId, days, JSON.stringify(body)],
    enabled: !!body,
    staleTime: 30_000,
    queryFn: () =>
      client.request<{ data: Coverage }>(
        post(`/ai-knowledge/topic-map/${topicId}/preview?days=${days}`, body)
      ),
    placeholderData: (prev) => prev
  })
}

function GlossaryAction({ t, days, done }: { t: Topic; days: string; done: () => void }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const initial: TermDraft = { ...blankDraft, term: t.name, collection: t.collections[0] ?? '' }
  const [draft, setDraft] = useState<{ term: string; aliases: string }>({
    term: initial.term,
    aliases: ''
  })
  // The coverage check follows the typing after a short pause.
  const [debounced, setDebounced] = useState(draft)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(draft), 400)
    return () => clearTimeout(id)
  }, [draft])
  const cov = useCoverage(
    t.id,
    days,
    debounced.term.trim()
      ? { kind: 'glossary', term: debounced.term, aliases: debounced.aliases }
      : null
  )
  const save = useMutation({
    mutationFn: (d: TermDraft) => client.request(post('/ai-knowledge/glossary', fromDraft(d))),
    onSuccess: () => {
      toast.success('Glossary term added')
      invalidateGlossary(client)
      void qc.invalidateQueries({ queryKey: ['nvr-ai-topic-map'] })
      done()
    },
    onError: (e) => toastError(e, 'The term was not saved')
  })
  return (
    <div className='flex flex-col gap-2'>
      <p className='text-[12px] text-slate-600 dark:text-slate-300'>
        Ask AI reads the definition whenever a question uses the term or one of its other spellings.
        Edit the term and spellings to see how many of this topic's questions it would reach.
      </p>
      <TermForm
        initial={initial}
        onDraftChange={(d) => setDraft({ term: d.term, aliases: d.aliases })}
        busy={save.isPending}
        onSave={(d) => save.mutate(d)}
        onCancel={done}
      />
      <CoverageNote c={cov.data?.data} noun='term' />
    </div>
  )
}

function GuideAction({
  t,
  days,
  questions,
  done
}: {
  t: Topic
  days: string
  questions: TopicQuestion[]
  done: () => void
}) {
  const [collection, setCollection] = useState(t.collections[0] ?? '')
  const examples = questions
    .filter((q) => q.question.length >= 12)
    .slice(0, 4)
    .map((q) => q.question)
  return (
    <div className='flex flex-col gap-2'>
      <p className='text-[12px] text-slate-600 dark:text-slate-300'>
        A data guide rides Ask AI's prompt when a question names its collection or looks like one of
        its example questions. Four of this topic's questions are added as examples; edit before
        saving.
      </p>
      <div className='w-full max-w-[320px]'>
        <SimpleSelect
          value={collection}
          onChange={setCollection}
          ariaLabel='Collection'
          className='h-8 text-[12.5px]'
          options={[
            { value: '', label: 'Pick the collection the answers read' },
            ...t.collections.map((c) => ({ value: c, label: c }))
          ]}
        />
      </div>
      {collection && (
        <DataGuideCard
          key={collection}
          collection={collection}
          addExamples={examples}
          onSaved={done}
          renderPreview={(d) => (
            <GuidePreview t={t} days={days} collection={collection} examples={d.examples} />
          )}
        />
      )}
    </div>
  )
}

function GuidePreview({
  t,
  days,
  collection,
  examples
}: {
  t: Topic
  days: string
  collection: string
  examples: string[]
}) {
  const cov = useCoverage(t.id, days, { kind: 'guide', collection, examples })
  return <CoverageNote c={cov.data?.data} noun='guide' />
}

function StatusAction({ t, days, done }: { t: Topic; days: string; done: () => void }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [status, setStatus] = useState<'handled' | 'ignored'>(
    t.status === 'ignored' ? 'ignored' : 'handled'
  )
  const [note, setNote] = useState('')
  const save = useMutation({
    mutationFn: (s: 'handled' | 'ignored' | 'open') =>
      client.request(
        post(`/ai-knowledge/topic-map/${t.id}/status?days=${days}`, { status: s, note })
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nvr-ai-topic-map'] })
      done()
    },
    onError: (e) => toastError(e, 'The topic was not updated')
  })
  return (
    <div className='flex flex-col gap-2'>
      <div className='self-start'>
        <Segmented
          ariaLabel='Mark the topic'
          value={status}
          onChange={setStatus}
          options={[
            { value: 'handled', label: 'Handled' },
            { value: 'ignored', label: 'Ignore' }
          ]}
        />
      </div>
      <p className='text-[12px] text-slate-600 dark:text-slate-300'>
        {status === 'handled'
          ? 'The topic leaves the Open list. Questions asked after today are counted as “new since” so you can see whether the fix worked.'
          : 'The topic leaves the Open list and stops counting as a gap. Nothing changes in what Ask AI knows.'}{' '}
        It stays marked as the topic is re-clustered; Undo puts it back.
      </p>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        placeholder={status === 'handled' ? 'What was done (optional)' : 'Why (optional)'}
        aria-label='Note'
        className='h-8 rounded-md border border-slate-200 bg-white px-2 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:bg-background'
      />
      <div className='flex gap-2'>
        <button
          type='button'
          disabled={save.isPending}
          onClick={() => save.mutate(status)}
          className='inline-flex h-8 items-center rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white hover:bg-nvr-cyan/90 disabled:opacity-50'
        >
          {save.isPending ? 'Saving…' : status === 'handled' ? 'Mark handled' : 'Ignore this topic'}
        </button>
        {t.status !== 'open' && (
          <button
            type='button'
            onClick={() => save.mutate('open')}
            className='inline-flex h-8 items-center rounded-md border border-slate-200 px-3 text-[12.5px] hover:bg-slate-50 dark:border-border dark:hover:bg-muted'
          >
            Reopen
          </button>
        )}
        <button
          type='button'
          onClick={done}
          className='h-8 rounded-md px-3 text-[12.5px] text-slate-500 hover:bg-slate-50 dark:hover:bg-muted'
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function RenameAction({ t, days, done }: { t: Topic; days: string; done: () => void }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [name, setName] = useState(t.name)
  const save = useMutation({
    mutationFn: () =>
      client.request(post(`/ai-knowledge/topic-map/${t.id}/rename?days=${days}`, { name })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nvr-ai-topic-map'] })
      done()
    },
    onError: (e) => toastError(e, 'The topic was not renamed')
  })
  return (
    <form
      className='flex flex-wrap items-center gap-2'
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim() && name.trim() !== t.name) save.mutate()
      }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={60}
        aria-label='Topic name'
        className='h-8 min-w-[220px] flex-1 rounded-md border border-slate-200 bg-white px-2 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:bg-background'
      />
      <button
        type='submit'
        disabled={!name.trim() || name.trim() === t.name || save.isPending}
        className='inline-flex h-8 items-center rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white hover:bg-nvr-cyan/90 disabled:opacity-50'
      >
        Rename
      </button>
      <button
        type='button'
        onClick={done}
        className='h-8 rounded-md px-3 text-[12.5px] text-slate-500 hover:bg-slate-50 dark:hover:bg-muted'
      >
        Cancel
      </button>
      <p className='w-full text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        The name stays with these questions when the map is rebuilt; Undo goes back to the generated
        name.
      </p>
    </form>
  )
}

function MergeAction({
  t,
  all,
  days,
  done
}: {
  t: Topic
  all: Topic[]
  days: string
  done: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [into, setInto] = useState('')
  const target = all.find((x) => x.id === into)
  const save = useMutation({
    mutationFn: () =>
      client.request(post(`/ai-knowledge/topic-map/${t.id}/merge?days=${days}`, { into })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nvr-ai-topic-map'] })
      done()
    },
    onError: (e) => toastError(e, 'The topics were not merged')
  })
  return (
    <div className='flex flex-col gap-2'>
      <div className='w-full max-w-[360px]'>
        <SimpleSelect
          value={into}
          onChange={setInto}
          ariaLabel='Merge into'
          className='h-8 text-[12.5px]'
          options={[
            { value: '', label: 'Merge into…' },
            ...all
              .filter((x) => x.id !== t.id)
              .map((x) => ({ value: x.id, label: `${x.name} (${x.volume})` }))
          ]}
        />
      </div>
      {target && (
        <p className='text-[12px] text-slate-600 dark:text-slate-300'>
          “{t.name}” ({t.volume}) joins “{target.name}” ({target.volume}): one topic of{' '}
          {t.volume + target.volume} questions, named “{target.name}”. The merge is redone every
          time the map is rebuilt; Undo splits them again.
        </p>
      )}
      <div className='flex gap-2'>
        <button
          type='button'
          disabled={!into || save.isPending}
          onClick={() => save.mutate()}
          className='inline-flex h-8 items-center rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white hover:bg-nvr-cyan/90 disabled:opacity-50'
        >
          {save.isPending ? 'Merging…' : 'Merge'}
        </button>
        <button
          type='button'
          onClick={done}
          className='h-8 rounded-md px-3 text-[12.5px] text-slate-500 hover:bg-slate-50 dark:hover:bg-muted'
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function PlaybookPanel({ q, onClose }: { q: TopicQuestion; onClose: () => void }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const preview = useQuery({
    queryKey: ['nvr-ai-topic-playbook', q.request_id],
    queryFn: () =>
      client.request<{ data: PlaybookPreview }>(
        post('/ai-knowledge/topic-map/playbook', { request_id: q.request_id })
      )
  })
  const save = useMutation({
    mutationFn: () =>
      client.request<{ data: PlaybookPreview }>(
        post('/ai-knowledge/topic-map/playbook', { request_id: q.request_id, save: true })
      ),
    onSuccess: () => {
      toast.success('Kept as a playbook')
      void qc.invalidateQueries({ queryKey: ['nvr-ai-topic-map'] })
      onClose()
    },
    onError: (e) => toastError(e, 'The playbook was not saved')
  })
  const p = preview.data?.data
  return (
    <div className='mt-2 rounded-md border border-slate-200 bg-white p-3 text-[12px] animate-in fade-in-0 slide-in-from-top-1 duration-150 motion-reduce:animate-none dark:border-border dark:bg-card'>
      {preview.isLoading ? (
        <Skeleton className='h-12 w-full' />
      ) : preview.isError ? (
        <QueryErrorState
          error={preview.error}
          what='the plan'
          onRetry={() => void preview.refetch()}
        />
      ) : p ? (
        <>
          <p className='text-slate-700 dark:text-slate-200'>
            Ask AI will offer this plan as a worked example to anyone who asks something similar
            {p.replaces ? ' (it replaces the playbook kept for the same question)' : ''}:
          </p>
          {p.plan.length ? (
            <ol className='mt-1.5 list-decimal pl-5 font-mono text-[11px] text-slate-700 dark:text-slate-300'>
              {p.plan.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: plan steps in order
                <li key={i} className='break-words'>
                  {s.tool}({JSON.stringify(s.input).slice(0, 160)})
                </li>
              ))}
            </ol>
          ) : (
            <p className='mt-1 text-amber-800 dark:text-[#e2b192]'>
              The answer used no tools that worked, so there is no plan to keep.
            </p>
          )}
          {p.skipped_errors > 0 && (
            <p className='mt-1 text-[11.5px] text-slate-500'>
              {p.skipped_errors} failed step(s) are left out.
            </p>
          )}
          <div className='mt-2 flex gap-2'>
            <button
              type='button'
              disabled={!p.plan.length || !p.answered || save.isPending}
              onClick={() => save.mutate()}
              className='inline-flex h-7 items-center rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white hover:bg-nvr-cyan/90 disabled:opacity-50'
            >
              {save.isPending ? 'Saving…' : 'Keep as playbook'}
            </button>
            <button
              type='button'
              onClick={onClose}
              className='h-7 rounded-md px-2.5 text-[12px] text-slate-500 hover:bg-slate-50 dark:hover:bg-muted'
            >
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

function QuestionsList({
  questions,
  onOpen
}: {
  questions: TopicQuestion[]
  onOpen: (callId: number) => void
}) {
  const [playbookFor, setPlaybookFor] = useState<string | null>(null)
  return (
    <ul className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border/60 dark:border-border'>
      {questions.map((q) => (
        <li key={q.request_id} className='px-3 py-2' data-ai-topic-question>
          <div className='flex flex-wrap items-start gap-x-3 gap-y-1'>
            <button
              type='button'
              disabled={q.call_id == null}
              onClick={() => q.call_id != null && onOpen(q.call_id)}
              className='min-w-0 flex-1 rounded text-left text-[12.5px] text-slate-900 hover:text-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-foreground'
              data-tip='Open the call and its conversation'
            >
              <span className='line-clamp-2 break-words'>{q.question}</span>
            </button>
            <span className='flex shrink-0 items-center gap-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
              {q.unanswered && (
                <span className='rounded bg-amber-50 px-1.5 py-px text-amber-800 dark:bg-[#d4936a]/10 dark:text-[#e2b192]'>
                  unanswered
                </span>
              )}
              {q.thumbs_down && (
                <ThumbsDown
                  className='h-3 w-3 text-red-700 dark:text-[#eaa3a3]'
                  aria-label='Thumbs down'
                />
              )}
              {q.thumbs_up && (
                <ThumbsUp
                  className='h-3 w-3 text-green-700 dark:text-[#b9d3a6]'
                  aria-label='Thumbs up'
                />
              )}
              {q.since_status && (
                <span className='text-amber-700 dark:text-[#e2b192]'>new since marked</span>
              )}
              <span className='tabular-nums'>{usd(q.cost)}</span>
            </span>
          </div>
          <div className='mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
            <span>{q.asked_by ?? 'Someone'}</span>
            <span>· {q.role}</span>
            {q.at && (
              <span>
                ·{' '}
                {new Date(q.at).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit'
                })}
              </span>
            )}
            {!q.unanswered && (
              <button
                type='button'
                onClick={() => setPlaybookFor(playbookFor === q.request_id ? null : q.request_id)}
                className='ml-auto inline-flex items-center gap-1 rounded text-nvr-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
              >
                <Library className='h-3 w-3' aria-hidden /> Keep as playbook
              </button>
            )}
          </div>
          {playbookFor === q.request_id && (
            <PlaybookPanel q={q} onClose={() => setPlaybookFor(null)} />
          )}
        </li>
      ))}
    </ul>
  )
}

function ActionButton({
  icon,
  label,
  on,
  onClick
}: {
  icon: ReactNode
  label: string
  on?: boolean
  onClick: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
        on
          ? 'border-nvr-cyan/60 bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-muted'
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function TopicDetail({
  t,
  all,
  days,
  onOpenCall,
  onOpenSuggestions
}: {
  t: Topic
  all: Topic[]
  days: string
  onOpenCall: (id: number) => void
  onOpenSuggestions?: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [action, setAction] = useState<Action>(null)
  const [section, setSection] = useState<'questions' | 'roles' | 'docs'>('questions')
  const questions = useQuery({
    queryKey: ['nvr-ai-topic-questions', t.id, days],
    queryFn: () =>
      client.request<{ data: TopicQuestion[] }>(
        get(`/ai-knowledge/topic-map/${t.id}/questions`, { days })
      ),
    staleTime: 5 * 60_000
  })
  const docs = useQuery({
    queryKey: ['nvr-ai-topic-docs', t.id, days],
    enabled: section === 'docs',
    queryFn: () =>
      client.request<{ data: Array<{ id: number; query: string; created_at: string }> }>(
        get(`/ai-knowledge/topic-map/${t.id}/docs-gaps`, { days })
      )
  })
  const undo = useMutation({
    mutationFn: (id: string) => client.request(del(`/ai-knowledge/topic-map/overrides/${id}`)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nvr-ai-topic-map'] }),
    onError: (e) => toastError(e, 'Could not undo')
  })
  const toggle = (a: Action) => setAction(action === a ? null : a)
  const done = () => setAction(null)
  return (
    <div className='flex flex-col gap-3 border-t border-slate-100 px-4 py-3 dark:border-border/60'>
      {t.gap && (
        <p className='text-[12px] text-amber-800 dark:text-[#e2b192]'>
          {t.note}. Missing: {t.missing.map((m) => MISSING_LABEL[m]).join(', ')}.
          {onOpenSuggestions && (
            <>
              {' '}
              <button type='button' className='underline' onClick={onOpenSuggestions}>
                Draft suggestions
              </button>
            </>
          )}
        </p>
      )}
      <div className='flex flex-wrap gap-1.5' role='toolbar' aria-label='Actions'>
        <ActionButton
          icon={<BookOpen className='h-3.5 w-3.5' aria-hidden />}
          label='Add glossary term'
          on={action === 'glossary'}
          onClick={() => toggle('glossary')}
        />
        <ActionButton
          icon={<Wand2 className='h-3.5 w-3.5' aria-hidden />}
          label='Add data guide'
          on={action === 'guide'}
          onClick={() => toggle('guide')}
        />
        <ActionButton
          icon={<Check className='h-3.5 w-3.5' aria-hidden />}
          label={t.status === 'open' ? 'Mark handled / ignore' : 'Change status'}
          on={action === 'status'}
          onClick={() => toggle('status')}
        />
        <ActionButton
          icon={<Pencil className='h-3.5 w-3.5' aria-hidden />}
          label='Rename'
          on={action === 'rename'}
          onClick={() => toggle('rename')}
        />
        <ActionButton
          icon={<GitMerge className='h-3.5 w-3.5' aria-hidden />}
          label='Merge into…'
          on={action === 'merge'}
          onClick={() => toggle('merge')}
        />
      </div>
      {t.overrides.length > 0 && (
        <ul className='flex flex-wrap gap-1.5'>
          {t.overrides.map((o) => (
            <li
              key={o.id}
              className='inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 py-px pl-2 pr-1 text-[11px] text-slate-600 dark:border-border dark:bg-muted dark:text-muted-foreground'
            >
              {o.label}
              <button
                type='button'
                aria-label={`Undo: ${o.label}`}
                data-tip='Undo'
                onClick={() => undo.mutate(o.id)}
                className='inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-border'
              >
                <Undo2 className='h-3 w-3' aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Fold open={action != null}>
        <div className='rounded-lg border border-nvr-cyan/30 bg-slate-50/60 p-3 dark:bg-muted/20'>
          {action === 'glossary' && <GlossaryAction t={t} days={days} done={done} />}
          {action === 'guide' && (
            <GuideAction t={t} days={days} questions={questions.data?.data ?? []} done={done} />
          )}
          {action === 'status' && <StatusAction t={t} days={days} done={done} />}
          {action === 'rename' && <RenameAction t={t} days={days} done={done} />}
          {action === 'merge' && <MergeAction t={t} all={all} days={days} done={done} />}
        </div>
      </Fold>
      <div className='self-start'>
        <Segmented
          ariaLabel='Show'
          value={section}
          onChange={setSection}
          options={[
            { value: 'questions', label: `Questions (${t.volume})` },
            { value: 'roles', label: 'By role' },
            { value: 'docs', label: 'Docs gaps' }
          ]}
        />
      </div>
      {section === 'questions' &&
        (questions.isLoading ? (
          <Skeleton className='h-24 w-full' />
        ) : questions.isError ? (
          <QueryErrorState
            error={questions.error}
            what='the questions'
            onRetry={() => void questions.refetch()}
          />
        ) : (
          <QuestionsList questions={questions.data?.data ?? []} onOpen={onOpenCall} />
        ))}
      {section === 'roles' && (
        <div className='overflow-x-auto'>
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
                <tr key={r.role} className='border-t border-slate-100 dark:border-border/60'>
                  <td className='py-1'>{r.role}</td>
                  <td className='py-1 text-right tabular-nums'>{r.volume}</td>
                  <td className='py-1 text-right tabular-nums'>{pct(r.unanswered_rate)}</td>
                  <td className='py-1 text-right tabular-nums'>{pct(r.thumbs_down_rate)}</td>
                  <td className='py-1 text-right tabular-nums'>{usd(r.avg_cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {section === 'docs' &&
        (docs.isLoading ? (
          <Skeleton className='h-12 w-full' />
        ) : docs.isError ? (
          <QueryErrorState
            error={docs.error}
            what='the docs gaps'
            onRetry={() => void docs.refetch()}
          />
        ) : (docs.data?.data ?? []).length === 0 ? (
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            No docs search came up empty while answering these questions.
          </p>
        ) : (
          <ul className='flex flex-col gap-1'>
            {(docs.data?.data ?? []).map((d) => (
              <li key={d.id} className='flex items-start gap-1.5 text-[12px]'>
                <FileQuestion className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
                <span className='min-w-0 break-words'>“{d.query}”</span>
              </li>
            ))}
          </ul>
        ))}
    </div>
  )
}

export function TopicMapTab({ onOpenSuggestions }: { onOpenSuggestions?: () => void }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [days, setDays] = useState('30')
  const [open, setOpen] = useState<string | null>(null)
  const [gapsOnly, setGapsOnly] = useState(false)
  const [status, setStatus] = useState<StatusFilter>('open')
  const [sort, setSort] = useState<SortKey>('volume')
  const [find, setFind] = useState('')
  const [callId, setCallId] = useState<number | null>(null)
  const [thread, setThread] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const q = useQuery({
    queryKey: ['nvr-ai-topic-map', days],
    staleTime: 5 * 60_000,
    queryFn: () => client.request<{ data: TopicMapData }>(get('/ai-knowledge/topic-map', { days }))
  })
  const rebuild = async () => {
    setRebuilding(true)
    try {
      const fresh = await client.request<{ data: TopicMapData }>(
        get('/ai-knowledge/topic-map', { days, fresh: '1' })
      )
      qc.setQueryData(['nvr-ai-topic-map', days], fresh)
    } catch (e) {
      toastError(e, 'The topic map was not rebuilt')
    } finally {
      setRebuilding(false)
    }
  }
  const d = q.data?.data
  const all = d?.topics ?? []
  const counts = useMemo(
    () => ({
      open: all.filter((t) => t.status === 'open').length,
      handled: all.filter((t) => t.status === 'handled').length,
      ignored: all.filter((t) => t.status === 'ignored').length
    }),
    [all]
  )
  const topics = all
    .filter((t) => status === 'all' || t.status === status)
    .filter((t) => !gapsOnly || t.gap)
    .filter((t) => !find.trim() || t.name.toLowerCase().includes(find.trim().toLowerCase()))
    .sort((a, b) => SORTS[sort](b) - SORTS[sort](a) || b.volume - a.volume)
  return (
    <div className='flex flex-col gap-3' data-ai-topic-map>
      <div className='flex flex-wrap items-center gap-2'>
        <Segmented
          ariaLabel='Window'
          value={days}
          onChange={setDays}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' }
          ]}
        />
        <Segmented
          ariaLabel='Status'
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: `Open${d ? ` ${counts.open}` : ''}` },
            { value: 'handled', label: `Handled${d ? ` ${counts.handled}` : ''}` },
            { value: 'ignored', label: `Ignored${d ? ` ${counts.ignored}` : ''}` },
            { value: 'all', label: 'All' }
          ]}
        />
        <div className='w-[170px]'>
          <SimpleSelect
            value={sort}
            onChange={(v) => setSort(v as SortKey)}
            ariaLabel='Sort topics'
            className='h-8 text-[12px]'
            options={[
              { value: 'volume', label: 'Most questions' },
              { value: 'unanswered', label: 'Most unanswered' },
              { value: 'down', label: 'Most thumbs-down' },
              { value: 'cost', label: 'Highest cost' },
              { value: 'trend', label: 'Growing fastest' }
            ]}
          />
        </div>
        <label className='inline-flex items-center gap-1.5 text-[12px]'>
          <input
            type='checkbox'
            checked={gapsOnly}
            onChange={(e) => setGapsOnly(e.target.checked)}
          />
          Only gaps
        </label>
        <label className='relative flex min-w-[160px] flex-1 items-center sm:max-w-[240px]'>
          <span className='sr-only'>Find a topic</span>
          <Search
            className='pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400'
            aria-hidden
          />
          <input
            type='search'
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder='Find a topic'
            className='h-8 w-full rounded-md border border-slate-200 bg-white pl-8 pr-2 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:bg-card'
          />
        </label>
        <button
          type='button'
          onClick={() => void rebuild()}
          disabled={rebuilding || q.isFetching}
          data-tip='Group the questions again now (the map is otherwise reused for ten minutes)'
          className='ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[12px] text-slate-600 hover:bg-slate-50 disabled:opacity-60 dark:border-border dark:bg-card dark:text-muted-foreground dark:hover:bg-muted'
        >
          <RotateCw
            className={cn(
              'h-3.5 w-3.5',
              (rebuilding || q.isFetching) && 'animate-spin motion-reduce:animate-none'
            )}
            aria-hidden
          />
          {rebuilding ? 'Re-clustering…' : 'Re-cluster'}
        </button>
      </div>
      <p className='max-w-[80ch] text-[11.5px] text-muted-foreground'>
        Questions people asked Ask AI, grouped by meaning, with the window before for the trend.
        Open a topic to read its questions (that is logged), follow one to its conversation, and act
        on it.
        {d?.named_by === 'keywords' &&
          ' Topic names come from common words because AI naming is unavailable.'}
        {d && ` ${d.total_questions} questions in ${all.length} topics.`}
      </p>
      {q.isLoading ? (
        <div className='flex flex-col gap-2'>
          <Skeleton className='h-14 w-full' />
          <Skeleton className='h-14 w-full' />
          <Skeleton className='h-14 w-full' />
        </div>
      ) : q.isError ? (
        <QueryErrorState error={q.error} what='the topic map' onRetry={() => void q.refetch()} />
      ) : !topics.length ? (
        <div className='rounded-lg border border-dashed border-slate-300 p-8 text-center text-[12.5px] text-muted-foreground dark:border-border'>
          {all.length === 0
            ? 'No Ask AI questions in this window.'
            : gapsOnly
              ? 'No topic here has a gap.'
              : find.trim()
                ? 'No topic name matches.'
                : status === 'open'
                  ? 'Every topic in this window is handled or ignored.'
                  : `No ${status} topics in this window.`}
        </div>
      ) : (
        <ul className='flex flex-col gap-2'>
          {topics.map((t) => {
            const isOpen = open === t.id
            const total = t.daily.reduce((s, n) => s + n, 0)
            return (
              <li
                key={t.id}
                data-ai-topic={t.id}
                className={cn(
                  'rounded-lg border bg-white transition-shadow dark:bg-card',
                  isOpen
                    ? 'border-slate-300 shadow-sm dark:border-border'
                    : 'border-slate-200 dark:border-border'
                )}
              >
                <button
                  type='button'
                  onClick={() => setOpen(isOpen ? null : t.id)}
                  aria-expanded={isOpen}
                  className='flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg px-4 py-3 lg:grid lg:grid-cols-[14px_minmax(0,1fr)_84px_116px_112px_120px_104px] text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted/40'
                >
                  <ChevronRight
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
                      isOpen && 'rotate-90'
                    )}
                    aria-hidden
                  />
                  <span className='flex min-w-[180px] flex-1 flex-wrap items-center gap-2'>
                    <span className='text-[13px] font-semibold'>{t.name}</span>
                    {t.renamed_from && (
                      <span
                        className='text-[10.5px] text-slate-400'
                        data-tip={`Generated name: ${t.renamed_from}`}
                      >
                        renamed
                      </span>
                    )}
                    {t.merged > 0 && (
                      <span className='text-[10.5px] text-slate-400'>+{t.merged} merged</span>
                    )}
                    {t.gap && t.status === 'open' && (
                      <span className='rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-[#d4936a]/10 dark:text-[#e2b192]'>
                        Gap
                      </span>
                    )}
                    <StatusBadge t={t} />
                  </span>
                  <Spark
                    daily={t.daily}
                    label={`${total} questions over ${d?.days ?? days} days`}
                  />
                  <span className='inline-flex items-center gap-1.5'>
                    <Fig
                      label={t.volume === 1 ? 'question' : 'questions'}
                      value={String(t.volume)}
                    />
                    <Trend t={t} />
                  </span>
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
                </button>
                <Fold open={isOpen}>
                  <TopicDetail
                    t={t}
                    all={all}
                    days={days}
                    onOpenCall={(id) => {
                      setThread(false)
                      setCallId(id)
                    }}
                    onOpenSuggestions={onOpenSuggestions}
                  />
                </Fold>
              </li>
            )
          })}
        </ul>
      )}
      <CallDrawer
        callId={callId}
        threadOpen={thread}
        onClose={() => {
          setCallId(null)
          setThread(false)
        }}
        onOpenCall={(id) => {
          setThread(false)
          setCallId(id)
        }}
        onThread={setThread}
      />
    </div>
  )
}
