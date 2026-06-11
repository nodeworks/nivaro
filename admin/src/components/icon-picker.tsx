import * as Icons from 'lucide-react'
import { ChevronDown, Search, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

// Curated set of icons useful in a CMS context
const ICON_NAMES = [
  'Activity', 'AlignLeft', 'Archive', 'ArrowRight', 'AtSign',
  'Award', 'BarChart', 'BarChart2', 'Bell', 'Bookmark',
  'Book', 'BookOpen', 'Box', 'Briefcase', 'Building',
  'Building2', 'Calendar', 'Camera', 'Check', 'CheckCircle',
  'ChevronRight', 'Circle', 'Clipboard', 'Clock', 'Cloud',
  'Code', 'Code2', 'Cpu', 'CreditCard', 'Database',
  'DollarSign', 'Download', 'Edit', 'Edit2', 'ExternalLink',
  'Eye', 'EyeOff', 'File', 'FileText', 'Files',
  'Film', 'Filter', 'Flag', 'Flame', 'Folder',
  'FolderOpen', 'Globe', 'GraduationCap', 'Grid', 'Hammer',
  'Heart', 'HelpCircle', 'History', 'Home', 'Image',
  'Inbox', 'Info', 'Key', 'Laptop', 'Layers',
  'Layout', 'LayoutDashboard', 'Link', 'List', 'Lock',
  'LogIn', 'Mail', 'Map', 'MapPin', 'Maximize',
  'MessageCircle', 'MessageSquare', 'Mic', 'Minimize', 'Monitor',
  'Moon', 'Music', 'Navigation', 'Network', 'Package',
  'Paperclip', 'Pencil', 'Phone', 'PieChart', 'Pin',
  'Plus', 'Printer', 'RefreshCw', 'RotateCcw', 'Save',
  'Search', 'Send', 'Settings', 'Settings2', 'Share2',
  'Shield', 'ShoppingBag', 'ShoppingCart', 'Sliders', 'SlidersHorizontal',
  'Smartphone', 'Star', 'Sun', 'Table', 'Tag',
  'Tags', 'Target', 'Terminal', 'Timer', 'Trash2',
  'TrendingUp', 'Trophy', 'Truck', 'Unlock', 'Upload',
  'User', 'UserCheck', 'UserCircle', 'UserPlus', 'Users',
  'Video', 'Wallet', 'Wifi', 'Workflow', 'Wrench',
  'X', 'Zap', 'ZoomIn', 'GitBranch', 'GitMerge',
]

function toPascal(name: string) {
  return name
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('')
}

function toDash(pascal: string) {
  return pascal.replace(/([A-Z])/g, (m, l, i) => (i > 0 ? `-${l.toLowerCase()}` : l.toLowerCase()))
}

function getIcon(name: string): React.ElementType | null {
  return (Icons as Record<string, unknown>)[name] as React.ElementType | null
}

export function IconPicker({
  value,
  onChange,
  className,
  trigger,
}: {
  value: string
  onChange: (v: string) => void
  className?: string
  trigger?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const pascal = value ? toPascal(value) : null
  const SelectedIcon = pascal ? getIcon(pascal) : null

  const filtered = ICON_NAMES.filter((name) => {
    const q = search.toLowerCase()
    return name.toLowerCase().includes(q) || toDash(name).includes(q)
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button
            type='button'
            variant='outline'
            className={cn('w-full justify-between text-[13px] font-normal', className)}
          >
            <span className='flex items-center gap-2 truncate'>
              {SelectedIcon ? (
                <SelectedIcon className='h-4 w-4 shrink-0 text-slate-600 dark:text-slate-400' />
              ) : (
                <span className='h-4 w-4 shrink-0' />
              )}
              {value ? (
                <span className='truncate text-slate-700 dark:text-slate-200'>{value}</span>
              ) : (
                <span className='text-slate-400'>Select an icon…</span>
              )}
            </span>
            <ChevronDown className='ml-2 h-3.5 w-3.5 shrink-0 text-slate-400' />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className='w-[300px] p-3' align='start'>
        {/* Search */}
        <div className='mb-2.5 flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 dark:border-slate-700 dark:bg-slate-900'>
          <Search className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          <input
            autoFocus
            className='min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-slate-400'
            placeholder='Search icons…'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button type='button' onClick={() => setSearch('')}>
              <X className='h-3 w-3 text-slate-400 hover:text-slate-600' />
            </button>
          )}
        </div>

        {/* Grid */}
        <div className='grid max-h-[220px] grid-cols-8 gap-0.5 overflow-y-auto'>
          {filtered.map((name) => {
            const IC = getIcon(name)
            if (!IC) return null
            const dash = toDash(name)
            const selected = value === dash
            return (
              <button
                key={name}
                type='button'
                title={dash}
                onClick={() => {
                  onChange(selected ? '' : dash)
                  setOpen(false)
                  setSearch('')
                }}
                className={cn(
                  'flex items-center justify-center rounded p-1.5 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800',
                  selected &&
                    'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/20 dark:text-nvr-cyan',
                )}
              >
                <IC className='h-[15px] w-[15px]' />
              </button>
            )
          })}
          {filtered.length === 0 && (
            <p className='col-span-8 py-6 text-center text-[12px] text-slate-400'>
              No icons found
            </p>
          )}
        </div>

        {/* Clear */}
        {value && (
          <div className='mt-2 border-t border-slate-100 pt-2 dark:border-slate-800'>
            <button
              type='button'
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
              className='flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
            >
              <X className='h-3 w-3' />
              Clear icon
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
