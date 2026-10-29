import { AlignHorizontalSpaceAround } from 'lucide-react'
import { useMemo } from 'react'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import type { DesignTarget } from '../design-context'
import { evenRowPlan, rowsToEven } from '../even-row'
import { WIDTH_LABELS } from '../field-zones'
import type { ApplyOptions } from '../useLayoutDraft'

// #3180: under a Width setting — "Even out this row" when the selected
// field shares a row whose widths differ. Quiet otherwise (nothing shows).

export function EvenRowAction({
  bundle,
  targets,
  apply
}: {
  bundle: LayoutBundle
  targets: DesignTarget[]
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
}) {
  const plan = useMemo(() => evenRowPlan(bundle, targets), [bundle, targets])
  const rows = useMemo(() => (plan.ok ? rowsToEven(bundle, targets) : []), [plan, bundle, targets])
  if (!plan.ok) return null
  const shared = rows.filter((r) => r.members.length > 1)
  const one = shared.length === 1 ? shared[0] : null
  const text = one
    ? `Even out this row (${one.members.length} at ${WIDTH_LABELS[one.width] ?? one.width})`
    : `Even out their ${shared.length} rows`
  return (
    <button
      type='button'
      data-even-row=''
      data-tip='Every field in the row gets the same width, filling the row'
      onClick={() => apply(plan.ops, { label: plan.label })}
      className='inline-flex items-center gap-1.5 text-[12px] font-medium text-sky-700 hover:underline dark:text-nvr-cyan'
    >
      <AlignHorizontalSpaceAround className='h-3.5 w-3.5' />
      {text}
    </button>
  )
}
