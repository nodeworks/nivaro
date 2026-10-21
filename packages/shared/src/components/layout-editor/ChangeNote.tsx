import { type KeyboardEvent, useMemo, useState } from 'react'
import { cn } from '../../lib/utils'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { inputBase } from './panel-style'
import { unsavedText } from './UnsavedConfirm'
import type { SaveMeta } from './useLayoutDraft'

/**
 * Required change note (#2654). A layout's `change_note` setting makes every
 * Save ask for a short reason ('note'), or a reason and a ticket link
 * ('note_ticket'). The reason (and ticket) ride the History version's note;
 * the server refuses a save without them (400 CHANGE_NOTE_REQUIRED).
 */

export type ChangeNotePolicy = 'note' | 'note_ticket'

/** The stored setting as a policy; anything else is off. */
export function changeNotePolicyOf(layout: object | null | undefined): ChangeNotePolicy | null {
  const v = (layout as { change_note?: unknown } | null | undefined)?.change_note
  return v === 'note' || v === 'note_ticket' ? v : null
}

export interface ChangeNoteValue {
  reason: string
  ticket: string
}

/** Same rule as the server (services/layout-change-note.ts). */
export function changeNoteReady(policy: ChangeNotePolicy | null, v: ChangeNoteValue): boolean {
  if (!policy) return true
  if (v.reason.trim().length < 3) return false
  return policy !== 'note_ticket' || v.ticket.trim().length > 0
}

export function changeNoteMeta(v: ChangeNoteValue): SaveMeta {
  return { reason: v.reason.trim(), ticket: v.ticket.trim() || null }
}

/** The reason box (and ticket link) — in the Save popover and the leave confirm. */
export function ChangeNoteFields({
  policy,
  value,
  onChange,
  onSubmit
}: {
  policy: ChangeNotePolicy
  value: ChangeNoteValue
  onChange: (v: ChangeNoteValue) => void
  /** Enter in either box. */
  onSubmit?: () => void
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit?.()
    }
  }
  return (
    <div className='space-y-2' data-change-note-fields={policy}>
      <label className='block'>
        <span className='mb-1 block text-[12px] font-medium text-slate-700 dark:text-foreground'>
          Why this change?
        </span>
        <input
          // biome-ignore lint/a11y/noAutofocus: the popover opens to ask exactly this
          autoFocus
          value={value.reason}
          maxLength={200}
          onChange={(e) => onChange({ ...value, reason: e.target.value })}
          onKeyDown={onKeyDown}
          placeholder='A short reason, kept with this version'
          data-change-note-reason=''
          className={cn(inputBase, 'h-8 w-full')}
        />
      </label>
      <label className='block'>
        <span className='mb-1 block text-[12px] font-medium text-slate-700 dark:text-foreground'>
          Ticket link{policy === 'note_ticket' ? '' : ' (optional)'}
        </span>
        <input
          value={value.ticket}
          maxLength={300}
          onChange={(e) => onChange({ ...value, ticket: e.target.value })}
          onKeyDown={onKeyDown}
          placeholder='https://… or OPS-123'
          data-change-note-ticket=''
          className={cn(inputBase, 'h-8 w-full')}
        />
      </label>
    </div>
  )
}

/**
 * Save with a change note: anchored beside the Save button (or whatever asked),
 * resolves `onDone(true)` once everything landed.
 */
export function ChangeNoteSave({
  open,
  anchor,
  policy,
  count,
  value,
  onChange,
  onSave,
  onClose,
  intro
}: {
  open: boolean
  anchor: HTMLElement | null
  policy: ChangeNotePolicy
  /** Replaces the line under the title (the edit freeze explains itself, #2717). */
  intro?: string
  count: number
  /** Kept by the editor: the leave confirm asks with the same boxes. */
  value: ChangeNoteValue
  onChange: (v: ChangeNoteValue) => void
  /** Resolves true when every change was saved. */
  onSave: () => Promise<boolean>
  onClose: () => void
}) {
  const [saving, setSaving] = useState(false)
  const anchorRef = useMemo(
    () => ({ current: anchor ?? document.body }) as { current: HTMLElement },
    [anchor]
  )
  if (!open) return null
  const ready = changeNoteReady(policy, value)
  const submit = async () => {
    if (!ready || saving) return
    setSaving(true)
    try {
      if (await onSave()) onClose()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Popover
      open
      onOpenChange={(o) => {
        if (!o && !saving) onClose()
      }}
    >
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent align='end' className='w-[320px] p-3' data-change-note-save=''>
        <p className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          Save {unsavedText(count)}
        </p>
        <p className='mb-2 mt-0.5 text-[12px] leading-snug text-slate-600 dark:text-muted-foreground'>
          {intro ?? 'This layout keeps a reason with every save. It shows in History.'}
        </p>
        <ChangeNoteFields
          policy={policy}
          value={value}
          onChange={onChange}
          onSubmit={() => void submit()}
        />
        <div className='mt-3 flex items-center justify-end gap-1.5'>
          <button
            type='button'
            onClick={onClose}
            disabled={saving}
            className='inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 disabled:pointer-events-none disabled:opacity-40 dark:text-muted-foreground dark:hover:text-foreground'
          >
            Cancel
          </button>
          <button
            type='button'
            data-change-note-submit=''
            onClick={() => void submit()}
            disabled={!ready || saving}
            className='inline-flex h-7 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40'
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
