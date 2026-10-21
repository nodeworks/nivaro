import { Check, ChevronDown } from 'lucide-react'
import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * The editor's toolbar parts: one look for every bar button, and the bar's
 * menus (Tools ▾, AI ▾, ⋯, Save ▾).
 *
 * A tool renders a `ToolButton`. On its own it is a bar button (and its
 * popover's trigger). Inside a `BarMenu` the same component stays mounted
 * outside the menu, keeps its state, and puts a row into the open menu
 * instead; picking the row closes the menu and opens the tool's popover
 * anchored to the menu's button. Badges and dots of the rows add up on the
 * menu's button.
 */

export const barBtn =
  'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
export const barIconBtn =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 disabled:pointer-events-none disabled:opacity-40 dark:text-muted-foreground dark:hover:text-foreground'
/** A bordered bar button that is on (its panel open, its view shown). */
export const barBtnOn = 'border-nvr-cyan/40 bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
/** An icon button that is on. */
export const barIconOn = 'bg-accent text-slate-900 dark:text-foreground'
/** A count beside a bar button's label. */
export const barCount =
  'inline-flex min-w-[18px] items-center justify-center rounded-full bg-nvr-cyan/15 px-1 text-[11px] font-semibold tabular-nums text-slate-800 dark:text-foreground'

const rowCls =
  'flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] text-slate-700 outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-40 dark:text-foreground'

interface Report {
  badge?: number
  dot?: boolean
}

interface BarMenuState {
  open: boolean
  /** The open menu's list element (rows portal into it). */
  list: HTMLElement | null
  /** The menu's button: what a picked tool's popover anchors to. */
  anchor: RefObject<HTMLButtonElement | null>
  /** Close the menu; `run` (opening a popover or a panel) runs with it, and
   *  focus stays where `run` puts it instead of going back to the menu's button. */
  pick: (run?: () => void) => void
  report: (id: string, r: Report | null) => void
}

const BarMenuContext = createContext<BarMenuState | null>(null)

/** The menu a tool sits in, or null when it is a bar button of its own. */
export function useBarMenu() {
  return useContext(BarMenuContext)
}

function arrowNav(e: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!keys.includes(e.key)) return
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])')
  ]
  if (items.length === 0) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : e.key === 'ArrowDown'
          ? (at + 1) % items.length
          : (at - 1 + items.length) % items.length
  items[next]?.focus()
}

/**
 * A bar button that opens a menu of tools. `children` are the tools
 * themselves (ToolButton-based components); they render no box in the bar.
 * Hidden while no tool offers a row (e.g. AI for someone who is not an
 * administrator).
 */
export function BarMenu({
  label,
  icon,
  tip,
  children,
  iconOnly = false,
  align = 'start',
  width = 'w-[288px]',
  className,
  data
}: {
  label: string
  icon?: ReactNode
  tip?: string
  children: ReactNode
  /** The button shows the icon only (label as its accessible name). */
  iconOnly?: boolean
  align?: 'start' | 'center' | 'end'
  width?: string
  className?: string
  data?: Record<string, string>
}) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<HTMLElement | null>(null)
  // State, not only a ref: rows re-render once the button exists, so a
  // shortcut-opened popover (⌘F, ⌘K) already has its anchor.
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null)
  const anchor = useMemo(() => ({ current: anchorEl }), [anchorEl])
  const keepFocus = useRef(false)
  const [reports, setReports] = useState<Record<string, Report>>({})
  const report = useCallback((id: string, r: Report | null) => {
    setReports((cur) => {
      if (r == null) {
        if (!(id in cur)) return cur
        const { [id]: _, ...rest } = cur
        return rest
      }
      const prev = cur[id]
      if (prev && prev.badge === r.badge && prev.dot === r.dot) return cur
      return { ...cur, [id]: r }
    })
  }, [])
  const pick = useCallback((run?: () => void) => {
    keepFocus.current = !!run
    setOpen(false)
    run?.()
  }, [])
  const ctx = useMemo<BarMenuState>(
    () => ({ open, list, anchor, pick, report }),
    [open, list, anchor, pick, report]
  )
  const entries = Object.values(reports)
  const badge = entries.reduce((s, r) => s + (r.badge ?? 0), 0)
  const dot = entries.some((r) => r.dot)

  return (
    <BarMenuContext.Provider value={ctx}>
      {children}
      {entries.length > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              ref={setAnchorEl}
              type='button'
              aria-haspopup='menu'
              aria-label={iconOnly ? label : undefined}
              data-tip={tip}
              data-bar-menu={label}
              {...data}
              className={cn(
                iconOnly ? barIconBtn : barBtn,
                'relative',
                open && (iconOnly ? barIconOn : barBtnOn),
                className
              )}
            >
              {icon}
              {!iconOnly && <span data-tb-menu-label=''>{label}</span>}
              {badge > 0 && (
                <span
                  data-bar-menu-badge={badge}
                  className={cn(
                    barCount,
                    iconOnly &&
                      'absolute -right-1 -top-1 h-4 min-w-4 bg-white px-0.5 text-[10px] ring-1 ring-slate-200 dark:bg-card dark:ring-border'
                  )}
                >
                  {badge}
                </span>
              )}
              {dot && (
                <span
                  data-bar-menu-dot=''
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-rose-500',
                    iconOnly && 'absolute right-1 top-1'
                  )}
                />
              )}
              {!iconOnly && (
                <ChevronDown className='h-3 w-3 shrink-0 text-slate-500 dark:text-muted-foreground' />
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            ref={setList}
            role='menu'
            aria-label={label}
            align={align}
            data-bar-menu-list={label}
            onKeyDown={arrowNav}
            onCloseAutoFocus={(e) => {
              if (!keepFocus.current) return
              e.preventDefault()
              keepFocus.current = false
            }}
            className={cn(
              'flex max-h-[min(80vh,560px)] flex-col gap-px overflow-y-auto overscroll-contain p-1',
              // Separators of sections that offer nothing here (a host without AI) fold away.
              '[&>hr:first-child]:hidden [&>hr:last-child]:hidden [&>hr+hr]:hidden',
              width
            )}
          />
        </Popover>
      )}
    </BarMenuContext.Provider>
  )
}

/** A line between groups of rows in a BarMenu (nothing outside one). */
export function MenuSeparator() {
  const menu = useBarMenu()
  if (!menu?.open || !menu.list) return null
  return createPortal(
    <hr className='my-1 h-px shrink-0 border-0 bg-slate-100 dark:bg-border' />,
    menu.list
  )
}

export interface ToolButtonProps {
  label: string
  icon?: ReactNode
  /** Instant tip in the bar; in a menu the row's second line says it (`hint`). */
  tip?: string
  /** A menu row's second line. */
  hint?: ReactNode
  /** A shortcut shown at the row's end ("⌘F"). */
  kbd?: string
  /** The button opens a popover: it is the popover's trigger in the bar. */
  popover?: boolean
  /** In a menu: open the tool's popover (anchored to the menu's button). */
  onOpen?: () => void
  /** A plain action (in a menu it runs and the menu closes, unless `checked` is set). */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  /** The action opens a dialog or panel that takes focus: the menu does not take it back. */
  opensDialog?: boolean
  disabled?: boolean
  /** On / off: pressed in the bar, a tick in a menu (the menu stays open). */
  checked?: boolean
  /** Its popover or panel is showing. */
  active?: boolean
  /** A count (a menu adds its rows' counts up on its button). */
  badge?: number
  /** Something is running (recording): a pulsing dot. */
  dot?: boolean
  /** Bar: icon only, the label is the accessible name. */
  iconOnly?: boolean
  /** Bar: after the label (a coloured count, a state icon). */
  trailing?: ReactNode
  ariaLabel?: string
  className?: string
  buttonRef?: (el: HTMLButtonElement | null) => void
  /** data-* attributes, on the bar button or the menu row. */
  data?: Record<string, string | number | undefined>
}

/** A tool's button: in the bar on its own, or a row inside a BarMenu. */
export function ToolButton(props: ToolButtonProps) {
  const menu = useBarMenu()
  const id = useId()
  const report = menu?.report
  const { badge, dot } = props
  useEffect(() => {
    if (!report) return
    report(id, { badge, dot })
    return () => report(id, null)
  }, [report, id, badge, dot])
  if (menu) return <ToolRow {...props} menu={menu} />
  const {
    label,
    icon,
    tip,
    popover,
    onClick,
    disabled,
    checked,
    active,
    iconOnly,
    trailing,
    ariaLabel,
    className,
    buttonRef,
    data
  } = props
  const btn = (
    <button
      ref={buttonRef}
      type='button'
      aria-label={ariaLabel ?? (iconOnly ? label : undefined)}
      aria-pressed={checked}
      data-tip={tip}
      disabled={disabled}
      onClick={onClick}
      {...data}
      className={cn(
        iconOnly ? barIconBtn : barBtn,
        (active || checked) && (iconOnly ? barIconOn : barBtnOn),
        className
      )}
    >
      {icon}
      {!iconOnly && label}
      {trailing}
    </button>
  )
  return popover ? <PopoverTrigger asChild>{btn}</PopoverTrigger> : btn
}

function ToolRow({
  menu,
  label,
  icon,
  hint,
  kbd,
  popover,
  onOpen,
  onClick,
  opensDialog,
  disabled,
  checked,
  active,
  badge,
  dot,
  ariaLabel,
  data
}: ToolButtonProps & { menu: BarMenuState }) {
  const row =
    menu.open && menu.list
      ? createPortal(
          <button
            type='button'
            {...(checked === undefined
              ? { role: 'menuitem' }
              : { role: 'menuitemcheckbox', 'aria-checked': checked })}
            aria-label={ariaLabel}
            disabled={disabled}
            {...data}
            onClick={(e) => {
              if (popover) return menu.pick(onOpen)
              if (checked !== undefined) return onClick?.(e)
              if (opensDialog) return menu.pick(() => onClick?.(e))
              onClick?.(e)
              menu.pick()
            }}
            className={cn(rowCls, active && 'bg-accent')}
          >
            <span className='flex h-4 w-4 shrink-0 items-center justify-center text-slate-500 dark:text-muted-foreground [&>svg]:h-3.5 [&>svg]:w-3.5'>
              {icon}
            </span>
            <span className='flex min-w-0 flex-1 flex-col'>
              <span className='truncate font-medium text-slate-900 dark:text-foreground'>
                {label}
              </span>
              {hint && (
                <span className='text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
                  {hint}
                </span>
              )}
            </span>
            {dot && (
              <span className='h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-rose-500' />
            )}
            {!!badge && badge > 0 && <span className={barCount}>{badge}</span>}
            {kbd && (
              <kbd className='shrink-0 font-sans text-[11px] text-slate-500 dark:text-muted-foreground'>
                {kbd}
              </kbd>
            )}
            {checked !== undefined && (
              <Check
                aria-hidden
                className={cn('h-3.5 w-3.5 shrink-0 text-nvr-cyan', !checked && 'invisible')}
              />
            )}
          </button>,
          menu.list
        )
      : null
  // A popover tool opens beside the menu's button (also from its shortcut).
  return (
    <>
      {popover && <PopoverAnchor virtualRef={menu.anchor as RefObject<HTMLButtonElement>} />}
      {row}
    </>
  )
}
