import { Check, Download, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { useDownload } from './RunDetailSheet'
import { definitionTitle, type ImportDefinition } from './types'

/**
 * Import Console → Download sample: pick an import and get a CSV with the headers it reads and
 * a few rows showing how to fill them in (GET /staged-imports/definitions/:id/sample).
 */
export function DownloadSampleButton({ definitions }: { definitions: ImportDefinition[] }) {
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState<number | null>(null)
  const { download, busy, error } = useDownload()
  useEffect(() => {
    if (error) toast.error(`Could not download the sample: ${error}`)
  }, [error])
  const sorted = [...definitions].sort((a, b) =>
    definitionTitle(a).localeCompare(definitionTitle(b))
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size='sm'
          variant='outline'
          className='h-7'
          data-import-sample-open
          disabled={definitions.length === 0}
          data-tip='A CSV with the columns an import reads and example rows'
        >
          <Download className='h-3.5 w-3.5' />
          <span className='max-sm:sr-only'>Download sample</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[300px] p-0'>
        <Command>
          <CommandInput placeholder='Which import?' className='h-9 text-[12.5px]' />
          <CommandList className='max-h-[320px]'>
            <CommandEmpty className='py-4 text-center text-[12px] text-slate-500 dark:text-slate-400'>
              No import matches.
            </CommandEmpty>
            <CommandGroup>
              {sorted.map((d) => {
                const path = `/staged-imports/definitions/${d.id}/sample`
                const loading = busy === path
                return (
                  <CommandItem
                    key={d.id}
                    value={`${definitionTitle(d)} ${d.key}`}
                    data-import-sample={d.key}
                    disabled={!!busy}
                    onSelect={() => {
                      void download(path, `${d.key}_sample.csv`).then(() => {
                        setDone(d.id)
                        window.setTimeout(() => setDone((x) => (x === d.id ? null : x)), 2000)
                      })
                    }}
                    className='flex items-center gap-2 text-[12.5px]'
                  >
                    <span className='min-w-0 flex-1 truncate'>{definitionTitle(d)}</span>
                    {loading ? (
                      <Loader2 className='h-3.5 w-3.5 shrink-0 text-slate-400 motion-safe:animate-spin' />
                    ) : done === d.id ? (
                      <Check className='h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400' />
                    ) : (
                      <Download className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        <p className='border-t border-slate-100 px-3 py-2 text-[11px] leading-snug text-slate-500 dark:border-border dark:text-slate-400'>
          Headers the import reads, with example rows. Open it, replace the rows with yours, and
          upload it with New import.
        </p>
      </PopoverContent>
    </Popover>
  )
}
