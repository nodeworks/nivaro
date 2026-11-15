import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  GitMerge,
  Layers,
  Loader2,
  Lock,
  Pencil,
  Undo2
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useItemNavigation, useNivaroClient } from '../../context'
import { get, patch as patchCmd, post } from '../../lib/commands'
import { cn, formatDate } from '../../lib/utils'
import { ErrorNotice } from '../ErrorNotice'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Skeleton } from '../ui/skeleton'
import { Textarea } from '../ui/textarea'
import {
  combineValues,
  defaultPicks,
  defaultRoles,
  differingFields,
  displayValue,
  type FieldPick,
  firstSurvivor,
  isEmptyValue,
  type MergePlan,
  type MergePlanField,
  type MergePlanRecord,
  type MergePlanRelation,
  plural,
  type RecordRole,
  relationTotal,
  sameValue,
  survivorChanges
} from './merge-values'

/**
 * Merge records (Rob 2026-11-14): "choose fields from each, a true merge, not just choose
 * one or the other, and decide which one to keep and which to discard".
 *
 * One column per record and a Result column. Per field the person picks the value from
 * ANY record, combines them (long text by line, rich text by paragraph, tags and
 * multi-selects as a union — lib/field-merge.ts) or types a new one. Per record: Keep (one
 * survivor: its id, number and history stay), Discard (to the trash, restorable) or Leave
 * alone. Per relation: move what hangs off the discarded records to the kept one, or
 * leave it. Then a review, then the merge — one server call (api routes/record-merge.ts,
 * judged as the person) — and an Undo for 24 hours.
 *
 * `draft`: the unsaved record of a create form (the duplicate notice's "Merge…"): it shows
 * as a column whose values can be picked, can never be kept, and is never saved.
 */

export const DRAFT_ID = '__draft__'

/** How a record is named on the screen: its number (#69, or the business id) first. */
export const refOf = (r: { ref?: string; id: string; draft?: boolean }) =>
  r.draft ? 'New' : r.ref || `#${r.id}`

/** "#69 Fiber splice — Dover hub" (the number alone when the label is just the number). */
const fullName = (r: { ref?: string; id: string; label: string; draft?: boolean }) => {
  const ref = refOf(r)
  return r.label && r.label !== ref ? `${ref} ${r.label}` : ref
}

/** A server refusal's code and sentence, from either client error shape. */
interface Refusal {
  code: string | null
  message: string
  record: string | null
  changedBy: string | null
}

function refusalOf(err: unknown): Refusal | null {
  type Body = { code?: unknown; error?: unknown; record?: unknown; changed_by?: unknown }
  const r = (err as { response?: Body & { data?: Body } } | null)?.response
  if (!r) return null
  const pick = (k: keyof Body) => {
    const v = r[k] ?? r.data?.[k]
    return typeof v === 'string' ? v : null
  }
  return {
    code: pick('code'),
    message: pick('error') ?? '',
    record: pick('record'),
    changedBy: pick('changed_by')
  }
}

export interface MergeDoneInfo {
  survivor: string
  merge_id: string | null
  discarded: string[]
}

interface ApplyAnswer {
  merge_id: string
  survivor: string
  discarded: string[]
  kept: string[]
  fields_changed: string[]
  moved: number
  undo_until: string
}

interface UndoAnswer {
  restored: string[]
  kept_fields: string[]
  problems: string[]
}

export function MergeRecordsDialog({
  collection,
  ids,
  open,
  onOpenChange,
  draft,
  preferredSurvivor,
  onMerged,
  container
}: {
  collection: string
  ids: Array<string | number>
  open: boolean
  onOpenChange: (open: boolean) => void
  draft?: { values: Record<string, unknown>; label?: string } | null
  preferredSurvivor?: string | number | null
  /** After a merge (or an undo) — refresh lists, leave a create form. */
  onMerged?: (info: MergeDoneInfo) => void
  container?: HTMLElement | null
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        container={container}
        data-merge-records
        className='flex max-h-[min(92vh,940px)] w-[min(1320px,96vw)] max-w-none flex-col overflow-hidden p-0 dark:bg-card max-sm:h-[100dvh] max-sm:max-h-none max-sm:w-screen max-sm:rounded-none'
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        {open && (
          <MergeBody
            collection={collection}
            ids={ids.map(String)}
            draft={draft ?? null}
            preferredSurvivor={preferredSurvivor != null ? String(preferredSurvivor) : null}
            onClose={() => onOpenChange(false)}
            onMerged={onMerged}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MergeBody({
  collection,
  ids,
  draft,
  preferredSurvivor,
  onClose,
  onMerged
}: {
  collection: string
  ids: string[]
  draft: { values: Record<string, unknown>; label?: string } | null
  preferredSurvivor: string | null
  onClose: () => void
  onMerged?: (info: MergeDoneInfo) => void
}) {
  const client = useNivaroClient()
  const [step, setStep] = useState<Step>('choose')
  const planQuery = useQuery({
    queryKey: ['record-merge-plan', collection, ids.join(','), draft ? 'draft' : ''],
    queryFn: () =>
      client
        .request<{ data: MergePlan }>(
          get(`/record-merge/${collection}/plan`, {
            ids: ids.join(','),
            ...(draft ? { draft: '1' } : {})
          })
        )
        .then((r) => r.data),
    staleTime: 0,
    gcTime: 0,
    retry: false
  })
  const plan = planQuery.data
  const records = useMemo<MergePlanRecord[]>(() => {
    if (!plan) return []
    if (!draft) return plan.records
    const values: Record<string, unknown> = {}
    for (const f of plan.fields) values[f.field] = draft.values[f.field] ?? null
    return [
      ...plan.records,
      {
        id: DRAFT_ID,
        label: draft.label?.trim() || 'Your new record',
        values,
        state: null,
        can_survive: false,
        survive_reason: 'It is not saved yet — keep the existing record instead.',
        can_discard: true,
        discard_reason: null,
        partner: null,
        open_tasks: 0,
        open_approvals: 0,
        draft: true
      }
    ]
  }, [plan, draft])

  return (
    <>
      <header className='shrink-0 border-b border-slate-200 px-6 pb-4 pt-5 pr-12 dark:border-border max-sm:px-4'>
        <DialogTitle className='flex items-center gap-2 text-[16px] font-semibold text-slate-900 dark:text-foreground'>
          <GitMerge className='h-4 w-4 text-nvr-cyan' aria-hidden />
          {plan
            ? draft
              ? `Merge your new ${plan.noun} into an existing one`
              : `Merge ${records.length} ${plan.plural}`
            : 'Merge records'}
        </DialogTitle>
        <DialogDescription
          className={cn(
            'mt-1 max-w-[72ch] text-[12.5px] leading-relaxed text-slate-500 dark:text-muted-foreground',
            step === 'done' && 'sr-only'
          )}
        >
          {step === 'review'
            ? 'Check what will change before you merge.'
            : step === 'done'
              ? 'The merge is finished.'
              : 'Pick each value from any record, combine them, or type a new one. The record you keep keeps its number and history; the ones you discard go to the trash and can be restored.'}
        </DialogDescription>
      </header>
      {planQuery.isLoading && <PlanSkeleton />}
      {planQuery.isError && (
        <div className='p-6'>
          <ErrorNotice
            error={planQuery.error}
            fallback='Could not open the merge'
            onRetry={() => void planQuery.refetch()}
          />
        </div>
      )}
      {plan && (
        <MergeEditor
          collection={collection}
          plan={plan}
          records={records}
          draft={!!draft}
          preferredSurvivor={preferredSurvivor}
          onClose={onClose}
          onMerged={onMerged}
          onStale={() => planQuery.refetch()}
          onStep={setStep}
        />
      )}
    </>
  )
}

function PlanSkeleton() {
  return (
    <div className='flex-1 space-y-3 overflow-hidden p-6' aria-busy='true'>
      <div className='grid grid-cols-[12rem_1fr_1fr_1.2fr] gap-3'>
        {['a', 'b', 'c', 'd'].map((k) => (
          <Skeleton key={k} className='h-16 rounded-lg' />
        ))}
      </div>
      {['1', '2', '3', '4', '5', '6', '7'].map((row) => (
        <div key={row} className='grid grid-cols-[12rem_1fr_1fr_1.2fr] gap-3'>
          {['a', 'b', 'c', 'd'].map((k) => (
            <Skeleton key={`${row}${k}`} className='h-9 rounded-md' />
          ))}
        </div>
      ))}
    </div>
  )
}

type Step = 'choose' | 'review' | 'done'

function MergeEditor({
  collection,
  plan,
  records,
  draft,
  preferredSurvivor,
  onClose,
  onMerged,
  onStale,
  onStep
}: {
  collection: string
  plan: MergePlan
  records: MergePlanRecord[]
  draft: boolean
  preferredSurvivor: string | null
  onClose: () => void
  onMerged?: (info: MergeDoneInfo) => void
  /** Someone changed a record since the screen opened: read the records again. */
  onStale: () => Promise<unknown>
  /** The step shown (the dialog header follows it). */
  onStep?: (step: Step) => void
}) {
  const client = useNivaroClient()
  const nav = useItemNavigation()
  const initial = firstSurvivor(records, preferredSurvivor)
  const [survivor, setSurvivor] = useState<string | null>(initial)
  const [roles, setRoles] = useState<Record<string, RecordRole>>(() =>
    defaultRoles(records, initial ?? '')
  )
  const [picks, setPicks] = useState<Record<string, FieldPick>>(() =>
    defaultPicks(plan, initial ?? '', records)
  )
  const [touched, setTouched] = useState<Set<string>>(() => new Set())
  const [moves, setMoves] = useState<Record<string, 'move' | 'leave'>>(() =>
    Object.fromEntries(plan.relations.map((r) => [r.key, r.default]))
  )
  const [showSame, setShowSame] = useState(false)
  const [step, setStep] = useState<Step>('choose')
  useEffect(() => onStep?.(step), [step, onStep])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState<{ answer: ApplyAnswer | null; undo: UndoAnswer | null } | null>(
    null
  )

  // Someone else changed a record while the person was merging (409 MERGE_STALE): the
  // columns are read again and the picks kept wherever that field did not change.
  const [stale, setStale] = useState<{
    who: string | null
    record: string | null
    message: string
  } | null>(null)
  /** `<record id>\u0001<field>` of every value someone else changed (marked in the grid). */
  const [changedCells, setChangedCells] = useState<Set<string>>(() => new Set())
  const prevRecords = useRef(records)
  useEffect(() => {
    const prev = prevRecords.current
    if (prev === records) return
    prevRecords.current = records
    const before = new Map(prev.map((r) => [r.id, r]))
    const cells = new Set<string>()
    for (const f of plan.fields)
      for (const r of records)
        if (!r.draft && !sameValue(before.get(r.id)?.values[f.field], r.values[f.field]))
          cells.add(`${r.id}\u0001${f.field}`)
    setChangedCells(cells)
    const changedFields = plan.fields
      .filter((f) => records.some((r) => cells.has(`${r.id}\u0001${f.field}`)))
      .map((f) => f.field)
    if (changedFields.length === 0) return
    const fresh = defaultPicks(plan, survivor ?? '', records)
    setPicks((cur) => {
      const next = { ...cur }
      for (const f of changedFields) next[f] = fresh[f]
      return next
    })
    setTouched((cur) => {
      const next = new Set(cur)
      for (const f of changedFields) next.delete(f)
      return next
    })
  }, [records, plan, survivor])

  const byId = useMemo(() => new Map(records.map((r) => [r.id, r])), [records])
  const differing = useMemo(() => differingFields(plan, records), [plan, records])
  const discarded = records.filter((r) => roles[r.id] === 'discard')
  const realDiscarded = discarded.filter((r) => !r.draft)
  const leftAlone = records.filter((r) => roles[r.id] === 'leave')
  const keep = survivor ? byId.get(survivor) : undefined

  // A new survivor: the fields still on their starting value follow it.
  const chooseSurvivor = (id: string) => {
    if (id === survivor) return
    const fresh = defaultPicks(plan, id, records)
    setPicks((prev) => {
      const next: Record<string, FieldPick> = {}
      for (const f of plan.fields)
        next[f.field] = touched.has(f.field) && f.writable ? prev[f.field] : fresh[f.field]
      return next
    })
    setRoles((prev) => {
      const next = { ...prev }
      for (const r of records) {
        if (r.id === id) next[r.id] = 'keep'
        else if (prev[r.id] === 'keep') next[r.id] = r.can_discard ? 'discard' : 'leave'
      }
      return next
    })
    setSurvivor(id)
  }
  const setRole = (id: string, role: RecordRole) => {
    if (role === 'keep') return chooseSurvivor(id)
    setRoles((prev) => ({ ...prev, [id]: role }))
    // A record left out of the merge lends no values: its picks go back to the kept record.
    if (role === 'leave' && survivor) {
      const s0 = records.find((r) => r.id === survivor)
      setPicks((prev) => {
        const next = { ...prev }
        for (const f of plan.fields)
          if (next[f.field]?.source === id)
            next[f.field] = { source: survivor, value: s0?.values[f.field] ?? null }
        return next
      })
    }
  }
  const pick = (field: string, p: FieldPick) => {
    setPicks((prev) => ({ ...prev, [field]: p }))
    setTouched((prev) => new Set(prev).add(field))
  }

  const changes = useMemo(
    () => (survivor ? survivorChanges(plan, survivor, picks, records) : {}),
    [plan, survivor, picks, records]
  )
  const changeCount = Object.keys(changes).length
  const movingRelations = plan.relations.filter(
    (r) =>
      relationTotal(
        r,
        realDiscarded.map((d) => d.id)
      ) > 0
  )
  const movedRows = movingRelations
    .filter((r) => moves[r.key] === 'move')
    .reduce(
      (n, r) =>
        n +
        relationTotal(
          r,
          realDiscarded.map((d) => d.id)
        ),
      0
    )
  const blockedMove = movingRelations.find((r) => moves[r.key] === 'move' && !r.movable)
  const partnerWarnings = realDiscarded.filter((r) => r.partner)
  const openApprovals = realDiscarded.reduce((n, r) => n + r.open_approvals, 0)
  const nothingToDiscard = discarded.length === 0
  // Two records and the other one may not be discarded: offer the swap in one click.
  const swap = (() => {
    if (!keep || !nothingToDiscard) return null
    const real = records.filter((r) => !r.draft)
    if (real.length !== 2) return null
    const other = real.find((r) => r.id !== keep.id)
    if (!other || other.can_discard || !other.can_survive || !keep.can_discard) return null
    return { keep, other }
  })()
  const canReview = !!keep && !nothingToDiscard && !blockedMove

  const visibleFields = plan.fields.filter((f) => showSame || differing.has(f.field))
  const sameCount = plan.fields.length - differing.size

  const apply = async () => {
    if (!survivor) return
    setBusy(true)
    setError(null)
    try {
      if (realDiscarded.length === 0) {
        // Only the unsaved draft goes: the kept record simply takes the picked values.
        if (changeCount > 0)
          await client.request(
            patchCmd(`/items/${collection}/${encodeURIComponent(survivor)}`, changes)
          )
        setDone({ answer: null, undo: null })
        onMerged?.({ survivor, merge_id: null, discarded: [] })
      } else {
        const relations: Record<string, 'move' | 'leave'> = {}
        for (const r of movingRelations) relations[r.key] = moves[r.key] ?? r.default
        const r = await client.request<{ data: ApplyAnswer }>(
          post(`/record-merge/${collection}/apply`, {
            survivor,
            discard: realDiscarded.map((d) => d.id),
            keep: leftAlone.filter((d) => !d.draft).map((d) => d.id),
            values: changes,
            relations,
            // A record changed since this screen read it is refused (409 MERGE_STALE).
            stamps: Object.fromEntries(
              records.filter((x) => !x.draft && x.stamp).map((x) => [x.id, x.stamp])
            ),
            opened_at: plan.read_at
          })
        )
        setDone({ answer: r.data, undo: null })
        onMerged?.({ survivor, merge_id: r.data.merge_id, discarded: r.data.discarded })
      }
      setStep('done')
      setStale(null)
      setChangedCells(new Set())
    } catch (err) {
      const refusal = refusalOf(err)
      if (refusal?.code === 'MERGE_STALE') {
        setStale({ who: refusal.changedBy, record: refusal.record, message: refusal.message })
        setStep('choose')
        await onStale()
      } else setError(err)
    } finally {
      setBusy(false)
    }
  }

  const undo = async () => {
    if (!done?.answer) return
    setBusy(true)
    setError(null)
    try {
      const r = await client.request<{ data: UndoAnswer }>(
        post(`/record-merge/undo/${done.answer.merge_id}`, {})
      )
      setDone({ ...done, undo: r.data })
      onMerged?.({ survivor: done.answer.survivor, merge_id: null, discarded: [] })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (step === 'done' && keep)
    return (
      <DoneView
        keep={keep}
        discarded={realDiscarded}
        answer={done?.answer ?? null}
        undone={done?.undo ?? null}
        busy={busy}
        error={error}
        noun={plan.noun}
        draft={draft}
        onUndo={() => void undo()}
        onOpen={(id) => {
          onClose()
          nav.open({ collection, itemId: id })
        }}
        onClose={onClose}
      />
    )

  return (
    <>
      <div className='min-h-0 flex-1 overflow-auto overscroll-contain' data-merge-step={step}>
        {step === 'choose' ? (
          <div className='px-6 pb-8 max-sm:px-4' data-merge-grid>
            {stale && (
              <StaleCallout
                stale={stale}
                record={records.find((r) => r.id === stale.record) ?? null}
                fields={plan.fields
                  .filter((f) => changedCells.has(`${stale.record}\u0001${f.field}`))
                  .map((f) => f.label)}
              />
            )}
            <RecordHeaders
              records={records}
              roles={roles}
              onRole={setRole}
              resultLabel={keep ? fullName(keep) : null}
            />
            {visibleFields.length === 0 && (
              <p className='py-8 text-center text-[13px] text-slate-500 dark:text-muted-foreground'>
                Every field holds the same value in all of these records.
              </p>
            )}
            <div className='divide-y divide-slate-100 dark:divide-border'>
              {visibleFields.map((f) => (
                <FieldRow
                  key={f.field}
                  field={f}
                  records={records}
                  roles={roles}
                  survivor={survivor}
                  pickValue={picks[f.field]}
                  labels={plan.labels[f.field]}
                  onPick={(p) => pick(f.field, p)}
                  changed={changedCells}
                />
              ))}
            </div>
            {sameCount > 0 && (
              <button
                type='button'
                onClick={() => setShowSame((v) => !v)}
                className='mt-3 rounded-sm text-[12px] font-medium text-slate-500 underline decoration-slate-300 underline-offset-4 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:decoration-border dark:hover:text-foreground'
                data-merge-show-same
              >
                {showSame
                  ? 'Hide the fields that are the same'
                  : `Show ${plural(sameCount, 'field')} that ${sameCount === 1 ? 'is' : 'are'} the same in every record`}
              </button>
            )}
            {movingRelations.length > 0 && (
              <RelationsSection
                relations={movingRelations}
                discarded={realDiscarded}
                moves={moves}
                onMove={(key, v) => setMoves((prev) => ({ ...prev, [key]: v }))}
                keepLabel={keep ? fullName(keep) : 'the kept record'}
                keepRef={keep ? refOf(keep) : 'the kept record'}
              />
            )}
            {(openApprovals > 0 || realDiscarded.some((r) => r.open_tasks > 0)) && (
              <p className='mt-4 max-w-[72ch] text-[12px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
                {openApprovals > 0 &&
                  `${plural(openApprovals, 'open approval')} on the discarded records ${openApprovals === 1 ? 'is' : 'are'} closed with a merge note. `}
                {keep?.state && `${refOf(keep)} stays at ${keep.state.label}.`}
              </p>
            )}
          </div>
        ) : (
          <ReviewView
            plan={plan}
            keep={keep}
            discarded={discarded}
            leftAlone={leftAlone}
            changes={changes}
            picks={picks}
            byId={byId}
            relations={movingRelations}
            moves={moves}
            partnerWarnings={partnerWarnings}
            openApprovals={openApprovals}
            draft={draft}
          />
        )}
      </div>
      <footer className='shrink-0 border-t border-slate-200 bg-slate-50/80 px-6 py-3 dark:border-border dark:bg-muted/30 max-sm:px-4'>
        {error != null && <ErrorNotice error={error} fallback='Could not merge' className='mb-3' />}
        <div className='flex flex-wrap items-center gap-x-4 gap-y-2'>
          <p
            className='min-w-0 flex-1 text-[12.5px] text-slate-600 dark:text-muted-foreground max-sm:basis-full'
            aria-live='polite'
          >
            {!keep ? (
              'Choose the record to keep.'
            ) : nothingToDiscard ? (
              swap ? (
                <span className='flex flex-wrap items-center gap-x-2 gap-y-1'>
                  <span>{swap.other.ref} cannot be discarded.</span>
                  <button
                    type='button'
                    onClick={() => {
                      chooseSurvivor(swap.other.id)
                      setRole(swap.keep.id, 'discard')
                    }}
                    className='font-medium text-nvr-cyan-dark underline decoration-nvr-cyan/40 underline-offset-2 hover:decoration-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-nvr-cyan'
                    data-merge-swap
                  >
                    Keep {swap.other.ref} instead and discard {swap.keep.ref}
                  </button>
                </span>
              ) : (
                'Choose at least one record to discard.'
              )
            ) : blockedMove ? (
              <span className='text-amber-700 dark:text-amber-400'>
                {blockedMove.label}: {blockedMove.reason}
              </span>
            ) : (
              <>
                <span className='sm:hidden'>
                  Keep{' '}
                  <strong className='font-medium text-slate-900 dark:text-foreground'>
                    {refOf(keep)}
                  </strong>
                  {` · discard ${discarded.length} · ${changeCount === 0 ? 'no changes' : plural(changeCount, 'change')}`}
                  {movedRows > 0 && ` · ${plural(movedRows, 'row')} move`}
                </span>
                <span className='max-sm:hidden'>
                  Keep{' '}
                  <strong className='font-medium text-slate-900 dark:text-foreground'>
                    {refOf(keep)}
                  </strong>
                  {' · '}
                  discard {discarded.length}
                  {' · '}
                  {changeCount === 0
                    ? 'no field changes'
                    : `${plural(changeCount, 'field')} change`}
                  {movedRows > 0 && ` · ${plural(movedRows, 'linked row')} move`}
                </span>
              </>
            )}
          </p>
          <div className='flex items-center gap-2 max-sm:ml-auto'>
            {step === 'review' ? (
              <Button
                type='button'
                variant='outline'
                size='sm'
                className='dark:bg-transparent'
                onClick={() => setStep('choose')}
                disabled={busy}
              >
                Back
              </Button>
            ) : (
              <Button type='button' variant='ghost' size='sm' onClick={onClose}>
                Cancel
              </Button>
            )}
            {step === 'choose' ? (
              <Button
                type='button'
                size='sm'
                className='gap-1.5 bg-nvr-cyan text-white hover:bg-nvr-cyan-dark disabled:bg-slate-200 disabled:text-slate-500 disabled:opacity-100 dark:disabled:bg-muted dark:disabled:text-muted-foreground'
                disabled={!canReview}
                onClick={() => {
                  setError(null)
                  setStep('review')
                }}
                data-merge-review
              >
                Review merge
                <ArrowRight className='h-3.5 w-3.5' aria-hidden />
              </Button>
            ) : (
              <Button
                type='button'
                size='sm'
                className='gap-1.5 bg-nvr-cyan text-white hover:bg-nvr-cyan-dark disabled:bg-slate-200 disabled:text-slate-500 disabled:opacity-100 dark:disabled:bg-muted dark:disabled:text-muted-foreground'
                disabled={busy || !canReview}
                onClick={() => void apply()}
                data-merge-apply
              >
                {busy ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden />
                ) : (
                  <GitMerge className='h-3.5 w-3.5' aria-hidden />
                )}
                {busy
                  ? 'Merging…'
                  : realDiscarded.length === 0
                    ? `Save into ${keep?.label ?? 'the record'}`
                    : `Merge ${discarded.length + 1} ${plan.plural}`}
              </Button>
            )}
          </div>
        </div>
      </footer>
    </>
  )
}

/** Someone changed a record while the person was merging: who, which record, which fields. */
function StaleCallout({
  stale,
  record,
  fields
}: {
  stale: { who: string | null; record: string | null; message: string }
  record: MergePlanRecord | null
  fields: string[]
}) {
  return (
    <div
      className='mt-4 flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-[12.5px] leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100'
      role='status'
      data-merge-stale
    >
      <AlertTriangle
        className='mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400'
        aria-hidden
      />
      <div className='min-w-0'>
        {record ? (
          <p>
            <strong className='font-semibold'>{stale.who ?? 'Someone'}</strong> changed{' '}
            <strong className='font-semibold'>{fullName(record)}</strong>
            {fields.length > 0 && ` (${fields.join(', ')})`} while you were merging.
          </p>
        ) : (
          <p>{stale.message}</p>
        )}
        <p className='mt-0.5 text-amber-800/90 dark:text-amber-200/80'>
          The columns now show it as it is — changed values are marked. Your choices are kept
          wherever that field did not change; review them and merge again.
        </p>
      </div>
    </div>
  )
}

// ─── Columns ────────────────────────────────────────────────────────────────

const gridCols = (n: number) => ({
  gridTemplateColumns: `minmax(8.5rem, 12rem) repeat(${n}, minmax(10rem, 1fr)) minmax(13rem, 1.25fr)`
})

function RecordHeaders({
  records,
  roles,
  onRole,
  resultLabel
}: {
  records: MergePlanRecord[]
  roles: Record<string, RecordRole>
  onRole: (id: string, role: RecordRole) => void
  resultLabel: string | null
}) {
  return (
    <div
      className='z-10 -mx-6 mb-1 md:sticky md:top-0 border-b border-slate-200 bg-white/95 px-6 pb-3 pt-4 backdrop-blur-sm dark:border-border dark:bg-card/95 max-sm:-mx-4 max-sm:px-4'
      data-merge-headers
    >
      <div className='hidden gap-3 md:grid' style={gridCols(records.length)}>
        <div />
        {records.map((r) => (
          <RecordHeader key={r.id} record={r} role={roles[r.id]} onRole={(v) => onRole(r.id, v)} />
        ))}
        <div className='flex min-w-0 flex-col justify-start self-stretch rounded-lg border border-nvr-cyan/30 bg-nvr-cyan/[0.06] px-3 py-2'>
          <span className='text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
            Result
          </span>
          <span className='truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {resultLabel ? `${resultLabel} after the merge` : 'Choose a record to keep'}
          </span>
        </div>
      </div>
      <div className='space-y-2 md:hidden'>
        {records.map((r) => (
          <RecordHeader key={r.id} record={r} role={roles[r.id]} onRole={(v) => onRole(r.id, v)} />
        ))}
      </div>
    </div>
  )
}

const ROLE_WORDS: Record<RecordRole, string> = {
  keep: 'Keep',
  discard: 'Discard',
  leave: 'Not in this merge'
}

function RecordHeader({
  record,
  role,
  onRole
}: {
  record: MergePlanRecord
  role: RecordRole
  onRole: (role: RecordRole) => void
}) {
  const options: Array<{ role: RecordRole; disabled: string | null }> = [
    { role: 'keep', disabled: record.can_survive ? null : record.survive_reason },
    {
      role: 'discard',
      disabled: record.draft ? null : record.can_discard ? null : record.discard_reason
    },
    {
      role: 'leave',
      disabled: record.draft ? 'It is not saved yet — it is never kept.' : null
    }
  ]
  return (
    <div
      className={cn(
        'min-w-0 rounded-lg border px-3 py-2 transition-colors',
        role === 'keep'
          ? 'border-nvr-cyan/50 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06)] dark:bg-card'
          : role === 'discard'
            ? 'border-dashed border-slate-300 bg-slate-50 dark:border-border dark:bg-muted/40'
            : 'border-dashed border-slate-200 bg-slate-50/60 dark:border-border dark:bg-muted/20'
      )}
      data-merge-record={record.id}
      data-merge-role={role}
    >
      <div className='flex min-w-0 items-baseline gap-2'>
        <span
          className={cn(
            'shrink-0 text-[13px] font-semibold tabular-nums',
            role === 'discard' && !record.draft
              ? 'text-slate-500 line-through decoration-slate-300 dark:text-muted-foreground dark:decoration-border'
              : 'text-slate-900 dark:text-foreground'
          )}
        >
          {refOf(record)}
        </span>
        <span
          className='min-w-0 truncate text-[12.5px] text-slate-600 dark:text-muted-foreground'
          title={record.label}
        >
          {record.label}
        </span>
        {record.draft && (
          <span className='shrink-0 rounded bg-amber-100 px-1.5 py-px text-[10.5px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'>
            Not saved
          </span>
        )}
      </div>
      {(record.created_at || record.state) && (
        <div className='mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
          {record.created_at && (
            <span className='tabular-nums'>Created {formatDate(record.created_at)}</span>
          )}
          {record.state && (
            <span className='inline-flex min-w-0 shrink items-center gap-1'>
              <span
                className='h-1.5 w-1.5 shrink-0 rounded-full'
                style={{ background: record.state.color ?? '#94a3b8' }}
                aria-hidden
              />
              <span className='truncate'>{record.state.label}</span>
            </span>
          )}
        </div>
      )}
      <div
        role='radiogroup'
        aria-label={`What happens to ${record.label}`}
        className='mt-2 inline-flex max-w-full rounded-md border border-slate-200 bg-slate-100/70 p-0.5 dark:border-border dark:bg-muted/60'
      >
        {options.map((o) => {
          const on = role === o.role
          return (
            // biome-ignore lint/a11y/useSemanticElements: a segmented choice drawn as buttons, not a form input
            <button
              key={o.role}
              type='button'
              role='radio'
              aria-checked={on}
              disabled={!!o.disabled}
              data-tip={o.disabled ?? undefined}
              onClick={() => onRole(o.role)}
              className={cn(
                'h-6 whitespace-nowrap rounded px-2 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-40',
                on
                  ? o.role === 'keep'
                    ? 'bg-nvr-cyan text-white shadow-sm'
                    : o.role === 'discard'
                      ? 'bg-white text-red-700 shadow-sm dark:bg-card dark:text-red-400'
                      : 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-foreground'
                  : 'text-slate-600 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
              )}
            >
              {ROLE_WORDS[o.role]}
            </button>
          )
        })}
      </div>
      {role === 'discard' && record.partner && (
        <p className='mt-1.5 flex gap-1 text-[11px] leading-snug text-amber-700 dark:text-amber-400'>
          <AlertTriangle className='mt-px h-3 w-3 shrink-0' aria-hidden />
          {record.partner.warning}
        </p>
      )}
      {role !== 'discard' &&
        !record.draft &&
        [
          ...new Set(
            [
              record.can_survive ? null : record.survive_reason,
              record.can_discard ? null : record.discard_reason
            ].filter((x): x is string => !!x)
          )
        ].map((reason) => (
          <p
            key={reason}
            className='mt-1.5 flex gap-1 text-[11px] leading-snug text-slate-500 dark:text-muted-foreground'
            data-merge-record-reason
          >
            <Lock className='mt-px h-3 w-3 shrink-0' aria-hidden />
            {reason}
          </p>
        ))}
    </div>
  )
}

const TEXT_TYPES = new Set(['string', 'text', 'uuid', 'csv'])
const NUMBER_TYPES = new Set(['integer', 'bigInteger', 'float', 'decimal'])

function editorKind(f: MergePlanField): 'text' | 'long' | 'number' | 'date' | 'choice' | null {
  if (!f.writable || f.relation) return null
  if (f.choices?.length) return /multiple|checkbox|tags/.test(f.interface ?? '') ? null : 'choice'
  if (NUMBER_TYPES.has(f.type)) return 'number'
  if (f.type === 'date') return 'date'
  if (f.type === 'text' || /textarea|markdown|code|multiline/.test(f.interface ?? '')) return 'long'
  if (TEXT_TYPES.has(f.type)) return 'text'
  return null
}

function FieldRow({
  field,
  records,
  roles,
  survivor,
  pickValue,
  labels,
  onPick,
  changed
}: {
  field: MergePlanField
  records: MergePlanRecord[]
  roles: Record<string, RecordRole>
  survivor: string | null
  pickValue: FieldPick | undefined
  labels: Record<string, string> | undefined
  onPick: (p: FieldPick) => void
  /** Values someone else changed while the screen was open (`<id>\u0001<field>`). */
  changed?: ReadonlySet<string>
}) {
  const [editing, setEditing] = useState(false)
  // A record left out of the merge lends nothing: its values do not combine either.
  const values = records.filter((r) => roles[r.id] !== 'leave').map((r) => r.values[field.field])
  const combined = useMemo(() => combineValues(field, values), [field, values])
  const canCombine =
    field.writable && combined != null && !values.some((v) => sameValue(v, combined))
  const kind = editorKind(field)
  const result = pickValue?.value
  const sourceLabel =
    pickValue?.source === 'combined'
      ? 'Combined'
      : pickValue?.source === 'custom'
        ? 'Typed'
        : (() => {
            const r = records.find((x) => x.id === pickValue?.source)
            return r ? refOf(r) : undefined
          })()
  // Leaving edit mode when the pick moves elsewhere.
  useEffect(() => {
    if (pickValue?.source !== 'custom') setEditing(false)
  }, [pickValue?.source])

  return (
    <div
      className='grid gap-x-3 gap-y-1.5 py-2.5 max-md:!grid-cols-1'
      style={gridCols(records.length)}
      data-merge-field={field.field}
    >
      <div className='flex min-w-0 items-start gap-1.5 pt-1.5'>
        <span className='text-[12.5px] font-medium text-slate-700 dark:text-foreground/90'>
          {field.label}
        </span>
        {!field.writable && (
          <Lock
            className='mt-0.5 h-3 w-3 shrink-0 text-slate-400'
            aria-label='You cannot change this field'
            data-tip='You cannot change this field — the kept record’s value stays.'
          />
        )}
      </div>
      {records.map((r) => {
        const v = r.values[field.field]
        const text = displayValue(field, v, labels)
        const chosen = pickValue?.source === r.id
        const left = roles[r.id] === 'leave'
        const disabled = left || (!field.writable && r.id !== survivor)
        const isChanged = !!changed?.has(`${r.id}\u0001${field.field}`)
        return (
          // biome-ignore lint/a11y/useSemanticElements: a segmented choice drawn as buttons, not a form input
          <button
            key={r.id}
            type='button'
            role='radio'
            aria-checked={chosen}
            aria-label={`${field.label} from ${refOf(r)}: ${text ?? 'empty'}${isChanged ? ' (changed)' : ''}`}
            disabled={disabled}
            onClick={() => onPick({ source: r.id, value: v ?? null })}
            className={cn(
              'group relative flex min-w-0 items-start gap-2 rounded-md border px-2.5 py-1.5 text-left text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-default',
              chosen
                ? 'border-nvr-cyan bg-nvr-cyan/[0.07] text-slate-900 dark:text-foreground'
                : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-foreground/85 dark:hover:border-slate-500 dark:hover:bg-muted/50',
              roles[r.id] === 'discard' && !chosen && 'opacity-80',
              disabled &&
                'opacity-60 hover:border-slate-200 hover:bg-white dark:hover:border-border dark:hover:bg-card',
              left && 'border-dashed opacity-40',
              isChanged && 'ring-2 ring-amber-400/70 dark:ring-amber-400/60'
            )}
            data-merge-cell={r.id}
          >
            <span
              className={cn(
                'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                chosen
                  ? 'border-nvr-cyan bg-nvr-cyan text-white'
                  : 'border-slate-400 bg-white dark:border-slate-400 dark:bg-card'
              )}
              aria-hidden
            >
              {chosen && <Check className='h-2.5 w-2.5' strokeWidth={3} />}
            </span>
            <span className='min-w-0 flex-1'>
              <span className='mb-0.5 block text-[10.5px] font-medium text-slate-400 md:hidden'>
                {refOf(r)}
              </span>
              {text == null ? (
                <span className='text-slate-400 dark:text-muted-foreground/70'>Empty</span>
              ) : (
                <span className='line-clamp-3 whitespace-pre-line break-words'>{text}</span>
              )}
            </span>
            {isChanged && (
              <span className='shrink-0 rounded bg-amber-100 px-1.5 py-px text-[10.5px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'>
                Changed
              </span>
            )}
          </button>
        )
      })}
      <div
        className='min-w-0 rounded-md border border-nvr-cyan/25 bg-nvr-cyan/[0.04] px-2.5 py-1.5'
        data-merge-result={field.field}
      >
        <span className='mb-0.5 block text-[10.5px] font-medium text-slate-400 md:hidden'>
          Result
        </span>
        {editing && kind ? (
          <ValueEditor
            kind={kind}
            field={field}
            value={result}
            onChange={(v) => onPick({ source: 'custom', value: v })}
          />
        ) : (
          <div className='text-[12.5px] text-slate-900 dark:text-foreground'>
            {isEmptyValue(result) ? (
              <span className='text-slate-400 dark:text-muted-foreground/70'>Empty</span>
            ) : (
              <span className='line-clamp-4 whitespace-pre-line break-words'>
                {displayValue(field, result, labels)}
              </span>
            )}
          </div>
        )}
        <div className='mt-1 flex flex-wrap items-center gap-x-2 gap-y-1'>
          {sourceLabel && (
            <span className='truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
              {pickValue?.source === 'combined' || pickValue?.source === 'custom'
                ? sourceLabel
                : `From ${sourceLabel}`}
            </span>
          )}
          <span className='ml-auto flex items-center gap-1'>
            {canCombine && pickValue?.source !== 'combined' && (
              <button
                type='button'
                onClick={() => onPick({ source: 'combined', value: combined })}
                className='inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] font-medium text-nvr-cyan-dark hover:bg-nvr-cyan/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-nvr-cyan'
                data-merge-combine={field.field}
              >
                <Layers className='h-3 w-3' aria-hidden />
                Combine
              </button>
            )}
            {kind && (
              <button
                type='button'
                onClick={() => {
                  if (!editing) onPick({ source: 'custom', value: result ?? null })
                  setEditing((v) => !v)
                }}
                className='inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] font-medium text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-muted'
                data-merge-edit={field.field}
              >
                {editing ? (
                  <Check className='h-3 w-3' aria-hidden />
                ) : (
                  <Pencil className='h-3 w-3' aria-hidden />
                )}
                {editing ? 'Done' : 'Edit'}
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

function ValueEditor({
  kind,
  field,
  value,
  onChange
}: {
  kind: 'text' | 'long' | 'number' | 'date' | 'choice'
  field: MergePlanField
  value: unknown
  onChange: (v: unknown) => void
}) {
  const s = value == null ? '' : String(value)
  if (kind === 'choice')
    return (
      <SimpleSelect
        value={s}
        onChange={(v) => onChange(v === '' ? null : v)}
        ariaLabel={field.label}
        options={[
          { value: '', label: 'Empty' },
          ...(field.choices ?? []).map((c) => ({ value: String(c.value), label: c.text }))
        ]}
        className='h-8 text-[12.5px]'
      />
    )
  if (kind === 'long')
    return (
      <Textarea
        autoFocus
        value={s}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        aria-label={field.label}
        className='min-h-[84px] bg-white text-[12.5px] dark:bg-background'
      />
    )
  return (
    <Input
      autoFocus
      type={kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'}
      value={kind === 'date' ? s.slice(0, 10) : s}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '') return onChange(null)
        onChange(kind === 'number' ? Number(raw) : raw)
      }}
      aria-label={field.label}
      className='h-8 bg-white text-[12.5px] dark:bg-background'
    />
  )
}

// ─── Relations ──────────────────────────────────────────────────────────────

/** The "leave" choice in words (a many-to-many "keep only" names whose and what). */
function leaveWord(r: MergePlanRelation, keepRef: string): string {
  if (r.kind === 'm2m' || r.kind === 'files')
    return `Keep only ${keepRef}’s ${r.label.toLowerCase()}`
  return r.leave_word
}

function RelationsSection({
  relations,
  discarded,
  moves,
  onMove,
  keepLabel,
  keepRef
}: {
  relations: MergePlanRelation[]
  discarded: MergePlanRecord[]
  moves: Record<string, 'move' | 'leave'>
  onMove: (key: string, v: 'move' | 'leave') => void
  keepLabel: string
  keepRef: string
}) {
  return (
    <section className='mt-8' data-merge-relations>
      <h3 className='text-[13.5px] font-semibold text-slate-900 dark:text-foreground'>
        Linked to the discarded {discarded.length === 1 ? 'record' : 'records'}
      </h3>
      <p className='mt-0.5 max-w-[72ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
        Move them to {keepLabel} so nothing is lost, or leave them with the record that goes to the
        trash.
      </p>
      <div className='mt-3 overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
        {relations.map((r, i) => {
          const choice = moves[r.key] ?? r.default
          const counts = discarded
            .map((d) => ({ d, n: (r.counts[d.id] ?? 0) + (r.hidden[d.id] ?? 0) }))
            .filter((x) => x.n > 0)
          return (
            <div
              key={r.key}
              className={cn(
                'flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5',
                i > 0 && 'border-t border-slate-100 dark:border-border'
              )}
              data-merge-relation={r.key}
            >
              <div className='min-w-[12rem] flex-1'>
                <div className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                  {r.label}
                </div>
                <div className='text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'>
                  {counts.map((x) => `${x.n.toLocaleString()} on ${refOf(x.d)}`).join(' · ')}
                </div>
                {r.reason && (
                  <div
                    className={cn(
                      'mt-0.5 flex gap-1 text-[11.5px]',
                      r.movable
                        ? 'text-slate-500 dark:text-muted-foreground'
                        : 'text-amber-700 dark:text-amber-400'
                    )}
                  >
                    <Lock className='mt-0.5 h-3 w-3 shrink-0' aria-hidden />
                    {r.reason}
                  </div>
                )}
              </div>
              <div
                role='radiogroup'
                aria-label={r.label}
                className='inline-flex rounded-md border border-slate-200 bg-slate-100/70 p-0.5 dark:border-border dark:bg-muted/60'
              >
                {(['move', 'leave'] as const).map((v) => {
                  const on = choice === v
                  const disabled = v === 'move' && !r.movable
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: a segmented choice drawn as buttons, not a form input
                    <button
                      key={v}
                      type='button'
                      role='radio'
                      aria-checked={on}
                      disabled={disabled}
                      onClick={() => onMove(r.key, v)}
                      className={cn(
                        'h-7 whitespace-nowrap rounded px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-40',
                        on
                          ? 'bg-white font-semibold text-slate-900 shadow-sm ring-1 ring-slate-300 dark:bg-slate-700 dark:text-white dark:ring-slate-500'
                          : 'text-slate-600 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
                      )}
                    >
                      {v === 'move' ? r.move_word : leaveWord(r, keepRef)}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ─── Review ─────────────────────────────────────────────────────────────────

function ReviewView({
  plan,
  keep,
  discarded,
  leftAlone,
  changes,
  picks,
  byId,
  relations,
  moves,
  partnerWarnings,
  openApprovals,
  draft
}: {
  plan: MergePlan
  keep: MergePlanRecord | undefined
  discarded: MergePlanRecord[]
  leftAlone: MergePlanRecord[]
  changes: Record<string, unknown>
  picks: Record<string, FieldPick>
  byId: Map<string, MergePlanRecord>
  relations: MergePlanRelation[]
  moves: Record<string, 'move' | 'leave'>
  partnerWarnings: MergePlanRecord[]
  openApprovals: number
  draft: boolean
}) {
  if (!keep) return null
  const changed = plan.fields.filter((f) => f.field in changes)
  const realDiscarded = discarded.filter((d) => !d.draft)
  const names = (rs: MergePlanRecord[]) => rs.map((r) => fullName(r)).join(', ')
  return (
    <div className='space-y-6 px-6 py-6 max-sm:px-4' data-merge-review-view>
      <ul className='space-y-2.5 text-[13px] leading-relaxed text-slate-700 dark:text-foreground/90'>
        <li className='flex gap-2.5'>
          <span className='mt-1.5 h-2 w-2 shrink-0 rounded-full bg-nvr-cyan' aria-hidden />
          <span>
            <strong className='font-semibold text-slate-900 dark:text-foreground'>
              Keep {fullName(keep)}
            </strong>
            {' — '}it keeps its number and history
            {keep.state ? `, and stays at ${keep.state.label}` : ''}.
          </span>
        </li>
        {realDiscarded.length > 0 && (
          <li className='flex gap-2.5'>
            <span className='mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-500' aria-hidden />
            <span>
              <strong className='font-semibold text-slate-900 dark:text-foreground'>
                Discard {names(realDiscarded)}
              </strong>
              {' — '}
              {realDiscarded.length === 1 ? 'it goes' : 'they go'} to the trash with a “Merged into{' '}
              {refOf(keep)}” note, and can be restored.
              {openApprovals > 0 && ` ${plural(openApprovals, 'open approval')} closed.`}
            </span>
          </li>
        )}
        {draft && (
          <li className='flex gap-2.5'>
            <span className='mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500' aria-hidden />
            <span>
              Your new {plan.noun} is not saved — its values go into {fullName(keep)}.
            </span>
          </li>
        )}
        {leftAlone.filter((r) => !r.draft).length > 0 && (
          <li className='flex gap-2.5'>
            <span
              className='mt-1.5 h-2 w-2 shrink-0 rounded-full bg-slate-300 dark:bg-border'
              aria-hidden
            />
            <span>
              <strong className='font-semibold text-slate-900 dark:text-foreground'>
                {names(leftAlone.filter((r) => !r.draft))}: not in this merge
              </strong>{' '}
              — {leftAlone.length === 1 ? 'it stays as it is' : 'they stay as they are'} and
              {leftAlone.length === 1 ? ' lends' : ' lend'} no values.
            </span>
          </li>
        )}
      </ul>

      {partnerWarnings.map((r) => (
        <div
          key={r.id}
          className='flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
          role='note'
        >
          <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
          <span>
            <strong className='font-semibold'>{fullName(r)}:</strong> {r.partner?.warning}
          </span>
        </div>
      ))}

      <section>
        <h3 className='text-[13.5px] font-semibold text-slate-900 dark:text-foreground'>
          {changed.length === 0
            ? `${refOf(keep)} keeps all its values`
            : `${plural(changed.length, 'field')} change on ${refOf(keep)}`}
        </h3>
        {changed.length > 0 && (
          <div className='mt-2 overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
            <table className='w-full text-left text-[12.5px]'>
              <thead className='bg-slate-50 text-[11.5px] text-slate-500 dark:bg-muted/40 dark:text-muted-foreground'>
                <tr>
                  <th className='px-3 py-2 font-medium'>Field</th>
                  <th className='px-3 py-2 font-medium'>Now</th>
                  <th className='px-3 py-2 font-medium'>After the merge</th>
                </tr>
              </thead>
              <tbody>
                {changed.map((f) => {
                  const p = picks[f.field]
                  const from =
                    p?.source === 'combined'
                      ? 'Combined'
                      : p?.source === 'custom'
                        ? 'Typed'
                        : (() => {
                            const r = byId.get(p?.source ?? '')
                            return r ? `From ${refOf(r)}` : ''
                          })()
                  return (
                    <tr
                      key={f.field}
                      className='border-t border-slate-100 align-top dark:border-border'
                    >
                      <td className='px-3 py-2 font-medium text-slate-700 dark:text-foreground/90'>
                        {f.label}
                      </td>
                      <td className='max-w-[18rem] px-3 py-2 text-slate-500 dark:text-muted-foreground'>
                        <span className='line-clamp-3 whitespace-pre-line break-words'>
                          {displayValue(f, keep.values[f.field], plan.labels[f.field]) ?? 'Empty'}
                        </span>
                      </td>
                      <td className='max-w-[22rem] px-3 py-2 text-slate-900 dark:text-foreground'>
                        <span className='line-clamp-4 whitespace-pre-line break-words'>
                          {displayValue(f, p?.value, plan.labels[f.field]) ?? 'Empty'}
                        </span>
                        <span className='mt-0.5 block text-[11px] text-slate-500 dark:text-muted-foreground'>
                          {from}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {relations.length > 0 && (
        <section>
          <h3 className='text-[13.5px] font-semibold text-slate-900 dark:text-foreground'>
            Linked rows
          </h3>
          <ul className='mt-2 space-y-1 text-[12.5px] text-slate-700 dark:text-foreground/90'>
            {relations.map((r) => {
              const n = relationTotal(
                r,
                realDiscarded.map((d) => d.id)
              )
              const move = (moves[r.key] ?? r.default) === 'move'
              return (
                <li key={r.key} className='flex items-baseline gap-2'>
                  <span className='tabular-nums text-slate-500 dark:text-muted-foreground'>
                    {n.toLocaleString()}
                  </span>
                  <span>
                    {r.label} —{' '}
                    {move
                      ? r.move_word.toLowerCase()
                      : leaveWord(r, refOf(keep))
                          .replace(/^Keep/, 'keep')
                          .replace(/^Leave/, 'leave')}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {realDiscarded.length > 0 && (
        <p className='flex items-center gap-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
          <Undo2 className='h-3.5 w-3.5' aria-hidden />
          You can undo this merge for {plan.undo_hours} hours.
        </p>
      )}
    </div>
  )
}

// ─── Done ───────────────────────────────────────────────────────────────────

function DoneView({
  keep,
  discarded,
  answer,
  undone,
  busy,
  error,
  noun,
  draft,
  onUndo,
  onOpen,
  onClose
}: {
  keep: MergePlanRecord
  discarded: MergePlanRecord[]
  answer: ApplyAnswer | null
  undone: UndoAnswer | null
  busy: boolean
  error: unknown
  noun: string
  draft: boolean
  onUndo: () => void
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const names = discarded.map((d) => fullName(d)).join(', ')
  const keepName = fullName(keep)
  const restoredRecord = undone?.restored.length
    ? discarded.find((d) => d.id === undone.restored[0])
    : undefined
  return (
    <div
      className='flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-12 text-center'
      data-merge-done={undone ? 'undone' : 'merged'}
    >
      <div
        className={cn(
          'flex h-11 w-11 items-center justify-center rounded-full',
          undone
            ? 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
            : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
        )}
      >
        {undone ? (
          <Undo2 className='h-5 w-5' aria-hidden />
        ) : (
          <CheckCircle2 className='h-5 w-5' aria-hidden />
        )}
      </div>
      <h3 className='mt-4 text-[16px] font-semibold text-slate-900 dark:text-foreground'>
        {undone
          ? 'Merge undone'
          : draft && !answer
            ? `Saved into ${keepName}`
            : `Merged into ${keepName}`}
      </h3>
      <p className='mt-1.5 max-w-[52ch] text-[13px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
        {undone
          ? `${names} ${discarded.length === 1 ? 'is' : 'are'} back, with ${discarded.length === 1 ? 'its' : 'their'} linked rows.${undone.kept_fields.length ? ` ${plural(undone.kept_fields.length, 'field')} on ${refOf(keep)} changed after the merge and kept the newer value.` : ''}`
          : answer
            ? `${names} went to the trash with a note saying where ${discarded.length === 1 ? 'it' : 'they'} went.${answer.moved ? ` ${plural(answer.moved, 'linked row')} moved to ${refOf(keep)}.` : ''}`
            : `Your new ${noun} was not saved; its values went into ${keepName}.`}
      </p>
      {undone && undone.problems.length > 0 && (
        <ul className='mt-3 max-w-[60ch] space-y-1 text-left text-[12px] text-amber-800 dark:text-amber-300'>
          {undone.problems.map((p) => (
            <li key={p} className='flex gap-1.5'>
              <AlertTriangle className='mt-0.5 h-3 w-3 shrink-0' aria-hidden />
              {p}
            </li>
          ))}
        </ul>
      )}
      {error != null && (
        <ErrorNotice error={error} fallback='Could not undo the merge' className='mt-4' />
      )}
      <div className='mt-6 flex flex-wrap items-center justify-center gap-2'>
        {answer && !undone && (
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='gap-1.5 dark:bg-transparent'
            disabled={busy}
            onClick={onUndo}
            data-merge-undo
          >
            {busy ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden />
            ) : (
              <Undo2 className='h-3.5 w-3.5' aria-hidden />
            )}
            Undo merge
          </Button>
        )}
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='dark:bg-transparent'
          onClick={onClose}
        >
          Close
        </Button>
        {!undone ? (
          <Button
            type='button'
            size='sm'
            className='bg-nvr-cyan text-white hover:bg-nvr-cyan-dark'
            onClick={() => onOpen(keep.id)}
          >
            Open {refOf(keep)}
          </Button>
        ) : (
          restoredRecord && (
            <Button
              type='button'
              size='sm'
              className='bg-nvr-cyan text-white hover:bg-nvr-cyan-dark'
              onClick={() => onOpen(restoredRecord.id)}
              data-merge-open-restored
            >
              Open {refOf(restoredRecord)}
            </Button>
          )
        )}
      </div>
      {answer && !undone && (
        <p className='mt-3 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          Undo is offered for 24 hours, also from {refOf(keep)}’s ⋯ menu.
        </p>
      )}
    </div>
  )
}
