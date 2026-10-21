import { Bookmark } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  ENTRY_PRESETS_MAX,
  entryConfigOf,
  PRESET_PARTS,
  type PresetPart,
  sanitizeEntryConfig
} from '../../../lib/entry-config'
import type { LayoutBundle, LayoutOp, PlacementRow } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { effectText } from '../panel-style'
import { barBtn } from '../toolbar-kit'
import type { ApplyOptions } from '../useLayoutDraft'
import { capturePreset, PART_LABEL, partsSet, presetOps, presetSummary } from './presets'

/**
 * Placement presets (#2702): save the selected field's width, required flag, help
 * text, placeholder, input + format or lock rule under a name, and apply a preset to
 * the selected fields in one click. Applying is one op batch, so one undo step.
 * The popover opens beside its button (helper surface, not a modal).
 */
export function PlacementPresets({
  bundle,
  rows,
  apply,
  className
}: {
  bundle: LayoutBundle
  /** The selected fields' placements; one field also offers "Save as preset". */
  rows: PlacementRow[]
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const config = entryConfigOf(bundle.layout)
  const presets = config.presets ?? []
  const source = rows.length === 1 ? rows[0] : null
  const [name, setName] = useState('')
  const [parts, setParts] = useState<PresetPart[]>([])
  const offered = source ? partsSet(source) : []

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setName('')
      setParts(source ? partsSet(source) : [])
    }
  }
  const save = () => {
    if (!source || !name.trim() || parts.length === 0) return
    const preset = capturePreset(name, source, parts)
    const next = sanitizeEntryConfig({ ...config, presets: [...presets, preset] })
    apply([{ op: 'layout_update', patch: { entry_config: next } }], {
      label: `Save preset “${preset.name}”`
    })
    setOpen(false)
    toast.success(`Saved the preset “${preset.name}”`)
  }
  const use = (id: string) => {
    const preset = presets.find((p) => p.id === id)
    if (!preset) return
    const { ops, changed } = presetOps(preset, rows)
    if (!changed) {
      toast.info(`Already set like “${preset.name}”`)
      setOpen(false)
      return
    }
    apply(ops, {
      label: `Apply preset “${preset.name}” to ${changed} ${changed === 1 ? 'field' : 'fields'}`
    })
    setOpen(false)
  }
  const full = presets.length >= ENTRY_PRESETS_MAX

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-placement-presets=''
          data-tip='Save these settings under a name, or apply a saved bundle'
          className={cn(barBtn, className)}
        >
          <Bookmark className='h-3.5 w-3.5 shrink-0' />
          Presets
          {presets.length > 0 && (
            <span className='tabular-nums text-slate-500 dark:text-muted-foreground'>
              {presets.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='left'
        align='start'
        className='w-[300px] space-y-3 p-3 text-[12px]'
        data-presets-popover=''
      >
        <div className='space-y-1'>
          <p className='m-0 text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
            Apply to {rows.length === 1 ? 'this field' : `${rows.length} fields`}
          </p>
          {presets.length === 0 ? (
            <p className={effectText}>
              No presets yet.{' '}
              {source
                ? 'Save this field’s settings below.'
                : 'Select one field to save its settings as a preset.'}
            </p>
          ) : (
            <ul className='m-0 max-h-48 list-none space-y-0.5 overflow-y-auto p-0'>
              {presets.map((p) => (
                <li key={p.id}>
                  <button
                    type='button'
                    data-preset-apply={p.id}
                    onClick={() => use(p.id)}
                    className='flex w-full flex-col rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted'
                  >
                    <span className='truncate text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                      {p.name}
                    </span>
                    <span className={cn(effectText, 'truncate')}>{presetSummary(p)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {source && (
          <div className='space-y-2 border-t border-slate-200 pt-3 dark:border-border'>
            <p className='m-0 text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
              Save this field’s settings
            </p>
            {offered.length === 0 ? (
              <p className={effectText}>
                Nothing is set on this field yet: change its width, make it required or add help
                text first.
              </p>
            ) : (
              <>
                <fieldset className='m-0 grid grid-cols-2 gap-x-3 gap-y-1 border-0 p-0'>
                  <legend className='sr-only'>What the preset sets</legend>
                  {PRESET_PARTS.filter((p) => offered.includes(p)).map((p) => (
                    <label
                      key={p}
                      className='flex items-center gap-1.5 text-slate-700 dark:text-foreground'
                    >
                      <input
                        type='checkbox'
                        checked={parts.includes(p)}
                        onChange={(e) =>
                          setParts((cur) =>
                            e.target.checked ? [...cur, p] : cur.filter((x) => x !== p)
                          )
                        }
                      />
                      {PART_LABEL[p]}
                    </label>
                  ))}
                </fieldset>
                <input
                  type='text'
                  aria-label='Preset name'
                  placeholder='Name, e.g. Narrow and required'
                  maxLength={60}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      save()
                    }
                  }}
                  className='h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:bg-background'
                />
                <button
                  type='button'
                  data-preset-save=''
                  disabled={!name.trim() || parts.length === 0 || full}
                  onClick={save}
                  className='h-7 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-[#00b8e0] disabled:opacity-40'
                >
                  Save preset
                </button>
                {full && (
                  <p className={effectText}>
                    This form holds {ENTRY_PRESETS_MAX} presets: delete one in Form settings first.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
