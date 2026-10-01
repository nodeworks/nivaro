import { cn } from '@/lib/utils'
import { useTrafficMap } from '../context'
import { callerLabel, fmtCount } from '../EventTicker'
import { Section, t } from '../Inspector'
import type { TrafficModel } from '../model'
import { canvasLayers, nodeBadges } from '../registry/canvasLayers'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import type { Selection } from '../types'
import {
  createStore,
  inPage,
  recentCount,
  TAG,
  useEntityDetail,
  useLens,
  useStore
} from './b1-shared'

/**
 * #1120 — conflict lens: requests refused because two writers collided — MIDAIR_COLLISION,
 * TRANSITION_DUPLICATE, IDEMPOTENCY_IN_PROGRESS and item-lock 409s — counted per entity. A lens
 * toggle beside the filters outlines the entities that had any and badges them with the count.
 */
export const CONFLICTS_TAP = 'conflicts'
export const conflictLens = createStore(false)
const CODE_LABEL: Record<string, string> = {
  MIDAIR_COLLISION: 'stale edit',
  TRANSITION_DUPLICATE: 'repeated transition',
  IDEMPOTENCY_IN_PROGRESS: 'twin still running',
  ITEM_LOCKED: 'record locked'
}

interface EntityConflicts {
  key: string
  n: number
  codes: Array<{ code: string; n: number }>
}

/** Conflicts per entity in the window: live frame counts, else the snapshot's. */
export function conflictCount(m: TrafficModel, key: string): number {
  return recentCount(m, CONFLICTS_TAP, key, m.snapshotWindow || 60)
}

const CHIP =
  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tm-card)]'

function ConflictLensToggle() {
  const on = useStore(conflictLens)
  const { setFilters } = useTrafficMap()
  const { data } = useLens<{ entities: EntityConflicts[] }>(CONFLICTS_TAP)
  const total = (data?.entities ?? []).reduce((a, e) => a + e.n, 0)
  return (
    <button
      type='button'
      id='tm-lens-conflicts'
      aria-pressed={on}
      onClick={() => {
        conflictLens.set(!on)
        // a new filters object repaints the canvas now, not on the next frame (or while paused)
        setFilters((f) => ({ ...f }))
      }}
      className={cn(
        CHIP,
        on
          ? 'border-[color-mix(in_srgb,var(--tm-update)_55%,var(--tm-line))] bg-[color-mix(in_srgb,var(--tm-update)_12%,var(--tm-card))] text-[var(--tm-fg)]'
          : 'border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
      )}
      title='Outline the entities whose writes collided (stale edits, repeated transitions, locks)'
    >
      <span
        className='h-2 w-2 rounded-sm'
        style={{ background: 'var(--tm-update)', opacity: on ? 1 : 0.35 }}
        aria-hidden='true'
      />
      Conflicts
      {total > 0 ? (
        <span className='tabular-nums text-[var(--tm-fg-2)]' data-tm-conflict-total={total}>
          {fmtCount(total)}
        </span>
      ) : null}
    </button>
  )
}

function ConflictPanel({ sel }: { sel: Selection }) {
  const { model, catalog } = useTrafficMap()
  const detail = useEntityDetail(sel.id)
  const d = (detail?.[CONFLICTS_TAP] ?? model.entityMeta(sel.id)?.ext?.[CONFLICTS_TAP]) as
    | {
        n: number
        codes: Array<{ code: string; n: number }>
        recent: Array<{ at: string; code: string; route: string; caller: string }>
      }
    | undefined
  if (!d?.n) return null
  return (
    <Section title='Conflicts'>
      <div className='grid gap-1.5 text-[12px]' id='tm-conflicts'>
        <span className='flex flex-wrap gap-1'>
          {d.codes.map((c) => (
            <span key={c.code} className={TAG} data-tm-conflict-code={c.code}>
              <span className='font-mono'>{c.code}</span>
              <span className='text-[var(--tm-muted)]'>
                {CODE_LABEL[c.code] ?? ''} ×{fmtCount(c.n)}
              </span>
            </span>
          ))}
        </span>
        {d.recent.slice(0, 5).map((r, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: conflicts can share a timestamp
            key={`${r.at}-${i}`}
            className='grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2 text-[11.5px]'
          >
            <span className='font-mono text-[10.5px] tabular-nums text-[var(--tm-muted)]'>
              {t(r.at)}
            </span>
            <span className='min-w-0 truncate' title={r.route}>
              <span className='font-mono text-[11px]'>{r.route}</span>
              <span className='text-[var(--tm-muted)]'> · {callerLabel(catalog, r.caller)}</span>
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

register(toolbarItems, { id: 'conflict-lens', order: 20, Component: inPage(ConflictLensToggle) })
register(nodeBadges, {
  id: 'conflicts',
  order: 30,
  badge(nodeId, model) {
    if (!conflictLens.get()) return null
    const n = conflictCount(model, nodeId)
    return n > 0 ? { text: `${n} conflict${n === 1 ? '' : 's'}`, tone: 'warn' } : null
  }
})
register(canvasLayers, {
  id: 'conflicts',
  order: 35,
  draw(ctx, { layout, data, tokens, model }) {
    if (!conflictLens.get()) return
    ctx.lineWidth = 1.5
    ctx.strokeStyle = tokens.update
    for (const lane of data.lanes)
      for (const e of lane.entities) {
        const r = layout.ents[e.key]
        if (!r || conflictCount(model, e.key) <= 0) continue
        ctx.beginPath()
        ctx.roundRect(r.x + 0.75, r.y + 1.75, r.w - 1.5, r.h - 3.5, 4)
        ctx.stroke()
      }
  }
})
register(inspectorPanels, {
  id: 'conflicts',
  order: 45,
  applies: (sel) => sel.kind === 'entity',
  Component: inPage(ConflictPanel)
})
