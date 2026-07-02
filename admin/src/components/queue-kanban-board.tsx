import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { useState } from 'react'
import { cn, formatNumber } from '@/lib/utils'

export interface QueueOwner {
  id: string
  name: string
}

export interface QueueItemRow {
  collection: string
  item_id: string
  label: string
  state: string | null
  state_color: string | null
  owners: QueueOwner[]
  sla_status: 'ok' | 'warning' | 'breached' | null
  at_risk: boolean
  aging_hours: number | null
  claimed_by: QueueOwner | null
  url: string
}

function formatAging(hours: number | null): string {
  if (hours == null) return '—'
  if (hours < 1) return '<1h'
  if (hours < 24) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}

const NO_STATE = '__no_state__'

function KanbanCard({
  item,
  onCardClick,
  onClaim,
  onRelease
}: {
  item: QueueItemRow
  onCardClick: (item: QueueItemRow) => void
  onClaim: (item: QueueItemRow) => void
  onRelease: (item: QueueItemRow) => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${item.collection}:${item.item_id}`,
    data: item
  })

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        'w-full rounded-md border border-slate-200 bg-white p-2.5 text-left shadow-sm dark:border-border dark:bg-card',
        isDragging && 'opacity-40'
      )}
    >
      <button type='button' onClick={() => onCardClick(item)} className='block w-full text-left'>
        <p className='mb-1.5 truncate text-[12px] font-medium text-slate-800 dark:text-slate-100'>
          {item.label}
        </p>
        <div className='flex items-center justify-between text-[11px] text-slate-400'>
          <span className='truncate'>
            {item.claimed_by
              ? `Claimed: ${item.claimed_by.name}`
              : item.owners.length
                ? item.owners.map((o) => o.name).join(', ')
                : 'No owners'}
          </span>
          <span className='shrink-0'>{formatAging(item.aging_hours)}</span>
        </div>
        {item.at_risk && <span className='mt-1 block text-[10px] text-red-500'>⚑ At risk</span>}
      </button>
      <button
        type='button'
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          item.claimed_by ? onRelease(item) : onClaim(item)
        }}
        className='mt-1.5 text-[11px] font-medium text-nvr-navy underline dark:text-nvr-cyan'
      >
        {item.claimed_by ? 'Release' : 'Claim'}
      </button>
    </div>
  )
}

function KanbanColumn({
  stateKey,
  label,
  color,
  items,
  onCardClick,
  onClaim,
  onRelease
}: {
  stateKey: string
  label: string
  color: string | null
  items: QueueItemRow[]
  onCardClick: (item: QueueItemRow) => void
  onClaim: (item: QueueItemRow) => void
  onRelease: (item: QueueItemRow) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stateKey })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-lg border border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/30',
        isOver && 'ring-2 ring-nvr-cyan'
      )}
    >
      <div className='flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-border'>
        <span
          className='h-2 w-2 shrink-0 rounded-full'
          style={{ backgroundColor: color ?? '#94a3b8' }}
        />
        <span className='truncate text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
          {label}
        </span>
        <span className='ml-auto shrink-0 text-[11px] text-slate-400'>
          {formatNumber(items.length)}
        </span>
      </div>
      <div className='flex-1 space-y-2 overflow-y-auto p-2' style={{ maxHeight: '70vh' }}>
        {items.map((item) => (
          <KanbanCard
            key={`${item.collection}:${item.item_id}`}
            item={item}
            onCardClick={onCardClick}
            onClaim={onClaim}
            onRelease={onRelease}
          />
        ))}
        {items.length === 0 && (
          <p className='py-6 text-center text-[11px] text-slate-300'>Nothing here</p>
        )}
      </div>
    </div>
  )
}

export function QueueKanbanBoard({
  items,
  onDrop,
  onCardClick,
  onClaim,
  onRelease
}: {
  items: QueueItemRow[]
  onDrop: (item: QueueItemRow, targetState: string) => void
  onCardClick: (item: QueueItemRow) => void
  onClaim: (item: QueueItemRow) => void
  onRelease: (item: QueueItemRow) => void
}) {
  const [activeItem, setActiveItem] = useState<QueueItemRow | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  )

  const columns: Array<{ key: string; label: string; color: string | null }> = []
  const seen = new Set<string>()
  for (const item of items) {
    const key = item.state ?? NO_STATE
    if (seen.has(key)) continue
    seen.add(key)
    columns.push({ key, label: item.state ?? 'No state', color: item.state_color })
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveItem((event.active.data.current as QueueItemRow) ?? null)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveItem(null)
    const { active, over } = event
    if (!over) return
    const item = active.data.current as QueueItemRow
    const targetState = String(over.id)
    if (targetState === NO_STATE) return
    if ((item.state ?? NO_STATE) === targetState) return
    onDrop(item, targetState)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className='flex gap-3 overflow-x-auto pb-2'>
        {columns.map((col) => (
          <KanbanColumn
            key={col.key}
            stateKey={col.key}
            label={col.label}
            color={col.color}
            items={items.filter((i) => (i.state ?? NO_STATE) === col.key)}
            onCardClick={onCardClick}
            onClaim={onClaim}
            onRelease={onRelease}
          />
        ))}
        {columns.length === 0 && (
          <p className='py-12 text-center text-[13px] text-slate-400'>Nothing in this queue.</p>
        )}
      </div>
      <DragOverlay dropAnimation={{ duration: 150, easing: 'ease' }}>
        {activeItem && (
          <div className='w-72 rounded-md border border-slate-300 bg-white p-2.5 shadow-lg'>
            <p className='truncate text-[12px] font-medium text-slate-800'>{activeItem.label}</p>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
