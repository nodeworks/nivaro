import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, Loader2, Pencil } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import {
  CELL_BEAT_MS,
  CELL_READ_COALESCE_MS,
  type CellCoords,
  type CellHolder,
  cellHolderKey,
  overwritesOthers,
  readCellHolders,
  releaseCell,
  takeCell
} from '../../lib/cell-locks'
import { get, patch } from '../../lib/commands'
import { cursorColor } from '../../lib/grid-cursors'
import {
  type InlineEditorKind,
  inlineInputValue,
  inlineValueUnchanged,
  parseInlineInput
} from '../../lib/list-inline-edit'
import { LIVE_ASPECTS, useLiveCollection } from '../../lib/live'
import { userErrorMessage } from '../../lib/safe-error'
import { choiceLabel, cn, formatDate } from '../../lib/utils'
import { RelationCombobox } from '../item-edit/RelationCombobox'
import { RelationLabel } from '../layout-editor/pickers/relation-label'
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
 *
 * Several people on one list (rt6 #15, lib/cell-locks.ts): a cell that knows its record
 * (`collection` + `itemId` + `field`) takes a soft lock while its editor is open — others see
 * who is editing it and cannot open it — and its save first re-reads the field as the viewer:
 * a value someone else changed since the editor opened asks inline, Keep mine / Take theirs.
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

/** A save held back because someone else changed the field since the editor opened. */
export interface InlineConflict {
  theirs: unknown
  mine: unknown
  by: string | null
  at: string | null
  commit: InlineCommit
}

export interface InlineEditController {
  editing: string | null
  /** Open a cell. With `coords` it takes the soft lock and remembers the value it opened on. */
  start: (cellKey: string, opts?: { coords?: CellCoords; value?: unknown }) => void
  /** A cell on screen: its holder is read and kept live. Returns the undo. */
  watchCell: (cellKey: string, coords: CellCoords) => () => void
  /** Someone else editing this cell now (never the viewer). */
  holderOf: (coords: CellCoords) => CellHolder | null
  /** The cell was taken by someone else just as the viewer opened it. */
  refusedOf: (cellKey: string) => string | null
  conflictOf: (cellKey: string) => InlineConflict | null
  resolveConflict: (cellKey: string, keep: 'mine' | 'theirs') => void
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
  const [conflicts, setConflicts] = useState<Record<string, InlineConflict>>({})
  const [refused, setRefused] = useState<Record<string, string>>({})
  const [holders, setHolders] = useState<Map<string, CellHolder>>(() => new Map())
  const [watchedCollections, setWatchedCollections] = useState<string[]>([])
  const savedTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  // ── Soft cell locks (rt6 #15) ──────────────────────────────────────────────
  /** Cells on screen, per collection: cellKey → coords. */
  const watched = useRef(new Map<string, Map<string, CellCoords>>())
  /** The value and time each open editor started from (the overwrite check's base). */
  const opened = useRef(new Map<string, { value: unknown; at: string }>())
  /** The cell whose lock this list holds. */
  const held = useRef<{ cellKey: string; coords: CellCoords } | null>(null)
  const readTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const timers = readTimers.current
    return () => {
      mounted.current = false
      for (const t of Object.values(savedTimers.current)) clearTimeout(t)
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      if (held.current) releaseCell(client, held.current.coords)
      held.current = null
    }
  }, [client])

  const readHolders = useCallback(
    (collection: string) => {
      if (readTimers.current.has(collection)) return
      readTimers.current.set(
        collection,
        setTimeout(() => {
          readTimers.current.delete(collection)
          const cells = [...(watched.current.get(collection)?.values() ?? [])]
          readCellHolders(client, collection, cells)
            .then((found) => {
              if (!mounted.current) return
              setHolders((prev) => {
                const next = new Map(prev)
                for (const k of next.keys()) if (k.startsWith(`${collection}\u0001`)) next.delete(k)
                for (const [k, h] of found) next.set(k, h)
                return next
              })
            })
            .catch(() => {})
        }, CELL_READ_COALESCE_MS)
      )
    },
    [client]
  )

  const watchCell = useCallback(
    (cellKey: string, coords: CellCoords) => {
      let m = watched.current.get(coords.collection)
      if (!m) {
        m = new Map()
        watched.current.set(coords.collection, m)
        const c = coords.collection
        setWatchedCollections((prev) => (prev.includes(c) ? prev : [...prev, c]))
      }
      m.set(cellKey, coords)
      readHolders(coords.collection)
      return () => {
        watched.current.get(coords.collection)?.delete(cellKey)
      }
    },
    [readHolders]
  )

  // Someone started or stopped editing a cell of a row on screen (`$cells`), or the row was
  // removed: re-read the holders of that collection's cells, coalesced.
  useLiveCollection(
    watchedCollections,
    (batch) => {
      const touched = new Set(batch.events.map((e) => String(e.collection)))
      for (const c of touched) readHolders(c)
    },
    {
      debounceMs: 300,
      match: (ev) => {
        const m = watched.current.get(String(ev.collection))
        if (!m || m.size === 0) return false
        const cellsNotice = !!ev.changed_fields?.includes(LIVE_ASPECTS.cells)
        if (!cellsNotice && ev.action !== 'delete') return false
        if (ev.item === '*') return true
        const id = String(ev.item).toUpperCase()
        for (const c of m.values()) if (String(c.id).toUpperCase() === id) return true
        return false
      }
    }
  )

  // Let go of a cell when its editor closes (commit, cancel, Tab to the next cell); keep
  // beating while it stays open.
  useEffect(() => {
    const h = held.current
    if (h && h.cellKey !== editing) {
      releaseCell(client, h.coords)
      held.current = null
    }
    if (!editing || !held.current) return
    const coords = held.current.coords
    const t = setInterval(() => void takeCell(client, coords, true), CELL_BEAT_MS)
    return () => clearInterval(t)
  }, [editing, client])

  const clearError = useCallback((cellKey: string) => {
    setErrors((prev) => {
      if (!(cellKey in prev)) return prev
      const next = { ...prev }
      delete next[cellKey]
      return next
    })
  }, [])
  const start = useCallback(
    (cellKey: string, opts?: { coords?: CellCoords; value?: unknown }) => {
      clearError(cellKey)
      setRefused((prev) => withoutKey(prev, cellKey))
      setConflicts((prev) => withoutKey(prev, cellKey))
      setEditing(cellKey)
      const coords = opts?.coords
      if (!coords) return
      opened.current.set(cellKey, { value: opts?.value, at: new Date().toISOString() })
      held.current = { cellKey, coords }
      // Open at once; if someone else took the cell a moment earlier, close it and say who.
      void takeCell(client, coords).then((r) => {
        if (r.ok || !mounted.current) return
        if (held.current?.cellKey === cellKey) held.current = null
        opened.current.delete(cellKey)
        setEditing((cur) => (cur === cellKey ? null : cur))
        setRefused((prev) => ({ ...prev, [cellKey]: r.holder.name }))
        readHolders(coords.collection)
      })
    },
    [clearError, client, readHolders]
  )
  const cancel = useCallback(() => setEditing(null), [])

  const send = useCallback(
    (c: InlineCommit) => {
      const undo = c.optimistic?.() ?? (() => {})
      setSaving((prev) => ({ ...prev, [c.cellKey]: true }))
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
            setSaved((prev) => withoutKey(prev, c.cellKey))
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
          setSaving((prev) => withoutKey(prev, c.cellKey))
        })
    },
    [client]
  )

  const commit = useCallback(
    (c: InlineCommit) => {
      setEditing(c.next ?? null)
      const base = opened.current.get(c.cellKey)
      opened.current.delete(c.cellKey)
      if (inlineValueUnchanged(c.kind, c.before, c.value)) return
      clearError(c.cellKey)
      if (!base) {
        send(c)
        return
      }
      // Overwrite check: the field as it is now, read as the viewer.
      setSaving((prev) => ({ ...prev, [c.cellKey]: true }))
      findConflict(client, c, base)
        .catch(() => null)
        .then((conflict) => {
          if (!mounted.current) return
          if (!conflict) {
            send(c)
            return
          }
          setSaving((prev) => withoutKey(prev, c.cellKey))
          setConflicts((prev) => ({ ...prev, [c.cellKey]: conflict }))
        })
    },
    [client, clearError, send]
  )

  const resolveConflict = useCallback(
    (cellKey: string, keep: 'mine' | 'theirs') => {
      const cf = conflicts[cellKey]
      if (!cf) return
      setConflicts((prev) => withoutKey(prev, cellKey))
      if (keep === 'mine') send(cf.commit)
      // Theirs: nothing to write — the list re-reads the row as it is now.
      else cf.commit.onSaved?.(null)
    },
    [conflicts, send]
  )

  return {
    editing,
    start,
    cancel,
    commit,
    watchCell,
    holderOf: (coords) => {
      const h = holders.get(cellHolderKey(coords.collection, coords.id, coords.field))
      return h && !h.mine ? h : null
    },
    refusedOf: (k) => refused[k] ?? null,
    conflictOf: (k) => conflicts[k] ?? null,
    resolveConflict,
    errorOf: (k) => errors[k] ?? null,
    savingOf: (k) => !!saving[k],
    savedOf: (k) => !!saved[k],
    clearError
  }
}

function withoutKey<T>(prev: Record<string, T>, k: string): Record<string, T> {
  if (!(k in prev)) return prev
  const next = { ...prev }
  delete next[k]
  return next
}

/**
 * Re-read the field as the viewer; a value someone else changed since the editor opened (and
 * not to what is being saved) is a conflict, with who and when from the activity log when it
 * names this field.
 */
async function findConflict(
  client: ReturnType<typeof useNivaroClient>,
  c: InlineCommit,
  base: { value: unknown; at: string }
): Promise<InlineConflict | null> {
  const path = `/items/${encodeURIComponent(c.collection)}/${encodeURIComponent(String(c.id))}`
  const res = await client.request<{ data: Record<string, unknown> | null }>(
    get(path, { fields: `id,${c.field}` })
  )
  const row = res?.data
  if (!row || !(c.field in row)) return null
  const theirs = row[c.field]
  if (!overwritesOthers(c.kind, base.value, theirs, c.value)) return null
  const change = await client
    .request<{
      data: { by?: string | null; at?: string; fields?: Array<{ field: string }> } | null
    }>(
      get('/picker-exclusions/linked-change', {
        collection: c.collection,
        item_id: String(c.id),
        since: base.at
      })
    )
    .then((r) => r?.data ?? null)
    .catch(() => null)
  const named = !!change?.fields?.some((f) => f.field === c.field)
  return {
    theirs,
    mine: c.value,
    by: named ? (change?.by ?? null) : null,
    at: named ? (change?.at ?? null) : null,
    commit: c
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

/** A value as the conflict line words it ("empty" for blank). */
function ConflictValue({
  kind,
  value,
  choices,
  target
}: {
  kind: InlineEditorKind
  value: unknown
  choices?: Array<{ value: string; label: string }>
  target?: string | null
}) {
  if (value == null || value === '') return <span className='italic'>empty</span>
  if (kind === 'm2o' && target) {
    const id = value && typeof value === 'object' ? (value as { id?: unknown }).id : value
    return <RelationLabel relatedCollection={target} id={id} />
  }
  let text: string
  if (kind === 'boolean') text = value === true || value === 1 || value === 'true' ? 'Yes' : 'No'
  else if (kind === 'choice')
    text = choiceLabel(choices?.find((c) => c.value === String(value))?.label ?? String(value))
  else if (kind === 'date') text = formatDate(String(value))
  else if (kind === 'datetime') {
    const d = new Date(String(value))
    text = Number.isNaN(d.getTime())
      ? String(value)
      : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } else text = String(value)
  return <span>“{text}”</span>
}

function clockTime(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** The inline question when a save would overwrite someone else's change. */
function ConflictBar({
  conflict,
  kind,
  choices,
  target,
  onKeep
}: {
  conflict: InlineConflict
  kind: InlineEditorKind
  choices?: Array<{ value: string; label: string }>
  target?: string | null
  onKeep: (keep: 'mine' | 'theirs') => void
}) {
  const when = clockTime(conflict.at)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stops the row's open-on-click
    // biome-ignore lint/a11y/useKeyWithClickEvents: the two buttons inside take the keys
    <span
      data-inline-conflict=''
      onClick={(e) => e.stopPropagation()}
      className='flex min-w-[240px] max-w-[560px] flex-wrap items-center gap-x-3 gap-y-1 whitespace-normal rounded-md bg-amber-50 px-2 py-1 text-[11.5px] leading-4 text-amber-900 ring-1 ring-inset ring-amber-200 dark:bg-amber-400/10 dark:text-amber-100 dark:ring-amber-400/25'
    >
      <span className='flex min-w-0 flex-1 basis-[240px] items-start gap-1.5'>
        <AlertTriangle
          aria-hidden='true'
          className='mt-0.5 h-3 w-3 shrink-0 text-amber-600 dark:text-amber-300'
        />
        <span className='min-w-0'>
          {conflict.by ?? 'Someone'} changed this to{' '}
          <span className='font-medium'>
            <ConflictValue kind={kind} value={conflict.theirs} choices={choices} target={target} />
          </span>
          {when ? ` at ${when}` : ' while you were editing'}
        </span>
      </span>
      <span className='ml-auto flex shrink-0 items-center gap-1'>
        <button
          type='button'
          onClick={() => onKeep('mine')}
          className='rounded px-1.5 py-0.5 font-medium text-amber-900 ring-1 ring-inset ring-amber-300 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-amber-50 dark:ring-amber-400/40 dark:hover:bg-amber-400/15'
        >
          Keep mine
        </button>
        <button
          type='button'
          onClick={() => onKeep('theirs')}
          className='rounded px-1.5 py-0.5 font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-amber-50 dark:hover:bg-amber-400/15'
        >
          Take theirs
        </button>
      </span>
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
  collection,
  itemId,
  field,
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
  /** The record and field this cell edits: with all three, the cell takes a soft lock while
   *  open, shows who else is editing it, and checks for others' changes before saving. */
  collection?: string
  itemId?: string | number | null
  field?: string
  onCommit: (value: unknown, dir: 0 | 1 | -1) => void
  children: React.ReactNode
}) {
  const open = controller.editing === cellKey
  const error = controller.errorOf(cellKey)
  const isSaving = controller.savingOf(cellKey)
  const isSaved = controller.savedOf(cellKey)
  const coords =
    collection && field && itemId != null && itemId !== ''
      ? { collection, id: itemId, field }
      : null
  const coordsKey = coords ? `${coords.collection}|${String(coords.id)}|${coords.field}` : ''
  const { watchCell } = controller
  // biome-ignore lint/correctness/useExhaustiveDependencies: coordsKey stands for coords
  useEffect(() => {
    if (!coords) return
    return watchCell(cellKey, coords)
  }, [watchCell, cellKey, coordsKey])
  const holder = coords && !open ? controller.holderOf(coords) : null
  const refusedBy = controller.refusedOf(cellKey)
  const conflict = controller.conflictOf(cellKey)
  const startEditing = () => controller.start(cellKey, coords ? { coords, value } : undefined)

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
  if (conflict) {
    return (
      <ConflictBar
        conflict={conflict}
        kind={kind}
        choices={choices}
        target={target}
        onKeep={(keep) => controller.resolveConflict(cellKey, keep)}
      />
    )
  }
  if (holder) {
    // Someone else is editing this cell: their colour and name, and it does not open.
    const color = cursorColor(holder.name)
    return (
      <span
        data-inline-held-by={holder.name}
        data-tip={`${holder.name} is editing this`}
        style={{ '--nvr-cursor': color } as React.CSSProperties}
        className='relative -mx-1 flex min-h-[22px] min-w-[48px] cursor-default items-center gap-1.5 rounded px-1 ring-1 ring-inset ring-[var(--nvr-cursor)]'
      >
        <span className='min-w-0 flex-1 truncate'>{children}</span>
        <span className='sr-only'>
          {label}: {holder.name} is editing this
        </span>
        <span
          aria-hidden='true'
          className='inline-flex max-w-[110px] shrink-0 items-center gap-1 text-[10.5px] font-medium leading-none text-slate-600 dark:text-slate-300'
        >
          <span className='h-1.5 w-1.5 shrink-0 rounded-full' style={{ backgroundColor: color }} />
          <span className='truncate'>{holder.name.split(/\s+/)[0]} editing</span>
        </span>
      </span>
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
        startEditing()
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault()
          e.stopPropagation()
          startEditing()
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
      {refusedBy && !error && (
        <span
          className='ml-1 max-w-[220px] shrink-0 truncate text-[10.5px] font-medium text-slate-500 dark:text-slate-400'
          data-inline-refused=''
          role='status'
        >
          {refusedBy} started editing this
        </span>
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
