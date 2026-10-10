import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageCircleQuestion, ThumbsDown, ThumbsUp } from 'lucide-react'
import { useId, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import { Textarea } from '../../ui/textarea'
import { helpVideoApi, helpVideoError, helpVideoKeys, useHelpVideoQuestions } from '../api'
import type { HelpVideoDto } from '../types'
import { fmtMoment, myQuestions, QUESTION_MAX, questionMoment, questionProblem } from './feedback'

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none'
const thumb = `inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] font-medium transition-colors duration-150 disabled:opacity-60 ${focusRing}`
const thumbOff = 'border-border bg-background text-foreground hover:bg-muted'
const thumbOn = 'border-nvr-cyan bg-nvr-cyan/15 text-foreground'

/**
 * Under the player (#1505): "Was this helpful?" once the video is (nearly)
 * over, "Ask a question here" at any time, and this person's own questions
 * with their answers. Question and answer text is shown as text, never as
 * markup.
 */
export function FeedbackPanel({
  video,
  due,
  currentMs,
  totalMs
}: {
  video: HelpVideoDto
  /** The thumbs show (the end, the completion threshold, or already finished). */
  due: boolean
  /** The player's clock (edited time) now. */
  currentMs: () => number
  totalMs: number
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const q = useHelpVideoQuestions(video.id)
  const [asking, setAsking] = useState<{ at: number } | null>(null)
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const textId = useId()
  const refresh = () => qc.invalidateQueries({ queryKey: helpVideoKeys.questions(video.id) })

  const rate = useMutation({
    mutationFn: (helpful: boolean) => helpVideoApi(client).rate(video.id, helpful),
    onSuccess: (r) => {
      qc.setQueryData(helpVideoKeys.questions(video.id), (prev: typeof q.data) =>
        prev ? { ...prev, my_rating: r.helpful } : prev
      )
      void refresh()
    }
  })
  const ask = useMutation({
    mutationFn: (body: { at_ms: number; text: string }) => helpVideoApi(client).ask(video.id, body),
    onSuccess: () => {
      setAsking(null)
      setText('')
      setSent(true)
      void refresh()
    },
    onError: (err) => {
      const e = helpVideoError(err)
      setProblem(
        e?.code === 'HELP_VIDEO_MASQUERADE'
          ? 'Not while viewing as someone else.'
          : ((err as Error).message ?? 'The question could not be sent.')
      )
    }
  })

  const mine = q.data?.my_rating ?? null
  const rateFailed = rate.error ? helpVideoError(rate.error) : null
  const own = myQuestions(q.data?.questions ?? [])

  return (
    <section
      aria-label='Was this helpful?'
      className='space-y-2 text-[13px]'
      data-hv-feedback
      data-hv-feedback-due={due ? '' : undefined}
    >
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1.5'>
        {due && (
          <div className='flex items-center gap-1.5' data-hv-rating={mine === null ? '' : mine}>
            <span className='text-muted-foreground'>Was this helpful?</span>
            <button
              type='button'
              aria-pressed={mine === true}
              aria-label='Yes, helpful'
              disabled={rate.isPending}
              className={`${thumb} ${mine === true ? thumbOn : thumbOff}`}
              onClick={() => mine !== true && rate.mutate(true)}
              data-hv-thumb='up'
            >
              <ThumbsUp className='h-3.5 w-3.5' aria-hidden /> Yes
            </button>
            <button
              type='button'
              aria-pressed={mine === false}
              aria-label='No, not helpful'
              disabled={rate.isPending}
              className={`${thumb} ${mine === false ? thumbOn : thumbOff}`}
              onClick={() => mine !== false && rate.mutate(false)}
              data-hv-thumb='down'
            >
              <ThumbsDown className='h-3.5 w-3.5' aria-hidden /> No
            </button>
            {mine !== null && !rate.isPending && (
              <span className='text-[12px] text-muted-foreground' role='status'>
                Thanks.
              </span>
            )}
          </div>
        )}
        {!asking && (
          <button
            type='button'
            className={`inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[12.5px] font-medium transition-colors duration-150 hover:bg-muted ${focusRing}`}
            onClick={() => {
              setSent(false)
              setProblem(null)
              setAsking({ at: questionMoment(currentMs(), totalMs) })
            }}
            data-hv-ask
          >
            <MessageCircleQuestion className='h-3.5 w-3.5' aria-hidden /> Ask a question here
          </button>
        )}
        {sent && !asking && (
          <span className='text-[12px] text-muted-foreground' role='status' data-hv-ask-sent>
            Sent to the video’s author. You will hear back here and in your notifications.
          </span>
        )}
      </div>
      {rateFailed && (
        <p role='alert' className='text-[12px] text-rose-700 dark:text-rose-300'>
          {rateFailed.code === 'HELP_VIDEO_MASQUERADE'
            ? 'Not while viewing as someone else.'
            : 'Your vote was not saved. Try again.'}
        </p>
      )}
      {asking && (
        <form
          className='space-y-1.5 rounded-md border border-border bg-muted/40 p-3'
          onSubmit={(e) => {
            e.preventDefault()
            const p = questionProblem(text)
            setProblem(p)
            if (!p) ask.mutate({ at_ms: asking.at, text: text.trim() })
          }}
          data-hv-ask-form={asking.at}
        >
          <label htmlFor={textId} className='block text-[12.5px] font-medium text-foreground'>
            Your question about {fmtMoment(asking.at)}
          </label>
          <Textarea
            id={textId}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              if (problem) setProblem(null)
            }}
            maxLength={QUESTION_MAX}
            rows={3}
            autoFocus
            placeholder='What is unclear at this moment?'
            className='text-[13px]'
            aria-invalid={problem ? true : undefined}
          />
          <div className='flex flex-wrap items-center gap-2'>
            <Button
              type='submit'
              size='sm'
              className='h-8'
              disabled={ask.isPending}
              data-hv-ask-send
            >
              {ask.isPending ? 'Sending…' : 'Send to the author'}
            </Button>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-8'
              onClick={() => {
                setAsking(null)
                setProblem(null)
              }}
            >
              Cancel
            </Button>
            <span className='ml-auto text-[12px] tabular-nums text-muted-foreground'>
              {text.length}/{QUESTION_MAX}
            </span>
          </div>
          {problem && (
            <p role='alert' className='text-[12px] text-rose-700 dark:text-rose-300'>
              {problem}
            </p>
          )}
        </form>
      )}
      {own.length > 0 && (
        <ul className='space-y-1.5' aria-label='Your questions' data-hv-my-questions>
          {own.map((item) => (
            <li
              key={item.id}
              className='rounded-md border border-border px-3 py-2'
              data-hv-question={item.id}
            >
              <p className='whitespace-pre-line text-foreground'>
                <span className='mr-1.5 tabular-nums text-muted-foreground'>
                  {fmtMoment(item.at_ms)}
                </span>
                {item.text}
              </p>
              {item.answer ? (
                <p
                  className='mt-1 whitespace-pre-line border-l-2 border-nvr-cyan pl-2 text-foreground'
                  data-hv-answer
                >
                  <span className='mr-1.5 text-[12px] text-muted-foreground'>
                    {item.answered_by_name ? `${item.answered_by_name}:` : 'Answer:'}
                  </span>
                  {item.answer}
                </p>
              ) : (
                <p className='mt-0.5 text-[12px] text-muted-foreground'>Waiting for an answer.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
