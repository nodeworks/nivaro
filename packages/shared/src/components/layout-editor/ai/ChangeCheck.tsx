import { Loader2, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { post } from '../../../lib/commands'
import type { LayoutBundle } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { Popover, PopoverContent } from '../../ui/popover'
import { useLayoutEditorHost } from '../host'
import { ToolButton } from '../toolbar-kit'
import { type LayoutDraft, parseSaveFailure } from '../useLayoutDraft'
import { savedJustNow, slimBundle } from './assist-ops'

/**
 * AI review of a change (#2684), in the Save menu. On a manual Save the editor
 * sends the layout as it was at the last save and as it is now to POST
 * /ai-design/layouts/:id/check-changes; the model reads the change next to
 * the roles and the workflow and warns about likely mistakes of intent. The
 * save is never held up: the check runs after it went out, and warnings open
 * in a popover anchored here (Undo reverses the saved change). Picking it
 * asks before saving. Admins only; silent when AI is not set up or the change is
 * trivial (labels, help text, order inside a section).
 */

interface ChangeWarning {
  message: string
  field: string | null
  field_label: string | null
  section: string | null
  section_label: string | null
  roles: string[]
}

type CheckAnswer =
  | { status: 'skipped'; reason: 'empty' | 'trivial'; changes: string[] }
  | { status: 'checked'; changes: string[]; warnings: ChangeWarning[]; dropped: number }

type Trigger = 'save' | 'ask'

type View =
  | { kind: 'idle' }
  | { kind: 'checking'; trigger: Trigger }
  | { kind: 'done'; trigger: Trigger; answer: CheckAnswer }
  | { kind: 'error'; message: string }

const quiet = 'text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'
const smallBtn =
  'inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'

export function AiChangeCheck({
  layoutId,
  draft
}: {
  layoutId: number
  draft: Pick<LayoutDraft, 'bundle' | 'status'> &
    Partial<Pick<LayoutDraft, 'unsavedCount' | 'autosave' | 'unsavedOps'>>
}) {
  const host = useLayoutEditorHost()
  const client = useNivaroClient()
  const [view, setView] = useState<View>({ kind: 'idle' })
  const [open, setOpen] = useState(false)
  const unsaved = draft.unsavedCount ?? 0
  const enabled = host.isAdmin && !!draft.unsavedOps

  // The layout at the last save, and what a Save is about to send.
  const clean = useRef<LayoutBundle | null>(null)
  const pending = useRef<{ before: LayoutBundle | null; after: LayoutBundle } | null>(null)
  const prevUnsaved = useRef(unsaved)
  const noAi = useRef(false)
  const asked = useRef(0)

  const run = useCallback(
    async (trigger: Trigger, change: { before: LayoutBundle | null; after: LayoutBundle }) => {
      if (trigger === 'save' && noAi.current) return
      const ticket = ++asked.current
      // A check after Save stays out of sight until it has something to say.
      if (trigger === 'ask') setView({ kind: 'checking', trigger })
      try {
        const res = await client.request<{ data: CheckAnswer }>(
          post(`/ai-design/layouts/${layoutId}/check-changes`, {
            before: change.before ? slimBundle(change.before) : null,
            after: slimBundle(change.after)
          })
        )
        if (ticket !== asked.current) return
        const answer = res?.data
        if (!answer || (answer.status === 'skipped' && trigger === 'save')) {
          setView({ kind: 'idle' })
          return
        }
        setView({ kind: 'done', trigger, answer })
        if (trigger === 'save' && answer.status === 'checked' && answer.warnings.length)
          setOpen(true)
      } catch (err) {
        if (ticket !== asked.current) return
        const f = parseSaveFailure(err, 'The AI check failed')
        if (f.status === 503) noAi.current = true
        if (trigger === 'save') {
          setView({ kind: 'idle' })
          return
        }
        setView({
          kind: 'error',
          message:
            f.status === 503 ? 'AI is not set up here, so changes cannot be checked.' : f.message
        })
      }
    },
    [client, layoutId]
  )

  useEffect(() => {
    if (!enabled) return
    if (unsaved > 0 && draft.bundle)
      pending.current = { before: clean.current, after: draft.bundle }
    if (savedJustNow(prevUnsaved.current, unsaved, draft.status, !!draft.autosave)) {
      const change = pending.current
      if (change) void run('save', change)
    }
    if (unsaved === 0) {
      pending.current = null
      if (draft.bundle) clean.current = draft.bundle
    }
    prevUnsaved.current = unsaved
  }, [enabled, unsaved, draft.status, draft.autosave, draft.bundle, run])

  // "Looks fine" after a save fades on its own.
  const fine =
    view.kind === 'done' && (view.answer.status === 'skipped' || view.answer.warnings.length === 0)
  useEffect(() => {
    if (!fine || open) return
    const t = setTimeout(() => setView({ kind: 'idle' }), 8000)
    return () => clearTimeout(t)
  }, [fine, open])

  if (!enabled) return null
  if (view.kind === 'idle' && unsaved === 0) return null

  const ask = () => {
    if (!draft.bundle) return
    void run('ask', { before: clean.current, after: draft.bundle })
  }
  const warnings =
    view.kind === 'done' && view.answer.status === 'checked' ? view.answer.warnings : []
  const state =
    view.kind === 'checking'
      ? 'Checking…'
      : warnings.length
        ? `${warnings.length} to look at`
        : fine
          ? 'Looks fine'
          : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ToolButton
        popover
        onOpen={() => {
          if (view.kind === 'idle' || view.kind === 'error') ask()
          setOpen(true)
        }}
        label='AI review'
        ariaLabel='AI review of the changes'
        icon={
          view.kind === 'checking' ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' />
          )
        }
        tip='AI reads the change next to the roles and the workflow and warns about likely mistakes. It never blocks Save.'
        hint={state ?? 'Likely mistakes, next to the roles and the workflow'}
        badge={warnings.length || undefined}
        data={{ 'data-ai-change-check': view.kind }}
        onClick={(e) => {
          if (view.kind === 'idle' || view.kind === 'error') {
            e.preventDefault()
            ask()
            setOpen(true)
          }
        }}
        className={cn(
          warnings.length &&
            'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950/60'
        )}
        trailing={
          state && <span className='text-slate-500 dark:text-muted-foreground'>· {state}</span>
        }
      />
      <PopoverContent align='end' className='w-[380px] p-0' data-ai-change-check-panel=''>
        <div className='space-y-2.5 p-3'>
          <p className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            {view.kind !== 'idle' && 'trigger' in view && view.trigger === 'save'
              ? 'AI review of the change you saved'
              : 'AI review of your unsaved changes'}
          </p>
          {view.kind === 'checking' && <p className={quiet}>Reading the change…</p>}
          {view.kind === 'error' && (
            <p className='text-[12px] text-[#9c2f47] dark:text-[#f08aa1]'>{view.message}</p>
          )}
          {view.kind === 'done' && view.answer.status === 'skipped' && (
            <p className={quiet}>
              {view.answer.reason === 'empty'
                ? 'Nothing has changed since the last save.'
                : 'Only labels, help text or the order inside a section changed: nothing for the AI to judge.'}
            </p>
          )}
          {view.kind === 'done' && view.answer.status === 'checked' && (
            <>
              {warnings.length ? (
                <ul className='space-y-1.5' data-ai-change-warnings=''>
                  {warnings.map((w, i) => (
                    <li
                      key={`${i}:${w.message}`}
                      className='rounded-md bg-amber-50 px-2.5 py-2 text-[12.5px] leading-snug text-amber-950 dark:bg-amber-950/40 dark:text-amber-100'
                    >
                      {w.message}
                      {(w.field_label || w.section_label || w.roles.length > 0) && (
                        <span className='mt-1 block text-[11.5px] text-amber-800/80 dark:text-amber-200/70'>
                          {[
                            w.field_label && `Field: ${w.field_label}`,
                            w.section_label && `Section: ${w.section_label}`,
                            w.roles.length > 0 && `Roles: ${w.roles.join(', ')}`
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className='text-[12.5px] text-slate-700 dark:text-foreground'>
                  Nothing looks off.
                </p>
              )}
              {view.answer.dropped > 0 && (
                <p className={quiet}>
                  Left out {view.answer.dropped} remark{view.answer.dropped === 1 ? '' : 's'} that
                  named fields, sections or roles this form does not have.
                </p>
              )}
              <details className='text-[12px]'>
                <summary className='cursor-pointer text-slate-600 dark:text-muted-foreground'>
                  What it read ({view.answer.changes.length})
                </summary>
                <ul className='mt-1 list-disc space-y-0.5 pl-4 text-slate-600 dark:text-muted-foreground'>
                  {view.answer.changes.map((c, i) => (
                    <li key={`${i}:${c}`}>{c}</li>
                  ))}
                </ul>
              </details>
            </>
          )}
          <p className={quiet}>
            Advice from AI: it never blocks Save, and Undo reverses a saved change.
          </p>
          <div className='flex justify-end gap-1'>
            {unsaved > 0 && view.kind !== 'checking' && (
              <button type='button' className={smallBtn} onClick={ask}>
                Check again
              </button>
            )}
            <button
              type='button'
              className={smallBtn}
              onClick={() => {
                setOpen(false)
                setView({ kind: 'idle' })
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
