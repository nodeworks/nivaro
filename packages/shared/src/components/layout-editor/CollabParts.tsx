import { AlertTriangle, ArrowUpRight, History, Settings2 } from 'lucide-react'
import { useMemo } from 'react'
import { cn, formatRelative } from '../../lib/utils'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import type { DesignTarget } from './design-context'
import type { RecoveryState } from './draft-recovery'
import { initials, type LayoutPeer } from './presence'
import { unsavedText } from './UnsavedConfirm'
import { stepTargets, touchesSettings } from './unsaved-marks'
import type { UnsavedStep } from './useLayoutDraft'

// The layout editor's collaboration surfaces: who else is here (#2651), the
// unsaved-changes list (#2629), changes a rebase could not keep (#2652) and a
// draft left behind by a crash (#2653).

const bannerCls =
  'flex shrink-0 items-start gap-3 border-b px-4 py-1.5 text-[12.5px] border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
const bannerBtn =
  'inline-flex h-7 shrink-0 items-center rounded-md border border-amber-300 px-2.5 text-[12px] font-medium hover:bg-amber-100 dark:border-amber-500/40 dark:hover:bg-amber-500/15'

/** Someone else saved first and these of my changes no longer fit (#2652). */
export function DroppedBanner({ labels, onDismiss }: { labels: string[]; onDismiss: () => void }) {
  if (labels.length === 0) return null
  return (
    <div role='alert' data-dropped-changes='' className={bannerCls}>
      <AlertTriangle className='mt-1 h-3.5 w-3.5 shrink-0' />
      <div className='min-w-0 flex-1 py-1'>
        <p className='m-0'>
          Someone else saved this layout first.{' '}
          {labels.length === 1 ? 'This change' : `These ${labels.length} changes`} no longer fit
          their version and {labels.length === 1 ? 'was' : 'were'} not kept — redo{' '}
          {labels.length === 1 ? 'it' : 'them'} by hand:
        </p>
        <ul className='m-0 mt-1 list-disc space-y-0.5 pl-5'>
          {labels.map((l, i) => (
            // Labels repeat ("Rename field"); their order is the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <li key={i} data-dropped-change=''>
              {l}
            </li>
          ))}
        </ul>
      </div>
      <button type='button' onClick={onDismiss} className={cn(bannerBtn, 'mt-0.5')}>
        Got it
      </button>
    </div>
  )
}

/** A staged draft from another browser, a closed tab or a crash: recover it (#2589, #2653). */
export function RecoveryBanner({
  state,
  onRecover,
  onDismiss
}: {
  state: RecoveryState
  onRecover: () => void
  onDismiss: () => void
}) {
  if (!state) return null
  const n = state.draft.steps.length
  const when = formatRelative(new Date(state.draft.at).toISOString())
  const where = state.source === 'server' ? 'kept for you' : 'left in this browser'
  return (
    <div
      role='note'
      data-draft-recovery={state.kind}
      data-draft-stale={state.stale ? '' : undefined}
      className={cn(bannerCls, 'items-center')}
    >
      <History className='h-3.5 w-3.5 shrink-0' />
      <p className='m-0 min-w-0 flex-1'>
        You have {unsavedText(n)} on this layout, {where} {when}.
        {state.stale &&
          ' The layout was saved since: Recover lays them on top of it and lists any that no longer fit.'}
      </p>
      <button
        type='button'
        data-draft-recover=''
        onClick={onRecover}
        className='inline-flex h-7 shrink-0 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90'
      >
        Recover
      </button>
      <button type='button' data-draft-dismiss='' onClick={onDismiss} className={bannerBtn}>
        Discard
      </button>
    </div>
  )
}

/** Avatars of the other people in this layout; a click jumps to what they selected (#2651). */
export function PresenceAvatars({
  peers,
  describe,
  onJump
}: {
  peers: LayoutPeer[]
  /** A selected target key in words ("Status in Main"), null when it is not on the form. */
  describe: (key: string) => string | null
  onJump: (key: string) => void
}) {
  if (peers.length === 0) return null
  const shown = peers.slice(0, 4)
  return (
    <div data-presence='' className='flex shrink-0 items-center -space-x-1.5'>
      {shown.map((p) => {
        const what = p.selected ? describe(p.selected) : null
        return (
          <button
            key={p.id}
            type='button'
            data-presence-peer={p.id}
            data-tip={what ? `${p.name} — on ${what}` : `${p.name} is editing this form too`}
            aria-label={what ? `${p.name}, on ${what}` : `${p.name}, editing this form`}
            disabled={!what}
            onClick={() => p.selected && onJump(p.selected)}
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold ring-2 ring-white disabled:cursor-default dark:ring-card',
              p.tone.chip
            )}
          >
            {initials(p.name)}
          </button>
        )
      })}
      {peers.length > shown.length && (
        <span
          data-tip={peers
            .slice(shown.length)
            .map((p) => p.name)
            .join(', ')}
          className='inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-slate-100 px-1 text-[11px] font-semibold text-slate-600 ring-2 ring-white dark:bg-muted dark:text-muted-foreground dark:ring-card'
        >
          +{peers.length - shown.length}
        </span>
      )}
    </div>
  )
}

/**
 * The unsaved changes, oldest first, each with a jump to what it changed
 * (#2629). Opened from the top bar's unsaved count.
 */
export function UnsavedList({
  anchor,
  steps,
  exists,
  describe,
  onJump,
  onSettings,
  onClose
}: {
  anchor: HTMLElement | null
  steps: UnsavedStep[]
  /** Is the target still on the form (a later step may have taken it away)? */
  exists: (t: DesignTarget) => boolean
  describe: (t: DesignTarget) => string
  onJump: (t: DesignTarget) => void
  onSettings: () => void
  onClose: () => void
}) {
  const anchorRef = useMemo(
    () => ({ current: anchor ?? document.body }) as { current: HTMLElement },
    [anchor]
  )
  return (
    <Popover open onOpenChange={(o) => !o && onClose()}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        align='end'
        className='max-h-[min(70vh,480px)] w-[340px] overflow-y-auto overscroll-contain p-2'
        data-unsaved-list=''
      >
        <p className='px-1.5 pb-1.5 pt-1 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          {unsavedText(steps.length)}
        </p>
        {steps.length === 0 ? (
          <p className='px-1.5 pb-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Everything is saved.
          </p>
        ) : (
          <ol className='m-0 list-none space-y-0.5 p-0'>
            {steps.map((s, i) => {
              const target = stepTargets(s).filter(exists).pop() ?? null
              const settings = !target && touchesSettings(s)
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: steps have no id; order is identity
                <li key={i}>
                  <button
                    type='button'
                    data-unsaved-step={i}
                    disabled={!target && !settings}
                    onClick={() => {
                      if (target) onJump(target)
                      else if (settings) onSettings()
                    }}
                    className='flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-muted disabled:pointer-events-none'
                  >
                    <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400' />
                    <span className='min-w-0 flex-1'>
                      <span className='block truncate text-[12.5px] text-slate-800 dark:text-foreground'>
                        {s.label}
                      </span>
                      {target && (
                        <span className='block truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                          {describe(target)}
                        </span>
                      )}
                    </span>
                    {target ? (
                      <ArrowUpRight className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                    ) : settings ? (
                      <Settings2 className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </PopoverContent>
    </Popover>
  )
}
