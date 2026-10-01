/**
 * #1107 — hook cost on an items / system collection: every before/after hook that runs for it
 * (its own and the `*` ones), slowest p95 first, with the owner (an extension id or the core
 * file that registered it). Run times since this API process started.
 */

import { useTrafficMap } from '../context'
import { fmtMs } from '../EventTicker'
import { Empty, type InspectorData, Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { entityOf, useEntityDetail } from './shared'

interface HookRow {
  timing: string
  action: string
  collection: string
  owner: string
  name: string | null
  runs: number
  errors: number
  p50_ms: number | null
  p95_ms: number | null
  max_ms: number | null
}

/** "after-create" — the hook's slot in plain words. */
export function hookSlot(h: Pick<HookRow, 'timing' | 'action' | 'collection'>): string {
  return `${h.timing}-${h.action}${h.collection === '*' ? ' (every collection)' : ''}`
}

function HookCostPanel({ sel }: { sel: Selection; d: InspectorData }) {
  const { win } = useTrafficMap()
  const e = entityOf(sel)
  const { data, loading } = useEntityDetail<{ hooks?: HookRow[] }>(e?.key ?? null, 'hook-cost', win)
  const hooks = (data?.hooks ?? []).filter((h) => h.runs > 0)
  return (
    <Section title='Hook cost on this collection'>
      {loading ? (
        <Empty>Reading hook timings…</Empty>
      ) : hooks.length === 0 ? (
        <Empty>No hook has run for this collection since this API process started.</Empty>
      ) : (
        <ul className='grid gap-1 text-[12px]' data-tm-hook-cost=''>
          {hooks.slice(0, 10).map((h) => (
            <li
              key={`${h.timing}-${h.action}-${h.collection}-${h.owner}-${h.name ?? ''}`}
              className='grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2'
              data-tm-hook={h.owner}
            >
              <span className='min-w-0 truncate' title={`${hookSlot(h)} · ${h.owner}`}>
                <span className='font-mono text-[11px]'>{hookSlot(h)}</span>{' '}
                <span className='text-[var(--tm-fg-2)]'>{h.name ?? h.owner}</span>
                {h.name && <span className='text-[var(--tm-muted)]'> · {h.owner}</span>}
              </span>
              <span className='tabular-nums'>
                <span className='font-medium'>{fmtMs(h.p95_ms ?? 0)}</span>
                <span className='text-[var(--tm-muted)]'>
                  {' '}
                  p95 · {h.runs.toLocaleString()} run{h.runs === 1 ? '' : 's'}
                  {h.errors ? (
                    <span className='text-[var(--tm-error-ink)]'> · {h.errors} failed</span>
                  ) : null}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'hook-cost',
  order: 30,
  applies: (sel) => {
    const e = entityOf(sel)
    return !!e && (e.lane === 'items' || e.lane === 'system') && !e.entity.startsWith('__')
  },
  Component: HookCostPanel
})
