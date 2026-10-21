import { ChevronDown, ChevronUp } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { foldLabel, type RowGroup } from '../../lib/form-structure'
import { cn, titleCase } from '../../lib/utils'
import { Label } from '../ui/label'
import type { CMSField } from './types'

// How a section lays out its rows and its fold on the record page (#2697
// #2698). The grids that render a section's fields (GroupSection, tabs and
// steps in ItemEditForm) share these pieces; the layout is planned by
// lib/form-structure.ts planFieldGrid.

/** A member of a row renders without its own label: the row shows one. */
export const rowMemberField = (f: CMSField): CMSField => ({ ...f, label: '' })

const memberName = (f: CMSField) => f.label || titleCase(f.field)

/** A member's share of the row: its own width setting (½ = 6 …), else an equal share. */
function memberGrow(f: CMSField): number {
  let o: unknown = f.options
  if (typeof o === 'string')
    try {
      o = JSON.parse(o)
    } catch {
      o = null
    }
  const span = (o as { col_span?: unknown } | null)?.col_span
  return typeof span === 'number' && [3, 4, 6].includes(span) ? span : 4
}

/**
 * Fields side by side under one label (#2697): one required marker for the
 * row, each input captioned with its own name. Stacks one under another in
 * a narrow section. `renderMember` renders the field (label hidden) the way
 * the host grid renders its fields.
 */
export function RowGroupCell({
  row,
  members,
  containerWidth,
  renderMember,
  errors
}: {
  row: RowGroup
  members: CMSField[]
  containerWidth: number
  renderMember: (f: CMSField) => ReactNode
  errors?: Record<string, string>
}) {
  const id = useId()
  const required = members.some((f) => f.required)
  const stacked = containerWidth > 0 && containerWidth < 480
  const label = row.label.trim() || members.map(memberName).join(' / ')
  const hasError = members.some((f) => errors?.[f.field])
  return (
    <fieldset
      aria-labelledby={id}
      data-row-group={row.key}
      style={{ gridColumn: 'span 12' }}
      className='min-w-0 space-y-1.5'
    >
      <div className='flex min-h-[1.5rem] items-center'>
        <Label id={id} className={cn('text-sm font-medium', hasError && 'text-destructive')}>
          {label}
          {required && <span className='ml-0.5 text-destructive'>*</span>}
        </Label>
      </div>
      <div className={cn('flex gap-3', stacked ? 'flex-col' : 'flex-row items-start')}>
        {members.map((f) => (
          <fieldset
            key={f.field}
            aria-label={memberName(f)}
            data-row-member={f.field}
            className='min-w-0'
            style={stacked ? undefined : { flex: `${memberGrow(f)} 1 0%` }}
          >
            {renderMember(f)}
            <p className='mt-1 truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
              {memberName(f)}
            </p>
          </fieldset>
        ))}
      </div>
    </fieldset>
  )
}

/**
 * The "Show N more" fold under a section's grid (#2698). `forcedOpen`: a
 * folded field holds a value, so it shows and cannot be folded away. On the
 * layout canvas the folded fields always show, under a line naming the fold.
 */
export function FoldArea({
  count,
  open,
  forcedOpen,
  design,
  onToggle,
  children
}: {
  count: number
  open: boolean
  forcedOpen: boolean
  design?: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const id = useId()
  if (count === 0) return null
  if (design)
    return (
      <div data-form-fold='design' className='mt-4'>
        <div className='mb-3 flex items-center gap-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
          <span>Behind “{foldLabel(count)}” while empty</span>
          <span className='h-px flex-1 bg-slate-200 dark:bg-border' />
        </div>
        {children}
      </div>
    )
  const shown = open || forcedOpen
  return (
    <div data-form-fold={shown ? 'open' : 'closed'} className='mt-3'>
      {shown && (
        <div id={id} className='nvr-expand-in'>
          {children}
        </div>
      )}
      {!forcedOpen && (
        <button
          type='button'
          aria-expanded={shown}
          aria-controls={shown ? id : undefined}
          onClick={onToggle}
          className={cn(
            '-ml-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nvr-cyan dark:text-muted-foreground dark:hover:text-foreground motion-reduce:transition-none',
            shown && 'mt-3'
          )}
        >
          {shown ? (
            <ChevronUp aria-hidden className='h-3.5 w-3.5' />
          ) : (
            <ChevronDown aria-hidden className='h-3.5 w-3.5' />
          )}
          {shown ? 'Show fewer' : foldLabel(count)}
        </button>
      )}
    </div>
  )
}
