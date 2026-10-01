/**
 * #1169 — near-timeout lens. Requests that used more than 80% of a budget — the longest statement
 * against the database's 15 s request timeout, the whole request against the proxy's 60 s — per
 * entity, before they start failing (and the ones that went past). A lens chip beside the
 * filters outlines and badges the entities that had any; the inspector lists the requests with a
 * used-of-budget bar and the 24 h picture from the api log.
 */
import { useEffect } from 'react'
import { useTrafficMap } from '../../context'
import { callerLabel, fmtTime } from '../../EventTicker'
import { Empty, Section } from '../../Inspector'
import { canvasLayers, nodeBadges, requestCanvasRepaint } from '../../registry/canvasLayers'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import type { Selection } from '../../types'
import { createStore, inPage, useEntityDetail, useStore } from '../b1-shared'
import {
  type Budgets,
  budgetLine,
  NEAR_TIMEOUT_TAP,
  type NearTimeoutEntity,
  nearTimeoutBadge,
  secs
} from './logic'
import { useDbLens } from './shared'
import { BudgetBar, Figures, LensChip, Sql } from './ui'

/** On by default: a request this close to failing is rare and worth seeing at once. */
export const nearTimeoutLens = createStore(true)

interface LensData {
  budgets: Budgets
  entities: Array<{ key: string; n: number; over: number; worst_pct: number }>
}
/** The lens figures the badge and outline read (kept fresh by the chip's poll). */
let current = new Map<string, { n: number; over: number; worst_pct: number }>()
let budgets: Budgets = { db_ms: 15_000, proxy_ms: 60_000, near_share: 0.8 }

function NearTimeoutChip() {
  const on = useStore(nearTimeoutLens)
  const { setFilters, win } = useTrafficMap()
  const { data } = useDbLens<LensData>('near-timeout', { params: { window: win }, every: 5000 })
  useEffect(() => {
    current = new Map((data?.entities ?? []).map((e) => [e.key, e]))
    if (data?.budgets) budgets = data.budgets
    requestCanvasRepaint()
  }, [data])
  const total = (data?.entities ?? []).reduce((a, e) => a + e.n, 0)
  return (
    <LensChip
      id='tm-lens-near-timeout'
      on={on}
      onToggle={() => {
        nearTimeoutLens.set(!on)
        setFilters((f) => ({ ...f }))
      }}
      color='var(--tm-error)'
      label='Near timeout'
      count={total}
      title={`Outline the entities whose requests used over ${Math.round(budgets.near_share * 100)}% of a budget: a ${secs(budgets.db_ms)} database statement, a ${secs(budgets.proxy_ms)} proxy request`}
    />
  )
}

function NearTimeoutPanel({ sel }: { sel: Selection }) {
  const { model, catalog } = useTrafficMap()
  const detail = useEntityDetail(sel.id)
  const d = (detail?.[NEAR_TIMEOUT_TAP] ?? model.entityMeta(sel.id)?.ext?.[NEAR_TIMEOUT_TAP]) as
    | NearTimeoutEntity
    | undefined
  const history = useDbLens<{
    hours: number
    rows: Array<{
      key: string
      near_proxy: number
      over_proxy: number
      db_timeouts: number
      worst_ms: number
    }>
  }>('near-timeout/history', { params: { hours: 24 }, every: 60_000 })
  const h = history.data?.rows.find((r) => r.key === sel.id)
  if (!d?.n && !h) return null
  const b = d?.budgets ?? budgets
  return (
    <Section title='Near timeout'>
      <div className='grid gap-2 text-[12px]' id='tm-near-timeout' data-tm-near-timeout={d?.n ?? 0}>
        {d?.n ? (
          <>
            <Figures
              items={[
                ['Database', `${d.near_db + d.over_db}`, d.over_db > 0],
                ['Proxy', `${d.near_proxy + d.over_proxy}`, d.over_proxy > 0],
                ['Worst', `${d.worst_pct}%`, d.worst_pct >= 100]
              ]}
            />
            <ul className='grid gap-1.5'>
              {d.recent.slice(0, 5).map((r, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: two requests can share a millisecond
                  key={`${r.at}-${i}`}
                  className='grid min-w-0 gap-0.5'
                  data-tm-near-timeout-row={r.over ? 'over' : 'near'}
                >
                  <span className='flex min-w-0 items-baseline gap-2'>
                    <span className='font-mono text-[10.5px] tabular-nums text-[var(--tm-muted)]'>
                      {fmtTime(r.at)}
                    </span>
                    <span className='min-w-0 truncate font-mono text-[11px]' title={r.route}>
                      {r.route}
                    </span>
                    <span className='ml-auto shrink-0 text-[11px] text-[var(--tm-muted)]'>
                      {callerLabel(catalog, r.caller)}
                    </span>
                  </span>
                  <BudgetBar pct={r.used_pct} />
                  <span
                    className={
                      r.over
                        ? 'text-[11.5px] text-[var(--tm-error-ink)]'
                        : 'text-[11.5px] text-[var(--tm-fg-2)]'
                    }
                  >
                    {r.over ? 'Went past: ' : ''}
                    {budgetLine(r, b)}
                  </span>
                  {r.budget === 'db' && <Sql text={r.sql} />}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Empty>None in this window on this node.</Empty>
        )}
        {h && (
          <p className='text-[11.5px] text-[var(--tm-muted)]' data-tm-near-timeout-history=''>
            Last 24 h (api log): {h.near_proxy} near the proxy limit, {h.over_proxy} past it,{' '}
            {h.db_timeouts} failed on a statement timeout · slowest {secs(h.worst_ms)}
          </p>
        )}
        <p className='text-[11.5px] text-[var(--tm-muted)]'>
          Budgets: {secs(b.db_ms)} per database statement, {secs(b.proxy_ms)} per request at the
          proxy; flagged from {Math.round(b.near_share * 100)}%.
        </p>
      </div>
    </Section>
  )
}

register(toolbarItems, { id: 'near-timeout-lens', order: 21, Component: inPage(NearTimeoutChip) })
register(nodeBadges, {
  id: 'near-timeout',
  order: 25,
  badge(nodeId) {
    if (!nearTimeoutLens.get()) return null
    const e = current.get(nodeId)
    return e ? nearTimeoutBadge(e.n, e.over) : null
  }
})
register(canvasLayers, {
  id: 'near-timeout',
  order: 34,
  draw(ctx, { layout, data, tokens }) {
    if (!nearTimeoutLens.get() || current.size === 0) return
    ctx.lineWidth = 1.5
    for (const lane of data.lanes)
      for (const e of lane.entities) {
        const r = layout.ents[e.key]
        const hit = current.get(e.key)
        if (!r || !hit) continue
        ctx.strokeStyle = hit.over > 0 ? tokens.error : tokens.update
        ctx.setLineDash(hit.over > 0 ? [] : [3, 2])
        ctx.beginPath()
        ctx.roundRect(r.x + 2.25, r.y + 3.25, r.w - 4.5, r.h - 6.5, 3)
        ctx.stroke()
      }
    ctx.setLineDash([])
  }
})
register(inspectorPanels, {
  id: 'near-timeout',
  order: 41,
  applies: (sel) => sel.kind === 'entity',
  Component: inPage(NearTimeoutPanel)
})
