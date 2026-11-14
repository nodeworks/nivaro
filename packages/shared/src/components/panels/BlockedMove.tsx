import { Lock } from 'lucide-react'
import { forwardRef } from 'react'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'

/**
 * Moves a person cannot make right now (Rob 2026-11-13): GET
 * /pipelines/instance answers them in `blocked_transitions`, each with
 * `blocked: {code, reason}` (api services/blocked-moves.ts — the reason is the
 * same sentence a forced press would be refused with). The record page draws
 * them in their normal place, disabled, with the reason as an instant tip that
 * also shows on keyboard focus — instead of the move silently vanishing. A
 * list-row menu never offers them (it reads `available_transitions` only).
 */

export type MoveBlockCode = 'ROLE' | 'OWNER' | 'ADMIN_ONLY' | 'SKIPPED'

export interface MoveBlock {
  code: MoveBlockCode | string
  reason: string
}

interface Orderable {
  id: string
  sort?: number | null
  blocked?: MoveBlock | null
}

/**
 * The moves on offer plus the blocked ones, in the order the pipeline authors
 * them (`sort`, the order the server reads both lists in). A blocked move
 * that is also on offer (an older cache) is dropped. Moves without a sort keep
 * their place after the sorted ones.
 */
export function withBlockedMoves<T extends Orderable>(
  available: T[],
  blocked: T[] | null | undefined
): T[] {
  if (!blocked || blocked.length === 0) return available
  const offered = new Set(available.map((t) => String(t.id).toUpperCase()))
  const extra = blocked.filter((t) => t.blocked && !offered.has(String(t.id).toUpperCase()))
  if (extra.length === 0) return available
  const all = [...available, ...extra]
  const key = (t: T) => (typeof t.sort === 'number' ? t.sort : Number.POSITIVE_INFINITY)
  return all
    .map((t, i) => ({ t, i }))
    .sort((a, b) => key(a.t) - key(b.t) || a.i - b.i)
    .map(({ t }) => t)
}

/** True when the move is held back from this person. */
export function isBlockedMove(t: { blocked?: MoveBlock | null }): boolean {
  return !!t.blocked?.reason
}

/**
 * The tip for a label group whose every move is held back: the one reason
 * when they share it, else each target with its own.
 */
export function blockedGroupTip(
  moves: Array<{ blocked?: MoveBlock | null }>,
  nameOf: (i: number) => string
): string {
  const reasons = [...new Set(moves.map((m) => m.blocked?.reason ?? '').filter(Boolean))]
  if (reasons.length <= 1) return reasons[0] ?? ''
  return moves.map((m, i) => `${nameOf(i)}: ${m.blocked?.reason ?? ''}`).join('\n')
}

/**
 * The button of a move this person cannot make. `aria-disabled`, never
 * `disabled`: a disabled button takes no focus and no pointer, so it could
 * not say why. A press does nothing (and never reaches the transition route).
 */
export const BlockedMoveButton = forwardRef<
  HTMLButtonElement,
  {
    label: string
    reason: string
    code?: string
    small?: boolean
    className?: string
  }
>(function BlockedMoveButton({ label, reason, code, small = false, className }, ref) {
  return (
    <Button
      ref={ref}
      type='button'
      size='sm'
      variant='outline'
      aria-disabled
      aria-description={reason}
      data-tip={reason}
      data-tip-focus
      data-move-unavailable={code ?? true}
      onClick={(e) => e.preventDefault()}
      className={cn(BLOCKED_MOVE_CLASS, small ? 'h-7 text-[11px]' : 'text-[12px]', className)}
    >
      <Lock className='h-3 w-3' aria-hidden />
      {label}
    </Button>
  )
})

/** A held-back move's look: dashed outline, muted ink, no press feedback. */
export const BLOCKED_MOVE_CLASS =
  'gap-1.5 cursor-not-allowed border-dashed border-slate-300 bg-transparent text-slate-500 shadow-none hover:bg-transparent hover:text-slate-500 active:scale-100 dark:border-slate-600 dark:bg-transparent dark:text-slate-400 dark:hover:bg-transparent dark:hover:text-slate-400 [&_svg]:size-3'

/**
 * Props for a held-back move inside a menu: it stays focusable (arrow keys
 * reach it and the tip says why beside the menu), a select does nothing and
 * keeps the menu open.
 */
export function blockedMenuItemProps(t: { blocked?: MoveBlock | null }) {
  if (!t.blocked?.reason) return {}
  return {
    'aria-disabled': true,
    'aria-description': t.blocked.reason,
    'data-tip': t.blocked.reason,
    'data-tip-focus': true,
    'data-move-unavailable': t.blocked.code,
    onSelect: (e: Event) => e.preventDefault(),
    className:
      'cursor-not-allowed text-slate-400 focus:bg-slate-50 focus:text-slate-500 dark:text-slate-500 dark:focus:bg-white/5 dark:focus:text-slate-400'
  }
}

/** The lock glyph at the end of a held-back menu row. */
export function BlockedMenuMark() {
  return <Lock aria-hidden className='ml-auto h-3 w-3 shrink-0 text-slate-400' />
}
