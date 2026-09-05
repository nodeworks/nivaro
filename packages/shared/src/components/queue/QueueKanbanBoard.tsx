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
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { buildGroups } from '../../lib/queue-grouping'
import { cn, formatNumber, humanHours } from '../../lib/utils'
import { OwnerAvatars } from './OwnerAvatars'

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
  return humanHours(hours)
}

const NO_STATE = '__no_state__'

function KanbanCard({
  item,
  onCardClick,
  onClaim,
  onRelease,
  claimsEnabled = true
}: {
  item: QueueItemRow
  onCardClick: (item: QueueItemRow) => void
  onClaim: (item: QueueItemRow) => void
  onRelease: (item: QueueItemRow) => void
  claimsEnabled?: boolean
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
        'nvr-section-enter w-full rounded-md border border-slate-200 bg-white p-2.5 text-left shadow-sm transition-[opacity,box-shadow,border-color] duration-150 hover:border-slate-300 hover:shadow dark:border-border dark:bg-card dark:hover:border-slate-600',
        isDragging && 'opacity-40'
      )}
    >
      <button type='button' onClick={() => onCardClick(item)} className='block w-full text-left'>
        <p className='mb-1.5 truncate text-[12px] font-medium text-slate-800 dark:text-slate-100'>
          {item.label}
        </p>
        <div className='flex items-center justify-between gap-2 text-[11px] text-slate-400'>
          {item.claimed_by ? (
            <span className='truncate'>Claimed: {item.claimed_by.name}</span>
          ) : (
            <OwnerAvatars owners={item.owners} max={3} />
          )}
          <span className='shrink-0'>{formatAging(item.aging_hours)}</span>
        </div>
        {item.at_risk && <span className='mt-1 block text-[10px] text-red-500'>⚑ At risk</span>}
      </button>
      {claimsEnabled && (
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
      )}
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
  onRelease,
  claimsEnabled = true
}: {
  stateKey: string
  label: string
  color: string | null
  items: QueueItemRow[]
  onCardClick: (item: QueueItemRow) => void
  onClaim: (item: QueueItemRow) => void
  onRelease: (item: QueueItemRow) => void
  claimsEnabled?: boolean
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
      <div className='nvr-stagger-direct flex-1 space-y-2 overflow-y-auto p-2' style={{ maxHeight: '70vh' }}>
        {items.map((item) => (
          <KanbanCard
            key={`${item.collection}:${item.item_id}`}
            item={item}
            onCardClick={onCardClick}
            onClaim={onClaim}
            onRelease={onRelease}
            claimsEnabled={claimsEnabled}
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
  onRelease,
  swimlaneBy = null,
  stateLabels,
  laneLabel,
  claimsEnabled = true
}: {
  items: QueueItemRow[]
  onDrop: (item: QueueItemRow, targetState: string) => void
  onCardClick: (item: QueueItemRow) => void
  onClaim: (item: QueueItemRow) => void
  onRelease: (item: QueueItemRow) => void
  /** Optional horizontal lanes crossed with the state columns. */
  swimlaneBy?: 'collection' | 'owners' | null
  /** State key → display label (falls back to the raw key). */
  stateLabels?: Record<string, string>
  /** Formats lane keys (e.g. collection names → display names). */
  laneLabel?: (key: string) => string
  /** When false the per-card Claim/Release button is hidden. */
  claimsEnabled?: boolean
}) {
  const [activeItem, setActiveItem] = useState<QueueItemRow | null>(null)
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(new Set())

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset collapsed lanes whenever the grouping dimension changes
  useEffect(() => {
    setCollapsedLanes(new Set())
  }, [swimlaneBy])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  )

  // Global state-column union, computed once from ALL items so columns align
  // vertically across every lane.
  const columns: Array<{ key: string; label: string; color: string | null }> = []
  const seen = new Set<string>()
  for (const item of items) {
    const key = item.state ?? NO_STATE
    if (seen.has(key)) continue
    seen.add(key)
    columns.push({
      key,
      label: item.state ? (stateLabels?.[item.state] ?? item.state) : 'No state',
      color: item.state_color
    })
  }

  const lanes = swimlaneBy ? buildGroups(items, swimlaneBy) : null

  function handleDragStart(event: DragStartEvent) {
    setActiveItem((event.active.data.current as QueueItemRow) ?? null)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveItem(null)
    const { active, over } = event
    if (!over) return
    const item = active.data.current as QueueItemRow
    // Lane droppables are namespaced `${laneKey}::${stateKey}` — the lane part is
    // derived display data, never writable; only the state segment drives the drop.
    const targetState = String(over.id).split('::').pop() as string
    if (targetState === NO_STATE) return
    if ((item.state ?? NO_STATE) === targetState) return
    onDrop(item, targetState)
  }

  function toggleLane(key: string) {
    setCollapsedLanes((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const renderColumns = (laneItems: QueueItemRow[], lanePrefix?: string) => (
    <div className='flex gap-3 overflow-x-auto pb-2'>
      {columns.map((col) => (
        <KanbanColumn
          key={col.key}
          stateKey={lanePrefix ? `${lanePrefix}::${col.key}` : col.key}
          label={col.label}
          color={col.color}
          items={laneItems.filter((i) => (i.state ?? NO_STATE) === col.key)}
          onCardClick={onCardClick}
          onClaim={onClaim}
          onRelease={onRelease}
          claimsEnabled={claimsEnabled}
        />
      ))}
      {columns.length === 0 && (
        <p className='py-12 text-center text-[13px] text-slate-400'>Nothing in this queue.</p>
      )}
    </div>
  )

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {lanes ? (
        <div className='space-y-4'>
          {lanes.map((lane) => {
            const collapsed = collapsedLanes.has(lane.key)
            return (
              <div key={lane.key}>
                <button
                  type='button'
                  onClick={() => toggleLane(lane.key)}
                  className='mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200'
                >
                  {collapsed ? (
                    <ChevronRight className='h-3.5 w-3.5 text-slate-400' />
                  ) : (
                    <ChevronDown className='h-3.5 w-3.5 text-slate-400' />
                  )}
                  {laneLabel ? laneLabel(lane.key) : lane.key}
                  <span className='font-normal text-slate-400'>
                    ({formatNumber(lane.rows.length)})
                  </span>
                </button>
                {!collapsed && renderColumns(lane.rows as QueueItemRow[], lane.key)}
              </div>
            )
          })}
          {lanes.length === 0 && (
            <p className='py-12 text-center text-[13px] text-slate-400'>Nothing in this queue.</p>
          )}
        </div>
      ) : (
        renderColumns(items)
      )}
      <DragOverlay dropAnimation={{ duration: 150, easing: 'ease' }}>
        {activeItem && (
          <div className='w-72 rounded-md border border-slate-300 bg-white p-2.5 shadow-lg dark:border-border dark:bg-card'>
            <p className='truncate text-[12px] font-medium text-slate-800'>{activeItem.label}</p>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
