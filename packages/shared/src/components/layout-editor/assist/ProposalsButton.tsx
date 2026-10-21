import { Inbox, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { applyLayoutOps, type LayoutBundle } from '../../../lib/layout-ops'
import { cn, formatRelative } from '../../../lib/utils'
import { Popover, PopoverContent } from '../../ui/popover'
import { useLayoutEditorHost } from '../host'
import { barCount, ToolButton } from '../toolbar-kit'
import { humanizeOpError, type LayoutDraft } from '../useLayoutDraft'
import { type LayoutProposal, useLayoutProposals, useResolveProposal } from './assist-api'

/**
 * "Suggested changes" (#2694), in the AI menu: layout changes a connected
 * assistant (claude.ai, ChatGPT, Claude Code over MCP) or an API caller
 * proposed for this form, each with who sent it and through what.
 * Each one reads as plain sentences; Try on canvas applies it to the draft as
 * ONE undo step (nothing is saved until Save, unless Autosave is on), then
 * Keep marks it applied or Take back undoes it. Reject closes it. Admins only;
 * the row shows only while suggestions wait (their count rides on AI).
 */

const quiet = 'text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'
const ghostBtn =
  'inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground'
const solidBtn =
  'inline-flex h-7 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50'

function conflictOf(p: LayoutProposal, bundle: LayoutBundle | null): string | null {
  if (!bundle) return null
  try {
    applyLayoutOps(bundle, p.ops)
    return null
  } catch (e) {
    return humanizeOpError(e instanceof Error ? e.message : String(e))
  }
}

export function ProposalsButton({
  layoutId,
  draft
}: {
  layoutId: number
  draft: Pick<LayoutDraft, 'bundle' | 'apply' | 'undo' | 'autosave'>
}) {
  const host = useLayoutEditorHost()
  const { data: proposals = [] } = useLayoutProposals(layoutId, host.isAdmin)
  const resolve = useResolveProposal(layoutId)
  const [open, setOpen] = useState(false)
  // The proposal tried on the canvas (applied to the draft, not yet kept).
  const [tried, setTried] = useState<string | null>(null)
  const open_ = useMemo(() => proposals.filter((p) => p.status === 'proposed'), [proposals])
  if (!host.isAdmin || open_.length === 0) return null

  const tryOn = (p: LayoutProposal) => {
    const why = conflictOf(p, draft.bundle)
    if (why) {
      toast.error(`This suggested change no longer fits the form: ${why}`)
      return
    }
    draft.apply(p.ops, { label: `Suggested change from ${p.proposer.name}` })
    setTried(p.id)
  }
  const keep = (p: LayoutProposal) =>
    resolve.mutate(
      { id: p.id, outcome: 'applied' },
      {
        onSuccess: () => {
          setTried(null)
          toast.success(
            draft.autosave
              ? 'Suggested change applied and saved'
              : 'Suggested change applied — Save to keep it'
          )
        }
      }
    )
  const takeBack = () => {
    draft.undo()
    setTried(null)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ToolButton
        popover
        onOpen={() => setOpen(true)}
        label='Suggested changes'
        icon={<Inbox className='h-3.5 w-3.5' />}
        tip='Changes an assistant or an API caller suggested for this form. Nothing changes until you apply one.'
        hint='From assistants and API callers'
        active={open}
        badge={open_.length}
        data={{ 'data-layout-proposals': open_.length }}
        trailing={<span className={barCount}>{open_.length}</span>}
      />
      <PopoverContent
        align='end'
        className='w-[440px] overflow-hidden p-0'
        data-proposals-popover=''
      >
        <div className='border-b border-slate-200 px-3 py-2 dark:border-border'>
          <p className='text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
            Suggested changes · from assistants and API callers
          </p>
          <p className={quiet}>
            Try one on the canvas to see it. It joins your unsaved changes as one undo step.
          </p>
        </div>
        <ul className='max-h-[min(60vh,460px)] divide-y divide-slate-100 overflow-y-auto overscroll-contain dark:divide-border'>
          {open_.map((p) => {
            const conflict = tried === p.id ? null : conflictOf(p, draft.bundle)
            const busy = resolve.isPending && resolve.variables?.id === p.id
            return (
              <li key={p.id} className='space-y-2 px-3 py-3' data-proposal={p.id}>
                <p className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
                  <Sparkles className='h-3.5 w-3.5 shrink-0 text-nvr-cyan' />
                  <span className='min-w-0 truncate'>
                    <b className='font-semibold text-slate-800 dark:text-foreground'>
                      {p.proposer.name}
                    </b>{' '}
                    via {p.proposer.via} · {formatRelative(p.created_at)}
                  </span>
                </p>
                {p.note && (
                  <p className='text-[12.5px] leading-snug text-slate-700 dark:text-foreground'>
                    {p.note}
                  </p>
                )}
                <ol className='list-decimal space-y-0.5 pl-5 text-[12.5px] leading-snug text-slate-700 dark:text-foreground'>
                  {p.sentences.map((s, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: ordered sentences, may repeat
                    <li key={`${i}:${s}`}>{s}</li>
                  ))}
                </ol>
                {p.dropped.length > 0 && (
                  <p className={quiet}>Left out when it was proposed: {p.dropped.join('; ')}.</p>
                )}
                {conflict && (
                  <p className='rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] leading-snug text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
                    The form changed since: {conflict}
                  </p>
                )}
                <div className='flex items-center justify-end gap-1.5'>
                  {tried === p.id ? (
                    <>
                      <span className={cn(quiet, 'mr-auto')}>On the canvas now</span>
                      <button type='button' className={ghostBtn} onClick={takeBack}>
                        Take back
                      </button>
                      <button
                        type='button'
                        className={solidBtn}
                        disabled={busy}
                        data-proposal-keep=''
                        onClick={() => keep(p)}
                      >
                        Keep
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type='button'
                        className={ghostBtn}
                        disabled={busy || tried != null}
                        data-proposal-reject=''
                        onClick={() => resolve.mutate({ id: p.id, outcome: 'rejected' })}
                      >
                        Reject
                      </button>
                      <button
                        type='button'
                        className={solidBtn}
                        disabled={!!conflict || busy || tried != null}
                        data-proposal-try=''
                        data-tip={
                          draft.autosave
                            ? 'Autosave is on: trying it saves it. Undo takes it back.'
                            : 'Shows it on the canvas as an unsaved change'
                        }
                        onClick={() => tryOn(p)}
                      >
                        {p.sentences.length > 1
                          ? `Try ${p.sentences.length} changes`
                          : 'Try on canvas'}
                      </button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
