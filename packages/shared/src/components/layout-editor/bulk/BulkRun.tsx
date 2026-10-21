import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Loader2, Undo2 } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '../../../lib/utils'
import { apiFailure, useInvalidateLayouts } from '../overview/overview-api'
import { effectText, tintCard } from '../panel-style'
import {
  type AppliedForm,
  type BulkAction,
  type BulkPreview,
  bulkKeys,
  type FormPreview,
  useBulkCalls
} from './bulk-api'

export const btnQuiet =
  'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
export const btnSolid =
  'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const STATUS_TEXT: Record<FormPreview['status'], string> = {
  change: 'Changes',
  same: 'Nothing to do',
  skip: 'Skipped'
}

/**
 * Preview → Apply → (Undo) for one bulk action. Each form is listed with what
 * happens to it; forms the action cannot reach are listed as skipped with the
 * reason. Apply sends the revs the preview read, so a form someone changed
 * meanwhile is skipped rather than changed blind.
 */
export function BulkRun({
  collection,
  action,
  labels,
  applyLabel,
  dirtyLayoutId,
  extra,
  onApplied
}: {
  collection: string
  action: BulkAction | null
  labels: Record<string, string>
  /** "Retire from {n}" — the apply button's text for n forms. */
  applyLabel: (n: number) => string
  /** The layout open in the editor when it has unsaved changes: it cannot be included. */
  dirtyLayoutId?: number | null
  /** Shown under the preview (retire: the value count). */
  extra?: (preview: BulkPreview) => ReactNode
  onApplied?: () => void
}) {
  const calls = useBulkCalls()
  const qc = useQueryClient()
  const invalidateLayouts = useInvalidateLayouts(collection)
  const [preview, setPreview] = useState<BulkPreview | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState<'preview' | 'apply' | 'undo' | null>(null)
  const [result, setResult] = useState<AppliedForm[] | null>(null)
  const [undone, setUndone] = useState(false)
  const actionKey = JSON.stringify(action)

  // A different action: start over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the action's content
  useEffect(() => {
    setPreview(null)
    setResult(null)
    setUndone(false)
  }, [actionKey])

  const refresh = (ids: number[]) => {
    invalidateLayouts()
    void qc.invalidateQueries({ queryKey: bulkKeys.fields(collection) })
    for (const id of ids) {
      void qc.invalidateQueries({ queryKey: ['layout-editor', 'bundle', id] })
      void qc.invalidateQueries({ queryKey: ['layout-editor', 'versions', id] })
    }
  }

  const runPreview = async () => {
    if (!action) return
    setBusy('preview')
    setResult(null)
    try {
      const p = await calls.preview({ collection, action, labels })
      setPreview(p)
      setPicked(
        new Set(
          p.forms
            .filter((f) => f.status === 'change' && f.layout_id !== dirtyLayoutId)
            .map((f) => f.layout_id)
        )
      )
    } catch (err) {
      toast.error(apiFailure(err, 'The preview could not be made').message)
    } finally {
      setBusy(null)
    }
  }

  const runApply = async () => {
    if (!action || !preview || picked.size === 0) return
    setBusy('apply')
    try {
      const revs: Record<string, string> = {}
      for (const f of preview.forms) revs[String(f.layout_id)] = f.rev
      const r = await calls.apply({
        collection,
        action,
        labels,
        layout_ids: [...picked],
        revs
      })
      setResult(r.forms)
      setUndone(false)
      const done = r.forms.filter((f) => f.status === 'applied').length
      const missed = r.forms.filter((f) => f.status === 'skipped' || f.status === 'failed').length
      if (done) toast.success(`${r.label}: ${plural(done, 'form')} changed`)
      if (missed) toast.warning(`${plural(missed, 'form')} could not be changed: see the list`)
      refresh(r.forms.map((f) => f.layout_id))
      onApplied?.()
    } catch (err) {
      toast.error(apiFailure(err, 'The change could not be applied').message)
    } finally {
      setBusy(null)
    }
  }

  const runUndo = async () => {
    if (!result) return
    setBusy('undo')
    try {
      const r = await calls.undo(collection, result)
      const back = r.forms.filter((f) => f.status === 'restored').length
      const kept = r.forms.filter((f) => f.status !== 'restored')
      setUndone(true)
      if (back) toast.success(`${plural(back, 'form')} put back`)
      if (kept.length)
        toast.warning(
          `${plural(kept.length, 'form')} changed since: restore ${kept.length === 1 ? 'it' : 'them'} from History`
        )
      refresh(r.forms.map((f) => f.layout_id))
    } catch (err) {
      toast.error(apiFailure(err, 'The change could not be undone').message)
    } finally {
      setBusy(null)
    }
  }

  const counts = preview
    ? {
        change: preview.forms.filter((f) => f.status === 'change').length,
        same: preview.forms.filter((f) => f.status === 'same').length,
        skip: preview.forms.filter((f) => f.status === 'skip').length
      }
    : null
  const dirtyPicked = dirtyLayoutId != null && picked.has(dirtyLayoutId)

  if (result) {
    const applied = result.filter((f) => f.status === 'applied')
    return (
      <div data-bulk-result='' className='space-y-3'>
        <ul className='space-y-1'>
          {result.map((f) => (
            <li key={f.layout_id} className='flex items-start gap-2 text-[12.5px]'>
              {f.status === 'applied' ? (
                <Check className='mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400' />
              ) : (
                <AlertTriangle
                  className={cn(
                    'mt-0.5 h-3.5 w-3.5 shrink-0',
                    f.status === 'same'
                      ? 'text-slate-400 dark:text-muted-foreground'
                      : 'text-amber-600 dark:text-amber-400'
                  )}
                />
              )}
              <span className='min-w-0'>
                <span className='font-medium text-slate-800 dark:text-foreground'>{f.name}</span>
                {f.reason && <span className={cn(effectText, 'block')}>{f.reason}</span>}
              </span>
            </li>
          ))}
        </ul>
        {applied.length > 0 && (
          <div className={cn(tintCard, 'space-y-2 p-2.5')}>
            <p className={effectText}>
              Each changed form has its own History entry from just before this change; restore any
              one of them from History.
            </p>
            <button
              type='button'
              data-bulk-undo=''
              className={btnQuiet}
              disabled={busy !== null || undone}
              onClick={() => void runUndo()}
            >
              {busy === 'undo' ? (
                <Loader2 className='h-3.5 w-3.5 animate-spin' />
              ) : (
                <Undo2 className='h-3.5 w-3.5' />
              )}
              {undone ? 'Undone' : 'Undo this bulk change'}
            </button>
          </div>
        )}
        <button
          type='button'
          className='text-[12px] font-medium text-[#0089ad] hover:underline dark:text-nvr-cyan'
          onClick={() => {
            setResult(null)
            setPreview(null)
          }}
        >
          Start another change
        </button>
      </div>
    )
  }

  return (
    <div className='space-y-3'>
      <button
        type='button'
        data-bulk-preview=''
        className={btnQuiet}
        disabled={!action || busy !== null}
        onClick={() => void runPreview()}
      >
        {busy === 'preview' && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
        {preview ? 'Preview again' : 'Preview'}
      </button>
      {preview && counts && (
        <div data-bulk-preview-list='' className='space-y-2'>
          <p className='text-[12.5px] text-slate-700 dark:text-foreground'>
            {preview.forms.length === 0
              ? 'This collection has no forms.'
              : [
                  counts.change && `Changes ${plural(counts.change, 'form')}`,
                  counts.same && `${counts.same} already like that`,
                  counts.skip && `${counts.skip} skipped`
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </p>
          {extra?.(preview)}
          <ul className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border dark:border-border'>
            {preview.forms.map((f) => (
              <FormRow
                key={f.layout_id}
                form={f}
                picked={picked.has(f.layout_id)}
                dirty={f.layout_id === dirtyLayoutId}
                onPick={(on) =>
                  setPicked((cur) => {
                    const next = new Set(cur)
                    if (on) next.add(f.layout_id)
                    else next.delete(f.layout_id)
                    return next
                  })
                }
              />
            ))}
          </ul>
          {dirtyPicked && (
            <p className='text-[12px] text-amber-700 dark:text-amber-300'>
              Save or discard your changes to this form first.
            </p>
          )}
          {counts.change > 0 && (
            <button
              type='button'
              data-bulk-apply=''
              className={btnSolid}
              disabled={busy !== null || picked.size === 0 || dirtyPicked}
              onClick={() => void runApply()}
            >
              {busy === 'apply' && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
              {applyLabel(picked.size)}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function FormRow({
  form,
  picked,
  dirty,
  onPick
}: {
  form: FormPreview
  picked: boolean
  dirty: boolean
  onPick: (on: boolean) => void
}) {
  const can = form.status === 'change'
  return (
    <li data-bulk-form={form.layout_id} data-status={form.status} className='px-2.5 py-2'>
      <label className={cn('flex items-start gap-2', can && 'cursor-pointer')}>
        <input
          type='checkbox'
          className='mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#00a3cc]'
          checked={can && picked}
          disabled={!can}
          aria-label={`Include ${form.name}`}
          onChange={(e) => onPick(e.target.checked)}
        />
        <span className='min-w-0 flex-1'>
          <span className='flex flex-wrap items-baseline gap-x-2'>
            <span className='font-medium text-[12.5px] text-slate-800 dark:text-foreground'>
              {form.name}
            </span>
            <span
              className={cn(
                'text-[11.5px]',
                form.status === 'skip'
                  ? 'text-amber-700 dark:text-amber-300'
                  : 'text-slate-500 dark:text-muted-foreground'
              )}
            >
              {STATUS_TEXT[form.status]}
              {dirty && can ? ' · has unsaved changes here' : ''}
            </span>
          </span>
          {form.changes.map((c) => (
            <span key={c} className='block text-[12px] text-slate-600 dark:text-muted-foreground'>
              {c}
            </span>
          ))}
          {form.reason && <span className={cn(effectText, 'block')}>{form.reason}</span>}
          {form.notes.map((n) => (
            <span key={n} className='block text-[12px] text-amber-700 dark:text-amber-300'>
              {n}
            </span>
          ))}
        </span>
      </label>
    </li>
  )
}
