import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CornerDownRight, RotateCw, ThumbsDown, ThumbsUp } from 'lucide-react'
import { useId, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Skeleton } from '../../ui/skeleton'
import { Textarea } from '../../ui/textarea'
import { helpVideoApi } from '../api'
import type { HelpVideoDto, HelpVideoQuestion } from '../types'
import { fmtMoment } from '../viewer/feedback'

/** Puts an answer into the draft as a chapter or caption at the question's
 *  moment (edited time); answers the reason when it cannot, else null. */
export type AnswerEdit = (
  kind: 'chapter' | 'caption',
  editedMs: number,
  text: string
) => string | null

const ANSWER_MAX = 2000

export function StatsTab({
  video,
  onJump,
  onAnswerEdit
}: {
  video: HelpVideoDto
  /** Shows the Edit tab at this moment (edited time). */
  onJump?: (editedMs: number) => void
  onAnswerEdit?: AnswerEdit
}) {
  const client = useNivaroClient()
  const q = useQuery({
    queryKey: ['help-videos', 'analytics', video.id],
    queryFn: () => helpVideoApi(client).analytics(video.id)
  })
  const a = q.data
  if (q.error)
    return (
      <div
        className='flex items-center gap-2 p-5 text-[13px] text-rose-700 dark:text-rose-300'
        role='alert'
      >
        <AlertCircle className='h-4 w-4' aria-hidden />
        <span>The stats couldn't load. {(q.error as Error).message}</span>
        <Button size='sm' variant='outline' className='h-7' onClick={() => void q.refetch()}>
          <RotateCw className='!size-3.5' /> Try again
        </Button>
      </div>
    )
  if (!a)
    return (
      <div
        className='max-w-[760px] space-y-4 p-5'
        role='status'
        aria-busy='true'
        aria-label='Loading stats'
      >
        <Skeleton className='h-16 w-full' />
        <Skeleton className='h-28 w-full' />
      </div>
    )
  const ratings = a.ratings ?? { up: 0, down: 0, helpful_rate: 0 }
  const questions = a.questions ?? []
  const votes = ratings.up + ratings.down
  if (!a.unique_viewers && !votes && !questions.length)
    return (
      <div className='max-w-[65ch] space-y-1 p-5 text-[13px]' data-hv-stats-empty>
        <p className='font-medium text-foreground'>Nobody has watched this yet.</p>
        <p className='text-muted-foreground'>
          Once people watch, you will see how many finished it, where they stopped, whether it
          helped, and the questions they asked.
        </p>
      </div>
    )
  return (
    <div className='max-w-[760px] space-y-6 p-5 text-[13px]' data-hv-stats>
      <dl className='grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4'>
        {[
          ['People who watched', String(a.unique_viewers)],
          ['Watched most of it', `${Math.round(a.completion_rate * 100)}%`],
          ['Hours watched', String(a.watched_hours)]
        ].map(([k, v]) => (
          <div key={k} className='bg-card p-3'>
            <dt className='text-[12px] text-muted-foreground'>{k}</dt>
            <dd className='text-[18px] font-semibold tabular-nums text-foreground'>{v}</dd>
          </div>
        ))}
        <div className='bg-card p-3' data-hv-stats-ratings={`${ratings.up}/${ratings.down}`}>
          <dt className='text-[12px] text-muted-foreground'>Found it helpful</dt>
          <dd className='text-[18px] font-semibold tabular-nums text-foreground'>
            {votes ? `${Math.round(ratings.helpful_rate * 100)}%` : '—'}
          </dd>
          <dd className='flex items-center gap-2 text-[12px] text-muted-foreground'>
            <span className='inline-flex items-center gap-1'>
              <ThumbsUp className='h-3 w-3' aria-hidden /> {ratings.up}
            </span>
            <span className='inline-flex items-center gap-1'>
              <ThumbsDown className='h-3 w-3' aria-hidden /> {ratings.down}
            </span>
            <span className='sr-only'>
              {ratings.up} found it helpful, {ratings.down} did not
            </span>
          </dd>
        </div>
      </dl>
      {a.unique_viewers > 0 && (
        <section>
          <h3 className='mb-2 text-[13px] font-semibold text-foreground'>Where people stop</h3>
          <p className='sr-only'>Share of viewers who reached each part of the video.</p>
          <div
            className='flex h-28 items-end gap-1 border-b border-border'
            aria-hidden
            data-hv-dropoff
          >
            {a.drop_off.map((v, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed 5% sections
                key={i}
                className='flex-1 rounded-t-sm bg-nvr-navy dark:bg-nvr-cyan'
                style={{ height: `${Math.max(2, v * 100)}%` }}
                title={`${i * 5}–${i * 5 + 5}% of the video: ${Math.round(v * 100)}% of viewers`}
              />
            ))}
          </div>
          <ul className='sr-only' data-hv-dropoff-list>
            {a.drop_off.map((v, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed 5% sections
              <li key={i}>
                {i * 5}–{i * 5 + 5}% of the video: {Math.round(v * 100)}% of viewers still watching
              </li>
            ))}
          </ul>
          <div className='mt-1 flex justify-between text-[12px] text-muted-foreground'>
            <span>Start</span>
            <span>End</span>
          </div>
        </section>
      )}
      <section data-hv-stats-questions={questions.length}>
        <h3 className='mb-2 text-[13px] font-semibold text-foreground'>
          Questions{questions.length ? ` (${questions.length})` : ''}
        </h3>
        {questions.length === 0 ? (
          <p className='text-muted-foreground'>
            Nobody has asked a question yet. Viewers can ask one at any moment of the video.
          </p>
        ) : (
          <ul className='space-y-2'>
            {questions.map((item) => (
              <QuestionRow
                key={item.id}
                video={video}
                item={item}
                onJump={onJump}
                onAnswerEdit={onAnswerEdit}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function QuestionRow({
  video,
  item,
  onJump,
  onAnswerEdit
}: {
  video: HelpVideoDto
  item: HelpVideoQuestion
  onJump?: (editedMs: number) => void
  onAnswerEdit?: AnswerEdit
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [answering, setAnswering] = useState(false)
  const [text, setText] = useState('')
  const [asChapter, setAsChapter] = useState(false)
  const [asCaption, setAsCaption] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const textId = useId()
  const chapterId = useId()
  const captionId = useId()
  const moment = fmtMoment(item.at_ms)
  const send = useMutation({
    mutationFn: (answer: string) => helpVideoApi(client).answer(video.id, item.id, answer),
    onSuccess: (_r, answer) => {
      // The draft edits go through the normal path (autosave, then Publish).
      const refused: string[] = []
      if (asChapter && onAnswerEdit) {
        const why = onAnswerEdit('chapter', item.at_ms, answer)
        if (why) refused.push(`Chapter: ${why}`)
      }
      if (asCaption && onAnswerEdit) {
        const why = onAnswerEdit('caption', item.at_ms, answer)
        if (why) refused.push(`Caption: ${why}`)
      }
      setNote(refused.length ? refused.join(' · ') : null)
      setAnswering(false)
      setText('')
      void qc.invalidateQueries({ queryKey: ['help-videos', 'analytics', video.id] })
    },
    onError: (err) => setNote((err as Error).message || 'The answer was not saved.')
  })
  return (
    <li
      className='rounded-md border border-border px-3 py-2'
      data-hv-stats-question={item.id}
      data-hv-answered={item.answer ? '' : undefined}
    >
      <div className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground'>
        <span>{item.asked_by_name ?? 'Someone'}</span>
        <span aria-hidden>·</span>
        <span>{new Date(item.created_at).toLocaleDateString()}</span>
        <span aria-hidden>·</span>
        <button
          type='button'
          className='inline-flex items-center gap-1 rounded text-[#2563eb] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-sky-300'
          onClick={() => onJump?.(item.at_ms)}
          disabled={!onJump}
          data-hv-jump={item.at_ms}
        >
          Jump to {moment}
        </button>
        <span className='ml-auto'>{item.answer ? 'Answered' : 'Unanswered'}</span>
      </div>
      <p className='mt-1 whitespace-pre-line text-foreground'>{item.text}</p>
      {item.answer && (
        <p className='mt-1.5 flex gap-1.5 whitespace-pre-line border-l-2 border-nvr-cyan pl-2 text-foreground'>
          <CornerDownRight
            className='mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground'
            aria-hidden
          />
          <span>
            <span className='mr-1.5 text-[12px] text-muted-foreground'>
              {item.answered_by_name ?? 'Answer'}:
            </span>
            {item.answer}
          </span>
        </p>
      )}
      {!answering ? (
        <div className='mt-1.5'>
          <Button
            size='sm'
            variant='outline'
            className='h-7 text-[12px]'
            onClick={() => {
              setNote(null)
              setText(item.answer ?? '')
              setAnswering(true)
            }}
            data-hv-answer-open
          >
            {item.answer ? 'Change the answer' : 'Answer'}
          </Button>
        </div>
      ) : (
        <form
          className='mt-2 space-y-1.5'
          onSubmit={(e) => {
            e.preventDefault()
            const t = text.trim()
            if (!t) {
              setNote('Write the answer first')
              return
            }
            send.mutate(t)
          }}
          data-hv-answer-form
        >
          <label htmlFor={textId} className='sr-only'>
            Your answer
          </label>
          <Textarea
            id={textId}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={ANSWER_MAX}
            placeholder='Your answer (the person who asked is notified)'
            className='text-[13px]'
          />
          {onAnswerEdit && (
            <div className='flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]'>
              <label htmlFor={chapterId} className='inline-flex items-center gap-1.5'>
                <Checkbox
                  id={chapterId}
                  checked={asChapter}
                  onCheckedChange={(v) => setAsChapter(v === true)}
                  data-hv-answer-chapter
                />
                Also add as a chapter at {moment}
              </label>
              <label htmlFor={captionId} className='inline-flex items-center gap-1.5'>
                <Checkbox
                  id={captionId}
                  checked={asCaption}
                  onCheckedChange={(v) => setAsCaption(v === true)}
                  data-hv-answer-caption
                />
                Also add as a caption at {moment}
              </label>
            </div>
          )}
          <div className='flex flex-wrap items-center gap-2'>
            <Button
              type='submit'
              size='sm'
              className='h-7'
              disabled={send.isPending}
              data-hv-answer-send
            >
              {send.isPending ? 'Sending…' : 'Send answer'}
            </Button>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-7'
              onClick={() => setAnswering(false)}
            >
              Cancel
            </Button>
            <span className='ml-auto text-[12px] tabular-nums text-muted-foreground'>
              {text.length}/{ANSWER_MAX}
            </span>
          </div>
        </form>
      )}
      {note && (
        <p
          role='status'
          className='mt-1 text-[12px] text-amber-700 dark:text-amber-300'
          data-hv-answer-note
        >
          {note}
        </p>
      )}
    </li>
  )
}
