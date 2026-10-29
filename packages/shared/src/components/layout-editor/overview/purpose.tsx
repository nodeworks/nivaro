import { CalendarRange, Lock, Smartphone, Tablet } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { dayWords, windowWords } from '../../../lib/layout-resolve'
import { cn } from '../../../lib/utils'
import {
  type ChoiceLabels,
  type DescribeField,
  describeReason,
  type Segment
} from './describe-conditions'
import type { OverviewRow } from './types'

// What a layout is for, in words — shared by the overview table, the editor's
// layouts rail and its top bar, so the three never describe a layout differently.

export const TYPE_USE: Record<string, string> = {
  summary: 'Read mode',
  detail: 'Drill-down panel',
  file: 'PDF',
  addendum: 'Addendum form',
  table: 'Grid columns'
}

export function shapeLine(row: OverviewRow): string {
  const { steps_or_tabs, groups, fields } = row.shape
  if (!fields && !groups) return 'empty'
  const parts: string[] = []
  if (steps_or_tabs > 0) {
    const unit = row.shape.container_mode === 'tabs' ? 'tab' : 'step'
    parts.push(`${steps_or_tabs} ${unit}${steps_or_tabs === 1 ? '' : 's'}`)
  } else if (groups > 0) parts.push(`${groups} ${groups === 1 ? 'section' : 'sections'}`)
  parts.push(`${fields} ${fields === 1 ? 'field' : 'fields'}`)
  return parts.join(' · ')
}

export function Sentence({ segs, muted }: { segs: Segment[]; muted?: boolean }) {
  if (!segs.length) return <span className='text-slate-400 dark:text-muted-foreground'>—</span>
  return (
    <span className={muted ? 'text-slate-500 dark:text-muted-foreground' : undefined}>
      {segs.map((s, i) =>
        s.strong ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          <b key={i} className='font-semibold text-slate-900 dark:text-foreground'>
            {s.text}
          </b>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          <Fragment key={i}>{s.text}</Fragment>
        )
      )}
    </span>
  )
}

export type PillTone = 'default' | 'rule' | 'link' | 'role' | 'view' | 'frozen'

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2 py-px text-[11px] font-semibold',
        tone === 'default' && 'bg-nvr-cyan/15 text-[#0089ad] dark:text-nvr-cyan',
        tone === 'rule' &&
          'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
        tone === 'role' && 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
        (tone === 'link' || tone === 'view') &&
          'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground',
        tone === 'frozen' &&
          'gap-1 bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200'
      )}
    >
      {children}
    </span>
  )
}

/**
 * Active dates, phone version and edit freeze (#2714 #2715 #2717) as small
 * pills beside a layout's name; nothing for a layout without them.
 */
export function ResolvePills({ row }: { row: OverviewRow }) {
  const win = row.active_window
  return (
    <>
      {win && (
        <span data-row-window={win.state} data-tip='Active dates: the form applies only then'>
          <Pill tone='view'>
            <CalendarRange className='mr-1 h-3 w-3' />
            {windowWords(win)}
          </Pill>
        </span>
      )}
      {row.phone_of != null && (
        <span data-row-phone-of={row.phone_of}>
          <Pill tone='view'>
            <Smartphone className='mr-1 h-3 w-3' />
            phone
          </Pill>
        </span>
      )}
      {row.phone_version && (
        <span
          data-row-phone-version={row.phone_version.layout_id}
          data-tip={`On small screens “${row.phone_version.name}” opens instead`}
        >
          <Pill tone='view'>
            <Smartphone className='mr-1 h-3 w-3' />
            has phone version
          </Pill>
        </span>
      )}
      {row.tablet_of != null && (
        <span data-row-tablet-of={row.tablet_of}>
          <Pill tone='view'>
            <Tablet className='mr-1 h-3 w-3' />
            tablet
          </Pill>
        </span>
      )}
      {row.tablet_version && (
        <span
          data-row-tablet-version={row.tablet_version.layout_id}
          data-tip={`On tablet-width screens “${row.tablet_version.name}” opens instead`}
        >
          <Pill tone='view'>
            <Tablet className='mr-1 h-3 w-3' />
            has tablet version
          </Pill>
        </span>
      )}
      {row.frozen && (
        <span
          data-row-frozen={row.frozen.until}
          data-tip={row.frozen.reason || 'Edits are refused until then'}
        >
          <Pill tone='frozen'>
            <Lock className='h-3 w-3' />
            frozen until {dayWords(row.frozen.until)}
          </Pill>
        </span>
      )}
    </>
  )
}

/** The one pill a layout wears in the rail and top bar, or null. */
export function rowPill(row: OverviewRow): { tone: PillTone; text: string } | null {
  if (row.section === 'forms') {
    if (row.is_default) return { tone: 'default', text: 'default' }
    if (row.reason.kind === 'record_rule') return { tone: 'rule', text: 'rule' }
    if (row.reason.kind === 'role') return { tone: 'role', text: 'role' }
    if (row.reason.kind === 'ab') return { tone: 'role', text: 'A/B' }
    if (row.reason.kind === 'phone') return { tone: 'view', text: 'phone' }
    if (row.reason.kind === 'tablet') return { tone: 'view', text: 'tablet' }
    return null
  }
  if (row.section === 'link_only') return { tone: 'link', text: 'link only' }
  if (row.section === 'other_views' && row.is_default) return { tone: 'default', text: 'default' }
  return null
}

/**
 * One short line saying when a layout is used: the rule sentence for forms,
 * where a link-only layout is referenced, what another view is for.
 */
export function purposeSegments(
  row: OverviewRow,
  fields: DescribeField[],
  choices: ChoiceLabels
): Segment[] {
  switch (row.section) {
    case 'unused':
      return [{ text: 'not used by anything' }]
    case 'link_only':
      return row.references.length
        ? [{ text: row.references.map((r) => r.label).join(' · ') }]
        : [{ text: 'opened by a link only' }]
    case 'other_views':
      return [{ text: row.reason.type_use || TYPE_USE[row.layout_type] || row.layout_type }]
    default: {
      if (row.reason.kind === 'slug') return [{ text: 'opened by a link only' }]
      const segs = describeReason(row.reason, fields, choices)
      if (row.reason.kind === 'default' || row.reason.kind === 'fallback')
        return [{ text: 'for ' }, ...segs]
      if (row.reason.kind === 'record_rule' && segs.length)
        return [{ text: 'when the record ' }, ...segs]
      return segs
    }
  }
}
