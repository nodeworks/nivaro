import { ChevronsDownUp, ChevronsUpDown, Keyboard, ListTree, Search, ZoomOut } from 'lucide-react'
import { useId } from 'react'
import { cn } from '../../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Switch } from '../../ui/switch'
import { keyLabels } from '../shortcuts'
import { FindPanel } from './FindPanel'
import type { FindHit } from './find'
import { ShortcutSheet } from './ShortcutSheet'
import type { NavNode } from './tree'

// The top bar's way-finding tools: Find (⌘F), the outline toggle, the canvas
// view (compact, expand all / collapse all) and the shortcut sheet (?).

const iconBtn =
  'inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 disabled:pointer-events-none disabled:opacity-40 dark:text-muted-foreground dark:hover:text-foreground'
const onBtn = 'bg-accent text-slate-900 dark:text-foreground'
const menuRow =
  'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-foreground'

const tipKeys = (keys: string[]) => keyLabels(keys).join('')

export interface NavToolsProps {
  find: {
    open: boolean
    onOpenChange: (open: boolean) => void
    nodes: NavNode[]
    onPick: (hit: FindHit) => void
    focusSeq: number
    /** Radix close-focus hook: a picked match keeps focus on the canvas. */
    onCloseAutoFocus?: (e: Event) => void
  }
  /** Absent on layouts without an outline (table columns, PDF). */
  outline?: { open: boolean; onToggle: () => void } | null
  /** Absent on layouts without the form canvas. */
  view?: {
    compact: boolean
    onCompact: (on: boolean) => void
    onExpandAll: () => void
    onCollapseAll: () => void
  } | null
  shortcuts: { open: boolean; onOpenChange: (open: boolean) => void }
}

export function NavTools({ find, outline, view, shortcuts }: NavToolsProps) {
  const compactId = useId()
  return (
    <div data-editor-nav-tools='' className='flex items-center gap-0.5'>
      <Popover open={find.open} onOpenChange={find.onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type='button'
            aria-label='Find on the form'
            data-editor-find-button=''
            data-tip={`Find a field by label or key (${tipKeys(['mod', 'f'])})`}
            className={cn(iconBtn, find.open && onBtn)}
          >
            <Search className='h-4 w-4' />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align='start'
          className='w-[340px] p-0'
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={find.onCloseAutoFocus}
        >
          {find.open && (
            <FindPanel nodes={find.nodes} onPick={find.onPick} focusSeq={find.focusSeq} />
          )}
        </PopoverContent>
      </Popover>
      {outline && (
        <button
          type='button'
          aria-label='Outline'
          aria-pressed={outline.open}
          data-editor-outline-toggle=''
          data-tip={outline.open ? 'Hide the outline' : 'Show the form as a tree beside the canvas'}
          onClick={outline.onToggle}
          className={cn(iconBtn, outline.open && onBtn)}
        >
          <ListTree className='h-4 w-4' />
        </button>
      )}
      {view && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type='button'
              aria-label='Canvas view'
              data-editor-view-menu=''
              data-tip='Compact canvas, expand or collapse every section, step and tab'
              className={cn(iconBtn, view.compact && onBtn)}
            >
              <ZoomOut className='h-4 w-4' />
            </button>
          </PopoverTrigger>
          <PopoverContent align='start' className='w-[260px] p-1.5'>
            <label
              htmlFor={compactId}
              className='flex h-9 cursor-pointer items-center gap-2 px-2 text-[12.5px] text-slate-700 dark:text-foreground'
            >
              <span className='flex-1'>
                Compact canvas
                <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
                  Smaller spacing and inputs, here only
                </span>
              </span>
              <Switch
                id={compactId}
                checked={view.compact}
                onCheckedChange={view.onCompact}
                aria-label='Compact canvas'
                data-editor-compact=''
              />
            </label>
            <div className='my-1 h-px bg-slate-100 dark:bg-border' />
            <button
              type='button'
              data-editor-expand-all=''
              onClick={view.onExpandAll}
              className={menuRow}
            >
              <ChevronsUpDown className='h-3.5 w-3.5 text-slate-500 dark:text-muted-foreground' />
              Expand all
              <span className='ml-auto text-[11px] text-slate-500 dark:text-muted-foreground'>
                every step and tab shown
              </span>
            </button>
            <button
              type='button'
              data-editor-collapse-all=''
              onClick={view.onCollapseAll}
              className={menuRow}
            >
              <ChevronsDownUp className='h-3.5 w-3.5 text-slate-500 dark:text-muted-foreground' />
              Collapse all
            </button>
          </PopoverContent>
        </Popover>
      )}
      <Popover open={shortcuts.open} onOpenChange={shortcuts.onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type='button'
            aria-label='Keyboard shortcuts'
            data-editor-shortcuts-button=''
            data-tip='Keyboard shortcuts (?)'
            className={cn(iconBtn, shortcuts.open && onBtn)}
          >
            <Keyboard className='h-4 w-4' />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align='end'
          className='max-h-[min(80vh,620px)] w-[380px] overflow-y-auto overscroll-contain p-0'
        >
          <ShortcutSheet />
        </PopoverContent>
      </Popover>
    </div>
  )
}
