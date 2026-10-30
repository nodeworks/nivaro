import { useQuery } from '@tanstack/react-query'
import { Check, Loader2, Pencil } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, patch } from '../../lib/commands'
import {
  type InlineEditorKind,
  inlineInputValue,
  inlineValueUnchanged,
  parseInlineInput
} from '../../lib/list-inline-edit'
import { userErrorMessage } from '../../lib/safe-error'
import { choiceLabel, cn } from '../../lib/utils'
import { RelationCombobox } from '../item-edit/RelationCombobox'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'

/**
 * #3224 — Edit in the list. One cell at a time: click (or Enter / F2 on a
 * focused cell) opens the editor, Enter or Tab commits, Escape cancels.
 *
 * The commit is the record form's own write — `PATCH /items/:collection/:id`
 * through the items service — so every server rule judges it (field update
 * rights, User Scopes, row filters, validation, edit locks, hooks, activity,
 * revisions). A refusal rolls the optimistic value back and stays on the cell
 * in the server's own words.
 */

export interface InlineCommit {
  /** Unique per list cell (`<row>|<column>`). */
  cellKey: string
  collection: string
  id: string | number
  field: string
  kind: InlineEditorKind
  before: unknown
  /** The parsed value to store. */
  value: unknown
  /** Put the value on screen now; returns the undo. */
  optimistic?: () => () => void
  /** After the server accepted it (refresh the list, etc.). */
  onSaved?: (row: Record<string, unknown> | null) => void
  /** The cell to open next (Tab / Shift+Tab), or null to stop editing. */
  next?: string | null
}

export interface InlineEditController {
  editing: string | null
  start: (cellKey: string) => void
  cancel: () => void
  commit: (c: InlineCommit) => void
  errorOf: (cellKey: string) => string | null
  savingOf: (cellKey: string) => boolean
  savedOf: (cellKey: string) => boolean
  clearError: (cellKey: string) => void
}

/** Edit state for one list: which cell is open, which are saving, refusals by cell. */
export function useInlineEdit(): InlineEditController {
  const client = useNivaroClient()
  const [editing, setEditing] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, true>>({})
  const [saved, setSaved] = useState<Record<string, true>>({})
  const savedTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  useEffect(
    () => () => {
      for (const t of Object.values(savedTimers.current)) clearTimeout(t)
    },
    []
  )
  const clearError = useCallback((cellKey: string) => {
    setErrors((prev) => {
      if (!(cellKey in prev)) return prev
      const next = { ...prev }
      delete next[cellKey]
      return next
    })
  }, [])
  const start = useCallback(
    (cellKey: string) => {
      clearError(cellKey)
      setEditing(cellKey)
    },
    [clearError]
  )
  const cancel = useCallback(() => setEditing(null), [])
  const commit = useCallback(
    (c: InlineCommit) => {
      setEditing(c.next ?? null)
      if (inlineValueUnchanged(c.kind, c.before, c.value)) return
      const undo = c.optimistic?.() ?? (() => {})
      setSaving((prev) => ({ ...prev, [c.cellKey]: true }))
      clearError(c.cellKey)
      client
        .request<{ data: Record<string, unknown> | null }>(
          patch(`/items/${encodeURIComponent(c.collection)}/${encodeURIComponent(String(c.id))}`, {
            [c.field]: c.value
          })
        )
        .then((res) => {
          c.onSaved?.(res?.data ?? null)
          setSaved((prev) => ({ ...prev, [c.cellKey]: true }))
          clearTimeout(savedTimers.current[c.cellKey])
          savedTimers.current[c.cellKey] = setTimeout(() => {
            setSaved((prev) => {
              const next = { ...prev }
              delete next[c.cellKey]
              return next
            })
          }, 1500)
        })
        .catch((err: unknown) => {
          undo()
          setErrors((prev) => ({
            ...prev,
            [c.cellKey]: userErrorMessage(err, 'This change was not saved')
          }))
        })
        .finally(() => {
          setSaving((prev) => {
            const next = { ...prev }
            delete next[c.cellKey]
            return next
          })
        })
    },
    [client, clearError]
  )
  return {
    editing,
    start,
    cancel,
    commit,
    errorOf: (k) => errors[k] ?? null,
    savingOf: (k) => !!saving[k],
    savedOf: (k) => !!saved[k],
    clearError
  }
}

/** The target collection's picker curation (`picker_filter`), for M2O cell pickers. */
function usePickerFilter(target: string | null): Record<string, unknown> | undefined {
  const client = useNivaroClient()
  // Same key + cached shape as the collection browser's own metadata read.
  const { data } = useQuery({
    queryKey: ['cbv-collection-meta', target],
    queryFn: () =>
      client
        .request<{ data: { picker_filter?: unknown } }>(get(`/collections/${target}`))
        .then((r) => r.data),
    enabled: !!target,
    staleTime: 10 * 60_000,
    retry: false
  })
  const raw = (data as { picker_filter?: unknown } | undefined)?.picker_filter
  if (!raw) return undefined
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>
    } catch {
      /* stale config — no curation */
    }
  }
  return undefined
}

const INPUT_CLS =
  'h-7 w-full min-w-[120px] rounded border border-nvr-cyan bg-white px-1.5 text-[12px] text-slate-800 shadow-sm outline-none ring-2 ring-nvr-cyan/30 dark:bg-slate-900 dark:text-slate-100'

function TextLikeEditor({
  kind,
  value,
  label,
  onCommit,
  onCancel
}: {
  kind: InlineEditorKind
  value: unknown
  label: string
  onCommit: (value: unknown, dir: 0 | 1 | -1) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(() => inlineInputValue(kind, value))
  const [error, setError] = useState<string | null>(null)
  const doneRef = useRef(false)
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
    try {
      ref.current?.select?.()
    } catch {
      /* date inputs have no text selection */
    }
  }, [])
  const finish = (dir: 0 | 1 | -1) => {
    if (doneRef.current) return
    const parsed = parseInlineInput(kind, text)
    if (!parsed.ok) {
      setError(parsed.error)
      ref.current?.focus()
      return
    }
    doneRef.current = true
    onCommit(parsed.value, dir)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      doneRef.current = true
      onCancel()
    } else if (e.key === 'Enter' && !(kind === 'longtext' && e.shiftKey)) {
      e.preventDefault()
      finish(0)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      finish(e.shiftKey ? -1 : 1)
    }
  }
  const common = {
    'aria-label': `Edit ${label}`,
    'aria-invalid': error ? true : undefined,
    value: text,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => {
      setText(e.target.value)
      if (error) setError(null)
    },
    onKeyDown,
    // Clicking away keeps what was typed (a spreadsheet's habit); a value that
    // does not parse is dropped (Enter / Tab say why instead).
    onBlur: () => {
      if (doneRef.current) return
      if (!parseInlineInput(kind, text).ok) {
        doneRef.current = true
        onCancel()
        return
      }
      finish(0)
    },
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation()
  }
  return (
    <span className='block min-w-0' data-inline-editor={kind}>
      {kind === 'longtext' ? (
        <textarea
          ref={ref}
          rows={2}
          {...common}
          className={cn(INPUT_CLS, 'h-auto min-h-[28px] resize-y py-1')}
        />
      ) : (
        <input
          ref={ref}
          type={kind === 'date' ? 'date' : kind === 'datetime' ? 'datetime-local' : 'text'}
          inputMode={kind === 'integer' ? 'numeric' : kind === 'number' ? 'decimal' : undefined}
          {...common}
          className={cn(
            INPUT_CLS,
            (kind === 'integer' || kind === 'number') && 'text-right tabular-nums'
          )}
        />
      )}
      {error && (
        <span className='mt-0.5 block text-[10.5px] font-medium text-red-600 dark:text-red-400'>
          {error}
        </span>
      )}
    </span>
  )
}

function ChoiceEditor({
  value,
  options,
  label,
  onCommit,
  onCancel
}: {
  value: unknown
  options: Array<{ value: string; label: string }>
  label: string
  onCommit: (value: unknown, dir: 0 | 1 | -1) => void
  onCancel: () => void
}) {
  const doneRef = useRef(false)
  const current = value == null ? '' : String(value)
  const pick = (v: string, dir: 0 | 1 | -1 = 0) => {
    if (doneRef.current) return
    doneRef.current = true
    onCommit(v === '' ? null : v, dir)
  }
  return (
    <Popover
      open
      onOpenChange={(o) => {
        if (!o && !doneRef.current) {
          doneRef.current = true
          onCancel()
        }
      }}
    >
      <PopoverAnchor asChild>
        <span className='block h-7 min-w-[120px] rounded border border-nvr-cyan bg-white px-1.5 py-1 text-[12px] text-slate-700 ring-2 ring-nvr-cyan/30 dark:bg-slate-900 dark:text-slate-200'>
          {options.find((o) => o.value === current)?.label ?? (current || '—')}
        </span>
      </PopoverAnchor>
      <PopoverContent
        align='start'
        className='w-[240px] p-0'
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Tab') {
            e.preventDefault()
            pick(current, e.shiftKey ? -1 : 1)
          }
        }}
      >
        <Command>
          <CommandInput placeholder={`Set ${label}…`} className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No matches
            </CommandEmpty>
            <CommandItem
              value='__clear__ —'
              onSelect={() => pick('')}
              className='text-[12px] text-slate-500 dark:text-slate-400'
            >
              <span className='mr-2 inline-block w-3' />— Clear —
            </CommandItem>
            {options.map((o) => (
              <CommandItem
                key={o.value}
                value={`${o.label} ${o.value}`}
                onSelect={() => pick(o.value)}
                className='text-[12px]'
              >
                <Check
                  className={cn('mr-2 h-3 w-3', o.value === current ? 'opacity-100' : 'opacity-0')}
                />
                {o.label}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function M2oEditor({
  target,
  value,
  onCommit,
  onCancel
}: {
  target: string
  value: unknown
  onCommit: (value: unknown, dir: 0 | 1 | -1) => void
  onCancel: () => void
}) {
  const pickerFilter = usePickerFilter(target)
  const doneRef = useRef(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || doneRef.current) return
      doneRef.current = true
      onCancel()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stops the row's open-on-click
    <span
      className='block min-w-[180px]'
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      data-inline-editor='m2o'
    >
      <RelationCombobox
        collection={target}
        value={value}
        defaultOpen
        // Picker curation + per-record exclusions: the picker asks with
        // `picker=1` itself, and the target's picker_filter narrows it here.
        extraFilter={pickerFilter}
        onChange={(v) => {
          if (doneRef.current) return
          doneRef.current = true
          onCommit(v ?? null, 0)
        }}
        onClose={() => {
          if (doneRef.current) return
          doneRef.current = true
          onCancel()
        }}
      />
    </span>
  )
}

/**
 * One list cell that may be edited in place. Renders `children` (the cell's
 * normal display) until it opens, then the editor for its kind.
 */
export function InlineEditCell({
  controller,
  cellKey,
  kind,
  value,
  label,
  choices,
  target,
  onCommit,
  children
}: {
  controller: InlineEditController
  cellKey: string
  kind: InlineEditorKind
  /** The stored value (an M2O id, not its label). */
  value: unknown
  /** Column label, for the editor's accessible name. */
  label: string
  /** Choice fields: the options. Booleans get Yes / No. */
  choices?: Array<{ value: string; label: string }>
  /** M2O fields: the collection the picker reads. */
  target?: string | null
  onCommit: (value: unknown, dir: 0 | 1 | -1) => void
  children: React.ReactNode
}) {
  const open = controller.editing === cellKey
  const error = controller.errorOf(cellKey)
  const isSaving = controller.savingOf(cellKey)
  const isSaved = controller.savedOf(cellKey)
  if (open) {
    const cancel = controller.cancel
    if (kind === 'm2o' && target)
      return <M2oEditor target={target} value={value} onCommit={onCommit} onCancel={cancel} />
    if (kind === 'choice' || kind === 'boolean') {
      const opts =
        kind === 'boolean'
          ? [
              { value: 'true', label: 'Yes' },
              { value: 'false', label: 'No' }
            ]
          : (choices ?? []).map((c) => ({ value: c.value, label: choiceLabel(c.label) }))
      const current =
        kind === 'boolean' && value != null
          ? value === true || value === 1 || value === '1' || value === 'true'
            ? 'true'
            : 'false'
          : value
      return (
        <ChoiceEditor
          value={current}
          options={opts}
          label={label}
          onCommit={(v, dir) =>
            onCommit(kind === 'boolean' ? (v == null ? null : v === 'true') : v, dir)
          }
          onCancel={cancel}
        />
      )
    }
    return (
      <TextLikeEditor
        kind={kind}
        value={value}
        label={label}
        onCommit={onCommit}
        onCancel={cancel}
      />
    )
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: wraps arbitrary cell content (links, chips)
    <span
      role='button'
      tabIndex={0}
      data-inline-editable={kind}
      data-inline-error={error ? '' : undefined}
      aria-label={`${label}: edit`}
      onClick={(e) => {
        e.stopPropagation()
        controller.start(cellKey)
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault()
          e.stopPropagation()
          controller.start(cellKey)
        }
      }}
      className={cn(
        'group/ie -mx-1 flex min-h-[22px] min-w-[48px] cursor-text items-center gap-1 rounded px-1 outline-none transition-colors hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-white/[0.06]',
        error && 'ring-1 ring-red-400 dark:ring-red-500/70',
        isSaving && 'opacity-60'
      )}
    >
      <span className='min-w-0 flex-1 truncate'>{children}</span>
      {isSaving ? (
        <Loader2 className='h-3 w-3 shrink-0 animate-spin text-slate-400' />
      ) : isSaved ? (
        <Check className='h-3 w-3 shrink-0 text-emerald-500 dark:text-emerald-400' />
      ) : (
        <Pencil className='invisible h-3 w-3 shrink-0 text-slate-400 group-hover/ie:visible group-focus-visible/ie:visible dark:text-slate-500' />
      )}
      {error && (
        <span
          className='ml-1 max-w-[220px] shrink-0 truncate text-[10.5px] font-medium text-red-600 dark:text-red-400'
          data-tip={error}
          data-inline-refusal=''
        >
          {error}
        </span>
      )}
    </span>
  )
}
