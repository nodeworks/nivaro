import { Check, ChevronsUpDown } from 'lucide-react'
import { useState } from 'react'
import { ScrollTabStrip } from '@/components/tab-strip'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { INFRA_TABS, type InfraGroup, type InfraTab } from './tabs'

export const tabDomId = (id: string) => `infra-tab-${id}`
export const PANEL_ID = 'infra-tabpanel'

const GROUPS = INFRA_TABS.reduce<Array<{ group: InfraGroup; tabs: InfraTab[] }>>((acc, t) => {
  const last = acc[acc.length - 1]
  if (last?.group === t.group) last.tabs.push(t)
  else acc.push({ group: t.group, tabs: [t] })
  return acc
}, [])

/**
 * The Infrastructure page's 16 views. Wide screens get one tab strip with a thin rule between
 * groups; when it overflows it scrolls (edges fade, the active tab is kept in view). Narrow
 * screens get a single button that opens the grouped, searchable list instead.
 */
export function InfraTabNav({
  active,
  onSelect
}: {
  active: InfraTab
  onSelect: (id: string) => void
}) {
  return (
    <div className='shrink-0 border-b border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='hidden md:block'>
        <ScrollTabStrip
          tabs={INFRA_TABS.map((t) => ({ id: t.id, label: t.label, group: t.group }))}
          active={active.id}
          onSelect={onSelect}
          ariaLabel='Infrastructure views'
          tabDomId={tabDomId}
          panelId={PANEL_ID}
        />
      </div>
      <div className='px-4 py-2 md:hidden'>
        <TabMenu active={active} onSelect={onSelect} />
      </div>
    </div>
  )
}

function TabMenu({ active, onSelect }: { active: InfraTab; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={`View: ${active.label}. Choose another view`}
          aria-controls={PANEL_ID}
          className='flex h-9 w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-left text-[13px] hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-card dark:hover:bg-muted'
        >
          {active.group !== active.label && (
            <>
              <span className='shrink-0 text-slate-500 dark:text-muted-foreground'>
                {active.group}
              </span>
              <span aria-hidden className='text-slate-300 dark:text-muted-foreground'>
                /
              </span>
            </>
          )}
          <span className='min-w-0 flex-1 truncate font-medium text-slate-900 dark:text-foreground'>
            {active.label}
          </span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[--radix-popover-trigger-width] p-0'>
        <Command defaultValue={`${active.label} ${active.group}`}>
          <CommandInput placeholder='Find a view' className='h-9 text-[13px]' />
          <CommandList className='max-h-[min(420px,60vh)]'>
            <CommandEmpty>No view by that name.</CommandEmpty>
            {GROUPS.map((g) => (
              <CommandGroup key={g.group} heading={g.group === 'Overview' ? undefined : g.group}>
                {g.tabs.map((t) => (
                  <CommandItem
                    key={t.id}
                    value={`${t.label} ${g.group}`}
                    onSelect={() => {
                      onSelect(t.id)
                      setOpen(false)
                    }}
                    className='text-[13px]'
                  >
                    <span className='flex-1'>{t.label}</span>
                    {t.id === active.id && (
                      <Check className='h-3.5 w-3.5 text-nvr-navy dark:text-nvr-cyan' aria-hidden />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
