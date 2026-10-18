/**
 * #2145 Baselines + #2144 health score on the map.
 *
 * - Entity dots are coloured by how far the node's errors and latency are from its own normal for
 *   this hour of the week (amber 2+ spreads above, red 4+), not by the fixed 5% rule — the rule
 *   still applies while no normal has been learned.
 * - A request surge gets a "3.1× usual" pill; callers and partners get the same on their nodes.
 * - The inspector's live sparkline draws the normal range behind the line; a "Normal for this
 *   hour" section compares requests, errors and p95 with their bands, and for an entity shows the
 *   0–100 health score and what took points off.
 * - Hot entities get a Health column (breakdown on hover) and can be sorted by it, or narrowed to
 *   nodes below 80. The sort is part of view links (`hsort`).
 * Then the features judged against the bands: what changed, the heatmap, the deploy check, the
 * executive summary.
 */
import { useContext, useEffect, useState } from 'react'
import { TrafficMapContext, useTrafficMap } from '../../context'
import { fmtMs, fmtPct } from '../../EventTicker'
import type { InspectorData } from '../../Inspector'
import { Empty, Section } from '../../Inspector'
import type { TrafficModel } from '../../model'
import { nodeBadges, nodeTones, sideBadges } from '../../registry/canvasLayers'
import { hotColumns, hotHeaderItems, hotRowTransforms } from '../../registry/hotColumns'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import { setSparkBandSource } from '../../registry/sparkBands'
import { viewParams } from '../../registry/viewParams'
import type { Selection } from '../../types'
import {
  type BandWire,
  HEALTH_GOOD,
  healthTip,
  judgeNode,
  type KeyBands,
  ratioText,
  type Score,
  scoreAgainstBaseline,
  scoreErrors
} from './score'
import { bandsFor, baselines, baselinesVersion, subscribeBaselines, useBaselines } from './store'
import {
  BASELINE_BADGE_ID,
  entityHealth,
  entityLive,
  fmtNum,
  isEntity,
  LevelChip,
  ToneChip
} from './ui'
import './what-changed'
import './heatmap'
import './deploy-check'
import './summary-view'

/** Badges and side pills read the last minute (their registries carry no window). */
const BADGE_WIN = 60

// ── sparkline bands ──────────────────────────────────────────────────────────
setSparkBandSource({
  get(node) {
    const b = baselines()
    if (!b) return null
    let band: BandWire | undefined
    if (node.kind === 'total') band = b.total.rpm
    else if (node.kind === 'entity')
      band = node.caller ? b.edges[`${node.caller}>${node.id}`]?.rpm : b.nodes[node.id]?.rpm
    else if (node.kind === 'caller') band = b.callers[node.id]?.rpm
    else band = b.downs[node.id]?.rpm
    return band ? { lo: band[1], hi: band[2] } : null
  },
  subscribe: subscribeBaselines,
  version: baselinesVersion
})

// ── node tones + pills ─────────────────────────────────────────────────────────
register(nodeTones, {
  id: 'baselines',
  tone(nodeId, m, win) {
    const live = entityLive(m, nodeId, win)
    if (!live.bands) return null
    const j = judgeNode(live, live.bands)
    if (j.worst === 'high') return 'error'
    if (j.worst === 'elevated') return 'update'
    if (j.worst === 'unknown') return null
    return 'normal'
  }
})

register(nodeBadges, {
  id: BASELINE_BADGE_ID,
  // registered after the detectors, so their pills win; this one shows a surge otherwise
  badge(nodeId, m) {
    const live = entityLive(m, nodeId, BADGE_WIN)
    const s = scoreAgainstBaseline((live.req * 60) / BADGE_WIN, live.bands?.rpm, true)
    if (s.level !== 'high' || (s.ratio ?? 0) < 2) return null
    const text = ratioText(s)
    return text ? { text, tone: 'info' } : null
  }
})

register(sideBadges, {
  id: 'baselines',
  order: 300,
  badge(kind, nodeId, m) {
    if (kind === 'caller') {
      const [req, err] = m.callerSum(nodeId, BADGE_WIN)
      const bands = bandsFor('caller', nodeId)
      const e = scoreErrors(req, err, bands?.err_pct)
      if (e.level === 'high') return { text: 'errors above usual', tone: 'error' }
      const r = scoreAgainstBaseline((req * 60) / BADGE_WIN, bands?.rpm)
      const text = r.level === 'high' && (r.ratio ?? 0) >= 2 ? ratioText(r) : null
      return text ? { text, tone: 'info' } : null
    }
    if (!nodeId.startsWith('ext:')) return null
    const [req, err] = m.downSum(nodeId, BADGE_WIN)
    const e = scoreErrors(req, err, bandsFor('down', nodeId)?.err_pct)
    if (e.level === 'high') return { text: 'failing above usual', tone: 'error' }
    if (e.level === 'elevated') return { text: 'more failures than usual', tone: 'warn' }
    return null
  }
})

// ── inspector: normal for this hour ────────────────────────────────────────────
function Row({
  label,
  now,
  band,
  score,
  fmt
}: {
  label: string
  now: string
  band: BandWire | undefined
  score: Score
  fmt: (v: number) => string
}) {
  return (
    <div className='grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-2 text-[12px]'>
      <span className='text-[var(--tm-fg-2)]'>{label}</span>
      <span className='tabular-nums'>
        {now}
        {band && (
          <span className='ml-1.5 text-[11.5px] text-[var(--tm-muted)]'>
            usual {fmt(band[1])}–{fmt(band[2])}
          </span>
        )}
      </span>
      <LevelChip
        level={score.level}
        tip={
          band
            ? `Median ${fmt(band[0])} over ${band[4]} sample hours (same weekday and hour, last four weeks)`
            : 'Not enough history for this hour yet'
        }
      />
    </div>
  )
}

function bandsOfSel(sel: Selection, d: InspectorData): KeyBands | undefined {
  if (sel.kind === 'entity')
    return d.focusCaller
      ? baselines()?.edges[`${d.focusCaller}>${sel.id}`]
      : bandsFor('entity', sel.id)
  if (sel.kind === 'caller') return bandsFor('caller', sel.id)
  if (sel.kind === 'down') return bandsFor('down', sel.id)
  return undefined
}

function NormalPanel({ sel, d }: { sel: Selection; d: InspectorData }) {
  const b = useBaselines()
  const { model, win, tick } = useTrafficMap()
  void tick
  const bands = bandsOfSel(sel, d)
  const req = d.rps * win
  const errors = Number.isFinite(d.errPct) ? (req * d.errPct) / 100 : 0
  const j = judgeNode({ req, errors, windowS: win, p95: d.p95 }, bands)
  const health = isEntity(sel) && !d.focusCaller ? entityHealth(model, sel.id, win) : null
  return (
    <Section title='Normal for this hour'>
      <div className='grid gap-1.5' data-tm-baseline=''>
        {!b ? (
          <Empty>Loading…</Empty>
        ) : !bands ? (
          <Empty>
            {b.learning
              ? `Still learning: ${b.hours_known} of ${b.hours_wanted} sample hours known for this hour of the week.`
              : 'No normal learned for this node at this hour yet (it was quiet here in past weeks).'}
          </Empty>
        ) : (
          <>
            <Row
              label='Requests/min'
              now={fmtNum(d.rps * 60)}
              band={bands.rpm}
              score={j.rpm}
              fmt={fmtNum}
            />
            <Row
              label='Errors'
              now={fmtPct(d.errPct)}
              band={bands.err_pct}
              score={j.errors}
              fmt={(v) => `${v.toFixed(1)}%`}
            />
            <Row label='p95' now={fmtMs(d.p95)} band={bands.p95} score={j.p95} fmt={fmtMs} />
          </>
        )}
        {health && (
          <div
            className='mt-1.5 grid gap-1 border-t border-[var(--tm-line-2)] pt-2'
            id='tm-health'
            data-tm-health={health.score}
          >
            <div className='flex items-baseline justify-between gap-2'>
              <span className='text-[12px] font-medium'>Health</span>
              <ToneChip tone={health.tone} tip={healthTip(health)}>
                {health.score}/100
              </ToneChip>
            </div>
            {health.parts.map((p) => (
              <div
                key={p.id}
                className='grid grid-cols-[72px_minmax(0,1fr)_auto] items-baseline gap-2 text-[11.5px]'
              >
                <span className='text-[var(--tm-fg-2)]'>{p.label}</span>
                <span className='min-w-0 truncate text-[var(--tm-muted)]' data-tip={p.detail}>
                  {p.detail}
                </span>
                <span className='tabular-nums'>{p.penalty ? `−${p.penalty}` : '0'}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  )
}

register(inspectorPanels, {
  id: 'baselines',
  order: 5,
  applies: (sel) =>
    (sel.kind === 'entity' && !sel.id.includes('/__')) ||
    sel.kind === 'caller' ||
    (sel.kind === 'down' && sel.id.startsWith('ext:')),
  Component: NormalPanel
})

// ── hot entities: health column, sort and filter ───────────────────────────────
type HotSort = 'busy' | 'health' | 'unhealthy'
let hotSort: HotSort = 'busy'
const sortSubs = new Set<() => void>()
function setHotSort(v: HotSort): void {
  hotSort = v
  for (const fn of sortSubs) fn()
}
function subscribeSort(fn: () => void): () => void {
  sortSubs.add(fn)
  return () => sortSubs.delete(fn)
}

function HealthCell({ rowKey }: { rowKey: string }) {
  // the hot table can render outside the page (tests, embeds): no page, no score
  const tm = useContext(TrafficMapContext)
  if (!tm || rowKey.includes('/__')) return null
  const h = entityHealth(tm.model, rowKey, tm.win)
  return (
    <ToneChip tone={h.tone} tip={healthTip(h)}>
      {h.score}
    </ToneChip>
  )
}
register(hotColumns, {
  id: 'health',
  header: 'Health',
  align: 'right',
  cell: (row) => <HealthCell rowKey={row.key} />
})

const SORTS: Array<{ v: HotSort; label: string; tip: string }> = [
  { v: 'busy', label: 'Busiest', tip: 'Most requests first' },
  { v: 'health', label: 'Least healthy', tip: 'Lowest health score first' },
  {
    v: 'unhealthy',
    label: `Below ${HEALTH_GOOD}`,
    tip: `Only nodes scoring under ${HEALTH_GOOD}, lowest first`
  }
]
function HotSortControl() {
  const [v, setV] = useState(hotSort)
  useEffect(() => subscribeSort(() => setV(hotSort)), [])
  return (
    <fieldset
      className='inline-flex overflow-hidden rounded-md border border-[var(--tm-line)]'
      aria-label='Order hot entities'
      id='tm-hot-sort'
    >
      {SORTS.map((s, i) => (
        <button
          key={s.v}
          type='button'
          aria-pressed={v === s.v}
          data-tip={s.tip}
          data-tm-hot-sort={s.v}
          onClick={() => setHotSort(s.v)}
          className={`px-2 py-[2px] text-[11.5px] font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan ${
            i > 0 ? 'border-l border-[var(--tm-line)]' : ''
          } ${
            v === s.v
              ? 'bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
              : 'bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
          }`}
        >
          {s.label}
        </button>
      ))}
    </fieldset>
  )
}
register(hotHeaderItems, { id: 'health-sort', Component: HotSortControl })

register(hotRowTransforms, {
  id: 'health',
  active: () => hotSort !== 'busy',
  apply(rows, m: TrafficModel, win) {
    const scored = rows
      .filter((r) => !r.key.includes('/__'))
      .map((r) => ({ r, s: entityHealth(m, r.key, win).score }))
    const kept = hotSort === 'unhealthy' ? scored.filter((x) => x.s < HEALTH_GOOD) : scored
    return kept.sort((a, b) => a.s - b.s || b.r.rps - a.r.rps).map((x) => x.r)
  }
})

register(viewParams, {
  id: 'health-sort',
  param: 'hsort',
  get: () => (hotSort === 'busy' ? null : hotSort),
  set: (v) => setHotSort(v === 'health' || v === 'unhealthy' ? v : 'busy'),
  subscribe: subscribeSort
})
