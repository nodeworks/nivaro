import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { patch } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TransitionRequirementFieldMeta {
  field: string
  label: string
  /** nivaro_fields type of the child column; null when the column has no nivaro_fields row. */
  type: string | null
}

export interface TransitionRequirementRow {
  id: string | number
  label: string
  complete: boolean
  values: Record<string, unknown>
}

export interface TransitionRequirementEntry {
  type: 'child_fields'
  collection: string
  fk_field: string
  title: string
  fields: TransitionRequirementFieldMeta[]
  rows: TransitionRequirementRow[]
}

/** Mirrors the `requirements` array from the transition endpoint's 422 payload. */
export type TransitionRequirementsPayload = TransitionRequirementEntry[]

// ─── Helpers ────────────────────────────────────────────────────────────────────

function rowKey(collection: string, id: string | number): string {
  return `${collection}::${String(id)}`
}

// Same numeric type-string set the other Input-driven PATCH consumers coerce on
// (FieldRenderer / InlineGridField) — the items PATCH endpoint does no coercion.
const NUMERIC_FIELD_TYPES = [
  'integer',
  'bigInteger',
  'float',
  'decimal',
  'numeric',
  'int',
  'bigint',
  'smallint',
  'tinyint',
  'real',
  'money',
  'smallmoney',
  'double',
  'number'
]

// Coerce a non-empty input string by column type before it rides in a PATCH
// body. NaN falls back to the raw string so the server's own 4xx surfaces
// inline instead of us silently writing garbage.
function coerceForPatch(raw: string, type: string | null): unknown {
  if (type && NUMERIC_FIELD_TYPES.includes(type)) {
    const n = Number(raw.trim())
    if (!Number.isNaN(n)) return n
  }
  return raw
}

function toInputValue(v: unknown): string {
  return v == null ? '' : String(v)
}

function snapshotValues(
  payload: TransitionRequirementsPayload
): Record<string, Record<string, string>> {
  const snapshot: Record<string, Record<string, string>> = {}
  for (const entry of payload) {
    for (const row of entry.rows) {
      const fieldValues: Record<string, string> = {}
      for (const f of entry.fields) fieldValues[f.field] = toInputValue(row.values[f.field])
      snapshot[rowKey(entry.collection, row.id)] = fieldValues
    }
  }
  return snapshot
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TransitionRequirementsDialog({
  payload,
  isRetry,
  onSubmitted,
  onClose
}: {
  payload: TransitionRequirementsPayload
  /** True when this payload came from a retry's second 422 (values changed underneath). */
  isRetry?: boolean
  onSubmitted: () => void
  onClose: () => void
}) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()
  const [values, setValues] = useState<Record<string, Record<string, string>>>(() =>
    snapshotValues(payload)
  )
  const savedRef = useRef<Record<string, Record<string, string>>>(snapshotValues(payload))
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  const setFieldValue = (rk: string, field: string, v: string) => {
    setValues((prev) => ({ ...prev, [rk]: { ...prev[rk], [field]: v } }))
    setRowErrors((prev) => {
      if (!(rk in prev)) return prev
      const next = { ...prev }
      delete next[rk]
      return next
    })
  }

  const hasEmpty = payload.some((entry) =>
    entry.rows.some((row) => {
      const rk = rowKey(entry.collection, row.id)
      return entry.fields.some((f) => !(values[rk]?.[f.field] ?? '').trim())
    })
  )

  const handleSubmit = async () => {
    setSubmitting(true)
    const results = await Promise.all(
      payload.flatMap((entry) =>
        entry.rows.map(async (row) => {
          const rk = rowKey(entry.collection, row.id)
          const current = values[rk] ?? {}
          const saved = savedRef.current[rk] ?? {}
          const changed: Record<string, unknown> = {}
          for (const f of entry.fields) {
            if (current[f.field] !== saved[f.field]) {
              changed[f.field] = coerceForPatch(current[f.field] ?? '', f.type)
            }
          }
          if (Object.keys(changed).length === 0) return { rk, ok: true as const }
          try {
            await client.request(patch(`/items/${entry.collection}/${row.id}`, changed))
            queryClient.invalidateQueries({ queryKey: ['item', entry.collection, String(row.id)] })
            return { rk, ok: true as const, saved: { ...saved, ...current } }
          } catch (err) {
            const resp = (err as { response?: { error?: string } })?.response
            return { rk, ok: false as const, error: resp?.error ?? 'Failed to save' }
          }
        })
      )
    )
    setSubmitting(false)
    const failures = results.filter((r) => !r.ok)
    for (const r of results) {
      if (r.ok && r.saved) savedRef.current[r.rk] = r.saved
    }
    if (failures.length > 0) {
      setRowErrors(Object.fromEntries(failures.map((f) => [f.rk, f.ok ? '' : f.error])))
      return
    }
    setRowErrors({})
    onSubmitted()
  }

  const title =
    payload.length === 1 && payload[0].title ? payload[0].title : 'Required before continuing'

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent className='max-w-2xl'>
        <DialogHeader>
          <DialogTitle className='text-[15px]'>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className='max-h-[60vh] space-y-5 overflow-y-auto'>
          {isRetry && (
            <p className='flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400'>
              <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400' />
              Values changed since your last attempt — review the highlighted rows.
            </p>
          )}
          {payload.map((entry) => (
            <div key={`${entry.collection}-${entry.fk_field}-${entry.title}`} className='space-y-2'>
              {payload.length > 1 && (
                <h4 className='text-[12px] font-semibold text-slate-500'>{entry.title}</h4>
              )}
              {entry.fields.length > 0 && (
                <div className='flex items-center gap-2 px-1 text-[11px] font-medium text-slate-400'>
                  <span className='min-w-0 flex-1'>Row</span>
                  {entry.fields.map((f) => (
                    <span key={f.field} className='w-36 shrink-0'>
                      {f.label}
                    </span>
                  ))}
                </div>
              )}
              <div className='space-y-1.5'>
                {entry.rows.map((row) => {
                  const rk = rowKey(entry.collection, row.id)
                  return (
                    <div
                      key={rk}
                      className='flex flex-wrap items-center gap-2 rounded-md border border-slate-200 px-2.5 py-1.5 dark:border-border'
                    >
                      <span className='flex min-w-0 flex-1 items-center gap-1.5'>
                        {!row.complete && (
                          <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 animate-pulse' />
                        )}
                        <span
                          className={cn(
                            'truncate text-[12px]',
                            row.complete ? 'text-slate-400' : 'font-medium text-slate-700'
                          )}
                        >
                          {row.label}
                        </span>
                      </span>
                      <div className='flex flex-wrap items-center gap-1.5'>
                        {entry.fields.map((f) => (
                          <Input
                            key={f.field}
                            value={values[rk]?.[f.field] ?? ''}
                            onChange={(e) => setFieldValue(rk, f.field, e.target.value)}
                            placeholder={f.label}
                            className='h-8 w-36 text-[12px]'
                          />
                        ))}
                      </div>
                      {rowErrors[rk] && (
                        <p className='flex w-full items-center gap-1 text-[11px] text-red-600'>
                          <AlertCircle className='h-3 w-3 shrink-0' />
                          {rowErrors[rk]}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </DialogBody>
        <DialogFooter>
          <Button type='button' variant='outline' onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type='button' onClick={handleSubmit} disabled={submitting || hasEmpty}>
            {submitting ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Submit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
