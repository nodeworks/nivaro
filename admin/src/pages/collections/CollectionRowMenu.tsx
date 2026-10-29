import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FolderInput,
  GitBranch,
  LayoutTemplate,
  ListChecks,
  MoreHorizontal,
  Rows3,
  Settings2,
  Star,
  StarOff,
  TableProperties
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Collection } from '@/lib/api'
import { cn } from '@/lib/utils'
import { recordCollectionOpen } from './overview-data'
import type { FolderOption } from './types'

const ITEM = 'gap-2 text-[12px] [&_svg]:size-3.5 [&_svg]:text-slate-400 dark:[&_svg]:text-slate-500'

const DATA_MODEL_TABS: Array<{ tab: string; label: string; icon: ReactNode }> = [
  { tab: 'fields', label: 'Fields', icon: <TableProperties /> },
  { tab: 'relations', label: 'Relations', icon: <GitBranch /> },
  { tab: 'groups', label: 'Form layouts', icon: <LayoutTemplate /> },
  { tab: 'rules', label: 'Rules', icon: <ListChecks /> },
  { tab: 'imports', label: 'Imports', icon: <Download /> },
  { tab: 'settings', label: 'Settings', icon: <Settings2 /> }
]

export function CollectionRowMenu({
  col,
  displayName,
  isAdmin,
  pinned,
  onTogglePin,
  folders,
  onMove,
  className
}: {
  col: Collection
  displayName: string
  isAdmin: boolean
  pinned: boolean
  onTogglePin: () => void
  folders: FolderOption[]
  onMove: (group: string | null) => void
  className?: string
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<'main' | 'folders'>('main')
  const name = col.collection
  const enc = encodeURIComponent(name)
  const recordsPath = `/collections/${enc}`

  const onOpenChange = (v: boolean) => {
    setOpen(v)
    if (!v) setPage('main')
  }
  const run = (fn: () => void) => () => {
    onOpenChange(false)
    fn()
  }
  const copyKey = () => {
    const done = () => toast.success(`Copied ${name}`)
    const fail = () => toast.error('Could not copy to the clipboard')
    if (!navigator.clipboard?.writeText) return fail()
    navigator.clipboard.writeText(name).then(done, fail)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={`More actions for ${displayName}`}
          data-tip='More actions'
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-opacity hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 data-[state=open]:bg-slate-100 data-[state=open]:text-slate-700 motion-reduce:transition-none dark:text-slate-500 dark:hover:bg-white/10 dark:hover:text-slate-300 dark:data-[state=open]:bg-white/10 dark:data-[state=open]:text-slate-200',
            className
          )}
        >
          <MoreHorizontal className='h-3.5 w-3.5' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        sideOffset={4}
        collisionPadding={8}
        className='w-56 p-0'
        onClick={(e) => e.stopPropagation()}
      >
        {page === 'main' ? (
          <Command loop>
            <CommandList className='max-h-[min(70vh,480px)]'>
              <CommandGroup>
                <CommandItem
                  value='open-records'
                  className={ITEM}
                  onSelect={run(() => {
                    recordCollectionOpen(name)
                    navigate(recordsPath)
                  })}
                >
                  <Rows3 />
                  Open records
                </CommandItem>
                <CommandItem
                  value='open-new-tab'
                  className={ITEM}
                  onSelect={run(() => {
                    recordCollectionOpen(name)
                    window.open(recordsPath, '_blank', 'noopener')
                  })}
                >
                  <ExternalLink />
                  Open in new tab
                </CommandItem>
              </CommandGroup>
              {isAdmin && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading='Data model'>
                    {DATA_MODEL_TABS.map((t) => (
                      <CommandItem
                        key={t.tab}
                        value={`dm-${t.tab}`}
                        className={ITEM}
                        onSelect={run(() => navigate(`/data-model/${enc}?tab=${t.tab}`))}
                      >
                        {t.icon}
                        {t.label}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
              <CommandSeparator />
              <CommandGroup>
                <CommandItem value='toggle-pin' className={ITEM} onSelect={run(onTogglePin)}>
                  {pinned ? <StarOff /> : <Star />}
                  {pinned ? 'Unpin' : 'Pin'}
                </CommandItem>
                {isAdmin && (
                  <CommandItem
                    value='move-to-folder'
                    className={ITEM}
                    onSelect={() => setPage('folders')}
                  >
                    <FolderInput />
                    Move to folder
                    <ChevronRight className='ml-auto' />
                  </CommandItem>
                )}
                <CommandItem value='copy-key' className={ITEM} onSelect={run(copyKey)}>
                  <Copy />
                  Copy key
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        ) : (
          <Command loop>
            {folders.length > 7 && (
              <CommandInput placeholder='Find a folder…' className='h-9 text-[12px]' />
            )}
            <CommandList className='max-h-[320px]'>
              <CommandGroup>
                <CommandItem value='back' className={ITEM} onSelect={() => setPage('main')}>
                  <ArrowLeft />
                  Back
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading='Move to folder'>
                <CommandItem
                  value='folder-none'
                  keywords={['No folder']}
                  className={ITEM}
                  onSelect={run(() => col.group != null && onMove(null))}
                >
                  <span className='h-2 w-2 shrink-0 rounded-full border border-slate-300 dark:border-slate-600' />
                  No folder
                  {col.group == null && <Check className='ml-auto !text-nvr-cyan' />}
                </CommandItem>
                {folders.map((f) => (
                  <CommandItem
                    key={f.key}
                    value={`folder-${f.key}`}
                    keywords={[f.label]}
                    className={ITEM}
                    onSelect={run(() => col.group !== f.key && onMove(f.key))}
                  >
                    <span
                      className='h-2 w-2 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600'
                      style={f.color ? { backgroundColor: f.color } : undefined}
                    />
                    <span className='truncate'>{f.label}</span>
                    {col.group === f.key && <Check className='ml-auto !text-nvr-cyan' />}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
}
