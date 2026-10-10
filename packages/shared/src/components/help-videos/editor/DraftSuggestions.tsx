import { useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, Sparkles, X } from 'lucide-react'
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { helpVideoApi, helpVideoError, helpVideoKeys } from '../api'
import type { DraftSuggestion, HelpVideoContext, HelpVideoDto, VideoEdits } from '../types'
import {
  applyDraftSuggestion,
  describeSuggestion,
  isSuggestionApplied,
  suggestionClock
} from './draftSuggestions'

/** The sentence a failed request carries (`error` in our own answers, else the message). */
function reasonOf(err: unknown): string {
  const body = (err as { response?: { error?: unknown } } | null)?.response
  if (body && typeof body.error === 'string') return body.error
  return (err as Error)?.message || 'The request failed.'
}

/**
 * "Draft the edit" (#1487): one click asks the AI provider for chapters,
 * callouts at the recorded clicks, a title, a description and the screens
 * the video explains, from what the recorder saw. Each suggestion is a row
 * to accept or dismiss, the way the silence suggestions work: a chapter or
 * callout accepted goes into the edits (and so through autosave); a title,
 * description or screen goes through its own route at once. Nothing is
 * applied until a row is accepted; rows already in place read as done.
 */
export const DraftSuggestions = memo(function DraftSuggestions({
  video,
  edits,
  onChange,
  onSeek,
  onNote,
  disabled
}: {
  video: HelpVideoDto
  edits: VideoEdits
  onChange: (e: VideoEdits) => void
  onSeek: (srcMs: number) => void
  onNote: (n: string | null) => void
  disabled?: boolean
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error'
    suggestions: DraftSuggestion[]
    error?: string
    model?: string | null
  }>({ status: 'idle', suggestions: [] })
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState<string | null>(null)
  // The latest edits and video for the accept handlers (one identity each).
  const editsRef = useRef(edits)
  editsRef.current = edits
  const videoRef = useRef(video)
  videoRef.current = video

  const ask = useCallback(async () => {
    setState((s) => ({ ...s, status: 'loading', error: undefined }))
    setDismissed(new Set())
    try {
      const r = await helpVideoApi(client).suggestDraft(videoRef.current.id)
      setState({ status: 'ready', suggestions: r.suggestions, model: r.model })
    } catch (err) {
      const e = helpVideoError(err)
      const reason =
        e?.code === 'HELP_VIDEO_AI_NOT_CONFIGURED'
          ? 'No AI provider is set up. An administrator adds one under Settings → AI Features.'
          : e?.code === 'HELP_VIDEO_DRAFT_UNREADABLE'
            ? 'The AI answer could not be read. Try again.'
            : reasonOf(err)
      setState({ status: 'error', suggestions: [], error: reason })
    }
  }, [client])

  const pending = useMemo(
    () =>
      state.suggestions.filter(
        (s) => !dismissed.has(s.id) && !isSuggestionApplied(s, edits, video)
      ),
    [state.suggestions, dismissed, edits, video]
  )
  const applied = state.suggestions.length - pending.length - [...dismissed].length

  const accept = useCallback(
    async (s: DraftSuggestion) => {
      const v = videoRef.current
      const r = applyDraftSuggestion(s, editsRef.current, v.contexts)
      if (r.how === 'refused') {
        onNote(r.refused)
        return
      }
      if (r.how === 'edits') {
        onChange(r.edits)
        return
      }
      setBusy(s.id)
      try {
        if (r.how === 'details') {
          await helpVideoApi(client).update(v.id, r.patch)
          qc.setQueryData<HelpVideoDto>(helpVideoKeys.one(v.id), (old) =>
            old ? { ...old, ...r.patch } : old
          )
        } else {
          await helpVideoApi(client).setContexts(v.id, r.contexts)
          qc.setQueryData<HelpVideoDto>(helpVideoKeys.one(v.id), (old) =>
            old ? { ...old, contexts: r.contexts as HelpVideoContext[] } : old
          )
        }
        void qc.invalidateQueries({ queryKey: helpVideoKeys.one(v.id) })
      } catch (err) {
        onNote(`That did not save: ${reasonOf(err)}`)
      } finally {
        setBusy(null)
      }
    },
    [client, qc, onChange, onNote]
  )
  const acceptAll = useCallback(async () => {
    // Edits first, as one change; then the detail rows one after another.
    let e = editsRef.current
    let refused = 0
    const rest: DraftSuggestion[] = []
    for (const s of pending) {
      if (s.kind !== 'chapter' && s.kind !== 'callout') {
        rest.push(s)
        continue
      }
      const r = applyDraftSuggestion(s, e, videoRef.current.contexts)
      if (r.how === 'edits') e = r.edits
      else refused++
    }
    if (e !== editsRef.current) onChange(e)
    for (const s of rest) await accept(s)
    if (refused) onNote(`${refused} suggestion${refused === 1 ? '' : 's'} could not be added`)
  }, [pending, accept, onChange, onNote])

  const count = pending.length
  const label =
    state.status === 'loading'
      ? 'Drafting…'
      : state.status === 'ready' && state.suggestions.length
        ? count
          ? `${count} draft suggestion${count === 1 ? '' : 's'}`
          : 'Draft done'
        : 'Draft the edit'
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o && state.status === 'idle') void ask()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size='sm'
          variant='outline'
          className='h-8 px-2.5 text-[12.5px]'
          disabled={disabled}
          data-hv-draft-suggest
          title='Let the AI propose chapters, callouts, a title and where the video shows'
        >
          {state.status === 'loading' ? (
            <Loader2 className='!size-3.5 animate-spin motion-reduce:animate-none' aria-hidden />
          ) : (
            <Sparkles className='!size-3.5' aria-hidden />
          )}
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[440px] max-w-[calc(100vw-24px)] p-0'
        data-hv-draft-list
      >
        <div className='border-b border-border px-3 py-2.5'>
          <p className='text-[13px] font-semibold text-foreground'>First draft of the edit</p>
          <p className='mt-0.5 text-[12px] leading-snug text-muted-foreground'>
            {state.status === 'loading'
              ? 'Reading the clicks and the narration and asking the AI for a draft…'
              : state.status === 'error'
                ? state.error
                : count
                  ? 'From the recorded clicks and where you speak. Accept a row to add it, or dismiss it. Nothing changes until you accept it.'
                  : state.suggestions.length
                    ? applied > 0
                      ? 'Every suggestion has been handled.'
                      : 'Nothing left to suggest.'
                    : 'The AI had nothing to add for this recording.'}
          </p>
        </div>
        {state.status === 'error' && (
          <div className='px-3 py-2'>
            <Button
              size='sm'
              variant='outline'
              className='h-7 text-[12px]'
              onClick={() => void ask()}
            >
              Try again
            </Button>
          </div>
        )}
        {count > 0 && (
          <>
            <ul className='max-h-[320px] divide-y divide-border overflow-y-auto'>
              {pending.map((s) => {
                const d = describeSuggestion(s)
                const running = busy === s.id
                return (
                  <li
                    key={s.id}
                    className='flex items-center gap-2 px-3 py-2'
                    data-hv-draft-row={s.kind}
                  >
                    {d.at !== undefined ? (
                      <button
                        type='button'
                        className='mr-auto min-w-0 rounded-sm text-left text-[12.5px] text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                        onClick={() => onSeek(d.at as number)}
                        aria-label={`Go to the ${d.kind.toLowerCase()} at ${suggestionClock(d.at)}`}
                      >
                        <span className='block text-[11px] font-medium text-muted-foreground'>
                          {d.kind} ·{' '}
                          <span className='font-mono tabular-nums'>{suggestionClock(d.at)}</span>
                        </span>
                        <span className='line-clamp-2'>{d.text}</span>
                      </button>
                    ) : (
                      <span className='mr-auto min-w-0 text-[12.5px] text-foreground'>
                        <span className='block text-[11px] font-medium text-muted-foreground'>
                          {d.kind}
                        </span>
                        <span className='line-clamp-3'>{d.text}</span>
                      </span>
                    )}
                    <Button
                      size='sm'
                      variant='default'
                      className='h-7 shrink-0 px-2 text-[12px]'
                      onClick={() => void accept(s)}
                      disabled={running}
                      aria-label={`Accept the ${d.kind.toLowerCase()} “${d.text}”`}
                      data-hv-draft-accept
                    >
                      {running ? (
                        <Loader2
                          className='!size-3.5 animate-spin motion-reduce:animate-none'
                          aria-hidden
                        />
                      ) : (
                        <Check className='!size-3.5' aria-hidden />
                      )}
                      Accept
                    </Button>
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-7 w-7 shrink-0 px-0 text-muted-foreground'
                      onClick={() => setDismissed((cur) => new Set(cur).add(s.id))}
                      aria-label={`Dismiss the ${d.kind.toLowerCase()} “${d.text}”`}
                      data-tip='Dismiss'
                      data-hv-draft-dismiss
                    >
                      <X className='!size-3.5' aria-hidden />
                    </Button>
                  </li>
                )
              })}
            </ul>
            <div className='flex items-center gap-3 border-t border-border px-3 py-2'>
              <button
                type='button'
                className='rounded-sm text-[12px] text-foreground underline underline-offset-2 hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                onClick={() => void acceptAll()}
                disabled={busy !== null}
                data-hv-draft-accept-all
              >
                Accept them all
              </button>
              <button
                type='button'
                className='ml-auto rounded-sm text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                onClick={() => void ask()}
                data-hv-draft-again
              >
                Draft again
              </button>
            </div>
          </>
        )}
        {count === 0 && state.status === 'ready' && (
          <div className='px-3 py-2'>
            <button
              type='button'
              className='rounded-sm text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
              onClick={() => void ask()}
              data-hv-draft-again
            >
              Draft again
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
})
