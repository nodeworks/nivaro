import { ChevronDown, ChevronRight, Copy, Tags } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { cn } from '../../../lib/utils'
import { btnOutline, btnPrimary } from '../overview/OverviewActions'
import { apiFailure } from '../overview/overview-api'
import {
  applyToLayout,
  type DuplicatePair,
  type LabelFinding,
  useCrossform,
  useInvalidateAfterCrossWrite
} from './crossform-api'
import { linkParentOps, unifyLabelOps } from './crossform-model'

// Overview findings across the forms of a collection: a field labelled
// differently on different forms (#2631, unify in one click per field) and
// forms that are near copies of each other (#2660, compare or link to a parent).

const chip =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors'
const listCls = 'divide-y divide-slate-100 dark:divide-border/60'
const btnSmall =
  'inline-flex h-7 items-center whitespace-nowrap rounded-md border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const names = (layouts: Array<{ name: string }>) => layouts.map((l) => l.name).join(', ')

function LabelRow({ finding, collection }: { finding: LabelFinding; collection: string }) {
  const client = useNivaroClient()
  const refresh = useInvalidateAfterCrossWrite(collection)
  const [busy, setBusy] = useState<string | null>(null)
  const options = finding.variants.some((v) => v.label === finding.field_label)
    ? finding.variants.map((v) => v.label)
    : [...finding.variants.map((v) => v.label), finding.field_label]

  const unify = async (target: string) => {
    setBusy(target)
    const ids = finding.variants
      .filter((v) => v.label !== target)
      .flatMap((v) => v.layouts.map((l) => l.id))
    const done: number[] = []
    try {
      for (const id of ids) {
        await applyToLayout(
          client,
          id,
          (b) => unifyLabelOps(b, finding.field, target, finding.field_label),
          `Label “${target}” for ${finding.field_label}`
        )
        done.push(id)
      }
      toast.success(
        `${finding.field_label} reads “${target}” on every form (${plural(done.length, 'form')} changed)`
      )
    } catch (err) {
      toast.error(
        `${apiFailure(err, 'Could not change the label').message}${done.length ? ` (${plural(done.length, 'form')} already changed)` : ''}`
      )
    } finally {
      setBusy(null)
      refresh(ids)
    }
  }

  return (
    <li data-label-finding={finding.field} className='px-4 py-2.5'>
      <div className='flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px]'>
        <span className='font-semibold text-slate-900 dark:text-foreground'>
          {finding.field_label}
        </span>
        <span className='font-mono text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {finding.field}
        </span>
      </div>
      <ul className='mt-1 space-y-0.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
        {finding.variants.map((v) => (
          <li key={v.label}>
            <span className='font-medium text-slate-800 dark:text-foreground'>“{v.label}”</span> on{' '}
            {names(v.layouts)}
          </li>
        ))}
      </ul>
      <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
        <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Use one label:
        </span>
        {options.map((label) => (
          <button
            key={label}
            type='button'
            className={btnSmall}
            disabled={busy != null}
            data-tip={
              label === finding.field_label
                ? 'The field’s own label: clears the label set on each form'
                : `Every form shows “${label}”`
            }
            onClick={() => void unify(label)}
          >
            {busy === label ? 'Changing…' : `“${label}”`}
          </button>
        ))}
      </div>
    </li>
  )
}

function DuplicateRow({
  pair,
  collection,
  onOpen,
  onCompare
}: {
  pair: DuplicatePair
  collection: string
  onOpen: (id: number) => void
  onCompare: (a: number, b: number) => void
}) {
  const client = useNivaroClient()
  const refresh = useInvalidateAfterCrossWrite(collection)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const parent = pair.parent_id === pair.a.id ? pair.a : pair.b
  const child = parent === pair.a ? pair.b : pair.a
  const pct = Math.floor(pair.similarity * 100)
  const facts = [
    `${plural(pair.identical, 'field')} identical`,
    pair.only_a ? `${pair.only_a} only on ${pair.a.name}` : null,
    pair.only_b ? `${pair.only_b} only on ${pair.b.name}` : null,
    pair.differing ? `${pair.differing} set up differently` : null
  ].filter(Boolean)

  const link = async () => {
    setBusy(true)
    try {
      await applyToLayout(
        client,
        child.id,
        (b) => linkParentOps(b, parent.id),
        `Extends ${parent.name}`
      )
      toast.success(`${child.name} now extends ${parent.name}`)
      setAsking(false)
    } catch (err) {
      toast.error(apiFailure(err, 'Could not link the forms').message)
    } finally {
      setBusy(false)
      refresh([child.id])
    }
  }

  return (
    <li data-duplicate-pair={`${pair.a.id}-${pair.b.id}`} className='px-4 py-2.5'>
      <p className='text-[12.5px] text-slate-800 dark:text-foreground'>
        <button
          type='button'
          className='font-semibold hover:underline'
          onClick={() => onOpen(pair.a.id)}
        >
          {pair.a.name}
        </button>{' '}
        and{' '}
        <button
          type='button'
          className='font-semibold hover:underline'
          onClick={() => onOpen(pair.b.id)}
        >
          {pair.b.name}
        </button>{' '}
        are {pct}% the same
      </p>
      <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
        {facts.join(' · ')}. Suggestion: keep {parent.name} as the parent and let {child.name}{' '}
        extend it with only its differences.
      </p>
      <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
        <button type='button' className={btnSmall} onClick={() => onCompare(pair.a.id, pair.b.id)}>
          Compare side by side
        </button>
        {pair.can_link && !asking && (
          <button type='button' className={btnSmall} onClick={() => setAsking(true)}>
            Make {parent.name} the parent…
          </button>
        )}
      </div>
      {asking && (
        <div className='mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-foreground'>
          <p>
            {child.name} will extend {parent.name}. It keeps every field it has now; fields added to{' '}
            {parent.name} later also appear on {child.name}. Remove the fields {child.name} repeats
            unchanged in its editor to let changes to {parent.name} flow through.
          </p>
          <div className='mt-2 flex gap-1.5'>
            <button type='button' className={btnOutline} onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button
              type='button'
              disabled={busy}
              className={btnPrimary}
              onClick={() => void link()}
            >
              {busy ? 'Linking…' : `Extend ${parent.name}`}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

export function CrossformFindings({
  collection,
  onOpen,
  onCompare
}: {
  collection: string
  onOpen: (id: number) => void
  onCompare: (a: number, b: number) => void
}) {
  const { data } = useCrossform(collection)
  const [open, setOpen] = useState<'labels' | 'duplicates' | null>(null)
  const labels = data?.labels ?? []
  const duplicates = data?.duplicates ?? []
  if (!labels.length && !duplicates.length) return null

  const toggle = (k: 'labels' | 'duplicates', n: number, text: string, Icon: typeof Tags) =>
    n > 0 && (
      <button
        type='button'
        aria-expanded={open === k}
        data-crossform-toggle={k}
        onClick={() => setOpen(open === k ? null : k)}
        className={cn(
          chip,
          open === k
            ? 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-100'
            : 'text-amber-800 hover:bg-amber-100/70 dark:text-amber-200 dark:hover:bg-amber-500/10'
        )}
      >
        <Icon className='h-3.5 w-3.5' />
        {text}
        {open === k ? <ChevronDown className='h-3 w-3' /> : <ChevronRight className='h-3 w-3' />}
      </button>
    )

  return (
    <div
      data-crossform-findings=''
      className='shrink-0 border-b border-amber-200 bg-amber-50/60 dark:border-amber-500/25 dark:bg-[#211a0e]'
    >
      <div className='flex flex-wrap items-center gap-1 px-3 py-1.5'>
        <span className='px-1 text-[12px] font-semibold text-amber-900 dark:text-amber-100'>
          Across forms
        </span>
        {toggle(
          'labels',
          labels.length,
          `${plural(labels.length, 'field')} labelled differently`,
          Tags
        )}
        {toggle(
          'duplicates',
          duplicates.length,
          duplicates.length === 1
            ? '2 forms are near copies'
            : `${duplicates.length} pairs of near copies`,
          Copy
        )}
      </div>
      {open && (
        <div className='max-h-[320px] overflow-y-auto border-t border-amber-200 bg-white dark:border-amber-500/25 dark:bg-card'>
          <ul className={listCls}>
            {open === 'labels'
              ? labels.map((f) => <LabelRow key={f.field} finding={f} collection={collection} />)
              : duplicates.map((p) => (
                  <DuplicateRow
                    key={`${p.a.id}-${p.b.id}`}
                    pair={p}
                    collection={collection}
                    onOpen={onOpen}
                    onCompare={onCompare}
                  />
                ))}
          </ul>
        </div>
      )}
    </div>
  )
}
