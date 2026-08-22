import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Find in record (#82): search this form's fields by label or current value
 * and jump to the match — long multi-tab forms make "where is the vendor
 * field" a real question. Jumping uses the same scroll+flash the integrity
 * banner uses; a field on another tab that isn't mounted can't be flashed, so
 * the row says which section it lives in.
 */
export interface FindableField {
  field: string
  label: string
  group?: string | null
  value: string
}

export function FindInRecordButton({
  fields,
  onJump
}: {
  fields: FindableField[]
  onJump: (field: string) => boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [miss, setMiss] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (needle.length < 2) return []
    return fields
      .filter(
        (f) =>
          f.label.toLowerCase().includes(needle) ||
          f.field.toLowerCase().includes(needle) ||
          f.value.toLowerCase().includes(needle)
      )
      .slice(0, 12)
  }, [fields, q])

  return (
    <div ref={rootRef} className='relative'>
      <button
        type='button'
        title='Find a field in this record'
        onClick={() => {
          setOpen((o) => !o)
          setMiss(null)
          setQ('')
        }}
        className='inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground'
      >
        <Search className='h-3.5 w-3.5' />
      </button>
      {open && (
        <div className='absolute right-0 top-full z-[110] mt-1 w-[320px] rounded-lg border border-slate-200 bg-white p-2 shadow-xl dark:border-border dark:bg-card'>
          <input
            // biome-ignore lint/a11y/noAutofocus: the popover only exists after an explicit click
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setMiss(null)
            }}
            placeholder='Field name or value…'
            className='h-8 w-full rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] outline-none focus:border-nvr-cyan dark:border-border'
          />
          {miss && (
            <p className='mt-1.5 px-1 text-[11.5px] text-amber-600 dark:text-amber-400'>{miss}</p>
          )}
          <div className='mt-1.5 max-h-[280px] overflow-y-auto'>
            {q.trim().length >= 2 && matches.length === 0 && (
              <p className='px-1 py-2 text-[12px] text-slate-400'>No matching fields.</p>
            )}
            {matches.map((f) => (
              <button
                key={f.field}
                type='button'
                onClick={() => {
                  const jumped = onJump(f.field)
                  if (jumped) {
                    setOpen(false)
                  } else {
                    setMiss(
                      f.group
                        ? `"${f.label}" is on the ${f.group} section — open it first, then search again.`
                        : `"${f.label}" is not visible right now (another tab or hidden by a rule).`
                    )
                  }
                }}
                className='block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted'
              >
                <span className='block text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
                  {f.label}
                  {f.group && (
                    <span className='ml-1.5 text-[10.5px] font-normal text-slate-400'>
                      {f.group}
                    </span>
                  )}
                </span>
                {f.value && (
                  <span className='block truncate text-[11px] text-slate-400'>{f.value}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
