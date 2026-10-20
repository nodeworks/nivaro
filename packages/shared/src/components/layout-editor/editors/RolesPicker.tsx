import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Chip, inputCls, quietText } from '../settings/controls'

/**
 * Roles a layout is for, by name (never ids). Empty = everyone. A role id the
 * roles list no longer knows shows as "Unknown role" so it can still be removed.
 */
export function RolesPicker({
  value,
  roles,
  onChange
}: {
  value: string[]
  roles: Array<{ id: string; name: string }>
  onChange: (roleIds: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const nameOf = (id: string) => roles.find((r) => r.id === id)?.name ?? 'Unknown role'
  const q = query.trim().toLowerCase()
  const available = roles
    .filter((r) => !value.includes(r.id))
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
  return (
    <div className='space-y-1.5' data-roles-picker>
      <div className='flex flex-wrap items-center gap-1.5'>
        {value.length === 0 ? (
          <span className={quietText}>Everyone</span>
        ) : (
          value.map((id) => (
            <Chip
              key={id}
              label={nameOf(id)}
              onRemove={() => onChange(value.filter((x) => x !== id))}
            />
          ))
        )}
        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o)
            if (!o) setQuery('')
          }}
        >
          <PopoverTrigger asChild>
            <button
              type='button'
              className='inline-flex items-center gap-1 rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-[12px] text-slate-600 hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:text-muted-foreground dark:hover:text-nvr-cyan'
            >
              <Plus className='h-3 w-3' />
              Add role
            </button>
          </PopoverTrigger>
          <PopoverContent className='w-56 p-1.5' align='start'>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search roles…'
              aria-label='Search roles'
              className={`${inputCls} mb-1 h-7 text-[12px]`}
            />
            <div className='max-h-56 overflow-y-auto' role='listbox' aria-label='Roles'>
              {available.length === 0 ? (
                <p className='px-2 py-1.5 text-[12px] text-slate-400'>No more roles</p>
              ) : (
                available.map((r) => (
                  <button
                    key={r.id}
                    type='button'
                    role='option'
                    aria-selected={false}
                    data-option={r.id}
                    onClick={() => {
                      onChange([...value, r.id])
                      setOpen(false)
                      setQuery('')
                    }}
                    className='flex w-full rounded px-2 py-1 text-left text-[12px] text-slate-700 hover:bg-muted dark:text-foreground'
                  >
                    {r.name}
                  </button>
                ))
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
