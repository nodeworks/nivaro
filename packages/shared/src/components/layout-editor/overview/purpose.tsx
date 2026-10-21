import { Fragment, type ReactNode } from 'react'
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

export type PillTone = 'default' | 'rule' | 'link' | 'role' | 'view'

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
          'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
      )}
    >
      {children}
    </span>
  )
}

/** The one pill a layout wears in the rail and top bar, or null. */
export function rowPill(row: OverviewRow): { tone: PillTone; text: string } | null {
  if (row.section === 'forms') {
    if (row.is_default) return { tone: 'default', text: 'default' }
    if (row.reason.kind === 'record_rule') return { tone: 'rule', text: 'rule' }
    if (row.reason.kind === 'role') return { tone: 'role', text: 'role' }
    if (row.reason.kind === 'ab') return { tone: 'role', text: 'A/B' }
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
