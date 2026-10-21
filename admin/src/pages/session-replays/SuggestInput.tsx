/**
 * A free-text input with a suggestion list (the Combobox pattern for values
 * that may also be typed by hand) — replaces a native <datalist>, which
 * renders differently per browser and ignores the theme.
 */
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { useId, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const MAX = 8

export function SuggestInput({
  id,
  value,
  onChange,
  suggestions,
  placeholder,
  className
}: {
  id: string
  value: string
  onChange: (v: string) => void
  suggestions: string[]
  placeholder?: string
  className?: string
}) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const shown = useMemo(() => {
    const q = value.trim().toLowerCase()
    return suggestions.filter((s) => s.toLowerCase().includes(q) && s !== value).slice(0, MAX)
  }, [suggestions, value])
  const visible = open && shown.length > 0
  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
  }
  return (
    <PopoverPrimitive.Root open={visible}>
      <PopoverPrimitive.Anchor asChild>
        <Input
          id={id}
          value={value}
          placeholder={placeholder}
          autoComplete='off'
          role='combobox'
          aria-expanded={visible}
          aria-controls={listId}
          aria-autocomplete='list'
          aria-activedescendant={visible ? `${listId}-${active}` : undefined}
          className={className}
          onChange={(e) => {
            onChange(e.target.value)
            setActive(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (!visible) {
              if (e.key === 'ArrowDown') setOpen(true)
              return
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => (a + 1) % shown.length)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => (a - 1 + shown.length) % shown.length)
            } else if (e.key === 'Enter' && shown[active]) {
              e.preventDefault()
              pick(shown[active])
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align='start'
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className='z-50 w-[var(--radix-popover-trigger-width)] min-w-[11rem] rounded-md border border-slate-200 bg-popover p-1 text-popover-foreground shadow-md dark:border-border'
        >
          <div id={listId} role='listbox'>
            {shown.map((s, i) => (
              <div
                key={s}
                id={`${listId}-${i}`}
                role='option'
                tabIndex={-1}
                aria-selected={i === active}
                // mousedown, not click: the input's blur would close the list first.
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(s)
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'cursor-pointer truncate rounded px-2 py-1 font-mono text-[12px]',
                  i === active && 'bg-accent'
                )}
              >
                {s}
              </div>
            ))}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
