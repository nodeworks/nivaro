import { Rows3 } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { type LayoutBundle, type LayoutOp, UNGROUPED_KEY } from '../../../lib/layout-ops'
import { titleCase } from '../../../lib/utils'
import { Skeleton } from '../../ui/skeleton'
import type { DescribeField } from '../overview/describe-conditions'
import { Toggle } from '../settings/controls'
import { suggestSections } from './suggest-sections'
import { formatDuration, useCoChanges, useLayoutFriction, useLayoutUsageToday } from './usage-api'

/**
 * The editor's Usage tab (#2588, #2597, #2598, #2605): how this form is used
 * today and over the last 30 days, where it slows people down (time per step,
 * new records left unfinished, fields changed soon after saving) and sections
 * suggested from fields people change together. Read-only except the canvas
 * fill-rate switch and a suggestion's Apply (one undo step).
 */

const head = 'px-3 pb-1.5 pt-4 text-[12px] font-semibold text-slate-700 dark:text-foreground'
const quiet = 'px-3 text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className='flex flex-col gap-0.5 bg-white px-2.5 py-2 dark:bg-card'>
      <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</span>
      <span className='text-[14px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
        {value}
      </span>
    </div>
  )
}

function Stats({ children }: { children: ReactNode }) {
  return (
    <div className='mx-3 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
      {children}
    </div>
  )
}

export function UsagePanel({
  bundle,
  collection,
  fields,
  apply,
  showFill,
  onShowFill
}: {
  bundle: LayoutBundle
  collection: string
  fields: DescribeField[]
  apply(ops: LayoutOp[], opts?: { label: string }): void
  showFill: boolean
  onShowFill(on: boolean): void
}) {
  const layoutId = Number(bundle.layout.id)
  const { data: today, isLoading: todayLoading } = useLayoutUsageToday(layoutId)
  const { data: friction, isLoading: frictionLoading } = useLayoutFriction(layoutId)
  const { data: co, isLoading: coLoading } = useCoChanges(collection)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())

  const fieldLabel = useMemo(() => {
    const m = new Map(fields.map((f) => [f.field, f.label || titleCase(f.field)]))
    return (f: string) => m.get(f) ?? titleCase(f)
  }, [fields])
  const groupLabel = (key: string | null) =>
    key == null || key === UNGROUPED_KEY
      ? 'Ungrouped'
      : (bundle.groups.find((g) => g.key === key)?.label ?? key)
  const stepLabel = (key: string) =>
    key === '__form__' ? 'Whole form' : key === '__general__' ? 'General' : groupLabel(key)
  const onForm = useMemo(() => new Set(bundle.placements.map((p) => p.field)), [bundle.placements])

  const suggestions = useMemo(
    () => suggestSections(bundle, co?.pairs ?? []).filter((s) => !dismissed.has(s.id)),
    [bundle, co, dismissed]
  )

  const steps = friction?.steps ?? []
  const slowest = Math.max(1, ...steps.map((s) => s.avg_ms))
  const changed = (friction?.changed_after_save.fields ?? []).slice(0, 8)
  const notReady = (today && !today.ready) || (friction && !friction.ready)

  return (
    <div data-editor-usage='' className='flex flex-col pb-4'>
      <div className='flex items-center justify-between gap-2 px-3 pt-3'>
        <span className='text-[12.5px] text-slate-700 dark:text-foreground'>
          Show how full each field is
        </span>
        <Toggle label='Show how full each field is' checked={showFill} onChange={onShowFill} />
      </div>
      <p className={`${quiet} pt-1`}>
        Each field on the form shows the share of records that have a value.
      </p>

      {notReady && (
        <p role='note' className={`${quiet} pt-3`}>
          Usage is not being recorded on this instance yet (its database needs the latest update).
        </p>
      )}

      <p className={head}>Today</p>
      {todayLoading ? (
        <Skeleton className='mx-3 h-12 rounded-lg' />
      ) : (
        <Stats>
          <Stat label='Opens' value={(today?.opens ?? 0).toLocaleString()} />
          <Stat label='People' value={(today?.people ?? 0).toLocaleString()} />
          <Stat label='Records' value={(today?.records ?? 0).toLocaleString()} />
        </Stats>
      )}

      <p className={head}>Last {friction?.days ?? 30} days</p>
      {frictionLoading ? (
        <Skeleton className='mx-3 h-12 rounded-lg' />
      ) : (
        <Stats>
          <Stat label='Opens' value={(friction?.opens ?? 0).toLocaleString()} />
          <Stat label='Saves' value={(friction?.saves ?? 0).toLocaleString()} />
          <Stat label='Left unfinished' value={(friction?.abandons ?? 0).toLocaleString()} />
        </Stats>
      )}

      <p className={head}>Time per step</p>
      {steps.length === 0 ? (
        <p className={quiet}>{frictionLoading ? 'Loading…' : 'No visits recorded yet.'}</p>
      ) : (
        <ul data-usage-steps='' className='flex flex-col gap-2 px-3'>
          {steps.map((s) => (
            <li key={s.key} className='flex flex-col gap-1'>
              <div className='flex items-baseline justify-between gap-2 text-[12px]'>
                <span className='truncate text-slate-800 dark:text-foreground'>
                  {stepLabel(s.key)}
                </span>
                <span className='shrink-0 tabular-nums text-slate-500 dark:text-muted-foreground'>
                  {formatDuration(s.avg_ms)}
                  {s.abandons > 0 && (
                    <span className='text-amber-700 dark:text-amber-300'>
                      {' · '}
                      {s.abandons} left here
                    </span>
                  )}
                </span>
              </div>
              <div className='h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'>
                <div
                  className='h-full rounded-full bg-slate-400 dark:bg-slate-500'
                  style={{ width: `${Math.max(2, Math.round((s.avg_ms / slowest) * 100))}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className={head}>Changed soon after saving</p>
      {changed.length === 0 ? (
        <p className={quiet}>
          {frictionLoading
            ? 'Loading…'
            : 'No field was changed within a day of a record being created.'}
        </p>
      ) : (
        <>
          <ul data-usage-changed='' className='flex flex-col px-3'>
            {changed.map((c) => (
              <li
                key={c.field}
                className='flex items-baseline justify-between gap-2 border-b border-slate-100 py-1 text-[12px] last:border-0 dark:border-border'
              >
                <span className='min-w-0 truncate text-slate-800 dark:text-foreground'>
                  {fieldLabel(c.field)}
                  {!onForm.has(c.field) && (
                    <span className='text-slate-400 dark:text-muted-foreground'>
                      {' '}
                      · not on this form
                    </span>
                  )}
                </span>
                <span className='shrink-0 tabular-nums text-slate-500 dark:text-muted-foreground'>
                  {c.changes.toLocaleString()}×
                </span>
              </li>
            ))}
          </ul>
          <p className={`${quiet} pt-1`}>
            Edits within 24 hours of a record being created, last 90 days
            {friction?.changed_after_save.scope === 'collection'
              ? ', across every form of this collection.'
              : ', on records opened with this form.'}
          </p>
        </>
      )}

      <p className={head}>Suggested sections</p>
      {coLoading ? (
        <p className={quiet}>Loading…</p>
      ) : suggestions.length === 0 ? (
        <p className={quiet}>
          No suggestions. Fields people change together already sit together on this form.
        </p>
      ) : (
        <ul data-usage-suggestions='' className='flex flex-col gap-2 px-3'>
          {suggestions.map((s) => {
            const names = s.fields.map(fieldLabel)
            const list =
              names.length > 1
                ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
                : names[0]
            const spots = [...new Set(Object.values(s.from).map(groupLabel))]
            return (
              <li
                key={s.id}
                data-usage-suggestion={s.id}
                className='flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-2.5 dark:border-border dark:bg-card'
              >
                <p className='m-0 text-[12px] leading-snug text-slate-700 dark:text-foreground'>
                  <Rows3 className='mr-1 inline h-3.5 w-3.5 align-[-2px] text-slate-400' />
                  People usually change <b className='font-semibold'>{list}</b> together, but they
                  sit in {spots.join(' and ')}.
                </p>
                <div className='flex items-center gap-1.5'>
                  <button
                    type='button'
                    onClick={() =>
                      apply(s.ops, { label: `Move ${list} into ${groupLabel(s.target)}` })
                    }
                    className='inline-flex h-7 items-center rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90'
                  >
                    Move into {groupLabel(s.target)}
                  </button>
                  <button
                    type='button'
                    onClick={() => setDismissed((d) => new Set(d).add(s.id))}
                    className='inline-flex h-7 items-center rounded-md px-2 text-[12px] text-slate-500 transition-colors hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
                  >
                    Not now
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
