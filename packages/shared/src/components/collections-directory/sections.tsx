import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronRight, FolderOpen, GripVertical } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import type { FolderOption } from './types'

/**
 * The collections directory's building blocks (CollectionsDirectory and PinnedSection):
 * a bordered section, its sticky header and the sortable wrapper used by Arrange mode
 * and by the Pinned section.
 */

// ─── Sortable wrapper (Arrange mode; the Pinned section for admins) ──────────

export function SortableRow({
  id,
  label,
  children
}: {
  id: string
  /** Names the thing being moved for screen readers ("Drag to reorder Invoices"). */
  label?: string
  children: (handle: ReactNode) => ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id
  })
  const handle = (
    <button
      type='button'
      {...attributes}
      {...listeners}
      aria-label={label ? `Drag to reorder ${label}` : 'Drag to reorder'}
      data-tip='Drag to reorder (or focus and press Space, then the arrow keys)'
      className='flex w-7 shrink-0 cursor-grab touch-none items-center justify-center self-stretch rounded text-slate-400 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50 dark:text-slate-500 dark:hover:text-slate-300'
    >
      <GripVertical className='h-3.5 w-3.5' />
    </button>
  )
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'z-10 opacity-50')}
    >
      {children(handle)}
    </div>
  )
}

// ─── Folder section ───────────────────────────────────────────────────────────

export function FolderHeader({
  folder,
  count,
  hiddenCount,
  collapsed,
  onToggle,
  dragHandle,
  icon,
  hint
}: {
  folder: FolderOption
  /** null = no count shown (still loading, failed, or nothing to count). */
  count: number | null
  hiddenCount: number
  collapsed: boolean
  onToggle: () => void
  dragHandle?: ReactNode
  icon?: ReactNode
  /** A few muted words after the name ("For everyone"). */
  hint?: ReactNode
}) {
  const color = folder.color ?? '#94a3b8'
  return (
    <div
      // Sticks under the page toolbar while its folder scrolls past.
      className='sticky z-[5] flex items-stretch border-b border-slate-200 bg-slate-50 dark:border-white/[0.08] dark:bg-[#141f2a]'
      style={{ top: 'var(--cl-toolbar-h, 0px)' }}
    >
      {dragHandle}
      <button
        type='button'
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={cn(
          'flex flex-1 items-center gap-2.5 py-1.5 pr-4 text-left transition-colors hover:bg-slate-100 dark:hover:bg-white/[0.04]',
          !dragHandle && 'pl-4'
        )}
      >
        <span
          className='flex h-5 w-5 shrink-0 items-center justify-center rounded'
          style={{ backgroundColor: `${color}22` }}
        >
          {icon ?? <FolderOpen className='h-3 w-3' style={{ color }} />}
        </span>
        <span className='flex min-w-0 flex-1 items-baseline gap-2'>
          <span className='truncate text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
            {folder.label}
          </span>
          {hint && (
            <span className='truncate text-[11.5px] text-slate-500 dark:text-slate-400'>
              {hint}
            </span>
          )}
        </span>
        <span className='text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
          {count}
          {count != null && hiddenCount > 0 && (
            <span data-tip='Hidden collections in this folder — turn on Show hidden collections to list them'>
              {' '}
              · {hiddenCount} hidden
            </span>
          )}
        </span>
        {collapsed ? (
          <ChevronRight className='h-3.5 w-3.5 text-slate-400 dark:text-slate-500' />
        ) : (
          <ChevronDown className='h-3.5 w-3.5 text-slate-400 dark:text-slate-500' />
        )}
      </button>
    </div>
  )
}

export function Section({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section
      id={id}
      className='rounded-lg border border-slate-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]'
      style={{ scrollMarginTop: 'calc(var(--cl-toolbar-h, 0px) + 12px)' }}
    >
      {children}
    </section>
  )
}
