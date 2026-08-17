import {
  type ImportParseResponse,
  type ImportTemplateSummary,
  listImportTemplates
} from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Upload } from 'lucide-react'
import { type ChangeEvent, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { Button } from '../ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { ImportIssuesPanel } from './ImportIssuesPanel'

type ParseError = Error & { status?: number; issues?: ImportParseResponse['issues'] }

function acceptFor(templates: ImportTemplateSummary[]): string {
  const types = new Set(templates.flatMap((t) => t.file_types))
  return Array.from(types)
    .map((t) => `.${t}`)
    .join(',')
}

export function ImportFromFileButton({
  collection,
  templateFilter,
  getLabel,
  onParsed,
  compact = false
}: {
  collection: string
  templateFilter?: (t: ImportTemplateSummary) => boolean
  /** Per-template label source; defaults to the template's button_label. */
  getLabel?: (t: ImportTemplateSummary) => string | null | undefined
  onParsed: (result: ImportParseResponse, template: ImportTemplateSummary) => void
  /** Grid-toolbar sizing (h-6, 11px) matching other inline-table buttons. */
  compact?: boolean
}) {
  const client = useNivaroClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingTemplateRef = useRef<ImportTemplateSummary | null>(null)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [importingFile, setImportingFile] = useState<string | null>(null)
  const importing = importingFile != null
  const [error, setError] = useState<ParseError | null>(null)

  const { data } = useQuery({
    queryKey: ['import-templates', collection],
    queryFn: () => client.request(listImportTemplates(collection))
  })

  const allTemplates = data?.data ?? []
  const templates = templateFilter ? allTemplates.filter(templateFilter) : allTemplates
  if (templates.length === 0) return null

  function openPicker(template: ImportTemplateSummary) {
    pendingTemplateRef.current = template
    setError(null)
    setPopoverOpen(false)
    fileInputRef.current?.click()
  }

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    const template = pendingTemplateRef.current
    e.target.value = ''
    if (!file || !template) return
    setImportingFile(file.name)
    setError(null)
    try {
      const result = await client.importParse(template.id, file)
      onParsed(result, template)
    } catch (err) {
      const parseErr = err as ParseError
      // Toast for the headline; the issues list (when the server returned one)
      // opens in a dialog. NEVER inline under the button — an error appearing
      // in the header row displaces the layout around it.
      if (parseErr.issues?.length) setError(parseErr)
      else toast.error(parseErr.message || 'Import parse failed', { duration: 8000 })
    } finally {
      setImportingFile(null)
    }
  }

  // Single template: its custom label. Multiple: a label shared by ALL of them still
  // applies; mixed labels fall back to the generic text since the button fans out.
  const labelOf = (t: ImportTemplateSummary) => (getLabel ? getLabel(t) : t.button_label)
  const firstLabel = templates[0] ? labelOf(templates[0])?.trim() : undefined
  const customLabel =
    firstLabel && templates.every((t) => labelOf(t) === labelOf(templates[0]))
      ? firstLabel
      : null
  const buttonLabel = importing ? (
    <>
      <Loader2 className='h-3.5 w-3.5 animate-spin' /> Importing…
    </>
  ) : (
    <>
      <Upload className='h-3.5 w-3.5' /> {customLabel ?? 'Import from file'}
    </>
  )

  return (
    <div className='flex flex-col gap-2'>
      <input
        ref={fileInputRef}
        type='file'
        className='hidden'
        accept={acceptFor(templates)}
        onChange={handleFileChange}
      />
      {templates.length === 1 ? (
        compact ? (
          <button
            type='button'
            disabled={importing}
            onClick={() => openPicker(templates[0])}
            className='inline-flex h-6 items-center gap-1 rounded border border-slate-200 px-2.5 text-[11px] text-slate-600 transition-colors hover:border-slate-400 hover:text-slate-800 disabled:opacity-50 dark:border-border dark:text-slate-300'
          >
            {buttonLabel}
          </button>
        ) : (
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={importing}
            onClick={() => openPicker(templates[0])}
          >
            {buttonLabel}
          </Button>
        )
      ) : (
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            {compact ? (
              <button
                type='button'
                disabled={importing}
                className='inline-flex h-6 items-center gap-1 rounded border border-slate-200 px-2.5 text-[11px] text-slate-600 transition-colors hover:border-slate-400 hover:text-slate-800 disabled:opacity-50 dark:border-border dark:text-slate-300'
              >
                {buttonLabel}
              </button>
            ) : (
              <Button type='button' variant='outline' size='sm' disabled={importing}>
                {buttonLabel}
              </Button>
            )}
          </PopoverTrigger>
          <PopoverContent className='w-[220px] p-0' align='start'>
            <Command>
              <CommandInput placeholder='Search templates…' className='h-8 text-[12px]' />
              <CommandList>
                <CommandEmpty>No template found.</CommandEmpty>
                {templates.map((template) => (
                  <CommandItem
                    key={template.id}
                    value={template.name}
                    onSelect={() => openPicker(template)}
                  >
                    {template.name}
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
      {error?.issues &&
        createPortal(
          <div
            className='fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4'
            onClick={() => setError(null)}
          >
            <div
              className='max-h-[70vh] w-full max-w-[520px] overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 shadow-xl dark:border-border dark:bg-card'
              onClick={(e) => e.stopPropagation()}
            >
              <p className='mb-2 text-[13px] font-semibold text-red-600 dark:text-red-400'>
                {error.message || 'Import parse failed'}
              </p>
              <ImportIssuesPanel issues={error.issues} />
              <div className='mt-3 flex justify-end'>
                <Button type='button' variant='outline' size='sm' onClick={() => setError(null)}>
                  Close
                </Button>
              </div>
            </div>
          </div>,
          document.body
        )}
      {importing &&
        createPortal(
          <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/40'>
            <div className='flex items-center gap-3 rounded-lg border bg-background px-5 py-4 shadow-lg'>
              <Loader2 className='h-5 w-5 animate-spin text-muted-foreground' />
              <div className='text-[13px]'>
                Processing <span className='font-medium'>{importingFile}</span>…
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
