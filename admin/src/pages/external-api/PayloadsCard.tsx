import { TipLayer } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronRight, ChevronsUpDown, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Card } from '@/components/ui/card'
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
import { api, type ExternalApiEndpoint } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  errorMessage,
  slugKey,
  type TemplateMode,
  useCreateTemplate,
  useTemplates
} from '../payload-templates/api'
import { StatusChip } from '../payload-templates/TemplateList'

const KEY_RE = /^[a-z0-9-]+$/

function PickerCombobox({
  value,
  onChange,
  options,
  placeholder,
  emptyText,
  mono,
  ariaLabel
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string; hint?: string }[]
  placeholder: string
  emptyText: string
  mono?: boolean
  ariaLabel: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          role='combobox'
          aria-expanded={open}
          aria-label={ariaLabel}
          className='flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-left text-[13px] hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted'
        >
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              mono && selected && 'font-mono text-[12px]',
              !selected && 'text-muted-foreground'
            )}
          >
            {selected ? selected.label : placeholder}
          </span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 opacity-50' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[--radix-popover-trigger-width] min-w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              {emptyText}
            </CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={`${o.label} ${o.value} ${o.hint ?? ''}`}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className='gap-2 text-[12.5px]'
                >
                  <Check
                    className={cn(
                      'h-3 w-3 shrink-0',
                      o.value === value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className={cn('min-w-0 flex-1 truncate', mono && 'font-mono text-[12px]')}>
                    {o.label}
                  </span>
                  {o.hint && (
                    <span className='shrink-0 text-[11px] text-muted-foreground'>{o.hint}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function CreateForm({
  apiId,
  apiName,
  takenKeys,
  onCancel
}: {
  apiId: number
  apiName: string
  takenKeys: string[]
  onCancel: () => void
}) {
  const navigate = useNavigate()
  const create = useCreateTemplate()
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [keyEdited, setKeyEdited] = useState(false)
  const [collection, setCollection] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [mode, setMode] = useState<TemplateMode>('map')
  const labelRef = useRef<HTMLInputElement>(null)
  useEffect(() => labelRef.current?.focus(), [])

  const { data: collections = [] } = useQuery<{ collection: string }[]>({
    queryKey: ['collections'],
    queryFn: () =>
      api.get<{ data: { collection: string }[] }>('/collections').then((r) => r.data.data)
  })
  const { data: endpoints = [] } = useQuery<ExternalApiEndpoint[]>({
    queryKey: ['external-api-endpoints', apiId],
    queryFn: () =>
      api
        .get<{ data: ExternalApiEndpoint[] }>(`/external-apis/${apiId}/endpoints`)
        .then((r) => r.data.data)
  })

  const effectiveKey = keyEdited ? key : slugKey(label)
  const keyError = !effectiveKey
    ? null
    : !KEY_RE.test(effectiveKey)
      ? 'Lowercase letters, numbers and dashes only'
      : takenKeys.includes(effectiveKey)
        ? 'Another payload already uses this key'
        : null
  const canCreate =
    !!label.trim() && !!effectiveKey && !keyError && !!collection && !create.isPending

  const submit = () => {
    if (!canCreate) return
    create.mutate(
      {
        key: effectiveKey,
        label: label.trim(),
        external_api: apiName,
        collection,
        endpoint_path: endpoint || null,
        mode
      },
      {
        onSuccess: (r) => {
          toast.success('Payload created — nothing is sent until you publish it')
          navigate(`/external-apis/${apiId}/payloads/${encodeURIComponent(r.key)}`)
        },
        onError: (e) => toast.error(errorMessage(e, 'The payload was not created'))
      }
    )
  }

  return (
    <form
      className='mt-4 space-y-4 border-t border-slate-100 pt-4 dark:border-border'
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      data-payload-create
    >
      <div className='grid gap-4 sm:grid-cols-2'>
        <div className='space-y-1.5'>
          <Label htmlFor='payload-label'>Name</Label>
          <Input
            id='payload-label'
            ref={labelRef}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder='e.g. Workflow status update'
          />
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='payload-key'>Key</Label>
          <Input
            id='payload-key'
            value={effectiveKey}
            onChange={(e) => {
              setKeyEdited(true)
              setKey(e.target.value.toLowerCase())
            }}
            placeholder='workflow-status-update'
            className={cn('font-mono text-[12.5px]', keyError && 'border-red-400')}
            aria-invalid={!!keyError}
            aria-describedby='payload-key-hint'
          />
          <p
            id='payload-key-hint'
            className={cn(
              'text-[12px]',
              keyError
                ? 'text-red-600 dark:text-red-400'
                : 'text-slate-500 dark:text-muted-foreground'
            )}
          >
            {keyError ??
              'Pipeline actions and code pick the payload by this key. It cannot change later.'}
          </p>
        </div>
        <div className='space-y-1.5'>
          <Label>Records it is built from</Label>
          <PickerCombobox
            value={collection}
            onChange={setCollection}
            options={collections.map((c) => ({ value: c.collection, label: c.collection }))}
            placeholder='Pick a collection'
            emptyText='No collection by that name'
            mono
            ariaLabel='Collection'
          />
        </div>
        <div className='space-y-1.5'>
          <Label>Endpoint (optional)</Label>
          <PickerCombobox
            value={endpoint}
            onChange={(v) => setEndpoint(v === endpoint ? '' : v)}
            options={endpoints.map((ep) => ({
              value: ep.path,
              label: ep.path,
              hint: `${ep.method} · ${ep.name}`
            }))}
            placeholder={endpoints.length ? 'Shown on the editor only' : 'No endpoints on this API'}
            emptyText='No endpoint matches'
            mono
            ariaLabel='Endpoint'
          />
        </div>
      </div>
      <fieldset className='space-y-1.5'>
        <legend className='mb-1.5 text-sm font-medium leading-none'>Start as</legend>
        <div className='inline-flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
          {(
            [
              ['map', 'Field map', 'Rows you pick — always valid JSON'],
              ['code', 'Code', 'Liquid that must render JSON']
            ] as const
          ).map(([m, title, tip]) => (
            <button
              key={m}
              type='button'
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              data-tip={tip}
              className={cn(
                'rounded px-3 py-1 text-[12.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                mode === m
                  ? 'bg-slate-100 text-slate-900 dark:bg-muted dark:text-foreground'
                  : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
              )}
            >
              {title}
            </button>
          ))}
        </div>
      </fieldset>
      <div className='flex items-center gap-2'>
        <button
          type='submit'
          disabled={!canCreate}
          className='h-8 rounded-md bg-nvr-cyan px-3.5 text-[12.5px] font-semibold text-white hover:bg-nvr-cyan/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 disabled:hover:bg-slate-200 dark:disabled:border dark:disabled:border-border dark:disabled:bg-transparent dark:disabled:!text-slate-500 dark:disabled:hover:bg-transparent'
        >
          {create.isPending ? 'Creating…' : 'Create payload'}
        </button>
        <button
          type='button'
          onClick={onCancel}
          className='h-8 rounded-md px-3 text-[12.5px] font-medium text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

/**
 * External API page → Payloads: the JSON bodies this API is sent, each a
 * draft → publish template. Row → the full-width editor.
 */
export function PayloadsCard({ apiId, apiName }: { apiId: number; apiName: string }) {
  const navigate = useNavigate()
  const location = useLocation()
  const listQ = useTemplates(apiName)
  const templates = listQ.data?.data ?? []
  const warning = listQ.data?.warning ?? null
  const [creating, setCreating] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  // The editor's "New payload" lands here.
  useEffect(() => {
    if (location.hash !== '#new-payload') return
    setCreating(true)
    cardRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [location.hash])

  return (
    <Card ref={cardRef} className='mt-5 scroll-mt-4 p-6' id='payloads' data-payloads-card>
      <TipLayer />
      <div className='flex items-start justify-between gap-4'>
        <div>
          <Label>Payloads</Label>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            The request bodies Nivaro sends to {apiName}. Pushes send the published version only;
            edits stay a draft until you publish.
          </p>
        </div>
        {!creating && (
          <button
            type='button'
            onClick={() => setCreating(true)}
            className='inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:text-slate-200 dark:hover:bg-muted'
            data-payload-new
          >
            <Plus className='h-3.5 w-3.5' />
            New payload
          </button>
        )}
      </div>

      {warning && (
        <div className='mt-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200'>
          <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
          <p>{warning}</p>
        </div>
      )}

      <div className='mt-3'>
        {listQ.isLoading ? (
          <div className='space-y-2' aria-hidden>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className='h-11 animate-pulse rounded-md bg-[hsl(var(--nvr-skeleton))]'
              />
            ))}
          </div>
        ) : listQ.isError ? (
          <p className='text-[12.5px] text-red-600 dark:text-red-400'>
            {errorMessage(listQ.error, 'Payloads could not load')}{' '}
            <button
              type='button'
              onClick={() => void listQ.refetch()}
              className='font-medium underline underline-offset-2'
            >
              Try again
            </button>
          </p>
        ) : templates.length === 0 ? (
          !creating && (
            <p className='text-[13px] text-slate-500 dark:text-muted-foreground'>
              No payloads yet. A payload is the JSON body a pipeline action or code push sends to
              this API.
            </p>
          )
        ) : (
          <ul className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border dark:border-border'>
            {templates.map((t) => (
              <li key={t.key}>
                <button
                  type='button'
                  onClick={() =>
                    navigate(`/external-apis/${apiId}/payloads/${encodeURIComponent(t.key)}`)
                  }
                  className='flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan dark:hover:bg-muted'
                  data-payload-card-row={t.key}
                >
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[13px] text-slate-800 dark:text-foreground'>
                      {t.label}
                    </span>
                    <span className='block truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                      {t.key}
                    </span>
                  </span>
                  <StatusChip status={t.status} version={t.published_version} />
                  <span className='w-[84px] shrink-0 text-right text-[12px] text-slate-500 dark:text-muted-foreground'>
                    {t.used_by_count > 0 ? `Used by ${t.used_by_count}` : 'Not used'}
                  </span>
                  <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-300 dark:text-slate-600' />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {creating && (
        <CreateForm
          apiId={apiId}
          apiName={apiName}
          takenKeys={templates.map((t) => t.key)}
          onCancel={() => {
            setCreating(false)
            if (location.hash === '#new-payload') navigate({ hash: '' }, { replace: true })
          }}
        />
      )}
    </Card>
  )
}
