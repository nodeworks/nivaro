import { ChevronsDownUp, ChevronsUpDown, Keyboard, ListTree, Search, ZoomOut } from 'lucide-react'
import { Popover, PopoverContent } from '../../ui/popover'
import { keyLabels } from '../shortcuts'
import { ToolButton } from '../toolbar-kit'
import { FindPanel } from './FindPanel'
import type { FindHit } from './find'
import { ShortcutSheet } from './ShortcutSheet'
import type { NavNode } from './tree'

// The editor's way-finding tools, as rows of the top bar's Tools menu: Find
// on this form (⌘F), the outline, the canvas view (compact, expand all /
// collapse all) and the shortcut sheet (?).

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

/** Find on this form (⌘F): a popover anchored to its row's menu. */
export function FindTool({ find }: Pick<NavToolsProps, 'find'>) {
  return (
    <Popover open={find.open} onOpenChange={find.onOpenChange}>
      <ToolButton
        popover
        onOpen={() => find.onOpenChange(true)}
        label='Find on this form'
        icon={<Search className='h-4 w-4' />}
        kbd={tipKeys(['mod', 'f'])}
        tip={`Find a field by label or key (${tipKeys(['mod', 'f'])})`}
        active={find.open}
        data={{ 'data-editor-find-button': '' }}
      />
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
  )
}

/** The outline beside the canvas (absent on layouts without one). */
export function OutlineTool({ outline }: Pick<NavToolsProps, 'outline'>) {
  if (!outline) return null
  return (
    <ToolButton
      label='Outline'
      icon={<ListTree className='h-4 w-4' />}
      hint='The form as a tree beside the canvas'
      tip={outline.open ? 'Hide the outline' : 'Show the form as a tree beside the canvas'}
      checked={outline.open}
      onClick={outline.onToggle}
      data={{ 'data-editor-outline-toggle': '' }}
    />
  )
}

/** Compact canvas, expand all / collapse all (absent without the form canvas). */
export function ViewTools({ view }: Pick<NavToolsProps, 'view'>) {
  if (!view) return null
  return (
    <>
      <ToolButton
        label='Compact canvas'
        icon={<ZoomOut className='h-4 w-4' />}
        hint='Smaller spacing and inputs, here only'
        checked={view.compact}
        onClick={() => view.onCompact(!view.compact)}
        data={{ 'data-editor-compact': '' }}
      />
      <ToolButton
        label='Expand all'
        icon={<ChevronsUpDown className='h-4 w-4' />}
        hint='Every step and tab shown'
        onClick={view.onExpandAll}
        data={{ 'data-editor-expand-all': '' }}
      />
      <ToolButton
        label='Collapse all'
        icon={<ChevronsDownUp className='h-4 w-4' />}
        onClick={view.onCollapseAll}
        data={{ 'data-editor-collapse-all': '' }}
      />
    </>
  )
}

/** The keyboard shortcut sheet (?). */
export function ShortcutsTool({ shortcuts }: Pick<NavToolsProps, 'shortcuts'>) {
  return (
    <Popover open={shortcuts.open} onOpenChange={shortcuts.onOpenChange}>
      <ToolButton
        popover
        onOpen={() => shortcuts.onOpenChange(true)}
        label='Keyboard shortcuts'
        icon={<Keyboard className='h-4 w-4' />}
        kbd='?'
        tip='Keyboard shortcuts (?)'
        active={shortcuts.open}
        data={{ 'data-editor-shortcuts-button': '' }}
      />
      <PopoverContent
        align='end'
        className='max-h-[min(80vh,620px)] w-[380px] overflow-y-auto overscroll-contain p-0'
      >
        <ShortcutSheet />
      </PopoverContent>
    </Popover>
  )
}
