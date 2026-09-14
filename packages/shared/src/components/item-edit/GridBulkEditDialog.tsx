import { Loader2, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { cn, titleCase } from '../../lib/utils'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { FieldRenderer } from './FieldRenderer'
import type { CMSField, CMSRelation } from './types'

/**
 * Bulk lines edit (backlog #11): one mini-form over the grid's editable
 * columns, applied to every selected row. A column every selected row agrees
 * on is prefilled; one that varies starts empty with a "(varies)" placeholder.
 * Only fields the user actually TOUCHED are applied — an untouched prefilled
 * value is the rows' own value, not an instruction to rewrite it.
 *
 * The dialog owns no write path: `onApply` receives the touched values and
 * the grid decides (stage vs PATCH, row rules, locks) exactly as its own row
 * editor would.
 */
export function GridBulkEditDialog({
  open,
  onOpenChange,
  columns,
  rows,
  relations,
  collection,
  cascadeFilters,
  onApply
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Editable columns of the grid (readonly / computed / locked-by-config excluded). */
  columns: CMSField[]
  /** The selected rows as the grid shows them (staged edits merged). */
  rows: Record<string, unknown>[]
  relations: CMSRelation[]
  collection: string
  cascadeFilters?: Record<string, Record<string, unknown> | undefined>
  onApply: (touched: Record<string, unknown>) => Promise<void>
}) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  // Per column: the value every selected row shares, or "varies".
  const common = useMemo(() => {
    const out: Record<string, { value: unknown; varies: boolean }> = {}
    for (const c of columns) {
      if (rows.length === 0) {
        out[c.field] = { value: null, varies: false }
        continue
      }
      const first = rows[0][c.field] ?? null
      const same = rows.every((r) => String(r[c.field] ?? '') === String(first ?? ''))
      out[c.field] = { value: same ? first : null, varies: !same }
    }
    return out
  }, [columns, rows])

  // Fresh form per open: prefill from what the rows agree on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens
  useEffect(() => {
    if (!open) return
    const seed: Record<string, unknown> = {}
    for (const c of columns) seed[c.field] = common[c.field]?.value ?? null
    setValues(seed)
    setTouched(new Set())
    setBusy(false)
  }, [open])

  const setField = (k: string, v: unknown) => {
    setValues((prev) => ({ ...prev, [k]: v }))
    setTouched((prev) => new Set([...prev, k]))
  }
  const untouch = (k: string) => {
    setValues((prev) => ({ ...prev, [k]: common[k]?.value ?? null }))
    setTouched((prev) => {
      const next = new Set(prev)
      next.delete(k)
      return next
    })
  }

  const n = rows.length
  const lines = n === 1 ? 'line' : 'lines'

  async function apply() {
    if (touched.size === 0 || busy) return
    const payload: Record<string, unknown> = {}
    for (const k of touched) payload[k] = values[k] ?? null
    setBusy(true)
    try {
      await onApply(payload)
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        className='max-w-3xl dark:bg-card'
        data-o2m-editing=''
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            Edit {n} selected {lines}
          </DialogTitle>
          <DialogDescription>
            Only the fields you change here are written. Fields left as prefilled keep each
            line&apos;s own value.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className='max-h-[60vh] overflow-y-auto'>
          {columns.length === 0 ? (
            <p className='py-6 text-center text-[12px] text-slate-400'>
              This table has no columns that can be edited in bulk.
            </p>
          ) : (
            <div
              className='grid items-start gap-x-4 gap-y-3'
              style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
            >
              {columns.map((c) => {
                const label = c.label || titleCase(c.field)
                const info = common[c.field]
                const isTouched = touched.has(c.field)
                const field = info?.varies
                  ? ({ ...c, placeholder: '(varies)', sort: c.sort ?? 0 } as CMSField)
                  : ({ ...c, sort: c.sort ?? 0 } as CMSField)
                return (
                  <div
                    key={c.field}
                    className={cn(
                      'flex min-w-0 flex-col gap-1 rounded-md p-1.5 -m-1.5 transition-colors',
                      isTouched && 'bg-amber-50/70 dark:bg-amber-400/10'
                    )}
                  >
                    <span className='flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-400'>
                      <span className='truncate'>{label}</span>
                      {isTouched ? (
                        <>
                          <span className='rounded bg-amber-100 px-1 py-px text-[9px] normal-case tracking-normal text-amber-700 dark:bg-amber-400/20 dark:text-amber-300'>
                            will apply
                          </span>
                          <button
                            type='button'
                            onClick={() => untouch(c.field)}
                            className='ml-auto inline-flex items-center gap-0.5 rounded px-1 text-[10px] normal-case tracking-normal text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                            data-tip='Leave this field as each line has it'
                          >
                            <RotateCcw className='h-2.5 w-2.5' aria-hidden='true' />
                            keep
                          </button>
                        </>
                      ) : info?.varies ? (
                        <span
                          className='normal-case tracking-normal text-slate-400'
                          data-tip={`The ${n} selected ${lines} hold different values here`}
                        >
                          · varies
                        </span>
                      ) : null}
                    </span>
                    <FieldRenderer
                      field={field as Parameters<typeof FieldRenderer>[0]['field']}
                      value={values[c.field] ?? null}
                      onChange={(v) => setField(c.field, v)}
                      relations={relations}
                      collection={collection}
                      itemId='new'
                      cascadeFilter={cascadeFilters?.[c.field]}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </DialogBody>
        <DialogFooter className='items-center'>
          <span className='mr-auto text-[11px] text-slate-500 dark:text-slate-400'>
            {touched.size === 0
              ? 'Change a field to enable Apply'
              : `${touched.size} ${touched.size === 1 ? 'field' : 'fields'} → ${n} ${lines}`}
          </span>
          <button
            type='button'
            disabled={busy}
            onClick={() => onOpenChange(false)}
            className='rounded px-3 py-1.5 text-[12px] text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-muted'
          >
            Cancel
          </button>
          <button
            type='button'
            disabled={busy || touched.size === 0 || n === 0}
            onClick={() => void apply()}
            className='inline-flex items-center gap-1.5 rounded bg-nvr-cyan px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50'
          >
            {busy && <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden='true' />}
            {busy ? 'Applying…' : `Apply to ${n} ${lines}`}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
