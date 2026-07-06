import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS as DndCSS } from '@dnd-kit/utilities'
import { GripVertical, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CollectionFieldPickerPanel, type PickedField } from '@/components/field-picker'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { titleCase } from '@/lib/utils'

// Chip-based {{field}} display-template builder. Extracted from TableEditor's
// Settings tab so queue sources (and future consumers) share the exact editor.

type TemplateToken = { type: 'text'; value: string } | { type: 'field'; value: string }

function parseTemplate(template: string): TemplateToken[] {
  const tokens: TemplateToken[] = []
  const re = /\{\{([\w.]+)\}\}/g
  let last = 0
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: regex loop pattern
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', value: template.slice(last, m.index) })
    tokens.push({ type: 'field', value: m[1] })
    last = m.index + m[0].length
  }
  if (last < template.length) tokens.push({ type: 'text', value: template.slice(last) })
  return tokens
}

function serializeTemplate(tokens: TemplateToken[]): string {
  return tokens.map((t) => (t.type === 'field' ? `{{${t.value}}}` : t.value)).join('')
}

const snapCenterToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (draggingNodeRect && activatorEvent && 'clientX' in activatorEvent) {
    const e = activatorEvent as PointerEvent
    return {
      ...transform,
      x: transform.x + e.clientX - (draggingNodeRect.left + draggingNodeRect.width / 2),
      y: transform.y + e.clientY - (draggingNodeRect.top + draggingNodeRect.height / 2)
    }
  }
  return transform
}

function SortableTemplateToken({
  id,
  tok,
  idx,
  onUpdate,
  onRemove
}: {
  id: string
  tok: TemplateToken
  idx: number
  onUpdate: (idx: number, value: string) => void
  onRemove: (idx: number) => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = {
    transform: DndCSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }
  const handle = (
    <span
      ref={setActivatorNodeRef}
      {...listeners}
      className='inline-flex cursor-grab items-center text-slate-300 hover:text-slate-500 dark:text-muted-foreground'
    >
      <GripVertical className='h-3 w-3 shrink-0' />
    </span>
  )
  if (tok.type === 'field') {
    return (
      <span
        ref={setNodeRef}
        style={style}
        {...attributes}
        className='inline-flex items-center gap-1 rounded-full bg-nvr-cyan/10 px-1.5 py-0.5 text-[12px] font-medium text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
      >
        {handle}
        {tok.value.split('.').map(titleCase).join(' → ')}
        <button
          type='button'
          onClick={() => onRemove(idx)}
          className='text-nvr-navy/50 hover:text-red-500 dark:text-nvr-cyan/50'
        >
          ×
        </button>
      </span>
    )
  }
  return (
    <span
      ref={setNodeRef}
      style={style}
      {...attributes}
      className='inline-flex items-center gap-0.5 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 dark:border-border dark:bg-muted'
    >
      {handle}
      <input
        value={tok.value}
        onChange={(e) => onUpdate(idx, e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        placeholder='text…'
        size={Math.max(4, tok.value.length || 4)}
        className='bg-transparent text-[12px] text-slate-700 outline-none dark:text-foreground'
      />
      <button
        type='button'
        onClick={() => onRemove(idx)}
        onPointerDown={(e) => e.stopPropagation()}
        className='text-slate-300 hover:text-red-500 dark:text-muted-foreground'
      >
        ×
      </button>
    </span>
  )
}

export function DisplayTemplateEditor({
  value,
  onChange,
  collection,
  placeholder = 'Add fields and text to build a display template',
  disabled
}: {
  value: string
  onChange: (v: string) => void
  collection: string
  placeholder?: string
  disabled?: boolean
}) {
  const [tokens, setTokens] = useState<TemplateToken[]>(() => parseTemplate(value))
  const [pickerOpen, setPickerOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  // Sync inbound value changes without clobbering local empty-text tokens
  const prevValueRef = useRef(value)
  useEffect(() => {
    if (value !== serializeTemplate(tokens) && value !== prevValueRef.current) {
      setTokens(parseTemplate(value))
    }
    prevValueRef.current = value
    // biome-ignore lint/correctness/useExhaustiveDependencies: sync on inbound value only
  }, [value])

  // Stable IDs keyed to content so dnd-kit tracks correctly across re-renders
  const tokenIds = tokens.map((t, i) => `${t.type}:${i}`)
  const activeToken = activeId != null ? tokens[tokenIds.indexOf(activeId)] ?? null : null

  function commit(next: TemplateToken[]) {
    setTokens(next)
    onChange(serializeTemplate(next))
  }

  function updateToken(idx: number, text: string) {
    commit(tokens.map((t, i) => (i === idx ? { ...t, value: text } : t)))
  }

  function removeToken(idx: number) {
    commit(tokens.filter((_, i) => i !== idx))
  }

  function addText() {
    commit([...tokens, { type: 'text', value: '' }])
  }

  function insertField(picked: PickedField) {
    commit([...tokens, { type: 'field', value: picked.path.join('.') }])
    setPickerOpen(false)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null)
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = tokenIds.indexOf(String(active.id))
    const newIdx = tokenIds.indexOf(String(over.id))
    if (oldIdx === -1 || newIdx === -1) return
    commit(arrayMove(tokens, oldIdx, newIdx))
  }

  return (
    <div className='flex flex-wrap items-center gap-1 min-h-8 rounded-md border border-slate-200 bg-white px-2 py-1.5 dark:border-border dark:bg-background'>
      {tokens.length === 0 && (
        <span className='text-[12px] text-slate-400'>{placeholder}</span>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={({ active }) => setActiveId(String(active.id))}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <SortableContext items={tokenIds} strategy={rectSortingStrategy}>
          {tokens.map((tok, idx) => (
            <SortableTemplateToken
              key={tokenIds[idx]}
              id={tokenIds[idx]}
              tok={tok}
              idx={idx}
              onUpdate={updateToken}
              onRemove={removeToken}
            />
          ))}
        </SortableContext>
        <DragOverlay dropAnimation={null} modifiers={[snapCenterToCursor]}>
          {activeToken?.type === 'field' ? (
            <span className='inline-flex cursor-grabbing items-center gap-1 rounded-full bg-nvr-cyan/10 px-1.5 py-0.5 text-[12px] font-medium text-nvr-navy shadow-md dark:bg-nvr-cyan/15 dark:text-nvr-cyan'>
              <GripVertical className='h-3 w-3 shrink-0' />
              {activeToken.value.split('.').map(titleCase).join(' → ')}
            </span>
          ) : activeToken?.type === 'text' ? (
            <span className='inline-flex cursor-grabbing items-center gap-0.5 rounded border border-slate-300 bg-white px-1.5 py-0.5 shadow-md dark:border-border dark:bg-muted'>
              <GripVertical className='h-3 w-3 shrink-0 text-slate-300' />
              <span className='text-[12px] text-slate-700 dark:text-foreground'>{activeToken.value || 'text…'}</span>
            </span>
          ) : null}
        </DragOverlay>
      </DndContext>
      {!disabled && (
        <>
          <button
            type='button'
            onClick={addText}
            className='inline-flex items-center gap-0.5 rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-400 hover:border-nvr-cyan hover:text-nvr-cyan'
          >
            <Plus className='h-3 w-3' /> text
          </button>
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button
                type='button'
                className='inline-flex items-center gap-0.5 rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-400 hover:border-nvr-cyan hover:text-nvr-cyan'
              >
                <Plus className='h-3 w-3' /> field
              </button>
            </PopoverTrigger>
            <PopoverContent align='start' className='w-auto p-0' sideOffset={6}>
              <CollectionFieldPickerPanel
                collection={collection}
                onSelect={(picked) => insertField(picked)}
              />
            </PopoverContent>
          </Popover>
        </>
      )}
    </div>
  )
}
