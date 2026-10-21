import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { get, post } from '../../../lib/commands'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { titleCase } from '../../../lib/utils'
import { inspectKeys, type OrphanLayout } from '../inspect/inspect-api'
import { slotName } from '../slot-names'
import { layoutDraftKeys } from '../useLayoutDraft'
import { btnOutline } from './OverviewActions'
import { apiFailure } from './overview-api'

// Rows of the overview's findings strip: placements that point at nothing,
// with one click to remove them per form (#2650).

const REASON: Record<OrphanLayout['placements'][number]['reason'], string> = {
  column_dropped: 'column no longer exists',
  widget_deleted: 'widget was deleted',
  grid_missing: "grid's table is gone",
  section_missing: 'its section no longer exists'
}

const nameOf = (field: string) =>
  field.startsWith('__') ? slotName(field) : titleCase(field.split('.').pop() ?? field)

export function OrphanRow({
  layout,
  collection,
  onChanged
}: {
  layout: OrphanLayout
  collection: string
  onChanged(): void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const n = layout.placements.length

  // One batch through the layout ops, on the layout as it is now (its rev):
  // versions, history and the open editors' 409 all work as for any edit.
  const remove = async () => {
    setBusy(true)
    try {
      const bundle = await client.request<LayoutBundle>(
        get(`/collection-layouts/${layout.layout_id}/bundle`)
      )
      const ops: LayoutOp[] = layout.placements
        .filter((p) =>
          bundle.placements.some((b) => b.field === p.field && b.group_key === p.group_key)
        )
        .map((p) => ({ op: 'remove', at: { field: p.field, group_key: p.group_key } }))
      if (ops.length)
        await client.request(
          post(`/collection-layouts/${layout.layout_id}/ops`, {
            ops,
            base_rev: bundle.rev,
            note: 'Remove placements that point at nothing'
          })
        )
      toast.success(
        `Removed ${ops.length === 1 ? '1 placement' : `${ops.length} placements`} from ${layout.name}`
      )
      void qc.invalidateQueries({ queryKey: inspectKeys.orphans(collection) })
      void qc.invalidateQueries({ queryKey: inspectKeys.translations(collection) })
      void qc.invalidateQueries({ queryKey: layoutDraftKeys.bundle(layout.layout_id) })
      onChanged()
    } catch (err) {
      toast.error(apiFailure(err, 'Could not remove the placements').message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-orphan-layout={layout.layout_id}
      className='flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 pl-5'
    >
      <div className='min-w-0 text-[12px] leading-snug text-slate-600 dark:text-muted-foreground'>
        <span className='font-medium text-slate-800 dark:text-foreground'>{layout.name}</span>
        {': '}
        {layout.placements.map((p, i) => (
          <span key={`${p.field}\u0000${p.group_key ?? ''}`}>
            {nameOf(p.field)} <span className='font-mono text-[11px]'>({p.field})</span>,{' '}
            {REASON[p.reason]}
            {i < n - 1 ? '; ' : ''}
          </span>
        ))}
      </div>
      <button
        type='button'
        data-remove-orphans={layout.layout_id}
        disabled={busy}
        onClick={() => void remove()}
        className={btnOutline}
      >
        {busy ? 'Removing…' : n === 1 ? 'Remove it' : `Remove ${n}`}
      </button>
    </div>
  )
}
