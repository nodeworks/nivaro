import { Circle, Loader2, Play, Square, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { cn, titleCase } from '../../../lib/utils'
import { apiFailure } from '../overview/overview-api'
import { effectText, inputBase, labelText, tintCard } from '../panel-style'
import { BulkRun, btnQuiet, btnSolid } from './BulkRun'
import { type LayoutMacro, useBulkCalls, useMacros } from './bulk-api'
import { useFieldLabels } from './field-labels'
import { describeStep } from './macro-record'
import type { MacroRecorder } from './useMacroRecorder'

/**
 * Macros (#2663): Record / Stop in the editor, name and keep the steps, and
 * replay a kept macro on the collection's forms — fields matched by name,
 * sections by label — previewed form by form like any bulk change.
 */
export function MacrosPanel({
  collection,
  layoutId,
  dirty,
  recorder,
  onRecordStart
}: {
  collection: string
  layoutId: number | null
  dirty?: boolean
  recorder?: MacroRecorder
  /** Recording started: the panel steps aside so the form can be edited. */
  onRecordStart?: () => void
}) {
  const { labels } = useFieldLabels(collection)
  const labelOf = (f: string) => labels[f] ?? titleCase(f)
  const { data: macros = [], isLoading } = useMacros()
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div data-bulk-tab='macros' className='space-y-3'>
      {recorder ? (
        <Recorder
          collection={collection}
          layoutId={layoutId}
          recorder={recorder}
          labelOf={labelOf}
          onRecordStart={onRecordStart}
        />
      ) : (
        <p className={effectText}>
          Record a macro in the layout editor: open a form, then Every form → Macros → Record.
        </p>
      )}
      <div className='space-y-1.5'>
        <span className={labelText}>Your macros</span>
        {isLoading ? (
          <Loader2 className='h-4 w-4 animate-spin text-slate-400' />
        ) : macros.length === 0 ? (
          <p className={effectText}>None kept yet.</p>
        ) : (
          <ul className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border dark:border-border'>
            {macros.map((m) => (
              <MacroRow
                key={m.id}
                macro={m}
                collection={collection}
                labels={labels}
                labelOf={labelOf}
                open={open === m.id}
                onOpen={(on) => setOpen(on ? m.id : null)}
                dirtyLayoutId={dirty ? layoutId : null}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Recorder({
  collection,
  layoutId,
  recorder,
  labelOf,
  onRecordStart
}: {
  collection: string
  layoutId: number | null
  recorder: MacroRecorder
  labelOf: (f: string) => string
  onRecordStart?: () => void
}) {
  const calls = useBulkCalls()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const steps = recorder.steps

  const save = async () => {
    if (!name.trim() || steps.length === 0) return
    setSaving(true)
    try {
      await calls.saveMacro({
        name: name.trim(),
        collection,
        steps,
        source_layout_id: recorder.sourceLayoutId
      })
      toast.success(`Macro "${name.trim()}" kept`)
      setName('')
      recorder.clear()
    } catch (err) {
      toast.error(apiFailure(err, 'The macro could not be kept').message)
    } finally {
      setSaving(false)
    }
  }

  const list =
    steps.length > 0 ? (
      <ol className='list-decimal space-y-0.5 pl-5 text-[12px] text-slate-700 dark:text-foreground'>
        {steps.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps are an ordered list without ids
          <li key={i}>{describeStep(s, labelOf)}</li>
        ))}
      </ol>
    ) : null

  if (recorder.recording)
    return (
      <div data-macro-recording='' className={cn(tintCard, 'space-y-2 p-2.5')}>
        <p className='flex items-center gap-1.5 text-[12.5px] font-medium text-rose-700 dark:text-rose-300'>
          <span className='h-2 w-2 animate-pulse rounded-full bg-rose-500' />
          Recording · {steps.length} step{steps.length === 1 ? '' : 's'}
        </p>
        <p className={effectText}>
          Keep editing the form; every change is written down. Undo takes the last one back off.
        </p>
        {list}
        <button type='button' className={btnQuiet} onClick={recorder.stop} data-macro-stop=''>
          <Square className='h-3 w-3' />
          Stop
        </button>
      </div>
    )

  if (steps.length > 0)
    return (
      <div data-macro-save='' className={cn(tintCard, 'space-y-2 p-2.5')}>
        <p className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
          {steps.length} step{steps.length === 1 ? '' : 's'} recorded
        </p>
        {list}
        <input
          className={inputBase}
          placeholder='Name, e.g. "Fusion block after PO Number"'
          aria-label='Macro name'
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
        <div className='flex gap-2'>
          <button
            type='button'
            className={btnSolid}
            disabled={!name.trim() || saving}
            onClick={() => void save()}
            data-macro-keep=''
          >
            {saving && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
            Keep macro
          </button>
          <button type='button' className={btnQuiet} onClick={recorder.clear}>
            Discard
          </button>
        </div>
      </div>
    )

  return (
    <div className={cn(tintCard, 'space-y-2 p-2.5')}>
      <p className={effectText}>
        Record the changes you make to this form, then replay them on the other forms. Fields are
        matched by name and sections by label.
      </p>
      <button
        type='button'
        className={btnQuiet}
        disabled={layoutId == null}
        data-macro-record=''
        onClick={() => {
          if (layoutId == null) return
          recorder.start(layoutId)
          onRecordStart?.()
          toast('Recording: make your changes, then Every form → Stop')
        }}
      >
        <Circle className='h-3 w-3 fill-rose-500 text-rose-500' />
        Record
      </button>
    </div>
  )
}

function MacroRow({
  macro,
  collection,
  labels,
  labelOf,
  open,
  onOpen,
  dirtyLayoutId
}: {
  macro: LayoutMacro
  collection: string
  labels: Record<string, string>
  labelOf: (f: string) => string
  open: boolean
  onOpen: (on: boolean) => void
  dirtyLayoutId: number | null
}) {
  const calls = useBulkCalls()
  const [confirm, setConfirm] = useState(false)
  const other = macro.collection && macro.collection !== collection
  return (
    <li data-macro={macro.id} className='px-2.5 py-2'>
      <div className='flex items-center gap-2'>
        <div className='min-w-0 flex-1'>
          <span className='block truncate text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
            {macro.name}
          </span>
          <span className={effectText}>
            {macro.steps.length} step{macro.steps.length === 1 ? '' : 's'}
            {other ? ` · recorded on ${macro.collection}` : ''}
          </span>
        </div>
        <button
          type='button'
          className={btnQuiet}
          aria-expanded={open}
          onClick={() => onOpen(!open)}
          data-macro-replay=''
        >
          <Play className='h-3 w-3' />
          {open ? 'Close' : 'Replay'}
        </button>
        <button
          type='button'
          aria-label={confirm ? `Delete ${macro.name} for good` : `Delete ${macro.name}`}
          data-tip={confirm ? 'Click again to delete' : 'Delete'}
          className={cn(
            'inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] transition-colors',
            confirm
              ? 'bg-rose-50 font-medium text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
              : 'text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
          )}
          onBlur={() => setConfirm(false)}
          onClick={async () => {
            if (!confirm) return setConfirm(true)
            try {
              await calls.deleteMacro(macro.id)
            } catch (err) {
              toast.error(apiFailure(err, 'The macro could not be deleted').message)
            }
          }}
        >
          <Trash2 className='h-3.5 w-3.5' />
          {confirm && 'Delete'}
        </button>
      </div>
      {open && (
        <div className='mt-2 space-y-2'>
          <ol className='list-decimal space-y-0.5 pl-5 text-[12px] text-slate-600 dark:text-muted-foreground'>
            {macro.steps.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are an ordered list without ids
              <li key={i}>{describeStep(s, labelOf)}</li>
            ))}
          </ol>
          <BulkRun
            collection={collection}
            action={{ kind: 'macro', name: macro.name, steps: macro.steps }}
            labels={labels}
            dirtyLayoutId={dirtyLayoutId}
            applyLabel={(n) => `Replay on ${n} form${n === 1 ? '' : 's'}`}
          />
        </div>
      )}
    </li>
  )
}
