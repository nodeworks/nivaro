import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bookmark } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { type CatalogFault, errText } from '../api'
import { builderKeys, type ChaosPreset, createPreset, updatePreset } from './api'
import { type DraftSpec, formatSeconds, runBody, slugKey, targetWords } from './model'
import { inputCls, labelCls } from './steps'

/**
 * "Save as preset" (#2844 → #2855): an anchored popover beside the button, never a modal. Opened
 * from a preset it also offers "Update <preset>"; a shipped preset updated this way becomes a
 * saved override of the same key.
 */
export function SavePresetPopover({
  fault,
  draft,
  preset,
  disabled
}: {
  fault: CatalogFault
  draft: DraftSpec
  preset: ChaosPreset | null
  disabled?: boolean
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const defaultLabel = `${fault.label} on ${targetWords(draft.target)}, ${formatSeconds(draft.seconds)}`
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [proves, setProves] = useState('')
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setLabel(defaultLabel)
    setKey(slugKey(defaultLabel))
    setKeyTouched(false)
    setProves(fault.proves)
    setError(null)
  }

  const spec = () => {
    const { fault_key, target, params, seconds, hypothesis, note } = runBody(draft)
    return { fault_key, target, params, seconds, hypothesis, note }
  }

  const done = (p: ChaosPreset, verb: string) => {
    toast.success(`${verb} preset “${p.label}”`)
    void qc.invalidateQueries({ queryKey: builderKeys.presets })
    setOpen(false)
  }

  const create = useMutation({
    mutationFn: () =>
      createPreset({
        key,
        label: label.trim(),
        proves: proves.trim() || null,
        claim_keys: preset?.claim_keys?.length ? preset.claim_keys : fault.claim_keys,
        spec: spec()
      }),
    onSuccess: (p) => done(p, 'Saved'),
    onError: (e) => setError(errText(e, 'The preset was not saved'))
  })
  const update = useMutation({
    mutationFn: () => updatePreset(preset?.key as string, { spec: spec() }),
    onSuccess: (p) => done(p, 'Updated'),
    onError: (e) => setError(errText(e, 'The preset was not updated'))
  })
  const keyOk = /^[a-z][a-z0-9_.-]{1,79}$/.test(key)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) reset()
        setOpen(o)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={disabled}
          className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-[12.5px] font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:pointer-events-none disabled:opacity-40 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
        >
          <Bookmark className='h-3.5 w-3.5' aria-hidden />
          Save as preset
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[min(360px,calc(100vw-32px))] p-0'>
        <form
          className='space-y-3 p-3'
          onSubmit={(e) => {
            e.preventDefault()
            if (label.trim() && keyOk) create.mutate()
          }}
        >
          {preset && (
            <div className='flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2.5 py-2 dark:bg-muted/50'>
              <span className='min-w-0 truncate text-[12px] text-slate-600 dark:text-muted-foreground'>
                Started from{' '}
                <span className='font-medium text-slate-800 dark:text-foreground'>
                  {preset.label}
                </span>
              </span>
              <button
                type='button'
                disabled={update.isPending}
                onClick={() => update.mutate()}
                className='shrink-0 text-[12px] font-medium text-slate-800 underline-offset-2 hover:underline disabled:opacity-40 dark:text-foreground'
              >
                Update it
              </button>
            </div>
          )}
          <label className='block space-y-1'>
            <span className={labelCls}>Name</span>
            <input
              className={cn(inputCls, 'w-full')}
              value={label}
              maxLength={200}
              // biome-ignore lint/a11y/noAutofocus: the control appears on an explicit click
              autoFocus
              onChange={(e) => {
                setLabel(e.target.value)
                if (!keyTouched) setKey(slugKey(e.target.value))
              }}
            />
          </label>
          <label className='block space-y-1'>
            <span className={labelCls}>Key</span>
            <input
              className={cn(
                inputCls,
                'w-full font-mono text-[12px]',
                key && !keyOk && 'border-red-400 dark:border-red-500'
              )}
              value={key}
              maxLength={80}
              onChange={(e) => {
                setKeyTouched(true)
                setKey(e.target.value)
              }}
            />
            {key && !keyOk && (
              <span className='block text-[11.5px] text-red-700 dark:text-red-400'>
                Lower-case letters, digits, dots, dashes; starts with a letter.
              </span>
            )}
          </label>
          <label className='block space-y-1'>
            <span className={labelCls}>What it proves</span>
            <textarea
              className={cn(inputCls, 'h-auto min-h-[64px] w-full py-1.5 leading-snug')}
              value={proves}
              maxLength={2000}
              onChange={(e) => setProves(e.target.value)}
            />
          </label>
          {error && <p className='text-[12px] text-red-700 dark:text-red-400'>{error}</p>}
          <div className='flex justify-end gap-2'>
            <button
              type='button'
              onClick={() => setOpen(false)}
              className='inline-flex h-8 items-center rounded-md px-3 text-[12.5px] font-medium text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
            >
              Cancel
            </button>
            <button
              type='submit'
              disabled={!label.trim() || !keyOk || create.isPending}
              className='inline-flex h-8 items-center rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white hover:bg-[#00b8e0] disabled:pointer-events-none disabled:opacity-40'
            >
              Save new preset
            </button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
