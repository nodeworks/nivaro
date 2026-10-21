import { Asterisk, Check, EyeOff, Lock, PenLine } from 'lucide-react'
import { type ReactNode, useCallback, useRef, useState } from 'react'
import { cn } from '../../../lib/utils'
import { Popover, PopoverAnchor, PopoverContent } from '../../ui/popover'

// The pieces both matrices (#2644 field × state, #2645 role × section) share:
// a scroll box with sticky headers, cell buttons, and ONE popover anchored to
// the cell being changed (a popover per cell would mount hundreds of roots).
// Sticky cells have opaque backgrounds: tinted cells scroll under them.

export type CellTone = 'normal' | 'readonly' | 'required' | 'hidden'

export interface Choice<K extends string> {
  value: K
  label: string
  tone: CellTone
  /** Words under the label: what picking it writes. */
  effect: string
  /** Null: allowed. Otherwise why not (the row stays visible, greyed, with this tip). */
  blocked: string | null
}

const TONE: Record<CellTone, string> = {
  normal: 'text-slate-500 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted',
  readonly:
    'bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-500/15 dark:text-amber-200 dark:hover:bg-amber-500/25',
  required:
    'bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-200 dark:hover:bg-rose-500/25',
  hidden:
    'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
}

export function ToneIcon({ tone, className }: { tone: CellTone; className?: string }) {
  const cls = cn('h-3.5 w-3.5 shrink-0', className)
  if (tone === 'readonly') return <Lock aria-hidden className={cls} />
  if (tone === 'required') return <Asterisk aria-hidden className={cls} />
  if (tone === 'hidden') return <EyeOff aria-hidden className={cls} />
  return <PenLine aria-hidden className={cn(cls, 'opacity-60')} />
}

export const matrixTh =
  'sticky top-0 z-20 h-9 border-b border-slate-200 bg-slate-50 px-2 text-left text-[11.5px] font-semibold text-slate-600 dark:border-border dark:bg-card dark:text-muted-foreground'
/** The top-left corner: sticky both ways, above every other sticky cell. */
export const matrixCorner = cn(matrixTh, 'left-0 z-30 min-w-[220px]')
/** The first column of a body row: sticky left, opaque. */
export const matrixRowHead =
  'sticky left-0 z-10 min-w-[220px] max-w-[300px] border-b border-r border-slate-100 bg-white px-3 py-1 text-left align-middle dark:border-border/60 dark:bg-card'
export const matrixCellTd =
  'border-b border-slate-100 px-1 py-1 text-center align-middle dark:border-border/60'
/** A zone heading row ("Basic information"). */
export const matrixZoneTd =
  'sticky left-0 z-10 border-b border-slate-200 bg-slate-100 px-3 py-1.5 text-left text-[12px] font-semibold text-slate-700 dark:border-border dark:bg-muted dark:text-foreground'

export interface CellMenu {
  /** The cell whose menu is open (its data-matrix-cell key). */
  open: string | null
  setOpen: (key: string | null) => void
}

export function useCellMenu(): CellMenu {
  const [open, setOpen] = useState<string | null>(null)
  return { open, setOpen }
}

/**
 * One cell: its tone, icon and word. Clicking opens the shared menu on it.
 * `locked` cells never open (inherited, administrators) and say why.
 */
export function MatrixCellButton({
  cellKey,
  tone,
  word,
  tip,
  conflict,
  locked,
  label,
  menu
}: {
  cellKey: string
  tone: CellTone
  word: string
  tip: string
  conflict?: string | null
  locked?: string | null
  /** Accessible name: "Total cost in Draft: Read-only". */
  label: string
  menu: CellMenu
}) {
  const active = menu.open === cellKey
  const button = (
    <button
      type='button'
      data-matrix-cell={cellKey}
      data-tone={tone}
      aria-label={label}
      aria-haspopup={locked ? undefined : 'dialog'}
      aria-expanded={locked ? undefined : active}
      aria-disabled={locked ? true : undefined}
      data-tip={locked ?? tip}
      onClick={() => {
        if (locked) return
        menu.setOpen(active ? null : cellKey)
      }}
      className={cn(
        'relative inline-flex h-7 w-full min-w-[96px] items-center justify-center gap-1 rounded-md px-2 text-[12px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-nvr-cyan',
        TONE[tone],
        locked && 'cursor-not-allowed opacity-55',
        active && 'outline outline-2 outline-nvr-cyan'
      )}
    >
      <ToneIcon tone={tone} />
      <span className='truncate'>{word}</span>
      {conflict && (
        <span
          data-matrix-conflict=''
          className='absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-500'
        >
          <span className='sr-only'>{conflict}</span>
        </span>
      )}
    </button>
  )
  return active ? <PopoverAnchor asChild>{button}</PopoverAnchor> : button
}

/**
 * The one popover of a matrix. Wrap the table in it (`children`); the open
 * cell anchors it. Blocked choices stay listed, greyed, with their reason.
 */
export function MatrixMenu<K extends string>({
  menu,
  title,
  choices,
  current,
  onPick,
  children
}: {
  menu: CellMenu
  title: ReactNode
  choices: Choice<K>[]
  current: K | null
  onPick: (value: K) => void
  children: ReactNode
}) {
  // The last cell opened: by the time focus returns, menu.open is null.
  const last = useRef<string | null>(null)
  if (menu.open) last.current = menu.open
  const close = useCallback(() => menu.setOpen(null), [menu])
  return (
    <Popover open={menu.open != null} onOpenChange={(o) => !o && close()}>
      {children}
      <PopoverContent
        align='center'
        className='w-[280px] p-1.5'
        data-matrix-menu=''
        onCloseAutoFocus={(e) => {
          // Back to the cell that opened it (it is an anchor, not a trigger).
          e.preventDefault()
          const key = last.current
          if (!key) return
          for (const el of document.querySelectorAll<HTMLElement>('[data-matrix-cell]'))
            if (el.dataset.matrixCell === key) return el.focus({ preventScroll: true })
        }}
      >
        <p className='px-2 pb-1 pt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {title}
        </p>
        <div role='listbox' aria-label='Set to' className='flex flex-col'>
          {choices.map((c) => {
            const on = c.value === current
            return (
              <button
                key={c.value}
                type='button'
                role='option'
                aria-selected={on}
                aria-disabled={c.blocked ? true : undefined}
                data-matrix-choice={c.value}
                data-tip={c.blocked ?? undefined}
                onClick={() => {
                  if (c.blocked) return
                  onPick(c.value)
                  close()
                }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                  c.blocked ? 'cursor-not-allowed opacity-45' : 'hover:bg-muted',
                  on && 'bg-accent'
                )}
              >
                <ToneIcon tone={c.tone} className='mt-0.5' />
                <span className='min-w-0 flex-1'>
                  <span className='block text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                    {c.label}
                  </span>
                  <span className='block text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
                    {c.blocked ?? c.effect}
                  </span>
                </span>
                {on && <Check aria-hidden className='mt-0.5 h-3.5 w-3.5 text-nvr-cyan' />}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** "From Base order" / "Overrides Base order" beside a row's name, with its action. */
export function InheritChip({
  kind,
  parentName,
  action,
  actionLabel,
  actionTip,
  blocked = false,
  onAction
}: {
  kind: 'inherited' | 'override'
  parentName: string
  action: 'reset' | 'override'
  actionLabel: string
  actionTip: string
  /** The action cannot run (actionTip says why). */
  blocked?: boolean
  onAction: () => void
}) {
  return (
    <span className='mt-0.5 flex items-center gap-1.5' data-inherit={kind}>
      <span
        data-tip={
          kind === 'inherited'
            ? `Comes from ${parentName}`
            : `Changed on this form; ${parentName} has its own`
        }
        className='inline-flex items-center rounded bg-slate-100 px-1 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300'
      >
        {kind === 'inherited' ? `from ${parentName}` : 'overrides parent'}
      </span>
      <button
        type='button'
        data-inherit-action={action}
        aria-label={actionLabel}
        data-tip={actionTip}
        aria-disabled={blocked ? true : undefined}
        onClick={() => {
          if (!blocked) onAction()
        }}
        className={cn(
          'text-[11px] font-medium text-slate-500 underline-offset-2 dark:text-muted-foreground',
          blocked
            ? 'cursor-not-allowed opacity-50'
            : 'hover:text-slate-900 hover:underline dark:hover:text-foreground'
        )}
      >
        {action === 'reset' ? 'Reset' : 'Override'}
      </button>
    </span>
  )
}
