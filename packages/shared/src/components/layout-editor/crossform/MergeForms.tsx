import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeftRight, Check, Combine, Loader2, Undo2 } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { cn, formatNumber } from '../../../lib/utils'
import { Popover, PopoverContent } from '../../ui/popover'
import { Skeleton } from '../../ui/skeleton'
import { btnQuiet, btnSolid } from '../bulk/BulkRun'
import { apiFailure, useLayoutOverview } from '../overview/overview-api'
import { amberStrip, effectText, groupTitle, inputBase, labelText, tintCard } from '../panel-style'
import { PickList, type PickOption } from '../settings/controls'
import { ToolButton } from '../toolbar-kit'
import { useInvalidateAfterCrossWrite } from './crossform-api'
import {
  type MergeApplied,
  type MergePreview,
  type MergeViewTally,
  useMergeCalls
} from './merge-api'

// Merge two forms (#2661): fold one form into another. The differences
// become section rules, the kept form takes over who the folded one opened
// for, and the folded one stops being picked. Previewed first (with a check of
// the newest records), applied as one change, undone from here or History.

const plural = (n: number, one: string, many = `${one}s`) =>
  `${formatNumber(n)} ${n === 1 ? one : many}`

function Lines({ items, tone }: { items: string[]; tone?: 'amber' }) {
  return (
    <ul className='space-y-1'>
      {items.map((t) => (
        <li
          key={t}
          className={cn(
            'flex gap-1.5 text-[12.5px] leading-snug',
            tone === 'amber'
              ? 'text-amber-800 dark:text-amber-200'
              : 'text-slate-700 dark:text-foreground'
          )}
        >
          <span
            aria-hidden
            className='mt-[7px] h-1 w-1 shrink-0 rounded-full bg-current opacity-60'
          />
          <span className='min-w-0'>{t}</span>
        </li>
      ))}
    </ul>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className='space-y-1.5'>
      <h4 className={groupTitle}>{title}</h4>
      {children}
    </section>
  )
}

const recs = (n: number) => plural(n, 'record')
const opens = (n: number) => (n === 1 ? 'opens' : 'open')

/** One role view of the record check, in sentences. */
function viewLines(v: MergeViewTally, p: MergePreview, name: (id: number | null) => string) {
  const out: string[] = []
  if (v.sampled > 0) {
    if (v.carried)
      out.push(
        `${recs(v.carried)} that ${opens(v.carried)} ${p.fold.name} will open the merged form`
      )
    if (v.kept)
      out.push(
        `${recs(v.kept)} that ${opens(v.kept)} ${p.keep.name} ${v.kept === 1 ? 'keeps' : 'keep'} opening it`
      )
    for (const l of v.lost)
      out.push(
        `${recs(l.count)} that ${opens(l.count)} ${name(l.from)} will open ${l.to == null ? 'no form' : name(l.to)} instead`
      )
    for (const g of v.gained)
      out.push(`${recs(g.count)} that ${opens(g.count)} ${name(g.from)} will open the merged form`)
    if (!out.length) out.push(`None of them open ${p.keep.name} or ${p.fold.name}`)
  }
  if (v.plain.before !== v.plain.after)
    out.push(`A new record opens ${name(v.plain.after)} instead of ${name(v.plain.before)}`)
  return out
}

export interface MergePanelProps {
  collection: string
  /** Preselected forms (from a near-copies finding). */
  keepId?: number | null
  foldId?: number | null
  onDone?: () => void
}

export function MergePanel({ collection, keepId = null, foldId = null, onDone }: MergePanelProps) {
  const { data, isLoading } = useLayoutOverview(collection)
  const calls = useMergeCalls()
  const qc = useQueryClient()
  const refresh = useInvalidateAfterCrossWrite(collection)
  const [keep, setKeep] = useState<string | null>(keepId == null ? null : String(keepId))
  const [fold, setFold] = useState<string | null>(foldId == null ? null : String(foldId))
  const [preview, setPreview] = useState<MergePreview | null>(null)
  const [result, setResult] = useState<MergeApplied | null>(null)
  const [undone, setUndone] = useState(false)
  const [busy, setBusy] = useState<'preview' | 'apply' | 'undo' | null>(null)
  const [reason, setReason] = useState('')
  const [ticket, setTicket] = useState('')

  const forms = useMemo<PickOption[]>(
    () =>
      (data?.rows ?? [])
        .filter((r) => r.layout_type === 'grouped' || !r.layout_type)
        .map((r) => ({
          value: String(r.layout_id),
          label: r.name,
          hint: r.is_default ? 'default' : r.section === 'unused' ? 'unused' : undefined
        })),
    [data]
  )
  // A different pair: the preview no longer describes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the pair
  useEffect(() => {
    setPreview(null)
  }, [keep, fold])

  const names = (id: number | null) =>
    id == null
      ? 'no form'
      : (preview?.records?.names[String(id)] ??
        forms.find((f) => f.value === String(id))?.label ??
        `form ${id}`)

  const touched = (r: MergeApplied) => {
    refresh([r.keep.layout_id, r.fold.layout_id])
    for (const id of [r.keep.layout_id, r.fold.layout_id])
      void qc.invalidateQueries({ queryKey: ['layout-editor', 'versions', id] })
  }

  const runPreview = async () => {
    if (!keep || !fold || keep === fold) return
    setBusy('preview')
    try {
      setPreview(await calls.preview(collection, Number(keep), Number(fold)))
    } catch (err) {
      toast.error(apiFailure(err, 'The preview could not be made').message)
    } finally {
      setBusy(null)
    }
  }

  const runApply = async () => {
    if (!preview) return
    setBusy('apply')
    try {
      const r = await calls.apply(
        collection,
        preview,
        preview.needs_note ? { reason: reason.trim(), ticket: ticket.trim() } : undefined
      )
      setResult(r)
      setUndone(false)
      toast.success(`${preview.fold.name} is merged into ${preview.keep.name}`)
      touched(r)
    } catch (err) {
      toast.error(apiFailure(err, 'The forms could not be merged').message)
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
      setUndone(true)
      if (back === 2) toast.success('Both forms are back as they were')
      else
        toast.warning(
          `${back === 1 ? 'One form is back; the other' : 'The forms'} changed since: restore from History`
        )
      touched(result)
    } catch (err) {
      toast.error(apiFailure(err, 'The merge could not be undone').message)
    } finally {
      setBusy(null)
    }
  }

  if (result) {
    const canUndo = result.keep.version_id != null && result.fold.version_id != null
    return (
      <div data-merge-result='' className='space-y-3'>
        <p className='flex items-start gap-2 text-[12.5px] text-slate-800 dark:text-foreground'>
          <Check className='mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400' />
          <span>
            <strong>{result.keep.name}</strong> now holds both forms. The other one is called{' '}
            <strong>{result.fold.name}</strong> and no longer opens for any record.
          </span>
        </p>
        <div className={cn(tintCard, 'space-y-2 p-2.5')}>
          <p className={effectText}>
            Both forms have a “Before merge” version in History, so either can be put back on its
            own.
          </p>
          <button
            type='button'
            data-merge-undo=''
            className={btnQuiet}
            disabled={busy !== null || undone || !canUndo}
            onClick={() => void runUndo()}
          >
            {busy === 'undo' ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
            ) : (
              <Undo2 className='h-3.5 w-3.5' />
            )}
            {undone ? 'Undone' : 'Undo the merge'}
          </button>
        </div>
        {onDone && (
          <button
            type='button'
            className='text-[12px] font-medium text-[#0089ad] hover:underline dark:text-nvr-cyan'
            onClick={onDone}
          >
            Close
          </button>
        )}
      </div>
    )
  }

  const same = keep != null && keep === fold
  const noteMissing =
    !!preview?.needs_note &&
    (reason.trim().length < 3 || (preview.needs_note === 'note_ticket' && !ticket.trim()))
  const nothing = !!preview && preview.changes.length === 0 && preview.counts.sections_added === 0

  return (
    <div className='space-y-3'>
      <div className='grid grid-cols-[1fr_auto_1fr] items-end gap-1.5'>
        <div className='min-w-0 space-y-1'>
          <span className={labelText}>Keep</span>
          <PickList
            ariaLabel='Form to keep'
            value={keep}
            options={forms}
            onChange={setKeep}
            placeholder={isLoading ? 'Loading forms…' : 'Pick a form…'}
            emptyText='This collection has no record forms'
            className='w-full'
          />
        </div>
        <button
          type='button'
          aria-label='Swap the two forms'
          data-tip='Swap: keep the other one'
          className='mb-0.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-muted hover:text-slate-900 disabled:opacity-40 dark:text-muted-foreground dark:hover:text-foreground'
          disabled={!keep && !fold}
          onClick={() => {
            setKeep(fold)
            setFold(keep)
          }}
        >
          <ArrowLeftRight className='h-3.5 w-3.5' />
        </button>
        <div className='min-w-0 space-y-1'>
          <span className={labelText}>Fold in</span>
          <PickList
            ariaLabel='Form to fold in'
            value={fold}
            options={forms.filter((f) => f.value !== keep)}
            onChange={setFold}
            placeholder='Pick a form…'
            emptyText='No other record form'
            className='w-full'
          />
        </div>
      </div>
      <p className={effectText}>
        What only one form has becomes a section shown just for the records that form opened for.
        The kept form takes over who the other one opened for.
      </p>
      {same && (
        <p className='text-[12px] text-amber-700 dark:text-amber-300'>Pick two different forms.</p>
      )}
      <button
        type='button'
        data-merge-preview=''
        className={btnQuiet}
        disabled={!keep || !fold || same || busy !== null}
        onClick={() => void runPreview()}
      >
        {busy === 'preview' && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
        {preview ? 'Preview again' : 'Preview'}
      </button>

      {busy === 'preview' && !preview && (
        <div className='space-y-2' aria-hidden>
          <Skeleton className='h-3 w-2/3' />
          <Skeleton className='h-3 w-1/2' />
          <Skeleton className='h-3 w-3/5' />
        </div>
      )}

      {preview && (
        <div
          data-merge-plan=''
          className='space-y-3.5 border-t border-slate-100 pt-3 dark:border-border'
        >
          <Block title={`What ${preview.keep.name} gets`}>
            {nothing ? (
              <p className={effectText}>
                Nothing to add: {preview.keep.name} already shows everything {preview.fold.name}{' '}
                does.
              </p>
            ) : (
              <Lines items={preview.changes} />
            )}
          </Block>
          <Block title='Who opens the merged form'>
            <Lines items={preview.assignment} />
          </Block>
          {preview.records && (
            <Block
              title={
                preview.records.sampled_newest
                  ? `Checked on the newest ${plural(preview.records.sampled_newest, 'record')}`
                  : 'Who gets which form'
              }
            >
              {preview.records.views.map((v) => {
                const lines = viewLines(v, preview, names)
                if (!lines.length) return null
                return (
                  <div key={v.label} data-merge-view={v.label} className='space-y-1'>
                    {preview.records && preview.records.views.length > 1 && (
                      <p className='text-[12px] font-medium text-slate-600 dark:text-muted-foreground'>
                        {v.label}
                      </p>
                    )}
                    <Lines items={lines} />
                  </div>
                )
              })}
              {preview.records.views.every((v) => viewLines(v, preview, names).length === 0) && (
                <p className={effectText}>Every record keeps the form it opens with today.</p>
              )}
            </Block>
          )}
          <Block title={`${preview.fold.name} afterwards`}>
            <Lines items={preview.retire} />
            {preview.references.length > 0 && (
              <p className={effectText}>
                Still opened by id from: {preview.references.map((r) => r.label).join(' · ')}
              </p>
            )}
          </Block>
          {preview.notes.length > 0 && (
            <div data-merge-notes='' className={cn('rounded-md border p-2.5', amberStrip)}>
              <p className='mb-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold'>
                <AlertTriangle className='h-3.5 w-3.5' />
                Worth a look before merging
              </p>
              <Lines items={preview.notes} tone='amber' />
            </div>
          )}
          {preview.needs_note && (
            <div className='space-y-1.5'>
              <label className='block space-y-1'>
                <span className={labelText}>Why this change</span>
                <input
                  className={inputBase}
                  value={reason}
                  maxLength={200}
                  placeholder='A reason, for History'
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              {preview.needs_note === 'note_ticket' && (
                <label className='block space-y-1'>
                  <span className={labelText}>Ticket link</span>
                  <input
                    className={inputBase}
                    value={ticket}
                    maxLength={300}
                    placeholder='https://…'
                    onChange={(e) => setTicket(e.target.value)}
                  />
                </label>
              )}
            </div>
          )}
          <button
            type='button'
            data-merge-apply=''
            className={btnSolid}
            disabled={busy !== null || noteMissing}
            onClick={() => void runApply()}
          >
            {busy === 'apply' && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
            Merge into {preview.keep.name}
          </button>
        </div>
      )}
    </div>
  )
}

/** The overview's "More" entry: an anchored popover holding the merge panel. */
export function MergeFormsButton({ collection }: { collection: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ToolButton
        popover
        onOpen={() => setOpen(true)}
        label='Merge two forms'
        icon={<Combine className='h-3.5 w-3.5' />}
        tip='Fold one form into another: its differences become section rules'
        hint='Fold one form into another'
        data={{ 'data-merge-button': '' }}
      />
      <PopoverContent
        align='end'
        data-merge-panel=''
        className='max-h-[min(80vh,720px)] w-[480px] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain p-0'
      >
        {open && (
          <div className='space-y-3 p-4'>
            <div>
              <h3 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
                Merge two forms
              </h3>
              <p className={effectText}>
                Previewed first. Applied as one change; both forms keep a version in History.
              </p>
            </div>
            <MergePanel collection={collection} onDone={() => setOpen(false)} />
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
