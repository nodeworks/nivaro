import { RotateCcw } from 'lucide-react'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import type { DesignTarget } from '../design-context'
import { resetGroupPlan, resetPlacementOps } from '../inheritance'
import { tintCard } from '../panel-style'
import type { ApplyOptions } from '../useLayoutDraft'

/**
 * Top of the inspector for a node this layout overrides (#2635): the parent
 * has its own, and Reset to parent drops this layout's so the parent's shows
 * again (one undo step). Nothing for the layout's own nodes.
 */
export function OverrideNotice({
  bundle,
  parent,
  target,
  title,
  apply
}: {
  bundle: LayoutBundle
  parent: LayoutBundle | null | undefined
  target: DesignTarget
  title: string
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
}) {
  if (!parent) return null
  const parentName = String(parent.layout.name ?? 'the parent layout')
  let ops: LayoutOp[] = []
  let blocked: string | null = null
  let note: string | null = null
  if (target.kind === 'group') {
    if (!parent.groups.some((g) => g.key === target.key)) return null
    const plan = resetGroupPlan(bundle, parent, target.key)
    if (plan.ok) {
      ops = plan.ops
      if (plan.ungrouped.length)
        note = `${plan.ungrouped.length} ${plan.ungrouped.length === 1 ? 'field' : 'fields'} only this form places will move to Ungrouped.`
    } else blocked = plan.why
  } else {
    if (!parent.placements.some((p) => p.field === target.field)) return null
    ops = resetPlacementOps(bundle, target.field)
    if (ops.length === 0) return null
    if (ops.length > 1) note = `This form places it ${ops.length} times; every one goes.`
  }
  const what = target.kind === 'group' ? 'section' : 'field'
  return (
    <div data-setting='inspector.override_reset' className={cn(tintCard, 'mb-3 space-y-2 p-3')}>
      <p className='m-0 text-[12px] leading-snug text-slate-700 dark:text-foreground'>
        This {what} overrides <span className='font-medium'>{parentName}</span>: the changes here
        apply to this form only.
        {note && <span className='text-slate-500 dark:text-muted-foreground'> {note}</span>}
      </p>
      <button
        type='button'
        data-reset-to-parent=''
        aria-disabled={blocked ? true : undefined}
        data-tip={blocked ?? `Show ${parentName}'s ${what} here again`}
        onClick={() => {
          if (!blocked && ops.length) apply(ops, { label: `Reset ${title} to ${parentName}` })
        }}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[12px] font-medium text-slate-700 transition-colors dark:border-border dark:bg-background dark:text-foreground',
          blocked ? 'cursor-not-allowed opacity-50' : 'hover:bg-slate-50 dark:hover:bg-muted'
        )}
      >
        <RotateCcw aria-hidden className='h-3.5 w-3.5' />
        Reset to parent
      </button>
    </div>
  )
}
