import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Spreadsheet mode — editable grid over a collection.
 *
 * Excel-grade interactions: arrow/tab/enter navigation, click + shift-click
 * range selection, type-to-edit, Cmd/Ctrl+C copies TSV, paste fills a block
 * from Excel/Sheets, Cmd/Ctrl+D fills down. Every commit PATCHes through the
 * normal items API, so RBAC, hooks, validation and locks all apply per cell.
 * Readonly/computed/alias/relation fields render but never edit.
 */

interface GridField {
  field: string
  type: string | null
  interface: string | null
  readonly: boolean
  hidden: boolean
  special: string | null
  computed_formula?: string | null
}

type CellStatus = 'saving' | 'saved' | 'error'

const EDITABLE_TYPES = new Set([
  'string',
  'text',
  'integer',
  'bigInteger',
  'decimal',
  'float',
  'number',
  'boolean',
  'date',
  'dateTime',
  'datetime',
  'time'
])

const NUMERIC_TYPES = new Set(['integer', 'bigInteger', 'decimal', 'float', 'number'])

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function parseForField(raw: string, f: GridField): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (f.type === 'boolean') return /^(true|1|yes|y)$/i.test(trimmed)
  if (NUMERIC_TYPES.has(f.type ?? '')) {
    const n = Number(trimmed.replace(/,/g, ''))
    return Number.isNaN(n) ? raw : n
  }
  return raw
}

export function SpreadsheetView({ collection }: { collection: string }) {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const limit = 100

  const { data: fieldConfig } = useQuery({
    queryKey: ['field-config', collection],
    queryFn: () =>
      api.get<{ data: GridField[] }>(`/field-config/${collection}`).then((r) => r.data.data)
  })

  const { data: itemsData, isLoading } = useQuery({
    queryKey: ['grid-items', collection, page],
    queryFn: () =>
      api
        .get<{ data: Array<Record<string, unknown>>; total?: number }>(`/items/${collection}`, {
          params: { limit, page, sort: 'id' }
        })
        .then((r) => r.data)
  })

  const [rows, setRows] = useState<Array<Record<string, unknown>>>([])
  useEffect(() => {
    if (itemsData?.data) setRows(itemsData.data)
  }, [itemsData])

  const fields = useMemo(() => {
    return (fieldConfig ?? [])
      .filter(
        (f) =>
          !f.hidden &&
          f.field !== 'id' &&
          !f.field.includes('.') &&
          !(f.special ?? '').includes('m2m') &&
          !(f.special ?? '').includes('o2m') &&
          !(f.special ?? '').includes('m2a') &&
          (rows.length === 0 || f.field in (rows[0] ?? {}))
      )
      .slice(0, 30)
  }, [fieldConfig, rows])

  const isEditable = useCallback(
    (f: GridField) =>
      !f.readonly &&
      !f.computed_formula &&
      EDITABLE_TYPES.has(f.type ?? '') &&
      !f.field.endsWith('_id'),
    []
  )

  // Selection: active cell + optional range anchor. Coordinates are [row, col].
  const [active, setActive] = useState<[number, number] | null>(null)
  const [anchor, setAnchor] = useState<[number, number] | null>(null)
  const [editing, setEditing] = useState<[number, number] | null>(null)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<Record<string, CellStatus>>({}) // "row:col"
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLInputElement>(null)

  const total = itemsData?.total ?? rows.length
  const totalPages = Math.max(1, Math.ceil(total / limit))

  const range = useMemo((): [number, number, number, number] | null => {
    if (!active) return null
    const a = anchor ?? active
    return [
      Math.min(a[0], active[0]),
      Math.min(a[1], active[1]),
      Math.max(a[0], active[0]),
      Math.max(a[1], active[1])
    ]
  }, [active, anchor])

  const inRange = useCallback(
    (r: number, c: number) =>
      !!range && r >= range[0] && c >= range[1] && r <= range[2] && c <= range[3],
    [range]
  )

  function statusKey(r: number, c: number) {
    return `${r}:${c}`
  }

  const commitCell = useCallback(
    async (r: number, c: number, raw: string) => {
      const field = fields[c]
      const row = rows[r]
      if (!field || !row) return
      const value = parseForField(raw, field)
      if (cellText(row[field.field]) === cellText(value)) return
      const key = statusKey(r, c)
      setRows((prev) => prev.map((x, i) => (i === r ? { ...x, [field.field]: value } : x)))
      setStatus((prev) => ({ ...prev, [key]: 'saving' }))
      try {
        await api.patch(`/items/${collection}/${row.id}`, { [field.field]: value })
        setStatus((prev) => ({ ...prev, [key]: 'saved' }))
        setTimeout(
          () =>
            setStatus((prev) => {
              const next = { ...prev }
              if (next[key] === 'saved') delete next[key]
              return next
            }),
          1200
        )
      } catch (err) {
        setStatus((prev) => ({ ...prev, [key]: 'error' }))
        const msg =
          (err as { response?: { data?: { error?: string } } }).response?.data?.error ??
          'Save failed'
        toast.error(`${field.field}: ${msg}`)
      }
    },
    [collection, fields, rows]
  )

  const startEdit = useCallback(
    (r: number, c: number, initial?: string) => {
      const f = fields[c]
      if (!f || !isEditable(f)) return
      setEditing([r, c])
      setDraft(initial ?? cellText(rows[r]?.[f.field]))
    },
    [fields, rows, isEditable]
  )

  const stopEdit = useCallback(
    (commit: boolean) => {
      if (!editing) return
      const [r, c] = editing
      setEditing(null)
      if (commit) void commitCell(r, c, draft)
    },
    [editing, draft, commitCell]
  )

  // Focus the inline editor when it appears
  useEffect(() => {
    if (editing) editorRef.current?.focus()
  }, [editing])

  const move = useCallback(
    (dr: number, dc: number, extend: boolean) => {
      setActive((prev) => {
        const base = prev ?? [0, 0]
        const next: [number, number] = [
          Math.max(0, Math.min(rows.length - 1, base[0] + dr)),
          Math.max(0, Math.min(fields.length - 1, base[1] + dc))
        ]
        if (!extend) setAnchor(null)
        else setAnchor((a) => a ?? base)
        return next
      })
    },
    [rows.length, fields.length]
  )

  // Clipboard: copy selection as TSV
  const copySelection = useCallback(() => {
    if (!range) return
    const lines: string[] = []
    for (let r = range[0]; r <= range[2]; r++) {
      const cells: string[] = []
      for (let c = range[1]; c <= range[3]; c++) {
        cells.push(cellText(rows[r]?.[fields[c]?.field]))
      }
      lines.push(cells.join('\t'))
    }
    void navigator.clipboard.writeText(lines.join('\n'))
  }, [range, rows, fields])

  // Paste a TSV block starting at the active cell
  const pasteBlock = useCallback(
    (text: string) => {
      if (!active) return
      const lines = text
        .replace(/\r/g, '')
        .split('\n')
        .filter((l, i, arr) => l !== '' || i < arr.length - 1)
      let applied = 0
      lines.forEach((line, dr) => {
        line.split('\t').forEach((cell, dc) => {
          const r = active[0] + dr
          const c = active[1] + dc
          const f = fields[c]
          if (r < rows.length && f && isEditable(f)) {
            void commitCell(r, c, cell)
            applied++
          }
        })
      })
      if (applied > 0) toast.success(`Pasted ${applied} cell${applied === 1 ? '' : 's'}`)
    },
    [active, rows.length, fields, isEditable, commitCell]
  )

  // Fill down: top row of selection → every row below it
  const fillDown = useCallback(() => {
    if (!range) return
    for (let c = range[1]; c <= range[3]; c++) {
      const f = fields[c]
      if (!f || !isEditable(f)) continue
      const top = cellText(rows[range[0]]?.[f.field])
      for (let r = range[0] + 1; r <= range[2]; r++) {
        void commitCell(r, c, top)
      }
    }
  }, [range, fields, rows, isEditable, commitCell])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing) {
        if (e.key === 'Enter') {
          e.preventDefault()
          stopEdit(true)
          move(1, 0, false)
        } else if (e.key === 'Tab') {
          e.preventDefault()
          stopEdit(true)
          move(0, e.shiftKey ? -1 : 1, false)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          stopEdit(false)
        }
        return
      }
      if (!active) return
      const mod = e.metaKey || e.ctrlKey
      if (e.key === 'ArrowDown') e.preventDefault(), move(1, 0, e.shiftKey)
      else if (e.key === 'ArrowUp') e.preventDefault(), move(-1, 0, e.shiftKey)
      else if (e.key === 'ArrowRight') e.preventDefault(), move(0, 1, e.shiftKey)
      else if (e.key === 'ArrowLeft') e.preventDefault(), move(0, -1, e.shiftKey)
      else if (e.key === 'Tab') e.preventDefault(), move(0, e.shiftKey ? -1 : 1, false)
      else if (e.key === 'Enter') {
        e.preventDefault()
        startEdit(active[0], active[1])
      } else if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        copySelection()
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        fillDown()
      } else if (!mod && e.key.length === 1 && fields[active[1]] && isEditable(fields[active[1]])) {
        // type-to-edit: replace content
        e.preventDefault()
        startEdit(active[0], active[1], e.key)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        if (range) {
          for (let r = range[0]; r <= range[2]; r++) {
            for (let c = range[1]; c <= range[3]; c++) {
              if (fields[c] && isEditable(fields[c])) void commitCell(r, c, '')
            }
          }
        }
      }
    },
    [
      editing,
      active,
      range,
      fields,
      move,
      startEdit,
      stopEdit,
      copySelection,
      fillDown,
      isEditable,
      commitCell
    ]
  )

  if (isLoading) {
    return (
      <div className='flex flex-1 items-center justify-center text-slate-400'>
        <Loader2 className='mr-2 h-4 w-4 animate-spin' /> Loading grid…
      </div>
    )
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-1.5 text-[11px] text-slate-400 dark:border-border dark:bg-card'>
        <span>
          <kbd className='rounded border border-slate-200 px-1 dark:border-border'>↵</kbd> edit ·{' '}
          <kbd className='rounded border border-slate-200 px-1 dark:border-border'>⇧+arrows</kbd>{' '}
          select · <kbd className='rounded border border-slate-200 px-1 dark:border-border'>⌘C</kbd>{' '}
          copy · <kbd className='rounded border border-slate-200 px-1 dark:border-border'>⌘V</kbd>{' '}
          paste block ·{' '}
          <kbd className='rounded border border-slate-200 px-1 dark:border-border'>⌘D</kbd> fill
          down
        </span>
        <span className='ml-auto'>
          {total} rows · page {page}/{totalPages}
        </span>
        <Button
          size='sm'
          variant='outline'
          className='h-6 px-2 text-[11px]'
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Prev
        </Button>
        <Button
          size='sm'
          variant='outline'
          className='h-6 px-2 text-[11px]'
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </Button>
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: spreadsheet grid semantics */}
      <div
        ref={containerRef}
        role='grid'
        tabIndex={0}
        className='flex-1 overflow-auto outline-none'
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          e.preventDefault()
          pasteBlock(e.clipboardData.getData('text/plain'))
        }}
        onBlur={(e) => {
          // committing edits on outside click; ignore blur into the editor itself
          if (editing && !e.currentTarget.contains(e.relatedTarget as Node)) stopEdit(true)
        }}
      >
        <table className='w-max min-w-full border-collapse text-[12px]'>
          <thead className='sticky top-0 z-10'>
            <tr>
              <th className='w-14 border-b border-r border-slate-200 bg-slate-50 px-2 py-1.5 text-left font-mono text-[10.5px] font-normal text-slate-400 dark:border-border dark:bg-card'>
                id
              </th>
              {fields.map((f) => (
                <th
                  key={f.field}
                  className={cn(
                    'min-w-[110px] max-w-[260px] border-b border-r border-slate-200 bg-slate-50 px-2 py-1.5 text-left font-medium text-slate-600 dark:border-border dark:bg-card dark:text-slate-300',
                    !isEditable(f) && 'text-slate-400 dark:text-slate-500'
                  )}
                  title={isEditable(f) ? f.field : `${f.field} (read-only)`}
                >
                  {f.field}
                  {!isEditable(f) && ' 🔒'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={String(row.id)}>
                <td className='border-b border-r border-slate-100 bg-slate-50/60 px-2 py-1 font-mono text-[10.5px] text-slate-400 dark:border-border dark:bg-card/60'>
                  {String(row.id)}
                </td>
                {fields.map((f, c) => {
                  const isActive = active?.[0] === r && active?.[1] === c
                  const isEditingCell = editing?.[0] === r && editing?.[1] === c
                  const st = status[statusKey(r, c)]
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: grid keydown handled at container
                    <td
                      key={f.field}
                      role='gridcell'
                      className={cn(
                        'cursor-cell truncate border-b border-r border-slate-100 px-2 py-1 dark:border-border',
                        inRange(r, c) && 'bg-accent/60',
                        isActive && 'ring-2 ring-inset ring-[#00ceff]',
                        !isEditable(f) && 'bg-slate-50/40 text-slate-400 dark:bg-card/40',
                        st === 'saving' && 'bg-amber-50 dark:bg-amber-500/10',
                        st === 'saved' && 'bg-emerald-50 dark:bg-emerald-500/10',
                        st === 'error' && 'bg-red-50 dark:bg-red-500/10'
                      )}
                      onClick={(e) => {
                        containerRef.current?.focus()
                        if (editing) stopEdit(true)
                        if (e.shiftKey && active) setAnchor((a) => a ?? active)
                        else setAnchor(null)
                        setActive([r, c])
                      }}
                      onDoubleClick={() => startEdit(r, c)}
                    >
                      {isEditingCell ? (
                        <input
                          ref={editorRef}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          className='w-full bg-transparent outline-none'
                        />
                      ) : (
                        <span className='block max-w-[240px] truncate'>
                          {cellText(row[f.field]) || ' '}
                        </span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
