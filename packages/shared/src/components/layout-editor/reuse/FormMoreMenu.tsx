import { BookmarkPlus, ChevronLeft, FilePlus2, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import type { LayoutBundle } from '../../../lib/layout-ops'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { apiFailure } from '../overview/overview-api'
import { saveTemplate, useRefreshTemplates } from './reuse-api'
import { reuseInput, reuseLabel, reusePrimary } from './SectionReuseActions'
import { useFormFromRecord } from './useFormFromRecord'

// The editor's ⋯ menu: Save as template (#2594) and, with a preview record,
// New form from this record (#2585).

const item =
  'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted disabled:opacity-50'

export function FormMoreMenu({
  collection,
  bundle,
  previewRecord,
  onOpenLayout
}: {
  collection: string
  bundle: LayoutBundle | null
  previewRecord: { id: string; label: string } | null
  onOpenLayout: (layoutId: number) => void
}) {
  const client = useNivaroClient()
  const refresh = useRefreshTemplates()
  const fromRecord = useFormFromRecord(collection)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'menu' | 'template'>('menu')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const fallback = String(bundle?.layout.name ?? 'Form')

  const close = () => {
    setOpen(false)
    setView('menu')
    setName('')
    setDescription('')
  }

  const save = async () => {
    if (!bundle || busy) return
    const n = (name || fallback).trim()
    setBusy(true)
    try {
      await saveTemplate(client, {
        kind: 'form',
        name: n,
        description: description || null,
        layout_id: Number(bundle.layout.id),
        bundle
      })
      refresh('form')
      toast.success(`Saved ${n} as a template. Use it from New form → Template.`)
      close()
    } catch (err) {
      toast.error(apiFailure(err, 'Could not save the template').message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={(v) => (v ? setOpen(true) : close())}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='More'
          data-editor-more=''
          data-tip='More'
          className='inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
        >
          <MoreHorizontal className='h-4 w-4' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[300px] p-1.5'>
        {view === 'menu' ? (
          <div role='menu' aria-label='More'>
            <button
              type='button'
              role='menuitem'
              disabled={!bundle}
              data-more-save-template=''
              onClick={() => setView('template')}
              className={item}
            >
              <BookmarkPlus className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500' />
              <span className='flex flex-col'>
                <span className='text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
                  Save as template…
                </span>
                <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                  Start new forms on any collection from this one
                </span>
              </span>
            </button>
            {previewRecord && (
              <button
                type='button'
                role='menuitem'
                disabled={fromRecord.busy || !fromRecord.ready}
                data-more-from-record=''
                onClick={async () => {
                  const id = await fromRecord.make(previewRecord.id, previewRecord.label)
                  if (id != null) {
                    close()
                    onOpenLayout(id)
                  }
                }}
                className={item}
              >
                <FilePlus2 className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500' />
                <span className='flex flex-col'>
                  <span className='text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
                    {fromRecord.busy ? 'Making…' : 'New form from this record'}
                  </span>
                  <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    The fields {previewRecord.label} has filled in, in one section
                  </span>
                </span>
              </button>
            )}
          </div>
        ) : (
          <div className='p-1.5'>
            <button
              type='button'
              onClick={() => setView('menu')}
              className='mb-1 inline-flex items-center gap-0.5 text-[12px] text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
            >
              <ChevronLeft className='h-3.5 w-3.5' />
              Back
            </button>
            <p className='mb-2 text-[12px] leading-snug text-slate-600 dark:text-muted-foreground'>
              Sections, fields and how the form behaves are saved by field name. Rules for who gets
              it, defaults and links stay with this form.
            </p>
            <label className='block'>
              <span className={reuseLabel}>Template name</span>
              <input
                value={name}
                placeholder={fallback}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save()
                }}
                className={reuseInput}
              />
            </label>
            <label className='mt-2 block'>
              <span className={reuseLabel}>Description (optional)</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder='What it is for'
                className={reuseInput}
              />
            </label>
            <div className='mt-3 flex justify-end'>
              <button
                type='button'
                className={reusePrimary}
                disabled={busy}
                onClick={() => void save()}
              >
                {busy ? 'Saving…' : 'Save template'}
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
