/**
 * #1173 — extension ownership overlay. "Is this efp-ops or Nivaro?": each node's load (wall time
 * over the window) split between core and each extension — extension routes wholly, other
 * requests by the time extension hooks ran inside them, partner calls by who made them, cron jobs
 * by their id. The toolbar toggle draws a thin owner bar under every node an extension touches;
 * the inspector lists the split for the selection.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../../context'
import { fmtMs } from '../../EventTicker'
import { Empty, Section } from '../../Inspector'
import type { MapTokens, Rect } from '../../layout'
import { canvasLayers, requestCanvasRepaint } from '../../registry/canvasLayers'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import type { Selection } from '../../types'
import {
  CORE,
  type OwnershipData,
  ownerOfNodeId,
  ownershipNow,
  setOwnership,
  sharesOf,
  useOwnership
} from './store'

const PALETTE: Array<{ token: keyof MapTokens; css: string }> = [
  { token: 'update', css: 'var(--tm-update)' },
  { token: 'create', css: 'var(--tm-create)' },
  { token: 'inferred', css: 'var(--tm-inferred)' },
  { token: 'ecAuth', css: 'var(--tm-ec-auth)' },
  { token: 'ecRateLimited', css: 'var(--tm-ec-rate-limited)' },
  { token: 'read', css: 'var(--tm-read)' }
]

/** Stable colour slot per extension: its position in the sorted list of owners seen. */
export function colourSlot(owner: string, extensions: readonly string[]): number {
  const i = extensions.indexOf(owner)
  const idx = i >= 0 ? i : [...owner].reduce((a, c) => a + c.charCodeAt(0), 0)
  return idx % PALETTE.length
}

let shown = false
const subs = new Set<() => void>()
function setShown(v: boolean): void {
  shown = v
  for (const fn of subs) fn()
  requestCanvasRepaint()
}
function useShown(): boolean {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    () => shown,
    () => shown
  )
}

/** Every owner the overlay can colour: the server's list plus outright owners on the canvas. */
function extensionsOf(data: OwnershipData | null, ids: Iterable<string>): string[] {
  const set = new Set(data?.extensions ?? [])
  for (const id of ids) {
    const o = ownerOfNodeId(id)
    if (o) set.add(o)
  }
  return [...set].sort()
}

function OwnershipToggle() {
  const on = useShown()
  const q = useOwnership(on)
  useEffect(() => {
    setOwnership(on ? (q.data ?? null) : null)
  }, [on, q.data])
  const exts = on ? (q.data?.extensions ?? []) : []
  return (
    <button
      type='button'
      id='tm-ownership'
      aria-pressed={on}
      onClick={() => setShown(!on)}
      title='Shade each node by how much of its load is Nivaro core versus each extension'
      data-tm-ownership={on ? 'on' : 'off'}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tm-card)]',
        on
          ? 'border-[color-mix(in_srgb,var(--tm-update)_55%,var(--tm-line))] bg-[color-mix(in_srgb,var(--tm-update)_10%,var(--tm-card))] text-[var(--tm-fg)]'
          : 'border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
      )}
    >
      Owners
      {exts.map((e) => (
        <span
          key={e}
          className='inline-flex items-center gap-1 text-[11.5px] font-normal text-[var(--tm-fg-2)]'
          data-tm-owner-legend={e}
        >
          <i
            className='inline-block size-2 rounded-full'
            style={{ background: PALETTE[colourSlot(e, exts)].css }}
          />
          {e}
        </span>
      ))}
    </button>
  )
}

register(toolbarItems, { id: 'ext-ownership', order: 47, Component: OwnershipToggle })

/** Owner bar along the bottom edge of one node rect. */
function drawBar(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  shares: Array<{ owner: string; share: number }>,
  tokens: MapTokens,
  exts: string[]
): void {
  const h = 3
  const y = r.y + r.h - h - 1
  const w = r.w - 8
  let x = r.x + 4
  for (const s of shares) {
    const sw = Math.max(1, w * s.share)
    ctx.fillStyle =
      s.owner === CORE ? tokens.line : tokens[PALETTE[colourSlot(s.owner, exts)].token]
    ctx.fillRect(x, y, Math.min(sw, r.x + 4 + w - x), h)
    x += sw
    if (x >= r.x + 4 + w) break
  }
}

register(canvasLayers, {
  id: 'ext-ownership',
  order: 20,
  draw(ctx, { layout, tokens }) {
    if (!shown) return
    const data = ownershipNow()
    const rects: Array<[string, Rect]> = [
      ...Object.entries(layout.ents),
      ...Object.entries(layout.downs),
      ...Object.entries(layout.callers)
    ]
    const exts = extensionsOf(
      data,
      rects.map(([id]) => id)
    )
    for (const [id, r] of rects) {
      const shares = sharesOf(id, data)
      if (!shares.some((s) => s.owner !== CORE)) continue
      drawBar(ctx, r, shares, tokens, exts)
    }
    // a lane whose entities all belong to one extension (the Extensions lane) gets its own bar
    for (const [laneId, r] of Object.entries(layout.lanes)) {
      if (laneId !== 'extension') continue
      const owners = Object.keys(layout.ents)
        .filter((k) => k.startsWith('extension/'))
        .map((k) => ownerOfNodeId(k))
        .filter((o): o is string => !!o)
      if (!owners.length) continue
      const counts = new Map<string, number>()
      for (const o of owners) counts.set(o, (counts.get(o) ?? 0) + 1)
      drawBar(
        ctx,
        { x: r.x, y: r.y, w: r.w, h: 24 },
        [...counts].map(([owner, n]) => ({ owner, share: n / owners.length })),
        tokens,
        exts
      )
    }
  }
})

function nodeIdOf(sel: Selection): string | null {
  if (sel.kind === 'entity' || sel.kind === 'down' || sel.kind === 'caller') return sel.id
  return null
}

function OwnershipPanel({ sel }: { sel: Selection }) {
  const id = nodeIdOf(sel)
  const { win } = useTrafficMap()
  const q = useOwnership(true)
  if (!id) return null
  const shares = sharesOf(id, q.data ?? null)
  const exts = extensionsOf(q.data ?? null, [id])
  const outright = ownerOfNodeId(id)
  return (
    <Section title='Load by owner'>
      {q.isLoading ? (
        <Empty>Reading who owns this load…</Empty>
      ) : shares.length === 0 ? (
        <Empty>
          All Nivaro core over the last {win / 60} min — no extension route, hook or job touched
          this.
        </Empty>
      ) : (
        <ul className='grid gap-1.5 text-[12px]' data-tm-ownership-panel={id}>
          {shares.map((s) => (
            <li
              key={s.owner}
              className='grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2'
              data-tm-owner={s.owner}
            >
              <span className='inline-flex min-w-0 items-center gap-1.5 truncate'>
                <i
                  className='inline-block size-2 shrink-0 rounded-full'
                  style={{
                    background:
                      s.owner === CORE ? 'var(--tm-line)' : PALETTE[colourSlot(s.owner, exts)].css
                  }}
                />
                {s.owner === CORE ? 'Nivaro core' : s.owner}
              </span>
              <span className='tabular-nums'>
                <span className='font-medium'>{Math.round(s.share * 100)}%</span>
                {s.ms > 0 && <span className='text-[var(--tm-muted)]'> · {fmtMs(s.ms)}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {outright && shares.length > 0 && (
        <p className='mt-1.5 text-[11.5px] text-[var(--tm-muted)]'>
          {sel.kind === 'caller'
            ? `A scheduled job registered by ${outright}.`
            : `Registered by ${outright}.`}
        </p>
      )}
      {!outright && shares.some((s) => s.owner !== CORE) && (
        <p className='mt-1.5 text-[11.5px] text-[var(--tm-muted)]'>
          Wall time over the window: extension routes wholly, other requests by the time extension
          hooks ran inside them, partner calls by who made them.
        </p>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'ext-ownership',
  order: 35,
  applies: (sel) =>
    (sel.kind === 'entity' && !sel.id.endsWith('/__other__')) ||
    sel.kind === 'down' ||
    (sel.kind === 'caller' && !!ownerOfNodeId(sel.id)),
  Component: OwnershipPanel
})
