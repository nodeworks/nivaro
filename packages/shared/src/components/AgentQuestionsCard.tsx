import { useQueryClient } from '@tanstack/react-query'
import { Bot } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useApiFetchConfig, useItemNavigation } from '../context'
import { userErrorMessage } from '../lib/safe-error'
import { cn, formatRelative } from '../lib/utils'
import { Textarea } from './ui/textarea'

/**
 * Questions from assistants (#3220) — an agent connected to Nivaro (Claude, ChatGPT, a
 * script with an API key) asked this person something with ask_human and is waiting. My Work
 * shows them first; a choice is one click, free text is a short reply. Answers go in from a
 * signed-in browser session only (the API refuses every agent credential).
 *
 * `?focus=question:<id>` (the notification's link) scrolls to that question and marks it.
 */

export interface AgentQuestionRow {
  id: string
  status: string
  question: string
  choices: string[]
  allow_text: boolean
  collection: string | null
  item: string | null
  asked_by: string
  asked_for: string
  asked_for_name: string | null
  recipient: string
  expires_at: string
  created_at: string
}

function focusedQuestionId(): string | null {
  try {
    const f = new URLSearchParams(window.location.search).get('focus') ?? ''
    const m = /^question:([0-9a-f-]{36})/i.exec(f)
    return m ? m[1].toLowerCase() : null
  } catch {
    return null
  }
}

function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'Expired'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `Expires in ${mins} min`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `Expires in ${hrs} h`
  return `Expires in ${Math.round(hrs / 24)} days`
}

export function AgentQuestionsCard({ questions }: { questions: AgentQuestionRow[] }) {
  const focus = useRef(focusedQuestionId()).current
  const [done, setDone] = useState<Record<string, string>>({})
  if (questions.length === 0 && Object.keys(done).length === 0) return null
  const open = questions.filter((q) => !done[q.id]).length
  return (
    <section
      className='rounded-lg border border-nvr-cyan/30 bg-white dark:border-nvr-cyan/25 dark:bg-card'
      data-my-work-questions
      aria-labelledby='my-work-questions-title'
    >
      <div className='border-b border-slate-200 px-4 py-2.5 dark:border-border'>
        <h2
          id='my-work-questions-title'
          className='flex items-center gap-1.5 text-[13px] font-medium'
        >
          <Bot className='h-3.5 w-3.5 text-[#0e7490] dark:text-[#67e8f9]' aria-hidden />
          Questions from assistants
          {open > 0 && (
            <span className='rounded-full bg-nvr-cyan/10 px-1.5 text-[10.5px] font-semibold tabular-nums text-[#0e7490] dark:text-[#67e8f9]'>
              {open}
            </span>
          )}
        </h2>
        <p className='text-[11px] text-muted-foreground'>
          An assistant is waiting for your answer before it carries on.
        </p>
      </div>
      <ul className='divide-y divide-slate-100 dark:divide-border/60'>
        {questions
          .filter((q) => !done[q.id])
          .map((q) => (
            <QuestionItem
              key={q.id}
              q={q}
              focused={focus === q.id.toLowerCase()}
              // The viewer is the recipient: their own assistant asked when it acts for them.
              forMe={q.asked_for?.toLowerCase() === q.recipient?.toLowerCase()}
              onAnswered={(text) => setDone((d) => ({ ...d, [q.id]: text }))}
            />
          ))}
        {Object.entries(done).map(([id, text]) => (
          <li
            key={id}
            className='px-4 py-2 text-[12px] text-muted-foreground'
            role='status'
            data-my-work-question-done={id}
          >
            {text}
          </li>
        ))}
      </ul>
    </section>
  )
}

function QuestionItem({
  q,
  focused,
  forMe,
  onAnswered
}: {
  q: AgentQuestionRow
  focused: boolean
  forMe: boolean
  onAnswered: (text: string) => void
}) {
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  const { open: openItem } = useItemNavigation()
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLLIElement | null>(null)

  useEffect(() => {
    if (!focused || !ref.current) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ref.current.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
  }, [focused])

  const send = async (body: { choice?: string; answer?: string }, key: string) => {
    setBusy(key)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/agent-questions/${encodeURIComponent(q.id)}/answer`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        credentials,
        body: JSON.stringify(body)
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(json.error ?? 'Could not send the answer')
      onAnswered(`Sent to ${q.asked_by}: ${body.choice ?? body.answer}`)
      void qc.invalidateQueries({ queryKey: ['my-work'] })
      void qc.invalidateQueries({ queryKey: ['notifications'] })
    } catch (e) {
      setError(userErrorMessage(e, 'Could not send the answer'))
    } finally {
      setBusy(null)
    }
  }

  const hasChoices = q.choices.length > 0
  return (
    <li
      ref={ref}
      className={cn(
        'space-y-2 px-4 py-3 transition-colors duration-700',
        focused && 'bg-nvr-cyan/5 dark:bg-nvr-cyan/10'
      )}
      data-my-work-question={q.id}
    >
      <div className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
        <span className='text-[12px] font-medium text-slate-900 dark:text-foreground'>
          {q.asked_by}
        </span>
        <span className='text-[11px] text-muted-foreground'>
          {forMe ? 'your assistant' : `for ${q.asked_for_name ?? 'a colleague'}`} · asked{' '}
          {formatRelative(q.created_at)} · {expiresIn(q.expires_at)}
        </span>
        {q.collection && q.item && (
          <button
            type='button'
            onClick={() =>
              openItem({ collection: q.collection as string, itemId: q.item as string })
            }
            className='text-[11px] text-[#0e7490] hover:underline dark:text-[#67e8f9]'
          >
            Open the record
          </button>
        )}
      </div>
      <p className='whitespace-pre-wrap break-words text-[13px] text-slate-800 dark:text-slate-100'>
        {q.question}
      </p>
      {hasChoices && (
        <fieldset className='m-0 min-w-0 border-0 p-0'>
          <legend className='sr-only'>Choices</legend>
          <div className='flex flex-wrap gap-1.5'>
            {q.choices.map((c) => (
              <button
                key={c}
                type='button'
                disabled={busy != null}
                onClick={() => void send({ choice: c }, `c:${c}`)}
                className='rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-800 hover:border-nvr-cyan hover:bg-nvr-cyan/10 disabled:opacity-50 dark:border-border dark:bg-background dark:text-foreground'
                data-my-work-question-choice={c}
              >
                {busy === `c:${c}` ? 'Sending…' : c}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {(q.allow_text || !hasChoices) && (
        <form
          className='flex flex-col gap-1.5 sm:flex-row sm:items-end'
          onSubmit={(e) => {
            e.preventDefault()
            if (text.trim()) void send({ answer: text.trim() }, 'text')
          }}
        >
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={hasChoices ? 'Or write your own answer…' : 'Your answer…'}
            rows={2}
            maxLength={4000}
            className='min-h-[52px] flex-1 bg-white text-[12.5px] dark:bg-background'
            aria-label={`Answer to ${q.asked_by}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
                e.preventDefault()
                void send({ answer: text.trim() }, 'text')
              }
            }}
          />
          <button
            type='submit'
            disabled={!text.trim() || busy != null}
            className='h-8 shrink-0 rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white hover:bg-nvr-cyan/90 disabled:opacity-50'
          >
            {busy === 'text' ? 'Sending…' : 'Send answer'}
          </button>
        </form>
      )}
      {error && (
        <p className='text-[11.5px] text-red-600 dark:text-red-400' role='alert'>
          {error}
        </p>
      )}
    </li>
  )
}
