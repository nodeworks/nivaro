import { useMemo, useState } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'

/** Something wants to leave the layout while it has unsaved changes. */
export interface LeaveRequest {
  /** What the admin asked for, as a phrase after "before you": "leave", "open another layout". */
  what: string
  /** The control that asked (back button, rail row, link) — the confirm sits beside it. */
  anchor: HTMLElement | null
  /** Carry on with the leave. */
  go: () => void
}

export const unsavedText = (n: number) => `${n} unsaved ${n === 1 ? 'change' : 'changes'}`

/**
 * The anchored Save / Discard / Keep editing confirm (#2619). Save leaves only
 * once everything landed; a refused or stale Save keeps the admin here with
 * the top bar saying why.
 */
export function UnsavedConfirm({
  request,
  count,
  onSave,
  onDiscard,
  onKeep
}: {
  request: LeaveRequest | null
  count: number
  /** Resolves true when every change was saved. */
  onSave: () => Promise<boolean>
  onDiscard: () => void
  onKeep: () => void
}) {
  const [saving, setSaving] = useState(false)
  const anchorRef = useMemo(
    () => ({ current: request?.anchor ?? document.body }) as { current: HTMLElement },
    [request]
  )
  if (!request) return null
  const save = async () => {
    setSaving(true)
    try {
      if (await onSave()) request.go()
      else onKeep()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open && !saving) onKeep()
      }}
    >
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        align='start'
        className='w-[300px] p-3'
        data-unsaved-confirm=''
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement | null)
            ?.querySelector<HTMLElement>('[data-unsaved-action="save"]')
            ?.focus()
        }}
      >
        <p className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          {unsavedText(count)}
        </p>
        <p className='mt-1 text-[12px] leading-snug text-slate-600 dark:text-muted-foreground'>
          Save them before you {request.what}? Discarded changes cannot be brought back.
        </p>
        <div className='mt-3 flex items-center justify-end gap-1.5'>
          <button
            type='button'
            data-unsaved-action='keep'
            onClick={onKeep}
            disabled={saving}
            className='inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 disabled:pointer-events-none disabled:opacity-40 dark:text-muted-foreground dark:hover:text-foreground'
          >
            Keep editing
          </button>
          <button
            type='button'
            data-unsaved-action='discard'
            onClick={() => {
              onDiscard()
              request.go()
            }}
            disabled={saving}
            className='inline-flex h-7 items-center rounded-md border border-slate-200 px-2.5 text-[12px] font-medium text-red-700 transition-colors hover:bg-red-50 disabled:pointer-events-none disabled:opacity-40 dark:border-border dark:text-red-300 dark:hover:bg-red-500/10'
          >
            Discard
          </button>
          <button
            type='button'
            data-unsaved-action='save'
            onClick={() => void save()}
            disabled={saving}
            className='inline-flex h-7 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-60'
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
