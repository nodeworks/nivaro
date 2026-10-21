import { FlaskConical } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { LayoutBundle } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { Skeleton } from '../../ui/skeleton'
import { apiFailure, useLayoutOverview } from '../overview/overview-api'
import {
  type AbArm,
  type AbResults,
  type AbTestInfo,
  useAbActions,
  useAbResults,
  useAbTest,
  useSplittableRoles
} from './ab-api'
import { formatDuration } from './usage-api'

/**
 * The Usage tab's A/B test (#2614): show a new version of this form to half
 * of one role (chosen per person, the same half every time), compare how the
 * halves fill it in, then keep either version. Ending with the new version
 * copies its design onto this form, so links and history stay.
 */

const head = 'px-3 pb-1.5 pt-4 text-[12px] font-semibold text-slate-700 dark:text-foreground'
const quiet = 'px-3 text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'
const primaryBtn =
  'inline-flex h-7 items-center rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40'
const ghostBtn =
  'inline-flex h-7 items-center rounded-md px-2 text-[12px] text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 disabled:opacity-40 dark:text-muted-foreground dark:hover:text-foreground'
const outlineBtn =
  'inline-flex h-7 items-center rounded-md border border-slate-200 bg-white px-2.5 text-[12px] font-medium text-slate-700 transition-colors hover:bg-muted disabled:opacity-40 dark:border-border dark:bg-card dark:text-foreground'

/** Too few visits to read anything into the numbers. */
export const MIN_VISITS_PER_HALF = 20
const COPY = '__copy__'

const fmtDate = (v: string | null) =>
  v ? new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const num = (v: number) => v.toLocaleString()

function fail(err: unknown, fallback: string) {
  toast.error(apiFailure(err, fallback).message)
}

type Better = 'higher' | 'lower' | null

interface MetricRow {
  label: string
  a: string
  b: string
  /** The counts behind a share, for the cell's tip. */
  tipA?: string
  tipB?: string
  /** The numbers compared, when both halves have one. */
  cmp: [number, number] | null
  better: Better
}

/** The comparison rows, values as shown and which side reads better. */
export function abRows(r: AbResults): MetricRow[] {
  const both = (x: number | null, y: number | null): [number, number] | null =>
    x == null || y == null ? null : [x, y]
  const editedShare = (arm: AbArm) => (arm.created > 0 ? arm.edited_after_save / arm.created : null)
  return [
    {
      label: 'People in the half',
      a: num(r.a.people),
      b: num(r.b.people),
      cmp: null,
      better: null
    },
    { label: 'Opened', a: num(r.a.opens), b: num(r.b.opens), cmp: null, better: null },
    {
      label: 'Saved',
      a: pct(r.a.save_rate),
      b: pct(r.b.save_rate),
      tipA: `${num(r.a.saves)} saves in ${num(r.a.opens)} visits`,
      tipB: `${num(r.b.saves)} saves in ${num(r.b.opens)} visits`,
      cmp: both(r.a.save_rate, r.b.save_rate),
      better: 'higher'
    },
    {
      label: 'Time to save',
      a: r.a.avg_save_ms == null ? '—' : formatDuration(r.a.avg_save_ms),
      b: r.b.avg_save_ms == null ? '—' : formatDuration(r.b.avg_save_ms),
      cmp: both(r.a.avg_save_ms, r.b.avg_save_ms),
      better: 'lower'
    },
    {
      label: 'Left unfinished',
      a: num(r.a.abandons),
      b: num(r.b.abandons),
      cmp:
        r.a.opens > 0 && r.b.opens > 0
          ? [r.a.abandons / r.a.opens, r.b.abandons / r.b.opens]
          : null,
      better: 'lower'
    },
    { label: 'Records created', a: num(r.a.created), b: num(r.b.created), cmp: null, better: null },
    {
      label: 'Edited again within a day',
      a: r.a.created ? pct(editedShare(r.a)) : '—',
      b: r.b.created ? pct(editedShare(r.b)) : '—',
      tipA: `${num(r.a.edited_after_save)} of ${num(r.a.created)} records`,
      tipB: `${num(r.b.edited_after_save)} of ${num(r.b.created)} records`,
      cmp: both(editedShare(r.a), editedShare(r.b)),
      better: 'lower'
    }
  ]
}

/** 'a' | 'b' when one side reads better, else null. */
export function betterSide(row: MetricRow): 'a' | 'b' | null {
  if (!row.cmp || !row.better) return null
  const [a, b] = row.cmp
  if (a === b) return null
  return (row.better === 'higher' ? a > b : a < b) ? 'a' : 'b'
}

function Results({ test, layoutId }: { test: AbTestInfo; layoutId: number }) {
  const { data, isLoading, isError } = useAbResults(layoutId, true)
  if (isLoading) return <Skeleton className='mx-3 h-40 rounded-lg' />
  if (isError || !data)
    return <p className={quiet}>The numbers could not be loaded. Try again in a moment.</p>
  const rows = abRows(data)
  const thin = data.a.opens < MIN_VISITS_PER_HALF || data.b.opens < MIN_VISITS_PER_HALF
  const col = (label: string, name: string) => (
    <th
      scope='col'
      className='px-2 py-1.5 text-right text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'
      data-tip={name}
    >
      {label}
    </th>
  )
  return (
    <>
      <div className='mx-3 overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
        <table data-ab-results='' className='w-full table-fixed text-[12px]'>
          <colgroup>
            <col className='w-[40%]' />
            <col />
            <col />
          </colgroup>
          <thead className='bg-slate-50 dark:bg-muted/40'>
            <tr>
              <th scope='col' className='px-2 py-1.5 text-left'>
                <span className='sr-only'>Measure</span>
              </th>
              {col('Original', test.control.name)}
              {col('New', test.variant.name)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const best = thin ? null : betterSide(r)
              const cell = (side: 'a' | 'b', v: string) => (
                <td
                  data-tip={side === 'a' ? r.tipA : r.tipB}
                  className={cn(
                    'whitespace-nowrap px-2 py-1.5 text-right tabular-nums',
                    best === side
                      ? 'font-semibold text-slate-900 dark:text-foreground'
                      : 'text-slate-600 dark:text-muted-foreground'
                  )}
                >
                  {v}
                </td>
              )
              return (
                <tr
                  key={r.label}
                  className='border-t border-slate-100 first:border-t-0 dark:border-border'
                >
                  <th
                    scope='row'
                    className='px-2 py-1.5 text-left font-normal text-slate-700 dark:text-foreground'
                  >
                    {r.label}
                  </th>
                  {cell('a', r.a)}
                  {cell('b', r.b)}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className={`${quiet} pt-1.5`}>
        {thin
          ? `Too few visits to compare yet: the better side is marked once each half has ${MIN_VISITS_PER_HALF} visits.`
          : 'The better side of each comparable line is in bold.'}{' '}
        Records created and edited again count records people in each half made since{' '}
        {fmtDate(data.since)}, on any form.
        {!data.ready && ' Visits are not being recorded on this instance yet.'}
      </p>
    </>
  )
}

function EndTest({
  test,
  layoutId,
  collection
}: {
  test: AbTestInfo
  layoutId: number
  collection: string
}) {
  const actions = useAbActions(layoutId, collection)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const end = async (keep: 'control' | 'variant') => {
    setBusy(true)
    try {
      await actions.end(keep)
      toast.success(
        keep === 'variant'
          ? `“${test.control.name}” now has the new version’s design`
          : 'Test ended; everyone gets the original form'
      )
      setConfirming(false)
    } catch (err) {
      fail(err, 'Could not end the test')
    } finally {
      setBusy(false)
    }
  }
  if (!confirming)
    return (
      <div className='flex items-center gap-1.5 px-3 pt-2'>
        <button
          type='button'
          className={outlineBtn}
          onClick={() => setConfirming(true)}
          data-ab-end=''
        >
          End test
        </button>
      </div>
    )
  return (
    <div
      data-ab-end-confirm=''
      className='mx-3 mt-2 flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-2.5 dark:border-border dark:bg-card'
    >
      <p className='m-0 text-[12px] leading-snug text-slate-700 dark:text-foreground'>
        Which version should everyone get?
      </p>
      <p className='m-0 text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
        Using the new version copies its sections and fields onto “{test.control.name}”, so its
        links and history stay. History can put it back.
      </p>
      <div className='flex flex-wrap items-center gap-1.5'>
        <button
          type='button'
          className={primaryBtn}
          disabled={busy}
          onClick={() => void end('variant')}
        >
          Use the new version
        </button>
        <button
          type='button'
          className={outlineBtn}
          disabled={busy}
          onClick={() => void end('control')}
        >
          Keep “{test.control.name}”
        </button>
        <button
          type='button'
          className={ghostBtn}
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function StartTest({
  bundle,
  collection,
  onOpenLayout
}: {
  bundle: LayoutBundle
  collection: string
  onOpenLayout?: (id: number) => void
}) {
  const layoutId = Number(bundle.layout.id)
  const { data: roles = [], isLoading } = useSplittableRoles(true)
  const { data: overview } = useLayoutOverview(collection)
  const actions = useAbActions(layoutId, collection)
  const [roleId, setRoleId] = useState('')
  const [version, setVersion] = useState(COPY)
  const [busy, setBusy] = useState(false)
  const others = useMemo(
    () =>
      (overview?.rows ?? []).filter(
        (r) =>
          r.layout_id !== layoutId &&
          r.layout_type === 'grouped' &&
          !r.is_default &&
          r.reason.kind !== 'ab'
      ),
    [overview, layoutId]
  )
  if (isLoading) return <Skeleton className='mx-3 h-16 rounded-lg' />
  if (roles.length === 0)
    return (
      <p className={quiet}>
        There is no role to split: administrators always get the original form.
      </p>
    )
  const start = async () => {
    if (!roleId) return
    setBusy(true)
    try {
      const variantId =
        version === COPY
          ? await actions.copy(String(bundle.layout.name ?? 'Form'))
          : Number(version)
      await actions.start(variantId, roleId)
      const role = roles.find((r) => r.id === roleId)?.name ?? 'the role'
      toast.success(`Test started: half of ${role} get the new version`)
      if (version === COPY) onOpenLayout?.(variantId)
    } catch (err) {
      fail(err, 'Could not start the test')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-ab-start='' className='flex flex-col gap-2 px-3'>
      <p className='m-0 text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
        Show a new version of this form to half of one role, then compare how quickly each half
        saves and how often their records are edited again.
      </p>
      <SimpleSelect
        value={roleId}
        onChange={setRoleId}
        ariaLabel='Role to split'
        className='h-8 w-full text-[12.5px]'
        options={[
          { value: '', label: 'Pick a role to split' },
          ...roles.map((r) => ({ value: r.id, label: r.name }))
        ]}
      />
      <SimpleSelect
        value={version}
        onChange={setVersion}
        ariaLabel='New version'
        className='h-8 w-full text-[12.5px]'
        options={[
          { value: COPY, label: 'A copy of this form to change' },
          ...others.map((r) => ({ value: String(r.layout_id), label: r.name }))
        ]}
      />
      <div>
        <button
          type='button'
          className={primaryBtn}
          disabled={!roleId || busy}
          onClick={() => void start()}
        >
          {busy ? 'Starting…' : 'Start test'}
        </button>
      </div>
      {version === COPY && (
        <p className='m-0 text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
          The copy opens here so you can make your changes. People see each change as soon as it is
          saved.
        </p>
      )}
    </div>
  )
}

export function AbTestSection({
  bundle,
  collection,
  onOpenLayout
}: {
  bundle: LayoutBundle
  collection: string
  onOpenLayout?: (id: number) => void
}) {
  const layoutId = Number(bundle.layout.id)
  const { data: test, isLoading, isError } = useAbTest(layoutId)
  const type = bundle.layout.layout_type
  if (type != null && type !== 'grouped') return null
  let body: ReactNode
  if (isLoading) body = <Skeleton className='mx-3 h-12 rounded-lg' />
  else if (isError) body = <p className={quiet}>The A/B test could not be loaded.</p>
  else if (!test)
    body = <StartTest bundle={bundle} collection={collection} onOpenLayout={onOpenLayout} />
  else {
    const isVariant = test.side === 'variant'
    const other = isVariant ? test.control : test.variant
    body = (
      <>
        <p data-ab-running='' className={quiet}>
          <FlaskConical className='mr-1 inline h-3.5 w-3.5 align-[-2px] text-slate-400' />
          <span>
            {isVariant ? (
              <>
                This is the new version: half of{' '}
                <b className='font-semibold text-slate-700 dark:text-foreground'>
                  {test.role.name}
                </b>{' '}
                get it instead of “{test.control.name}”.
              </>
            ) : (
              <>
                Half of{' '}
                <b className='font-semibold text-slate-700 dark:text-foreground'>
                  {test.role.name}
                </b>{' '}
                get “{test.variant.name}” instead of this form.
              </>
            )}{' '}
            Since {fmtDate(test.started_at)}
            {test.started_by ? `, started by ${test.started_by.name}` : ''}.
          </span>
          {onOpenLayout && ' '}
          {onOpenLayout && (
            <button
              type='button'
              className='font-medium text-[#0089ad] hover:underline dark:text-nvr-cyan'
              onClick={() => onOpenLayout(other.id)}
            >
              Open “{other.name}”
            </button>
          )}
        </p>
        <div className='pt-2'>
          <Results test={test} layoutId={layoutId} />
        </div>
        <EndTest test={test} layoutId={layoutId} collection={collection} />
      </>
    )
  }
  return (
    <section data-ab-test='' aria-label='A/B test'>
      <p className={head}>A/B test</p>
      {body}
    </section>
  )
}
