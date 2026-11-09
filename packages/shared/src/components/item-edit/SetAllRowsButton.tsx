import { PenLine } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/** options.set_all_rows on an O2M grid: one header button per entry that writes ONE value
 *  into that column on every line (or the ticked lines), or clears it when left blank —
 *  e.g. "Set REQ ID on all lines" (EFP v2's "apply req id to all lines"). Admin-only unless
 *  `admin_only: false`. Generic: any grid, any plain column. */
export interface GridSetAllConfig {
  field: string
  /** Button + dialog wording; default the column's label. */
  label?: string
  /** Default true: only administrators see the button. */
  admin_only?: boolean
}

/** Valid entries only (a field name, no dotted paths). Pure. */
export function normalizeSetAllRows(raw: unknown): GridSetAllConfig[] {
  if (!Array.isArray(raw)) return []
  const out: GridSetAllConfig[] = []
  for (const r of raw) {
    const e = typeof r === 'string' ? { field: r } : (r as Partial<GridSetAllConfig> | null)
    if (!e || typeof e.field !== 'string' || !e.field || e.field.includes('.')) continue
    out.push({
      field: e.field,
      ...(typeof e.label === 'string' && e.label.trim() ? { label: e.label.trim() } : {}),
      admin_only: e.admin_only !== false
    })
  }
  return out
}

export function SetAllRowsButton({
  label,
  count,
  scope,
  commonValue,
  disabled,
  onApply
}: {
  label: string
  /** Lines the value goes on. */
  count: number
  /** 'all' lines, or only the 'selected' ones. */
  scope: 'all' | 'selected'
  /** The value every target line already shares, if any (prefills the box). */
  commonValue: string | null
  disabled?: boolean
  onApply: (value: string | null) => Promise<void> | void
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const where = scope === 'selected' ? `${count} selected` : `all ${count}`
  const noun = count === 1 ? 'line' : 'lines'

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setValue(commonValue ?? '')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={disabled || count === 0}
          data-grid-set-all
          data-tip={`Put one ${label} on ${where} ${noun}, or clear it`}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded border px-2 transition-colors disabled:opacity-50',
            open
              ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan'
              : 'border-slate-200 text-slate-600 hover:border-slate-400 hover:text-slate-800 dark:border-border dark:text-slate-300'
          )}
        >
          <PenLine className='h-3 w-3' aria-hidden='true' />
          Set {label}…
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[300px] space-y-2 p-3'>
        <form
          className='space-y-2'
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            try {
              await onApply(value.trim() === '' ? null : value.trim())
              setOpen(false)
            } finally {
              setBusy(false)
            }
          }}
        >
          <label className='block text-[12px] font-medium text-slate-700 dark:text-foreground'>
            {label} for {where} {noun}
            <input
              // biome-ignore lint/a11y/noAutofocus: the popover exists to take this one value
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={`New ${label} — blank clears it`}
              className='mt-1 h-8 w-full rounded-md border border-slate-200 bg-background px-2 text-[12.5px] font-normal outline-none focus:border-nvr-cyan dark:border-border'
            />
          </label>
          <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {value.trim() === ''
              ? `Leaving it blank clears ${label} on ${where} ${noun}.`
              : `Every ${scope === 'selected' ? 'selected ' : ''}line gets “${value.trim()}”.`}{' '}
            The grid’s rules and save mode apply as if typed on each line.
          </p>
          <div className='flex justify-end gap-2'>
            <button
              type='button'
              onClick={() => setOpen(false)}
              className='h-7 px-2 text-[12px] text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
            >
              Cancel
            </button>
            <button
              type='submit'
              disabled={busy}
              className='h-7 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white disabled:opacity-50'
            >
              {busy ? 'Applying…' : value.trim() === '' ? `Clear on ${count}` : `Apply to ${count}`}
            </button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
