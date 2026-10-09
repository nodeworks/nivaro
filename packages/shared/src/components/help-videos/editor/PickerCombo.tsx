import { Plus, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-1 focus-visible:ring-offset-background'

/** Adds one choice from a searchable list. The list portals into the hosting dialog. */
export function PickerCombo({
  options,
  onPick,
  placeholder,
  ariaLabel,
  emptyText = 'Nothing matches.'
}: {
  options: Array<{ value: string; label: string; hint?: string }>
  onPick: (value: string) => void
  placeholder: string
  ariaLabel: string
  /** What the list says when it has no rows ("Loading…", or why it could not load). */
  emptyText?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={ariaLabel}
          className={`inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-input px-2 text-[12px] text-foreground transition-colors duration-150 hover:bg-muted motion-reduce:transition-none ${focusRing}`}
        >
          <Plus className='h-3.5 w-3.5' aria-hidden /> {placeholder}
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[280px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {options.map((o) => (
              <CommandItem
                key={o.value}
                value={`${o.label} ${o.value}`}
                onSelect={() => {
                  onPick(o.value)
                  setOpen(false)
                }}
              >
                <span className='truncate'>{o.label}</span>
                {o.hint && (
                  <span className='ml-auto text-[11px] text-muted-foreground'>{o.hint}</span>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** A chosen item with a remove button. */
export function RemovableChip({
  children,
  removeLabel,
  onRemove,
  ...rest
}: {
  children: ReactNode
  removeLabel: string
  onRemove: () => void
} & Record<`data-${string}`, string | undefined>) {
  return (
    <span
      className='inline-flex h-7 items-center gap-1 rounded-full border border-border bg-muted/40 pl-2.5 pr-0.5 text-[12px] text-foreground'
      {...rest}
    >
      {children}
      <button
        type='button'
        aria-label={removeLabel}
        onClick={onRemove}
        className={`grid h-6 w-6 place-content-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground motion-reduce:transition-none ${focusRing}`}
      >
        <X className='h-3 w-3' aria-hidden />
      </button>
    </span>
  )
}

/** The chosen roles of a list, plus a picker for more. */
export function RoleChips({
  roles,
  selected,
  onChange,
  roleName,
  addLabel,
  emptyText
}: {
  roles: Array<{ id: string; name: string }>
  selected: string[]
  onChange: (ids: string[]) => void
  roleName: (id: string) => string
  /** Names the add button for a screen reader (two lists sit on one page). */
  addLabel: string
  emptyText?: string
}) {
  const up = selected.map((s) => s.toUpperCase())
  return (
    <div className='flex flex-wrap items-center gap-1.5'>
      {selected.map((id) => (
        <RemovableChip
          key={id}
          removeLabel={`Remove ${roleName(id)}`}
          onRemove={() => onChange(selected.filter((x) => x !== id))}
        >
          {roleName(id)}
        </RemovableChip>
      ))}
      <PickerCombo
        ariaLabel={addLabel}
        emptyText={emptyText}
        placeholder='Add a role'
        options={roles
          .filter((r) => !up.includes(r.id.toUpperCase()))
          .map((r) => ({ value: r.id, label: r.name }))}
        onPick={(v) => onChange([...selected, v])}
      />
    </div>
  )
}
