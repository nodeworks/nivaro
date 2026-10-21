import { Check, ChevronsUpDown } from 'lucide-react'
import { Fragment, type KeyboardEvent, useEffect, useRef, useState } from 'react'
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
        <TabStrip active={active.id} onSelect={onSelect} />
      </div>
      <div className='px-4 py-2 md:hidden'>
        <TabMenu active={active} onSelect={onSelect} />
      </div>
    </div>
  )
}

function TabStrip({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () =>
      setEdges((prev) => {
        const left = el.scrollLeft > 1
        const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
        return prev.left === left && prev.right === right ? prev : { left, right }
      })
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      ro.disconnect()
    }
  }, [])

  // Keep the active tab visible when it changes (deep links, keyboard, the narrow menu).
  useEffect(() => {
    const el = scroller.current
    const tab = el?.querySelector<HTMLElement>(`#${tabDomId(active)}`)
    if (!el || !tab) return
    const pad = 32
    if (tab.offsetLeft - pad < el.scrollLeft) el.scrollLeft = tab.offsetLeft - pad
    else if (tab.offsetLeft + tab.offsetWidth + pad > el.scrollLeft + el.clientWidth)
      el.scrollLeft = tab.offsetLeft + tab.offsetWidth + pad - el.clientWidth
  }, [active])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = INFRA_TABS.findIndex((t) => t.id === active)
    const next =
      e.key === 'ArrowRight'
        ? INFRA_TABS[(i + 1) % INFRA_TABS.length]
        : e.key === 'ArrowLeft'
          ? INFRA_TABS[(i - 1 + INFRA_TABS.length) % INFRA_TABS.length]
          : e.key === 'Home'
            ? INFRA_TABS[0]
            : e.key === 'End'
              ? INFRA_TABS[INFRA_TABS.length - 1]
              : null
    if (!next) return
    e.preventDefault()
    onSelect(next.id)
    requestAnimationFrame(() => document.getElementById(tabDomId(next.id))?.focus())
  }

  return (
    <div className='relative'>
      <div
        ref={scroller}
        role='tablist'
        aria-label='Infrastructure views'
        onKeyDown={onKeyDown}
        className='flex items-stretch gap-0.5 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
      >
        {GROUPS.map((g, gi) => (
          <Fragment key={g.group}>
            {gi > 0 && (
              <span
                aria-hidden
                className='mx-1.5 my-2.5 w-px shrink-0 bg-slate-200 dark:bg-border'
              />
            )}
            {g.tabs.map((t) => {
              const on = t.id === active
              return (
                <button
                  key={t.id}
                  id={tabDomId(t.id)}
                  type='button'
                  role='tab'
                  aria-selected={on}
                  aria-controls={PANEL_ID}
                  tabIndex={on ? 0 : -1}
                  onClick={() => onSelect(t.id)}
                  className={cn(
                    'shrink-0 whitespace-nowrap border-b-2 px-2.5 py-2.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
                    on
                      ? 'border-nvr-cyan text-slate-900 dark:text-foreground'
                      : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
                  )}
                >
                  {t.label}
                </button>
              )
            })}
          </Fragment>
        ))}
      </div>
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-white to-transparent transition-opacity duration-150 dark:from-card',
          edges.left ? 'opacity-100' : 'opacity-0'
        )}
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-white to-transparent transition-opacity duration-150 dark:from-card',
          edges.right ? 'opacity-100' : 'opacity-0'
        )}
      />
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
