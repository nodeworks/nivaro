import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  ChevronsUpDown,
  FileUp,
  Link2,
  Loader2,
  Sparkles
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'
import type { ImportJob } from './Imports'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseCSVPreview(csv: string): { headers: string[]; rows: string[][] } {
  const lines = csv
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((l) => l.trim())
  if (lines.length === 0) return { headers: [], rows: [] }

  const headers = parseCSVLine(lines[0])
  const rows = lines
    .slice(1, 6)
    .filter((l) => l.trim())
    .map((l) => parseCSVLine(l))
  return { headers, rows }
}

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}

// ─── Combobox (shadcn Popover + Command — never native select) ────────────────

function WizardCombobox({
  value,
  onChange,
  options,
  placeholder,
  className
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className={cn(
            'h-8 w-full justify-between px-2 font-mono text-[12px] font-normal',
            className
          )}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value || '__none'}
                  value={`${opt.value} ${opt.label}`}
                  onSelect={() => {
                    onChange(opt.value)
                    setOpen(false)
                  }}
                  className='font-mono text-[12px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3 w-3',
                      value === opt.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {opt.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── AI confidence badge ──────────────────────────────────────────────────────

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const cls =
    confidence >= 0.8
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900'
      : confidence >= 0.5
        ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900'
        : 'bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-900/40 dark:text-slate-400 dark:border-slate-800'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
        cls
      )}
      title={`AI confidence: ${Math.round(confidence * 100)}%`}
    >
      <Sparkles className='h-2.5 w-2.5' />
      {Math.round(confidence * 100)}%
    </span>
  )
}

// ─── Status helpers ───────────────────────────────────────────────────────────

const STATUS_CLS: Record<string, string> = {
  pending:
    'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-400 dark:border-yellow-900',
  processing:
    'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900',
  complete:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900',
  failed:
    'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900'
}

function StatusBadge({ status }: { status: string }) {
  const isProcessing = status === 'processing'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-semibold',
        STATUS_CLS[status] ?? 'bg-muted text-muted-foreground border-border'
      )}
    >
      {isProcessing && (
        <span className='h-2 w-2 animate-pulse rounded-full bg-blue-500 dark:bg-blue-400' />
      )}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}

function _ProgressBar({ processed, total }: { processed: number | null; total: number | null }) {
  if (!total || total === 0) {
    return (
      <div className='flex items-center gap-3'>
        <div className='flex-1 h-2 rounded-full bg-muted overflow-hidden' />
        <span className='text-sm text-muted-foreground w-12 text-right'>—</span>
      </div>
    )
  }
  const pct = Math.min(100, Math.round(((processed ?? 0) / total) * 100))
  return (
    <div className='flex items-center gap-3'>
      <div className='flex-1 h-2 rounded-full bg-muted overflow-hidden'>
        <div
          className='h-full rounded-full bg-nvr-cyan transition-all duration-500'
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className='text-sm text-muted-foreground w-12 text-right'>
        {processed ?? 0} / {total}
      </span>
    </div>
  )
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  variant = 'default'
}: {
  label: string
  value: number
  variant?: 'default' | 'success' | 'warning' | 'error'
}) {
  const variantCls = {
    default: 'text-foreground',
    success: 'text-emerald-600 dark:text-emerald-400',
    warning: 'text-yellow-600 dark:text-yellow-400',
    error: 'text-red-600 dark:text-red-400'
  }[variant]

  return (
    <div className='rounded-lg border border-border bg-card p-4 text-center'>
      <p className={cn('text-2xl font-bold tabular-nums', variantCls)}>{value}</p>
      <p className='text-[12px] text-muted-foreground mt-0.5'>{label}</p>
    </div>
  )
}

// ─── Step indicator ───────────────────────────────────────────────────────────

const STEPS = ['Upload', 'Map Columns', 'Options', 'Confirm']

function StepIndicator({ current }: { current: number }) {
  return (
    <div className='flex items-center gap-1'>
      {STEPS.map((label, idx) => {
        const done = idx < current
        const active = idx === current
        return (
          <div key={label} className='flex items-center'>
            <div className='flex items-center gap-1.5'>
              <div
                className={cn(
                  'h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0',
                  done
                    ? 'bg-nvr-cyan text-white'
                    : active
                      ? 'bg-nvr-cyan/20 text-nvr-cyan border border-nvr-cyan'
                      : 'bg-muted text-muted-foreground'
                )}
              >
                {done ? <Check className='h-3 w-3' /> : idx + 1}
              </div>
              <span
                className={cn(
                  'text-[12px] font-medium hidden sm:inline',
                  active
                    ? 'text-foreground'
                    : done
                      ? 'text-muted-foreground'
                      : 'text-muted-foreground'
                )}
              >
                {label}
              </span>
            </div>
            {idx < STEPS.length - 1 && (
              <ChevronRight className='h-3.5 w-3.5 text-muted-foreground mx-1' />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Step 1: Upload ───────────────────────────────────────────────────────────

function StepUpload({
  csvData,
  fileName,
  onCsvChange,
  onFileNameChange: _onFileNameChange
}: {
  csvData: string
  fileName: string
  onCsvChange: (csv: string, name: string) => void
  onFileNameChange: (name: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')
  const { headers, rows } = parseCSVPreview(csvData)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    onCsvChange(text, file.name)
  }

  const fetchUrlMut = useMutation({
    mutationFn: (fetchUrl: string) =>
      api
        .post<{ data: { csv_data: string; file_name: string } }>('/imports/from-url', {
          url: fetchUrl,
          preview: true
        })
        .then((r) => r.data.data),
    onSuccess: (res) => {
      onCsvChange(res.csv_data, res.file_name)
      toast.success(`Loaded ${res.file_name}`)
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to fetch CSV from URL'
      toast.error(msg)
    }
  })

  return (
    <div className='space-y-6'>
      <Tabs defaultValue='file'>
        <TabsList className='grid w-full max-w-sm grid-cols-2'>
          <TabsTrigger value='file'>
            <FileUp className='h-3.5 w-3.5 mr-1.5' />
            Upload file
          </TabsTrigger>
          <TabsTrigger value='url'>
            <Link2 className='h-3.5 w-3.5 mr-1.5' />
            From URL
          </TabsTrigger>
        </TabsList>

        <TabsContent value='file' className='mt-4 space-y-6'>
          <div className='space-y-2'>
            <Label>Upload CSV file</Label>
            <div className='flex items-center gap-3'>
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={() => fileRef.current?.click()}
              >
                <FileUp className='h-4 w-4 mr-1.5' />
                Choose file
              </Button>
              {fileName && (
                <span className='text-sm text-muted-foreground font-mono'>{fileName}</span>
              )}
            </div>
            <input
              ref={fileRef}
              type='file'
              accept='.csv,text/csv'
              className='hidden'
              onChange={handleFile}
            />
          </div>

          <div className='space-y-2'>
            <Label htmlFor='csv-paste'>Or paste CSV data</Label>
            <textarea
              id='csv-paste'
              value={csvData}
              onChange={(e) => onCsvChange(e.target.value, fileName || 'paste.csv')}
              placeholder={'col1,col2,col3\nval1,val2,val3\nval4,val5,val6'}
              className='flex min-h-[160px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-y'
              spellCheck={false}
            />
          </div>
        </TabsContent>

        <TabsContent value='url' className='mt-4 space-y-2'>
          <Label htmlFor='csv-url'>CSV file URL</Label>
          <form
            className='flex items-center gap-2'
            onSubmit={(e) => {
              e.preventDefault()
              if (!url.trim() || fetchUrlMut.isPending) return
              fetchUrlMut.mutate(url.trim())
            }}
          >
            <Input
              id='csv-url'
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder='https://example.com/data.csv'
              className='max-w-md font-mono text-sm'
            />
            <Button type='submit' size='sm' disabled={!url.trim() || fetchUrlMut.isPending}>
              {fetchUrlMut.isPending ? (
                <>
                  <Loader2 className='h-4 w-4 mr-1.5 animate-spin' />
                  Fetching…
                </>
              ) : (
                'Fetch'
              )}
            </Button>
          </form>
          <p className='text-[11px] text-muted-foreground'>
            The server fetches the file (max 25MB, CSV or plain text). Once loaded, preview and
            column mapping work exactly like a file upload.
          </p>
          {fileName && csvData && (
            <p className='text-[12px] text-muted-foreground'>
              Loaded: <span className='font-mono'>{fileName}</span>
            </p>
          )}
        </TabsContent>
      </Tabs>

      {headers.length > 0 && (
        <div className='space-y-2'>
          <p className='text-sm font-medium'>Preview (first 5 rows)</p>
          <div className='rounded-lg border border-border overflow-auto max-h-52'>
            <Table>
              <TableHeader>
                <TableRow>
                  {headers.map((h) => (
                    <TableHead key={h} className='text-[11px] whitespace-nowrap'>
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: preview rows are stable
                  <TableRow key={i}>
                    {headers.map((_, ci) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: stable col idx
                      <TableCell key={ci} className='text-[12px] font-mono max-w-[120px]'>
                        <span className='truncate block' title={row[ci] ?? ''}>
                          {row[ci] ?? ''}
                        </span>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Step 2: Map columns ──────────────────────────────────────────────────────

function StepMapColumns({
  headers,
  sampleRows,
  columnMap,
  onChange,
  collection,
  onCollectionChange,
  aiConfidence,
  onAiConfidenceChange
}: {
  headers: string[]
  sampleRows: string[][]
  columnMap: Record<string, string>
  onChange: (map: Record<string, string>) => void
  collection: string
  onCollectionChange: (v: string) => void
  aiConfidence: Record<string, number>
  onAiConfidenceChange: (c: Record<string, number>) => void
}) {
  const { data: collections } = useQuery({
    queryKey: ['collections-list'],
    queryFn: () =>
      api
        .get<{ data: { collection: string; display_name?: string | null }[] }>('/collections')
        .then((r) => r.data.data),
    staleTime: 60_000
  })

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () =>
      api
        .get<{ data: { fields?: { field: string; hidden?: boolean }[] } }>(
          `/collections/${collection}`
        )
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 60_000
  })

  const collectionFields = (colMeta?.fields ?? []).filter((f) => !f.hidden).map((f) => f.field)

  const aiMapMut = useMutation({
    mutationFn: () =>
      api
        .post<{
          data?: { mappings?: { column: string; field: string | null; confidence: number }[] }
          mappings?: { column: string; field: string | null; confidence: number }[]
        }>('/ai/map-columns', {
          collection,
          columns: headers,
          sample_rows: sampleRows.slice(0, 5)
        })
        .then((r) => r.data.data?.mappings ?? r.data.mappings ?? []),
    onSuccess: (mappings) => {
      const newMap = { ...columnMap }
      const conf: Record<string, number> = {}
      for (const m of mappings) {
        if (!headers.includes(m.column)) continue
        newMap[m.column] = m.field ?? ''
        if (m.field) conf[m.column] = m.confidence ?? 0
      }
      onChange(newMap)
      onAiConfidenceChange(conf)
      toast.success('Columns mapped with AI — review before continuing')
    },
    onError: (err: unknown) => {
      if (axios.isAxiosError(err) && err.response?.status === 503) {
        toast.message('AI is not configured', {
          description: 'Add an Anthropic API key in Settings to enable AI mapping.'
        })
        return
      }
      toast.error('AI mapping failed')
    }
  })

  function setMapping(csvCol: string, fieldName: string) {
    onChange({ ...columnMap, [csvCol]: fieldName })
    // Manual edit clears the AI badge for that column
    if (aiConfidence[csvCol] !== undefined) {
      const next = { ...aiConfidence }
      delete next[csvCol]
      onAiConfidenceChange(next)
    }
  }

  return (
    <div className='space-y-4'>
      <p className='text-sm text-muted-foreground'>
        Map each CSV column header to the corresponding field name in your collection. Leave blank
        to skip that column.
      </p>

      <div className='flex flex-wrap items-end justify-between gap-3'>
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>Target collection</Label>
          <div className='w-[240px]'>
            <WizardCombobox
              value={collection}
              onChange={onCollectionChange}
              options={(collections ?? [])
                .filter((c) => !c.collection.toLowerCase().startsWith('nivaro_'))
                .map((c) => ({ value: c.collection, label: c.collection }))}
              placeholder='Select collection…'
            />
          </div>
          <p className='text-[11px] text-muted-foreground'>
            Used for field suggestions and AI mapping (also prefills the Options step).
          </p>
        </div>
        <Button
          type='button'
          variant='outline'
          size='sm'
          onClick={() => aiMapMut.mutate()}
          disabled={!collection || headers.length === 0 || aiMapMut.isPending}
          title={collection ? 'Map columns automatically with AI' : 'Select a collection first'}
        >
          {aiMapMut.isPending ? (
            <Loader2 className='h-3.5 w-3.5 mr-1.5 animate-spin' />
          ) : (
            <Sparkles className='h-3.5 w-3.5 mr-1.5 text-nvr-cyan' />
          )}
          Auto-map with AI
        </Button>
      </div>

      <div className='rounded-lg border border-border overflow-hidden'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>CSV Column</TableHead>
              <TableHead>Collection Field</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {headers.map((header) => (
              <TableRow key={header}>
                <TableCell className='font-mono text-[12px] text-muted-foreground'>
                  {header}
                </TableCell>
                <TableCell>
                  <div className='flex items-center gap-2'>
                    {collectionFields.length > 0 ? (
                      <div className='w-[200px]'>
                        <WizardCombobox
                          value={columnMap[header] ?? ''}
                          onChange={(v) => setMapping(header, v)}
                          options={[
                            { value: '', label: '— skip —' },
                            ...collectionFields.map((f) => ({ value: f, label: f }))
                          ]}
                          placeholder='— skip —'
                        />
                      </div>
                    ) : (
                      <Input
                        value={columnMap[header] ?? ''}
                        onChange={(e) => setMapping(header, e.target.value)}
                        placeholder='field_name'
                        className='h-8 text-sm font-mono max-w-[200px]'
                      />
                    )}
                    {aiConfidence[header] !== undefined && columnMap[header] && (
                      <ConfidenceBadge confidence={aiConfidence[header]} />
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

// ─── Step 3: Options ──────────────────────────────────────────────────────────

function StepOptions({
  collection,
  duplicateStrategy,
  idField,
  onCollectionChange,
  onStrategyChange,
  onIdFieldChange
}: {
  collection: string
  duplicateStrategy: string
  idField: string
  onCollectionChange: (v: string) => void
  onStrategyChange: (v: string) => void
  onIdFieldChange: (v: string) => void
}) {
  return (
    <div className='space-y-5'>
      <div className='space-y-1.5'>
        <Label htmlFor='opt-collection'>Collection name</Label>
        <Input
          id='opt-collection'
          value={collection}
          onChange={(e) => onCollectionChange(e.target.value)}
          placeholder='e.g. articles'
          className='max-w-sm font-mono'
        />
        <p className='text-[11px] text-muted-foreground'>
          The exact database table name to import into.
        </p>
      </div>

      <div className='space-y-1.5'>
        <Label htmlFor='opt-strategy'>Duplicate strategy</Label>
        <Select value={duplicateStrategy} onValueChange={onStrategyChange}>
          <SelectTrigger id='opt-strategy' className='max-w-sm'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='skip'>Skip — keep existing record unchanged</SelectItem>
            <SelectItem value='overwrite'>Overwrite — replace all fields</SelectItem>
            <SelectItem value='merge'>Merge — update only mapped fields</SelectItem>
          </SelectContent>
        </Select>
        <p className='text-[11px] text-muted-foreground'>
          What to do when a record with the same ID field value already exists.
        </p>
      </div>

      <div className='space-y-1.5'>
        <Label htmlFor='opt-idfield'>ID field (optional)</Label>
        <Input
          id='opt-idfield'
          value={idField}
          onChange={(e) => onIdFieldChange(e.target.value)}
          placeholder='e.g. id or slug'
          className='max-w-sm font-mono'
        />
        <p className='text-[11px] text-muted-foreground'>
          Field used to detect duplicates. Leave blank to always create new records.
        </p>
      </div>
    </div>
  )
}

// ─── Step 4: Confirm ──────────────────────────────────────────────────────────

function StepConfirm({
  collection,
  fileName,
  duplicateStrategy,
  idField,
  headers,
  columnMap,
  rowCount
}: {
  collection: string
  fileName: string
  duplicateStrategy: string
  idField: string
  headers: string[]
  columnMap: Record<string, string>
  rowCount: number
}) {
  const mappedCount = headers.filter((h) => columnMap[h]?.trim()).length
  const skippedCount = headers.length - mappedCount

  return (
    <div className='space-y-5'>
      <p className='text-sm text-muted-foreground'>
        Review the settings below before submitting the import.
      </p>

      <div className='rounded-lg border border-border divide-y divide-border overflow-hidden'>
        {[
          { label: 'File', value: fileName },
          { label: 'Collection', value: collection, mono: true },
          { label: 'Data rows', value: String(rowCount) },
          { label: 'Mapped columns', value: `${mappedCount} of ${headers.length}` },
          { label: 'Duplicate strategy', value: duplicateStrategy },
          { label: 'ID field', value: idField || '— (always create)' }
        ].map(({ label, value, mono }) => (
          <div key={label} className='flex items-center px-4 py-2.5 gap-4'>
            <span className='text-[12px] text-muted-foreground w-36 shrink-0'>{label}</span>
            <span className={cn('text-sm font-medium', mono && 'font-mono')}>{value}</span>
          </div>
        ))}
      </div>

      {skippedCount > 0 && (
        <p className='text-[12px] text-muted-foreground'>
          {skippedCount} column{skippedCount > 1 ? 's' : ''} will be skipped (no mapping set).
        </p>
      )}
    </div>
  )
}

// ─── Create flow ──────────────────────────────────────────────────────────────

function CreateFlow() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)

  // Step 1 state
  const [csvData, setCsvData] = useState('')
  const [fileName, setFileName] = useState('')

  // Step 2 state — derived from CSV
  const [columnMap, setColumnMap] = useState<Record<string, string>>({})
  const [aiConfidence, setAiConfidence] = useState<Record<string, number>>({})

  // Step 3 state
  const [collection, setCollection] = useState('')
  const [duplicateStrategy, setDuplicateStrategy] = useState('skip')
  const [idField, setIdField] = useState('')

  const { headers, rows } = parseCSVPreview(csvData)
  const rowCount = Math.max(
    0,
    csvData
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .filter((l) => l.trim()).length - 1
  )

  function handleCsvChange(csv: string, name: string) {
    setCsvData(csv)
    setFileName(name)
    // Reset column map when CSV changes
    const { headers: newHeaders } = parseCSVPreview(csv)
    const newMap: Record<string, string> = {}
    for (const h of newHeaders) {
      // Auto-map: use header as field name (sanitised)
      newMap[h] = h.toLowerCase().replace(/[^a-z0-9_]/g, '_')
    }
    setColumnMap(newMap)
    setAiConfidence({})
  }

  const canNext: boolean[] = [
    // Step 0: must have CSV with at least a header + 1 data row
    headers.length > 0 && rowCount > 0,
    // Step 1: at least one mapped column
    Object.values(columnMap).some((v) => v.trim()),
    // Step 2: must have a collection name
    collection.trim().length > 0,
    // Step 3: always ready
    true
  ]

  const createMut = useMutation({
    mutationFn: (body: {
      collection: string
      csv_data: string
      column_map: Record<string, string>
      duplicate_strategy: string
      id_field?: string
      file_name: string
    }) => api.post<{ data: ImportJob }>('/imports', body).then((r) => r.data.data),
    onSuccess: (job) => {
      toast.success('Import job created')
      navigate(`/imports/${job.id}`)
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to create import job'
      toast.error(msg)
    }
  })

  function handleSubmit() {
    createMut.mutate({
      collection: collection.trim(),
      csv_data: csvData,
      column_map: Object.fromEntries(Object.entries(columnMap).filter(([, v]) => v.trim())),
      duplicate_strategy: duplicateStrategy,
      id_field: idField.trim() || undefined,
      file_name: fileName || 'import.csv'
    })
  }

  return (
    <div className='flex flex-col h-full'>
      {/* Header */}
      <div className='border-b border-border px-6 py-4 flex items-center justify-between shrink-0'>
        <div className='flex items-center gap-4'>
          <Button
            variant='ghost'
            size='icon'
            className='h-8 w-8'
            onClick={() => navigate('/imports')}
          >
            <ArrowLeft className='h-4 w-4' />
          </Button>
          <div>
            <h1 className='text-lg font-semibold'>New Import</h1>
            <p className='text-xs text-muted-foreground'>Import CSV data into a collection</p>
          </div>
        </div>
        <StepIndicator current={step} />
      </div>

      {/* Step content */}
      <div className='flex-1 overflow-auto p-6'>
        <div className='max-w-2xl mx-auto'>
          {step === 0 && (
            <StepUpload
              csvData={csvData}
              fileName={fileName}
              onCsvChange={handleCsvChange}
              onFileNameChange={setFileName}
            />
          )}
          {step === 1 && (
            <StepMapColumns
              headers={headers}
              sampleRows={rows}
              columnMap={columnMap}
              onChange={setColumnMap}
              collection={collection}
              onCollectionChange={setCollection}
              aiConfidence={aiConfidence}
              onAiConfidenceChange={setAiConfidence}
            />
          )}
          {step === 2 && (
            <StepOptions
              collection={collection}
              duplicateStrategy={duplicateStrategy}
              idField={idField}
              onCollectionChange={setCollection}
              onStrategyChange={setDuplicateStrategy}
              onIdFieldChange={setIdField}
            />
          )}
          {step === 3 && (
            <StepConfirm
              collection={collection}
              fileName={fileName}
              duplicateStrategy={duplicateStrategy}
              idField={idField}
              headers={headers}
              columnMap={columnMap}
              rowCount={rowCount}
            />
          )}
        </div>
      </div>

      {/* Nav footer */}
      <div className='border-t border-border px-6 py-4 flex items-center justify-between shrink-0'>
        <Button
          variant='outline'
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
        >
          <ArrowLeft className='h-4 w-4 mr-1.5' />
          Back
        </Button>

        {step < STEPS.length - 1 ? (
          <Button onClick={() => setStep((s) => s + 1)} disabled={!canNext[step]}>
            Next
            <ArrowRight className='h-4 w-4 ml-1.5' />
          </Button>
        ) : (
          <Button onClick={handleSubmit} disabled={createMut.isPending || !collection.trim()}>
            {createMut.isPending ? (
              <>
                <Loader2 className='h-4 w-4 mr-1.5 animate-spin' />
                Submitting…
              </>
            ) : (
              <>
                <FileUp className='h-4 w-4 mr-1.5' />
                Start Import
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── Detail view ──────────────────────────────────────────────────────────────

function DetailView({ id }: { id: string }) {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const { data: jobData, isLoading } = useQuery({
    queryKey: ['import-job', id],
    queryFn: () => api.get<{ data: ImportJob }>(`/imports/${id}`).then((r) => r.data.data)
  })

  const job = jobData

  // Poll while processing
  useEffect(() => {
    if (!job || (job.status !== 'processing' && job.status !== 'pending')) return
    const interval = setInterval(() => {
      qc.invalidateQueries({ queryKey: ['import-job', id] })
    }, 2000)
    return () => clearInterval(interval)
  }, [job?.status, id, qc, job])

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/imports/${id}`),
    onSuccess: () => {
      toast.success('Import job deleted')
      navigate('/imports')
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to delete job'
      toast.error(msg)
    }
  })

  if (isLoading) {
    return (
      <div className='flex flex-col h-full'>
        <div className='border-b border-border px-6 py-4 flex items-center gap-4 shrink-0'>
          <Skeleton className='h-8 w-8 rounded-md' />
          <Skeleton className='h-6 w-48' />
        </div>
        <div className='p-6 space-y-4'>
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className='h-24 w-full rounded-lg' />
          ))}
        </div>
      </div>
    )
  }

  if (!job) {
    return (
      <div className='flex flex-col h-full items-center justify-center p-12 text-center'>
        <p className='text-muted-foreground'>Import job not found.</p>
        <Button variant='outline' className='mt-4' onClick={() => navigate('/imports')}>
          Back to Imports
        </Button>
      </div>
    )
  }

  const errors = Array.isArray(job.errors) ? (job.errors as { row: number; error: string }[]) : []
  const pct =
    job.total_rows && job.total_rows > 0
      ? Math.min(100, Math.round(((job.processed_rows ?? 0) / job.total_rows) * 100))
      : job.status === 'complete'
        ? 100
        : 0

  const canDelete = job.status === 'complete' || job.status === 'failed'

  return (
    <div className='flex flex-col h-full'>
      {/* Header */}
      <div className='border-b border-border px-6 py-4 flex items-center justify-between shrink-0'>
        <div className='flex items-center gap-4'>
          <Button
            variant='ghost'
            size='icon'
            className='h-8 w-8'
            onClick={() => navigate('/imports')}
          >
            <ArrowLeft className='h-4 w-4' />
          </Button>
          <div>
            <div className='flex items-center gap-3'>
              <h1 className='text-lg font-semibold'>{job.file_name}</h1>
              <StatusBadge status={job.status} />
            </div>
            <p className='text-xs text-muted-foreground'>
              Collection: <span className='font-mono'>{job.collection}</span> · Created{' '}
              {formatDate(job.created_at)}
            </p>
          </div>
        </div>
        {canDelete && (
          <Button
            variant='outline'
            size='sm'
            className='text-destructive hover:text-destructive'
            onClick={() => deleteMut.mutate()}
            disabled={deleteMut.isPending}
          >
            {deleteMut.isPending ? 'Deleting…' : 'Delete job'}
          </Button>
        )}
      </div>

      {/* Content */}
      <div className='flex-1 overflow-auto p-6 space-y-6'>
        <div className='max-w-3xl space-y-6'>
          {/* Details card */}
          <div className='rounded-lg border border-border overflow-hidden'>
            <div className='px-4 py-3 bg-muted/40 border-b border-border'>
              <p className='text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
                Job Details
              </p>
            </div>
            <div className='divide-y divide-border'>
              {[
                { label: 'File', value: job.file_name },
                { label: 'Collection', value: job.collection, mono: true },
                { label: 'Duplicate strategy', value: job.duplicate_strategy },
                { label: 'ID field', value: job.id_field ?? '— (always create)' },
                { label: 'Started', value: job.started_at ? formatDate(job.started_at) : '—' },
                {
                  label: 'Completed',
                  value: job.completed_at ? formatDate(job.completed_at) : '—'
                }
              ].map(({ label, value, mono }) => (
                <div key={label} className='flex items-center px-4 py-2.5 gap-4'>
                  <span className='text-[12px] text-muted-foreground w-32 shrink-0'>{label}</span>
                  <span className={cn('text-sm', mono && 'font-mono')}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Progress */}
          <div className='rounded-lg border border-border p-4 space-y-3'>
            <div className='flex items-center justify-between'>
              <p className='text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
                Progress
              </p>
              <span className='text-sm font-medium tabular-nums'>{pct}%</span>
            </div>
            <div className='h-2.5 rounded-full bg-muted overflow-hidden'>
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500',
                  job.status === 'failed' ? 'bg-red-500' : 'bg-nvr-cyan'
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className='text-[12px] text-muted-foreground'>
              {job.processed_rows ?? 0} of {job.total_rows ?? '?'} rows processed
            </p>
          </div>

          {/* Stats grid */}
          <div className='grid grid-cols-2 sm:grid-cols-4 gap-3'>
            <StatCard label='Created' value={job.created_rows ?? 0} variant='success' />
            <StatCard label='Updated' value={job.updated_rows ?? 0} />
            <StatCard label='Skipped' value={job.skipped_rows ?? 0} variant='warning' />
            <StatCard
              label='Errors'
              value={job.error_rows ?? 0}
              variant={job.error_rows ? 'error' : 'default'}
            />
          </div>

          {/* Error table */}
          {errors.length > 0 && (
            <div className='rounded-lg border border-border overflow-hidden'>
              <div className='px-4 py-3 bg-red-50 dark:bg-red-950/20 border-b border-border'>
                <p className='text-[11px] font-semibold uppercase tracking-wide text-red-700 dark:text-red-400'>
                  Row Errors ({errors.length})
                </p>
              </div>
              <div className='overflow-auto max-h-72'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className='w-20'>Row</TableHead>
                      <TableHead>Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errors.map((e, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: error rows are stable after completion
                      <TableRow key={i}>
                        <TableCell className='font-mono text-sm'>{e.row}</TableCell>
                        <TableCell className='text-sm text-red-600 dark:text-red-400'>
                          {e.error}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/* Still running message */}
          {(job.status === 'pending' || job.status === 'processing') && (
            <div className='flex items-center gap-2 text-sm text-muted-foreground'>
              <Loader2 className='h-4 w-4 animate-spin' />
              <span>Processing — this page refreshes automatically every 2 seconds.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function ImportJobPage() {
  const { id } = useParams<{ id?: string }>()

  if (!id || id === 'new') {
    return <CreateFlow />
  }

  return <DetailView id={id} />
}
