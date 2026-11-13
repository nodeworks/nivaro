import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { ErrorNotice } from '@nivaro/shared'
import { MoreHorizontal, Pin } from 'lucide-react'
import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import type { Collection } from '@/lib/api'
import { label } from './page-model'
import { FolderHeader, Section, SortableRow } from './sections'

export const PINNED_KEY = '__pinned__'

export interface PinnedRowOptions {
  /** Admins: the drag handle at the row's left. */
  handle?: ReactNode
  /** Admins: one place up / down (absent at the ends). */
  onMoveUp?: () => void
  onMoveDown?: () => void
}

/**
 * "Pinned" — the collections an administrator put at the top of the page for everyone,
 * in their order. Admins reorder by drag (pointer or keyboard: focus the handle, Space,
 * arrows, Space) or with Move up / Move down in the row menu; everyone else reads it.
 * Hidden from non-admins while it is empty (there is nothing they could do with it).
 */
export function PinnedSection({
  cols,
  isAdmin,
  status,
  error,
  onRetry,
  onReorder,
  collapsed,
  onToggle,
  renderRow,
  sectionId
}: {
  cols: Collection[]
  isAdmin: boolean
  status: 'loading' | 'error' | 'ready'
  error?: unknown
  onRetry?: () => void
  onReorder: (names: string[]) => void
  collapsed: boolean
  onToggle: () => void
  renderRow: (col: Collection, opts: PinnedRowOptions) => ReactNode
  sectionId?: string
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  if (status === 'loading' && !isAdmin) return null
  if (status === 'ready' && cols.length === 0 && !isAdmin) return null

  const names = cols.map((c) => c.collection)
  const move = (name: string, delta: -1 | 1) => {
    const from = names.indexOf(name)
    const to = from + delta
    if (from === -1 || to < 0 || to >= names.length) return
    onReorder(arrayMove(names, from, to))
  }
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = names.indexOf(String(active.id))
    const to = names.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    onReorder(arrayMove(names, from, to))
  }

  let body: ReactNode
  if (status === 'loading') {
    body = (
      <div role='status' aria-busy='true' aria-label='Loading pinned collections'>
        {[0, 1].map((i) => (
          <div
            key={i}
            className='flex h-7 items-center gap-2.5 border-b border-slate-100 px-4 last:border-0 dark:border-white/[0.05]'
          >
            <Skeleton className='h-5 w-5 rounded' />
            <Skeleton className='h-3 w-40' />
          </div>
        ))}
      </div>
    )
  } else if (status === 'error') {
    body = (
      <div className='px-4 py-3'>
        <ErrorNotice error={error} what='the pinned collections' onRetry={onRetry} />
      </div>
    )
  } else if (cols.length === 0) {
    body = (
      <div className='px-4 py-3'>
        <p className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>
          Pin collections everyone should see first
        </p>
        <p className='mt-1 text-[12px] leading-relaxed text-slate-500 dark:text-slate-400'>
          Open a row’s
          <MoreHorizontal className='mx-1 inline h-3 w-3 -translate-y-px' aria-hidden='true' />
          menu and choose Pin for everyone, or use the
          <Pin className='mx-1 inline h-3 w-3 -translate-y-px' aria-hidden='true' />
          that shows when you point at a row. Everyone sees them here in your order — only the ones
          they can open. Only administrators can change this list.
        </p>
      </div>
    )
  } else if (!isAdmin) {
    body = (
      <div className='divide-y divide-slate-100 dark:divide-white/[0.05]'>
        {cols.map((c) => (
          <div key={c.collection}>{renderRow(c, {})}</div>
        ))}
      </div>
    )
  } else {
    body = (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={names} strategy={verticalListSortingStrategy}>
          <div className='divide-y divide-slate-100 dark:divide-white/[0.05]'>
            {cols.map((c, i) => (
              <SortableRow key={c.collection} id={c.collection} label={label(c)}>
                {(handle) =>
                  renderRow(c, {
                    handle,
                    onMoveUp: i > 0 ? () => move(c.collection, -1) : undefined,
                    onMoveDown: i < cols.length - 1 ? () => move(c.collection, 1) : undefined
                  })
                }
              </SortableRow>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    )
  }

  const open = !collapsed
  return (
    <div data-collections-pinned>
      <Section id={sectionId ?? 'cl-section-pinned'}>
        <FolderHeader
          folder={{ key: PINNED_KEY, label: 'Pinned', color: '#64748b' }}
          icon={
            <Pin
              className='h-3 w-3 fill-slate-500 text-slate-500 dark:fill-slate-300 dark:text-slate-300'
              aria-hidden='true'
            />
          }
          hint='For everyone'
          // Admin rows start with a drag handle; the same gutter here lines the icon up.
          dragHandle={
            isAdmin && status === 'ready' && cols.length > 0 ? (
              <span className='w-9 shrink-0' />
            ) : undefined
          }
          count={status === 'ready' && cols.length > 0 ? cols.length : null}
          hiddenCount={0}
          collapsed={!open}
          onToggle={onToggle}
        />
        {open && body}
      </Section>
    </div>
  )
}
