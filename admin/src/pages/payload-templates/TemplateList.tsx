import { ArrowLeft, Check, ChevronsUpDown, Plus } from 'lucide-react'
import { useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { ExternalApi } from '../ExternalApis'
import { statusText, type TemplateListItem, type TemplateStatus } from './api'

/** Live vN (green tint) · Draft changes (amber) · Not published (neutral). */
export function StatusChip({
  status,
  version,
  className
}: {
  status: TemplateStatus
  version: number | null
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10.5px] font-medium',
        status === 'live' &&
          'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
        status === 'draft' && 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
        status === 'unpublished' &&
          'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground',
        className
      )}
      data-payload-status={status}
    >
      {statusText(status, version)}
    </span>
  )
}

function ApiSwitcher({
  apis,
  current,
  onSwitch,
  className
}: {
  apis: ExternalApi[]
  current: ExternalApi | null
  onSwitch: (a: ExternalApi) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          role='combobox'
          aria-expanded={open}
          aria-label='Switch external API'
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 text-left text-[12.5px] font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:hover:bg-muted',
            className
          )}
          data-payload-api-switcher
        >
          <span className='min-w-0 flex-1 truncate'>{current?.name ?? 'Pick an API'}</span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[248px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Find an API…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No API by that name
            </CommandEmpty>
            <CommandGroup>
              {apis.map((a) => (
                <CommandItem
                  key={a.id}
                  value={`${a.name} ${a.id}`}
                  onSelect={() => {
                    setOpen(false)
                    if (a.id !== current?.id) onSwitch(a)
                  }}
                  className='text-[12.5px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3 w-3',
                      a.id === current?.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className='truncate'>{a.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** The payload list as one combobox (compact layout): label, status and use per row. */
function PayloadSwitcher({
  templates,
  loading,
  error,
  selectedKey,
  onSelect,
  apiName
}: {
  templates: TemplateListItem[]
  loading: boolean
  error: string | null
  selectedKey: string | null
  onSelect: (key: string) => void
  apiName: string
}) {
  const [open, setOpen] = useState(false)
  const current = templates.find((t) => t.key === selectedKey) ?? null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          role='combobox'
          aria-expanded={open}
          aria-label='Switch payload'
          disabled={loading && !templates.length}
          className='flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 text-left text-[12.5px] text-slate-800 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-wait dark:border-border dark:bg-background dark:text-foreground dark:hover:bg-muted sm:max-w-[420px]'
          data-payload-switcher
        >
          <span className='shrink-0 text-slate-500 dark:text-muted-foreground'>Payload</span>
          <span className='min-w-0 flex-1 truncate font-medium'>
            {current?.label ??
              (loading ? 'Loading…' : templates.length ? 'Pick a payload' : 'None yet')}
          </span>
          {templates.length > 1 && (
            <span className='shrink-0 tabular-nums text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              {templates.length}
            </span>
          )}
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[340px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Find a payload…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              {error ?? `No payload by that name on ${apiName}`}
            </CommandEmpty>
            <CommandGroup>
              {templates.map((t) => (
                <CommandItem
                  key={t.key}
                  value={`${t.label} ${t.key}`}
                  onSelect={() => {
                    setOpen(false)
                    if (t.key !== selectedKey) onSelect(t.key)
                  }}
                  className='items-start gap-2 py-1.5 text-[12.5px]'
                  data-payload-row={t.key}
                >
                  <Check
                    className={cn(
                      'mt-0.5 h-3 w-3 shrink-0',
                      t.key === selectedKey ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate'>{t.label}</span>
                    <span className='mt-0.5 flex items-center gap-2'>
                      <StatusChip status={t.status} version={t.published_version} />
                      <span className='truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                        {t.used_by_count > 0 ? `Used by ${t.used_by_count}` : 'Not used yet'}
                      </span>
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ListSkeleton() {
  return (
    <div className='space-y-1 px-2 py-1' aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className='space-y-1.5 rounded-md px-2.5 py-2'>
          <div className='h-3 w-3/4 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
          <div className='h-2.5 w-1/3 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
        </div>
      ))}
    </div>
  )
}

/**
 * The editor's left column: back to the API, the API switcher, and this API's
 * payloads (label, status, used-by). Selecting a row replaces the URL so Back
 * still returns to wherever the person came from.
 */
export function TemplateList({
  apis,
  currentApi,
  onBack,
  onSwitchApi,
  templates,
  loading,
  error,
  selectedKey,
  onSelect,
  onNew,
  compact
}: {
  apis: ExternalApi[]
  currentApi: ExternalApi | null
  onBack: () => void
  onSwitchApi: (a: ExternalApi) => void
  templates: TemplateListItem[]
  loading: boolean
  error: string | null
  selectedKey: string | null
  onSelect: (key: string) => void
  onNew: () => void
  /**
   * Not enough room for a list column (a narrow page, or the preview beside a cramped
   * editor): the list folds into a combobox in a bar above the editor.
   */
  compact: boolean
}) {
  if (compact)
    return (
      <div
        className='flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'
        data-payload-list-compact
      >
        <button
          type='button'
          onClick={onBack}
          aria-label={`Back to ${currentApi?.name ?? 'External APIs'}`}
          data-tip={`Back to ${currentApi?.name ?? 'External APIs'}`}
          className='inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
          data-payload-back
        >
          <ArrowLeft className='h-4 w-4' />
        </button>
        <ApiSwitcher
          apis={apis}
          current={currentApi}
          onSwitch={onSwitchApi}
          className='w-[180px] shrink-0'
        />
        <PayloadSwitcher
          templates={templates}
          loading={loading}
          error={error}
          selectedKey={selectedKey}
          onSelect={onSelect}
          apiName={currentApi?.name ?? 'this API'}
        />
        <button
          type='button'
          onClick={onNew}
          data-tip='New payload — created from the API page'
          aria-label='New payload'
          className='inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
        >
          <Plus className='h-4 w-4' />
        </button>
        {error && <p className='w-full text-[12px] text-red-600 dark:text-red-400'>{error}</p>}
      </div>
    )
  return (
    <aside className='flex w-[272px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='shrink-0 space-y-2.5 border-b border-slate-100 px-3 pb-3 pt-3 dark:border-border'>
        <button
          type='button'
          onClick={onBack}
          className='-ml-1 inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-[12.5px] text-slate-500 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:text-foreground'
          data-payload-back
        >
          <ArrowLeft className='h-3.5 w-3.5 shrink-0' />
          <span className='truncate'>{currentApi?.name ?? 'External APIs'}</span>
        </button>
        <ApiSwitcher apis={apis} current={currentApi} onSwitch={onSwitchApi} />
      </div>
      <div className='flex shrink-0 items-center justify-between px-4 pb-1 pt-3'>
        <p className='text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
          Payloads
        </p>
        <button
          type='button'
          onClick={onNew}
          data-tip='New payload — created from the API page'
          aria-label='New payload'
          className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted dark:hover:text-foreground'
        >
          <Plus className='h-3.5 w-3.5' />
        </button>
      </div>
      <nav className='min-h-0 flex-1 overflow-y-auto pb-3' aria-label='Payloads on this API'>
        {loading ? (
          <ListSkeleton />
        ) : error ? (
          <p className='px-4 py-3 text-[12px] text-red-600 dark:text-red-400'>{error}</p>
        ) : templates.length === 0 ? (
          <div className='px-4 py-3 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            <p>No payloads on {currentApi?.name ?? 'this API'} yet.</p>
            <button
              type='button'
              onClick={onNew}
              className='mt-1.5 text-[12.5px] font-medium text-slate-700 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-500 dark:text-foreground'
            >
              Create one on the API page
            </button>
          </div>
        ) : (
          <ul className='space-y-px px-2'>
            {templates.map((t) => {
              const active = t.key === selectedKey
              return (
                <li key={t.key}>
                  <button
                    type='button'
                    onClick={() => onSelect(t.key)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'w-full rounded-md px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                      active ? 'bg-nvr-cyan/10' : 'hover:bg-slate-50 dark:hover:bg-muted'
                    )}
                    data-payload-row={t.key}
                  >
                    <span
                      className={cn(
                        'block truncate text-[13px]',
                        active
                          ? 'font-medium text-slate-900 dark:text-foreground'
                          : 'text-slate-700 dark:text-slate-200'
                      )}
                    >
                      {t.label}
                    </span>
                    <span className='mt-1 flex items-center gap-2'>
                      <StatusChip status={t.status} version={t.published_version} />
                      <span className='truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                        {t.used_by_count > 0 ? `Used by ${t.used_by_count}` : 'Not used yet'}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </nav>
    </aside>
  )
}
