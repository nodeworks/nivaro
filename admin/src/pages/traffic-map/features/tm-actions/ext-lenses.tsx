/**
 * #2229 Extension lenses — an extension registers `ctx.traffic.registerLens({ id, label, read })`
 * and the map shows a lens chip for it. While a lens is on, the page asks the server for its data
 * every 15 s (GET /traffic-map/ext-lenses/:key — the server runs the extension's `read` and keeps
 * only badges and panel rows) and draws it through the map's own slots: a pill on each node it
 * names and an inspector panel. No extension code ever runs in this bundle.
 */
import { useQueries, useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../../context'
import { Empty, type InspectorData, Section } from '../../Inspector'
import { nodeBadges, requestCanvasRepaint, sideBadges } from '../../registry/canvasLayers'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import type { Selection } from '../../types'
import { createStore, inPage, useStore } from '../b1-shared'
import { LensChip } from '../db-lenses/ui'
import { LINK, SafeLink } from '../shared'

export interface ExtLens {
  key: string
  extension: string
  id: string
  label: string
  description: string | null
  node_badge: boolean
  panel_title: string | null
}
type Tone = 'info' | 'warn' | 'error'
export interface ExtLensData {
  badges: Array<{ node: string; text: string; tone: Tone }>
  panels: Array<{
    node: string
    title: string | null
    rows: Array<{ label: string; value: string; tone: Tone | null; href: string | null }>
    note: string | null
  }>
  summary: string | null
}

/** Lens keys switched on (page-scoped; off by default). */
export const extLensesOn = createStore<string[]>([])
/** The newest data of each lens that is on (badge providers read it). */
let byLens = new Map<string, { lens: ExtLens; data: ExtLensData }>()

/** First badge any lens that is on gives a node (pure over the held data; exported for tests). */
export function lensBadgeFor(
  held: Map<string, { lens: ExtLens; data: ExtLensData }>,
  nodeId: string
): { text: string; tone: Tone } | null {
  for (const { lens, data } of held.values()) {
    if (!lens.node_badge) continue
    const b = data.badges.find((x) => x.node === nodeId)
    if (b) return { text: b.text, tone: b.tone }
  }
  return null
}

function useLensList() {
  const { ready } = useTrafficMap()
  return useQuery({
    queryKey: ['traffic-map', 'ext-lenses'],
    queryFn: async () =>
      ((await api.get('/traffic-map/ext-lenses')).data.data.lenses ?? []) as ExtLens[],
    enabled: ready,
    staleTime: 5 * 60_000
  })
}

function ExtLensChips() {
  const { win, paused, setFilters } = useTrafficMap()
  const on = useStore(extLensesOn)
  const list = useLensList().data ?? []
  const active = list.filter((l) => on.includes(l.key))
  const results = useQueries({
    queries: active.map((l) => ({
      queryKey: ['traffic-map', 'ext-lens', l.key, win],
      queryFn: async () =>
        (
          await api.get(`/traffic-map/ext-lenses/${encodeURIComponent(l.key)}`, {
            params: { window: win }
          })
        ).data.data as ExtLensData,
      refetchInterval: paused ? (false as const) : 15_000,
      staleTime: 10_000
    }))
  })
  const stamp = results.map((r) => r.dataUpdatedAt).join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stamp` changes exactly when any lens's data does
  useEffect(() => {
    const next = new Map<string, { lens: ExtLens; data: ExtLensData }>()
    active.forEach((l, i) => {
      const d = results[i]?.data
      if (d) next.set(l.key, { lens: l, data: d })
    })
    byLens = next
    requestCanvasRepaint()
  }, [stamp, on.join(',')])
  if (!list.length) return null
  return (
    <>
      {list.map((l, i) => {
        const isOn = on.includes(l.key)
        const d = isOn ? results[active.findIndex((a) => a.key === l.key)]?.data : undefined
        return (
          <LensChip
            key={l.key}
            id={`tm-ext-lens-${l.key.replace(/[^a-z0-9_-]/gi, '-')}`}
            on={isOn}
            onToggle={() => {
              extLensesOn.set(isOn ? on.filter((k) => k !== l.key) : [...on, l.key])
              setFilters((f) => ({ ...f }))
            }}
            color={`var(--tm-${['update', 'create', 'accent', 'read'][i % 4]})`}
            label={l.label}
            count={d?.badges.length}
            title={d?.summary ?? l.description ?? `${l.label} — from the ${l.extension} extension`}
          />
        )
      })}
    </>
  )
}

const TONE_INK: Record<Tone, string> = {
  info: 'text-[var(--tm-fg)]',
  warn: 'font-semibold text-[var(--tm-fg)]',
  error: 'text-[var(--tm-error-ink)]'
}

function ExtLensPanels({ sel }: { sel: Selection; d: InspectorData }) {
  useStore(extLensesOn)
  const panels: Array<{ lens: ExtLens; panel: ExtLensData['panels'][number] }> = []
  for (const { lens, data } of byLens.values()) {
    if (!lens.panel_title) continue
    for (const p of data.panels) if (p.node === sel.id) panels.push({ lens, panel: p })
  }
  if (!panels.length) return null
  return (
    <>
      {panels.map(({ lens, panel }) => (
        <Section
          key={`${lens.key}:${panel.node}`}
          title={panel.title ?? lens.panel_title ?? lens.label}
        >
          {panel.rows.length ? (
            <dl
              className='grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-[12px]'
              data-tm-ext-lens-panel={lens.key}
            >
              {panel.rows.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows come in the lens's own order and labels may repeat
                <div key={i} className='contents'>
                  <dt className='min-w-0 truncate text-[var(--tm-fg-2)]'>{r.label}</dt>
                  <dd className={cn('text-right tabular-nums', r.tone ? TONE_INK[r.tone] : '')}>
                    {r.href ? (
                      <SafeLink to={r.href} className={LINK}>
                        {r.value}
                      </SafeLink>
                    ) : (
                      r.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <Empty>Nothing to show.</Empty>
          )}
          {panel.note ? (
            <p className='mt-1 text-[11.5px] text-[var(--tm-muted)]'>{panel.note}</p>
          ) : null}
          <p className='mt-1 text-[11px] text-[var(--tm-muted)]'>
            From the {lens.extension} extension.
          </p>
        </Section>
      ))}
    </>
  )
}

register(toolbarItems, { id: 'ext-lenses', order: 40, Component: inPage(ExtLensChips) })
register(nodeBadges, {
  id: 'ext-lenses',
  order: 95,
  badge: (nodeId) => (byLens.size ? lensBadgeFor(byLens, nodeId) : null)
})
register(sideBadges, {
  id: 'ext-lenses',
  order: 95,
  badge: (_kind, nodeId) => (byLens.size ? lensBadgeFor(byLens, nodeId) : null)
})
register(inspectorPanels, {
  id: 'ext-lenses',
  order: 60,
  applies: () => byLens.size > 0,
  Component: inPage(ExtLensPanels)
})
