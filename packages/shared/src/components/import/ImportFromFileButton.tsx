import {
  type ImportParseResponse,
  type ImportTemplateSummary,
  listImportTemplates
} from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Upload } from 'lucide-react'
import { type ChangeEvent, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  onParsed
}: {
  collection: string
  templateFilter?: (t: ImportTemplateSummary) => boolean
  onParsed: (result: ImportParseResponse, template: ImportTemplateSummary) => void
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
      setError(err as ParseError)
    } finally {
      setImportingFile(null)
    }
  }

  // Single template: its custom label. Multiple: a label shared by ALL of them still
  // applies; mixed labels fall back to the generic text since the button fans out.
  const firstLabel = templates[0]?.button_label?.trim()
  const customLabel =
    firstLabel && templates.every((t) => t.button_label === templates[0].button_label)
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
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={importing}
          onClick={() => openPicker(templates[0])}
        >
          {buttonLabel}
        </Button>
      ) : (
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <Button type='button' variant='outline' size='sm' disabled={importing}>
              {buttonLabel}
            </Button>
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
      {error && <div className='text-[12px] text-red-600 dark:text-red-400'>{error.message}</div>}
      {error?.issues && <ImportIssuesPanel issues={error.issues} />}
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
