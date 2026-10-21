import { Command, CornerDownLeft, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { post } from '../../../lib/commands'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { useLayoutEditorHost } from '../host'
import { useOverviewFields, useRoleNames } from '../overview/overview-api'
import { type LayoutDraft, parseSaveFailure } from '../useLayoutDraft'
import {
  type CommandEnv,
  type CommandIntent,
  type CommandPlan,
  intentsToOps,
  planLabel
} from './intents'
import { parseCommand } from './parse'

/**
 * The layout editor's command palette (#2586): ⌘K / Ctrl+K or the top bar's
 * Commands button opens it beside the button. A typed command is read by the
 * palette itself (commands/parse.ts); text it cannot read can go to the AI
 * (admins, POST /ai-design/layouts/:id/command), which answers intents in the
 * same vocabulary. Either way the preview lists every change in plain words
 * before anything is written, and Apply is ONE draft batch — one undo step.
 */

const EXAMPLES = [
  'move Shipping Location to Materials',
  'make Zone required',
  'hide Notes; set width Region half',
  'add step Review after Details'
]

type View =
  | { kind: 'idle' }
  | { kind: 'error'; error: string; canAsk: boolean }
  | { kind: 'asking' }
  | {
      kind: 'preview'
      intents: CommandIntent[]
      plan: CommandPlan
      source: 'typed' | 'ai'
      explanation: string | null
    }

const trigger =
  'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
const quiet = 'text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'
const ghostBtn =
  'inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const shortcut = isMac ? '⌘K' : 'Ctrl+K'

export function CommandPalette({
  collection,
  layoutId,
  draft
}: {
  collection: string
  layoutId: number
  draft: Pick<LayoutDraft, 'bundle' | 'apply'>
}) {
  const host = useLayoutEditorHost()
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [view, setView] = useState<View>({ kind: 'idle' })
  const inputRef = useRef<HTMLInputElement | null>(null)
  const { data: fields = [] } = useOverviewFields(collection)
  const { data: roles = [] } = useRoleNames(open)
  const canAsk = host.isAdmin

  // ⌘K / Ctrl+K anywhere in the editor (not inside rich text, which may bind it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return
      const t = e.target as HTMLElement | null
      if (t?.closest?.('[contenteditable]:not([contenteditable="false"])')) return
      e.preventDefault()
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const env = useMemo<CommandEnv | null>(
    () => (draft.bundle ? { bundle: draft.bundle, fields, roles } : null),
    [draft.bundle, fields, roles]
  )

  const reset = (next = '') => {
    setText(next)
    setView({ kind: 'idle' })
  }

  const preview = () => {
    if (!env || !text.trim()) return
    const parsed = parseCommand(text, env)
    if (!parsed.ok) {
      setView({ kind: 'error', error: parsed.error, canAsk })
      return
    }
    const plan = intentsToOps(parsed.intents, env)
    setView(
      plan.ok
        ? { kind: 'preview', intents: parsed.intents, plan, source: 'typed', explanation: null }
        : { kind: 'error', error: plan.error, canAsk: false }
    )
  }

  const askAi = async () => {
    if (!env || !text.trim()) return
    setView({ kind: 'asking' })
    try {
      const res = await client.request<{
        data: { intents: CommandIntent[]; explanation: string | null }
      }>(post(`/ai-design/layouts/${layoutId}/command`, { text: text.trim() }))
      const intents = Array.isArray(res?.data?.intents) ? res.data.intents : []
      const plan = intentsToOps(intents, env)
      setView(
        plan.ok
          ? {
              kind: 'preview',
              intents,
              plan,
              source: 'ai',
              explanation: res.data.explanation ?? null
            }
          : {
              kind: 'error',
              error: `The AI's answer does not fit this form: ${plan.error}`,
              canAsk: false
            }
      )
    } catch (err) {
      const f = parseSaveFailure(err, 'The AI could not read that')
      setView({
        kind: 'error',
        error:
          f.status === 503
            ? 'AI is not set up here — typed commands such as the examples still work.'
            : f.message,
        canAsk: false
      })
    }
  }

  // Planned again on the draft as it is now: the form may have changed since the preview.
  const apply = () => {
    if (view.kind !== 'preview' || !env) return
    const plan = intentsToOps(view.intents, env)
    if (!plan.ok) {
      setView({ kind: 'error', error: plan.error, canAsk: false })
      return
    }
    draft.apply(plan.ops, { label: planLabel(plan) })
    reset()
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v && view.kind !== 'preview') setView({ kind: 'idle' })
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          className={trigger}
          aria-label='Commands'
          data-command-palette-trigger=''
          data-tip={`Type a change in plain words (${shortcut})`}
          disabled={!draft.bundle}
        >
          <Command className='h-3.5 w-3.5' />
          Commands
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-[440px] overflow-hidden p-0'
        data-command-palette=''
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <form
          className='flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-border'
          onSubmit={(e) => {
            e.preventDefault()
            if (view.kind === 'preview') apply()
            else preview()
          }}
        >
          <Command className='h-4 w-4 shrink-0 text-slate-400' />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => reset(e.target.value)}
            placeholder='move Shipping Location to Materials'
            aria-label='Command'
            data-command-input=''
            className='h-8 min-w-0 flex-1 bg-transparent text-[13px] text-slate-800 outline-none placeholder:text-slate-400 dark:text-foreground dark:placeholder:text-muted-foreground'
          />
          <kbd className='hidden shrink-0 items-center gap-0.5 rounded border border-slate-200 px-1 text-[10.5px] text-slate-500 sm:inline-flex dark:border-border dark:text-muted-foreground'>
            <CornerDownLeft className='h-3 w-3' />
            {view.kind === 'preview' ? 'apply' : 'preview'}
          </kbd>
        </form>
        <div className='max-h-[min(60vh,420px)] overflow-y-auto overscroll-contain px-3 py-3'>
          {view.kind === 'idle' && (
            <div className='space-y-2'>
              <p className={quiet}>
                Say what to change. You see every change before it is made, and one Apply is one
                undo step.
              </p>
              <ul className='space-y-0.5'>
                {EXAMPLES.map((ex) => (
                  <li key={ex}>
                    <button
                      type='button'
                      className='w-full rounded-md px-2 py-1 text-left text-[12.5px] text-slate-700 transition-colors hover:bg-muted dark:text-foreground'
                      onClick={() => {
                        reset(ex)
                        inputRef.current?.focus()
                      }}
                    >
                      {ex}
                    </button>
                  </li>
                ))}
              </ul>
              <p className={quiet}>
                Also: rename, make … optional / read-only, show, remove, collapse, expand, “for
                &lt;role&gt;”. Separate several commands with “;”.
              </p>
            </div>
          )}
          {view.kind === 'asking' && <p className={quiet}>Asking the AI…</p>}
          {view.kind === 'error' && (
            <div className='space-y-2' data-command-error=''>
              <p className='text-[12.5px] leading-snug text-red-700 dark:text-red-300'>
                {view.error}
              </p>
              {view.canAsk && (
                <button type='button' className={ghostBtn} onClick={askAi} data-command-ask-ai=''>
                  <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' />
                  Ask AI to read it
                </button>
              )}
            </div>
          )}
          {view.kind === 'preview' && (
            <div className='space-y-2.5' data-command-preview=''>
              <p className='flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
                {view.source === 'ai' && <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' />}
                {view.source === 'ai' ? 'The AI read this as' : 'This will'}
              </p>
              <ol className='list-decimal space-y-1 pl-5 text-[12.5px] leading-snug text-slate-700 dark:text-foreground'>
                {view.plan.steps.map((s, i) => (
                  <li key={`${i}:${s}`}>{s}</li>
                ))}
              </ol>
              {view.explanation && <p className={quiet}>{view.explanation}</p>}
              {view.plan.notes.map((n) => (
                <p
                  key={n}
                  className='rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] leading-snug text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
                >
                  {n}
                </p>
              ))}
              <div className='flex items-center justify-end gap-1.5 pt-1'>
                <button
                  type='button'
                  className={ghostBtn}
                  onClick={() => setView({ kind: 'idle' })}
                >
                  Back
                </button>
                <button
                  type='button'
                  onClick={apply}
                  data-command-apply=''
                  className='inline-flex h-7 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90'
                >
                  {view.plan.steps.length > 1 ? `Apply ${view.plan.steps.length} changes` : 'Apply'}
                </button>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
