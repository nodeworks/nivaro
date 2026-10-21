import { BookmarkPlus, Download, FilePlus2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import type { LayoutBundle } from '../../../lib/layout-ops'
import { Popover, PopoverContent } from '../../ui/popover'
import { downloadLayout } from '../ops/ops-api'
import { apiFailure } from '../overview/overview-api'
import { ToolButton } from '../toolbar-kit'
import { saveTemplate, useRefreshTemplates } from './reuse-api'
import { reuseInput, reuseLabel, reusePrimary } from './SectionReuseActions'
import { useFormFromRecord } from './useFormFromRecord'

// Rows of the editor's ⋯ menu: Save as template (#2594), with a preview record
// New form from this record (#2585), and Download this form (a file another
// environment can take in under Compare with another environment).

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
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const fallback = String(bundle?.layout.name ?? 'Form')

  const close = () => {
    setOpen(false)
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

  const id = bundle ? Number(bundle.layout.id) : null
  return (
    <>
      <Popover open={open} onOpenChange={(v) => (v ? setOpen(true) : close())}>
        <ToolButton
          popover
          onOpen={() => setOpen(true)}
          label='Save as template…'
          icon={<BookmarkPlus className='h-3.5 w-3.5' />}
          hint='Start new forms on any collection from this one'
          disabled={!bundle}
          data={{ 'data-more-save-template': '' }}
        />
        <PopoverContent align='end' className='w-[300px] p-3'>
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
        </PopoverContent>
      </Popover>
      {previewRecord && (
        <ToolButton
          label={fromRecord.busy ? 'Making…' : 'New form from this record'}
          icon={<FilePlus2 className='h-3.5 w-3.5' />}
          hint={`The fields ${previewRecord.label} has filled in, in one section`}
          disabled={fromRecord.busy || !fromRecord.ready}
          data={{ 'data-more-from-record': '' }}
          onClick={async () => {
            const made = await fromRecord.make(previewRecord.id, previewRecord.label)
            if (made != null) onOpenLayout(made)
          }}
        />
      )}
      <ToolButton
        label='Download this form'
        icon={<Download className='h-3.5 w-3.5' />}
        hint='A file another environment can bring in'
        disabled={id == null}
        data={{ 'data-more-download': '' }}
        onClick={() => {
          if (id == null) return
          void downloadLayout(client, id, fallback).catch((err) =>
            toast.error(apiFailure(err, 'Could not download').message)
          )
        }}
      />
    </>
  )
}
