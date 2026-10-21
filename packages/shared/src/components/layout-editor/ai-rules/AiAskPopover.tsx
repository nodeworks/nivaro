import { Sparkles } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { cn } from '../../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { parseSaveFailure } from '../useLayoutDraft'

/**
 * The shell every AI rule writer (#2673 #2674 #2675) opens beside its button:
 * a sentence box, Ask, then the writer's own reviewable result. The writers
 * only PROPOSE — Apply / Save live in the result and go through the editor's
 * own seams (draft, global writer, field-rules route).
 */

export const aiQuiet = 'text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'
export const aiGhostBtn =
  'inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 disabled:opacity-40 dark:text-muted-foreground dark:hover:text-foreground'
export const aiPrimaryBtn =
  'inline-flex h-7 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40'
export const aiTriggerBtn =
  'inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
export const aiWarn =
  'rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] leading-snug text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'

/** An API failure in plain words; 503 = AI is not set up here. */
export function aiFailure(err: unknown, fallback: string): string {
  const f = parseSaveFailure(err, fallback)
  if (f.status === 503)
    return 'AI is not set up here — the settings beside this still work by hand.'
  return f.message
}

/** "Dropped: …" — what the AI said that did not fit, named so nothing vanishes silently. */
export function DroppedList({ items }: { items: string[] }) {
  if (!items.length) return null
  return (
    <div className={aiWarn} data-ai-dropped=''>
      <p className='font-medium'>Left out ({items.length})</p>
      <ul className='mt-0.5 list-disc space-y-0.5 pl-4'>
        {items.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
    </div>
  )
}

export function AiAskPopover<T>({
  label,
  title,
  placeholder,
  examples = [],
  ask,
  children,
  disabled,
  testId
}: {
  /** Words on the trigger button. */
  label: string
  /** One line at the top of the popover. */
  title: string
  placeholder: string
  examples?: string[]
  /** Sends the sentence; resolves with the writer's result. */
  ask: (text: string) => Promise<T>
  /** Renders the result; `done` closes the popover (after Apply / Save). */
  children: (result: T, done: () => void, back: () => void) => ReactNode
  disabled?: boolean
  testId: string
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'asking' }
    | { kind: 'error'; error: string }
    | { kind: 'ok'; result: T }
  >({ kind: 'idle' })
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const run = async () => {
    const t = text.trim()
    if (!t || state.kind === 'asking') return
    setState({ kind: 'asking' })
    try {
      setState({ kind: 'ok', result: await ask(t) })
    } catch (err) {
      setState({ kind: 'error', error: aiFailure(err, 'The AI could not write that') })
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={aiTriggerBtn}
          disabled={disabled}
          data-tip={title}
          data-ai-rule-trigger={testId}
        >
          <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[420px] max-w-[calc(100vw-32px)] overflow-hidden p-0'
        data-ai-rule-popover={testId}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <form
          className='space-y-2 border-b border-slate-200 px-3 py-2.5 dark:border-border'
          onSubmit={(e) => {
            e.preventDefault()
            run()
          }}
        >
          <p className='flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
            <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' />
            {title}
          </p>
          <textarea
            ref={inputRef}
            value={text}
            rows={2}
            onChange={(e) => {
              setText(e.target.value)
              if (state.kind !== 'asking') setState({ kind: 'idle' })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                run()
              }
            }}
            placeholder={placeholder}
            aria-label={title}
            data-ai-rule-input=''
            className='w-full resize-none rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
          />
          <div className='flex items-center justify-end'>
            <button
              type='submit'
              className={aiPrimaryBtn}
              disabled={!text.trim() || state.kind === 'asking'}
              data-ai-rule-ask=''
            >
              {state.kind === 'asking' ? 'Asking…' : 'Ask AI'}
            </button>
          </div>
        </form>
        <div className='max-h-[min(60vh,460px)] overflow-y-auto overscroll-contain px-3 py-3'>
          {state.kind === 'idle' && (
            <div className='space-y-1.5'>
              <p className={aiQuiet}>
                You see the result and what it does to real records before anything changes.
              </p>
              {examples.map((ex) => (
                <button
                  key={ex}
                  type='button'
                  className='block w-full rounded-md px-2 py-1 text-left text-[12.5px] text-slate-700 transition-colors hover:bg-muted dark:text-foreground'
                  onClick={() => {
                    setText(ex)
                    inputRef.current?.focus()
                  }}
                >
                  {ex}
                </button>
              ))}
            </div>
          )}
          {state.kind === 'asking' && (
            <p className={aiQuiet}>Asking the AI and testing the answer…</p>
          )}
          {state.kind === 'error' && (
            <p
              className='text-[12.5px] leading-snug text-red-700 dark:text-red-300'
              data-ai-rule-error=''
            >
              {state.error}
            </p>
          )}
          {state.kind === 'ok' && (
            <div className={cn('space-y-2.5')} data-ai-rule-result=''>
              {children(
                state.result,
                () => {
                  setOpen(false)
                  setText('')
                  setState({ kind: 'idle' })
                },
                () => setState({ kind: 'idle' })
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
