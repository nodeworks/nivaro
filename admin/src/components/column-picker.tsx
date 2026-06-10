import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useQueryClient } from '@tanstack/react-query'
import { Check, GripVertical, Plus, Save, Star, Trash2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { api, type CMSField, type CollectionPreset, type CollectionPresetsData } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, titleCase } from '@/lib/utils'

interface ColumnPickerProps {
  collection: string
  allFields: CMSField[]
  columns: string[]
  presetsData: CollectionPresetsData | undefined
  onChange: (cols: string[]) => void
  onPresetActivated: (cols: string[]) => void
}

export function ColumnPicker({
  collection,
  allFields,
  columns,
  presetsData,
  onChange,
  onPresetActivated
}: ColumnPickerProps) {
  const { user } = useAuth()
  const isAdmin = user?.is_admin ?? false
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const allFieldKeys = allFields.map((f) => f.field)
  const hiddenCols = allFieldKeys.filter((k) => !columns.includes(k))

  function handleDragEnd(event: DragEndEvent) {
    setIsDragging(false)
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = columns.indexOf(String(active.id))
    const newIdx = columns.indexOf(String(over.id))
    if (oldIdx === -1 || newIdx === -1) return
    onChange(arrayMove(columns, oldIdx, newIdx))
  }

  function removeColumn(key: string) {
    onChange(columns.filter((c) => c !== key))
  }

  function addColumn(key: string) {
    onChange([...columns, key])
  }

  async function handleSavePreset() {
    if (!presetName.trim()) return
    setIsSaving(true)
    try {
      await api.post('/presets', { collection, name: presetName.trim(), columns })
      await queryClient.invalidateQueries({ queryKey: ['presets', collection] })
      toast.success(`Preset "${presetName.trim()}" saved`)
      setPresetName('')
      setSaveDialogOpen(false)
    } catch {
      toast.error('Failed to save preset')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSetSystemDefault() {
    try {
      await api.put('/presets/system-default', { collection, columns })
      await queryClient.invalidateQueries({ queryKey: ['presets', collection] })
      toast.success('Collection default updated')
    } catch {
      toast.error('Failed to set collection default')
    }
  }

  async function handleActivatePreset(preset: CollectionPreset) {
    try {
      await api.post(`/presets/${preset.id}/activate`)
      await queryClient.invalidateQueries({ queryKey: ['presets', collection] })
      onPresetActivated(preset.columns.filter((k) => allFieldKeys.includes(k)))
      toast.success(`Switched to "${preset.name}"`)
    } catch {
      toast.error('Failed to activate preset')
    }
  }

  async function handleClearPreset() {
    try {
      await api.delete(`/presets/active?collection=${encodeURIComponent(collection)}`)
      await queryClient.invalidateQueries({ queryKey: ['presets', collection] })
      const fallback =
        presetsData?.systemDefault?.columns.filter((k) => allFieldKeys.includes(k)) ??
        allFieldKeys.slice(0, 7)
      onPresetActivated(fallback)
      toast.success('Preset cleared')
    } catch {
      toast.error('Failed to clear preset')
    }
  }

  async function handleDeletePreset(preset: CollectionPreset) {
    try {
      await api.delete(`/presets/${preset.id}`)
      await queryClient.invalidateQueries({ queryKey: ['presets', collection] })
      if (preset.id === presetsData?.activePresetId) {
        const fallback =
          presetsData?.systemDefault?.columns.filter((k) => allFieldKeys.includes(k)) ??
          allFieldKeys.slice(0, 7)
        onPresetActivated(fallback)
      }
    } catch {
      toast.error('Failed to delete preset')
    }
  }

  const activePreset = presetsData?.presets.find((p) => p.id === presetsData?.activePresetId)

  const labelFor = (key: string) => {
    const field = allFields.find((f) => f.field === key)
    return field?.field === 'id' ? 'ID' : titleCase(field?.field ?? key)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (isDragging) return
        setOpen(next)
        if (!next) setSaveDialogOpen(false)
      }}
    >
      <PopoverTrigger asChild>
        <Button variant='outline' size='sm' className='h-8 gap-1.5 text-[12px]'>
          Columns
          {activePreset && (
            <span className='ml-0.5 rounded bg-nvr-cyan/10 px-1 py-0.5 text-[10px] font-medium text-nvr-cyan'>
              {activePreset.name}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align='end'
        className='w-[260px] p-0'
        onInteractOutside={(e) => {
          if (isDragging) e.preventDefault()
        }}
      >
        {/* Active columns — draggable */}
        <div className='px-3 pt-3 pb-2'>
          <p className='mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
            Visible columns
          </p>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={() => setIsDragging(true)}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={columns} strategy={verticalListSortingStrategy}>
              {columns.length === 0 ? (
                <p className='py-1 text-[12px] text-slate-400'>No columns selected</p>
              ) : (
                columns.map((key) => (
                  <SortableColumnRow
                    key={key}
                    id={key}
                    label={labelFor(key)}
                    onRemove={() => removeColumn(key)}
                    disabled={columns.length === 1}
                  />
                ))
              )}
            </SortableContext>
          </DndContext>
        </div>

        {hiddenCols.length > 0 && (
          <>
            <Separator />
            <div className='px-3 py-2'>
              <p className='mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
                Add column
              </p>
              <div className='max-h-[120px] overflow-y-auto space-y-0.5'>
                {hiddenCols.map((key) => (
                  <button
                    key={key}
                    type='button'
                    onClick={() => addColumn(key)}
                    className='flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                  >
                    <Plus className='h-3 w-3 shrink-0 text-slate-400' />
                    {labelFor(key)}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        <Separator />

        {/* Presets */}
        <div className='px-3 py-2'>
          <p className='mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
            Presets
          </p>

          {presetsData?.presets && presetsData.presets.length > 0 && (
            <div className='mb-2 space-y-0.5'>
              {presetsData.presets.map((preset) => {
                const isActive = preset.id === presetsData.activePresetId
                return (
                  <div
                    key={preset.id}
                    className={cn(
                      'flex items-center gap-1 rounded px-1.5 py-1',
                      isActive && 'bg-nvr-cyan/5'
                    )}
                  >
                    <button
                      type='button'
                      onClick={() =>
                        isActive ? handleClearPreset() : handleActivatePreset(preset)
                      }
                      className='flex min-w-0 flex-1 items-center gap-1.5 text-left'
                    >
                      <Check
                        className={cn(
                          'h-3 w-3 shrink-0',
                          isActive ? 'text-nvr-cyan' : 'text-transparent'
                        )}
                      />
                      <span
                        className={cn(
                          'truncate text-[12px]',
                          isActive
                            ? 'font-medium text-nvr-cyan'
                            : 'text-slate-700 dark:text-slate-200'
                        )}
                      >
                        {preset.name}
                      </span>
                    </button>
                    <button
                      type='button'
                      title='Delete preset'
                      onClick={() => handleDeletePreset(preset)}
                      className='shrink-0 rounded p-0.5 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20'
                    >
                      <Trash2 className='h-3 w-3' />
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {!saveDialogOpen ? (
            <div className='flex flex-wrap gap-1'>
              <button
                type='button'
                onClick={() => {
                  setSaveDialogOpen(true)
                  setTimeout(() => nameInputRef.current?.focus(), 50)
                }}
                className='flex items-center gap-1 rounded px-2 py-1 text-[12px] text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200'
              >
                <Save className='h-3 w-3' />
                Save as preset…
              </button>
              {isAdmin && (
                <button
                  type='button'
                  onClick={handleSetSystemDefault}
                  className='flex items-center gap-1 rounded px-2 py-1 text-[12px] text-slate-500 transition-colors hover:bg-nvr-cyan/10 hover:text-nvr-cyan'
                  title='Set as the default view for all users'
                >
                  <Star className='h-3 w-3' />
                  Set default
                </button>
              )}
            </div>
          ) : (
            <div className='flex gap-1'>
              <Input
                ref={nameInputRef}
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSavePreset()
                  if (e.key === 'Escape') setSaveDialogOpen(false)
                }}
                placeholder='Preset name…'
                className='h-7 text-[12px]'
              />
              <Button
                size='sm'
                className='h-7 px-2'
                onClick={handleSavePreset}
                disabled={isSaving || !presetName.trim()}
              >
                Save
              </Button>
              <Button
                variant='ghost'
                size='icon'
                className='h-7 w-7'
                onClick={() => setSaveDialogOpen(false)}
              >
                <X className='h-3 w-3' />
              </Button>
            </div>
          )}

          {presetsData?.systemDefault && (
            <p className='mt-2 text-[11px] text-slate-400'>
              Collection default:{' '}
              <span className='font-medium text-slate-500'>
                {presetsData.systemDefault.columns.slice(0, 3).map(labelFor).join(', ')}
                {presetsData.systemDefault.columns.length > 3 &&
                  ` +${presetsData.systemDefault.columns.length - 3}`}
              </span>
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function SortableColumnRow({
  id,
  label,
  onRemove,
  disabled
}: {
  id: string
  label: string
  onRemove: () => void
  disabled: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-1.5 rounded px-1 py-0.5',
        isDragging && 'z-50 bg-white shadow-md dark:bg-slate-900'
      )}
    >
      <button
        type='button'
        {...attributes}
        {...listeners}
        className='cursor-grab touch-none text-slate-300 hover:text-slate-500 active:cursor-grabbing'
      >
        <GripVertical className='h-3.5 w-3.5' />
      </button>
      <span className='flex-1 truncate text-[12px] text-slate-700 dark:text-slate-200'>
        {label}
      </span>
      <button
        type='button'
        onClick={onRemove}
        disabled={disabled}
        className='rounded p-0.5 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-500 disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-red-900/20'
      >
        <X className='h-3 w-3' />
      </button>
    </div>
  )
}
