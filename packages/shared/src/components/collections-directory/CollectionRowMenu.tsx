import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderInput,
  MoreHorizontal,
  Pin,
  PinOff,
  Rows3,
  Star,
  StarOff
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNavigation } from '../../context'
import { cn } from '../../lib/utils'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { recordCollectionOpen } from './directory-data'
import type { DirectoryCollection, FolderOption, RowMenuLink } from './types'

const ITEM = 'gap-2 text-[12px] [&_svg]:size-3.5 [&_svg]:text-slate-400 dark:[&_svg]:text-slate-500'

/**
 * A row's ⋯ menu: open, favorite, pin for everyone (admins), the Pinned section's moves,
 * copy key — plus whatever the host adds (`extra`: the admin app's Data model pages) and,
 * when the host can move collections (`onMove`), Move to folder.
 */
export function CollectionRowMenu({
  col,
  displayName,
  isAdmin,
  recordsPath,
  extra,
  favorite,
  onToggleFavorite,
  pinnedForAll = false,
  onTogglePinned,
  onMoveUp,
  onMoveDown,
  folders,
  onMove,
  className
}: {
  col: DirectoryCollection
  displayName: string
  isAdmin: boolean
  /** Where the collection's records open in this app. */
  recordsPath: string
  /** The host's own group of links (heading + items), e.g. the admin's Data model pages. */
  extra?: { heading: string; items: RowMenuLink[] }
  favorite: boolean
  onToggleFavorite: () => void
  pinnedForAll?: boolean
  onTogglePinned?: () => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  folders: FolderOption[]
  /** Absent = no Move to folder (a host without folder editing). */
  onMove?: (group: string | null) => void
  className?: string
}) {
  const { navigate } = useNavigation()
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<'main' | 'folders'>('main')
  const name = col.collection

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
          data-cdr=''
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
              {extra && extra.items.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading={extra.heading}>
                    {extra.items.map((t) => (
                      <CommandItem
                        key={t.key}
                        value={`extra-${t.key}`}
                        className={ITEM}
                        onSelect={run(() => navigate(t.path))}
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
                <CommandItem
                  value='toggle-favorite'
                  className={ITEM}
                  onSelect={run(onToggleFavorite)}
                >
                  {favorite ? <StarOff /> : <Star />}
                  {favorite ? 'Remove from my favorites' : 'Add to my favorites'}
                </CommandItem>
                {isAdmin && onTogglePinned && (
                  <CommandItem
                    value='toggle-pinned'
                    className={ITEM}
                    onSelect={run(onTogglePinned)}
                  >
                    {pinnedForAll ? <PinOff /> : <Pin />}
                    {pinnedForAll ? 'Unpin for everyone' : 'Pin for everyone'}
                  </CommandItem>
                )}
                {isAdmin && onMoveUp && (
                  <CommandItem value='pin-move-up' className={ITEM} onSelect={run(onMoveUp)}>
                    <ArrowUp />
                    Move up
                  </CommandItem>
                )}
                {isAdmin && onMoveDown && (
                  <CommandItem value='pin-move-down' className={ITEM} onSelect={run(onMoveDown)}>
                    <ArrowDown />
                    Move down
                  </CommandItem>
                )}
                {isAdmin && onMove && (
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
                  onSelect={run(() => col.group != null && onMove?.(null))}
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
                    onSelect={run(() => col.group !== f.key && onMove?.(f.key))}
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
