import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { useEditorApi } from './editor-api'
import { editorQueryKeys } from './editor-queries'

export function PdfFieldConfig({
  tableName,
  value,
  filenameTemplate,
  onChange,
  onFilenameChange
}: {
  tableName: string
  value: string | null | undefined
  filenameTemplate: string | null | undefined
  onChange: (v: string | null) => void
  onFilenameChange: (v: string | null) => void
}) {
  const api = useEditorApi()
  const { data: relData } = useQuery({
    queryKey: editorQueryKeys.relationsFor(tableName),
    queryFn: () =>
      api
        .get<{
          data: Array<{
            id: number
            many_collection: string
            many_field: string
            one_collection: string | null
            one_field: string | null
            junction_field: string | null
          }>
        }>(`/data-model/relations/for/${tableName}`)
        .then((r) => r.data.data ?? []),
    enabled: !!tableName,
    staleTime: 30_000
  })

  // Find M2M fields on this collection that point to nivaro_files
  const fileFields = useMemo(() => {
    if (!relData) return []
    const junctions = relData.filter(
      (r) => r.one_collection === tableName && r.junction_field != null
    )
    const results: Array<{ field: string; junction: string }> = []
    const seen = new Set<string>()
    for (const jr of junctions) {
      if (seen.has(jr.many_collection)) continue
      // Primary: companion row explicitly points to nivaro_files
      const companion = relData.find(
        (r) => r.many_collection === jr.many_collection && r.one_collection === 'nivaro_files'
      )
      // Fallback: single-row M2M where junction_field or junction table name hints at files
      const jf = jr.junction_field ?? ''
      const looksLikeFiles = !!companion || /file/i.test(jf) || /file/i.test(jr.many_collection)
      if (!looksLikeFiles) continue
      seen.add(jr.many_collection)
      // Derive display name: skip 'id' (it's the PK ref, not a useful alias)
      const fieldName =
        jr.one_field && jr.one_field !== 'id'
          ? jr.one_field
          : jr.many_collection
              .replace(new RegExp(`^${tableName}_?|_?${tableName}$`, 'i'), '')
              .replace(/^_|_$/g, '') || jr.many_collection
      results.push({ field: fieldName, junction: jr.many_collection })
    }
    return results
  }, [relData, tableName])

  const [open, setOpen] = useState(false)
  const selected = fileFields.find((f) => f.field === value) ?? null

  return (
    <div className='mt-1.5 space-y-1'>
      <p className='text-[11px] font-medium text-slate-400'>Attach PDF to field</p>
      <div data-setting='pdf_button.attach_to_field'>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type='button'
              className='flex w-full items-center justify-between rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 hover:border-nvr-cyan/50 dark:border-border dark:bg-card dark:text-slate-200'
            >
              <span>
                {selected ? (
                  selected.field
                ) : (
                  <span className='text-slate-400'>Select file field…</span>
                )}
              </span>
              <ChevronDown className='h-3 w-3 text-slate-400' />
            </button>
          </PopoverTrigger>
          <PopoverContent className='w-56 p-0' align='start'>
            <Command>
              <CommandInput placeholder='Search fields…' className='text-[12px]' />
              <CommandList>
                <CommandEmpty className='py-2 text-center text-[11px] text-slate-400'>
                  {fileFields.length === 0 ? 'No file M2M fields found' : 'No match'}
                </CommandEmpty>
                {value && (
                  <CommandItem
                    value='__clear__'
                    onSelect={() => {
                      onChange(null)
                      setOpen(false)
                    }}
                    className='text-[11px] text-slate-400'
                  >
                    Clear
                  </CommandItem>
                )}
                {fileFields.map((f) => (
                  <CommandItem
                    key={f.field}
                    value={f.field}
                    onSelect={() => {
                      onChange(f.field)
                      setOpen(false)
                    }}
                    className='text-[11px]'
                  >
                    {f.field}
                    <span className='ml-auto text-[11px] text-slate-400 truncate'>
                      {f.junction}
                    </span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      <div className='mt-2 space-y-1' data-setting='pdf_button.filename_template'>
        <p className='text-[11px] font-medium text-slate-400'>Filename template</p>
        <input
          type='text'
          value={filenameTemplate ?? ''}
          onChange={(e) => onFilenameChange(e.target.value || null)}
          placeholder='e.g. {{title}}-report'
          className='w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 placeholder:text-slate-300 focus:border-nvr-cyan/50 focus:outline-none dark:border-border dark:bg-card dark:text-slate-200'
        />
        <p className='text-[11px] text-slate-400'>
          Use {'{{field}}'} tokens. Defaults to template name.
        </p>
      </div>
    </div>
  )
}
