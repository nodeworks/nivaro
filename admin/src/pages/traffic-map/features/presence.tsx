import { Eye } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAuth } from '@/lib/auth'
import { adminRealtime } from '@/lib/socket'
import { useTrafficMap } from '../context'
import { callerLabel, entityLabel } from '../EventTicker'
import type { TrafficModel } from '../model'
import { downLabel } from '../nodeKinds'
import { canvasLayers, requestCanvasRepaint } from '../registry/canvasLayers'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import { LANE_LABEL, type Lane, type Selection, type TrafficCatalog } from '../types'
import { BTN } from './shared'
import { useFrozenSnapshotId } from './snapshots'

/**
 * #1164 — other admins on the map, for incident calls. Every page that watches the map says
 * who it is and what it has selected (the server stamps the person and repeats it inside the
 * Traffic Map watch room only — per tenant in cloud mode); this lists the others and marks what
 * they are looking at on the canvas. An entry not heard from for STALE_MS is dropped.
 */
export interface Viewer {
  key: string
  sid: string
  tab: string
  user: { id: string; name: string }
  selection: Selection | null
  at: number
}
const ANNOUNCE_MS = 10_000
const STALE_MS = 25_000
const TAB = `t${Math.random().toString(36).slice(2, 12)}`

let viewers = new Map<string, Viewer>()
let version = 0
const subs = new Set<() => void>()
function changed() {
  version++
  for (const fn of subs) fn()
  requestCanvasRepaint()
}
function useViewers(): Viewer[] {
  useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
    () => version,
    () => version
  )
  return [...viewers.values()]
}

/** Apply one `traffic-map:viewer` message; returns true when it was someone new. */
export function applyViewerMessage(
  p: unknown,
  me: { tab: string; userId: string | null },
  now = Date.now()
): boolean {
  const m = p as {
    sid?: string
    tab?: string
    gone?: boolean
    user?: { id?: string; name?: string }
    selection?: Selection | null
  } | null
  if (!m?.sid) return false
  if (m.gone) {
    let any = false
    for (const [k, v] of viewers)
      if (v.sid === m.sid && (!m.tab || v.tab === m.tab)) {
        viewers.delete(k)
        any = true
      }
    if (any) changed()
    return false
  }
  if (!m.tab || m.tab === me.tab || !m.user?.id) return false
  if (me.userId && m.user.id.toUpperCase() === me.userId.toUpperCase()) return false // my other tab
  const key = `${m.sid}|${m.tab}`
  const fresh = !viewers.has(key)
  viewers.set(key, {
    key,
    sid: m.sid,
    tab: m.tab,
    user: { id: m.user.id, name: m.user.name || 'Someone' },
    selection: m.selection ?? null,
    at: now
  })
  changed()
  return fresh
}
export function pruneViewers(now = Date.now()): void {
  let any = false
  for (const [k, v] of viewers)
    if (now - v.at > STALE_MS) {
      viewers.delete(k)
      any = true
    }
  if (any) changed()
}
export function resetViewers(): void {
  viewers = new Map()
  changed()
}

export function selectionText(
  sel: Selection | null,
  m: TrafficModel,
  cat: TrafficCatalog | null
): string {
  if (!sel) return 'the whole map'
  if (sel.kind === 'entity') {
    const cut = sel.id.indexOf('/')
    return entityLabel(cat, sel.id.slice(0, cut), sel.id.slice(cut + 1))
  }
  if (sel.kind === 'lane') return `the ${LANE_LABEL[sel.id as Lane] ?? sel.id} lane`
  if (sel.kind === 'caller') return callerLabel(cat, sel.id)
  return downLabel(m, cat, sel.id)
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?'

function Presence() {
  const { selection, setSelection, model, catalog } = useTrafficMap()
  const frozen = useFrozenSnapshotId()
  const { user } = useAuth()
  const list = useViewers()
  const selRef = useRef(selection)
  selRef.current = selection
  const [open, setOpen] = useState(false)
  const userId = (user as { id?: string } | null)?.id ?? null

  // announce: on mount, every ANNOUNCE_MS, on a selection change, and soon after a newcomer
  useEffect(() => {
    if (frozen) return
    let soon: ReturnType<typeof setTimeout> | null = null
    const say = () => {
      const sel = selRef.current
      adminRealtime.emit('traffic-map:presence', {
        tab: TAB,
        selection: sel ? { kind: sel.kind, id: sel.id } : null
      })
    }
    say()
    const every = setInterval(() => {
      say()
      pruneViewers()
    }, ANNOUNCE_MS)
    const off = adminRealtime.on('traffic-map:viewer', (p: unknown) => {
      if (applyViewerMessage(p, { tab: TAB, userId }) && !soon)
        soon = setTimeout(() => {
          soon = null
          say()
        }, 800)
    })
    return () => {
      off()
      clearInterval(every)
      if (soon) clearTimeout(soon)
      adminRealtime.emit('traffic-map:bye', { tab: TAB })
      resetViewers()
    }
  }, [frozen, userId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: selection is the trigger
  useEffect(() => {
    if (frozen) return
    adminRealtime.emit('traffic-map:presence', {
      tab: TAB,
      selection: selection ? { kind: selection.kind, id: selection.id } : null
    })
  }, [selection?.kind, selection?.id, frozen])

  // one entry per person (several tabs: the newest)
  const people = useMemo(() => {
    const byUser = new Map<string, Viewer>()
    for (const v of list) {
      const cur = byUser.get(v.user.id)
      if (!cur || v.at > cur.at) byUser.set(v.user.id, v)
    }
    return [...byUser.values()].sort((a, b) => a.user.name.localeCompare(b.user.name))
  }, [list])
  if (frozen || !people.length) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          id='tm-presence'
          className={BTN}
          aria-label={`${people.length} other ${people.length === 1 ? 'admin is' : 'admins are'} watching the map`}
        >
          <Eye className='h-3.5 w-3.5' aria-hidden='true' />
          <span className='flex -space-x-1' aria-hidden='true'>
            {people.slice(0, 3).map((v) => (
              <span
                key={v.user.id}
                className='inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border border-[var(--tm-card)] bg-[var(--tm-accent-soft)] text-[9px] font-semibold text-[var(--tm-accent-ink)]'
              >
                {initials(v.user.name)}
              </span>
            ))}
          </span>
          <span className='tabular-nums'>{people.length}</span> watching
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[300px] p-0'>
        <div className='traffic-map border-b border-[var(--tm-line-2)] px-3 py-2 text-[12px] font-semibold text-[var(--tm-fg)]'>
          Also on the map
        </div>
        <ul className='traffic-map grid gap-0.5 p-1.5 text-[12px]' id='tm-presence-list'>
          {people.map((v) => (
            <li key={v.key} className='flex items-center justify-between gap-2 rounded px-1.5 py-1'>
              <span className='min-w-0'>
                <span className='block truncate font-medium text-[var(--tm-fg)]'>
                  {v.user.name}
                </span>
                <span className='block truncate text-[11.5px] text-[var(--tm-fg-2)]'>
                  Looking at {selectionText(v.selection, model, catalog)}
                </span>
              </span>
              {v.selection ? (
                <button
                  type='button'
                  className={BTN}
                  data-tm-presence-go={v.user.id}
                  onClick={() => {
                    setSelection(v.selection)
                    setOpen(false)
                  }}
                >
                  Go there
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

register(toolbarItems, { id: 'presence', order: 5, Component: Presence })
register(canvasLayers, {
  id: 'presence',
  order: 95,
  draw(ctx, { layout, tokens, fonts }) {
    if (!viewers.size) return
    // a small name tag above whatever another admin has selected
    const seen = new Set<string>()
    ctx.font = `600 9.5px ${fonts.sans}`
    for (const v of viewers.values()) {
      const s = v.selection
      if (!s) continue
      const r =
        s.kind === 'entity'
          ? layout.ents[s.id]
          : s.kind === 'lane'
            ? layout.lanes[s.id]
            : s.kind === 'caller'
              ? layout.callers[s.id]
              : layout.downs[s.id]
      if (!r) continue
      const slot = `${s.kind}:${s.id}`
      if (seen.has(`${slot}|${v.user.id}`)) continue
      seen.add(`${slot}|${v.user.id}`)
      const t = v.user.name.split(/\s+/)[0] ?? v.user.name
      const w = ctx.measureText(t).width + 10
      const x = r.x + r.w - w - 2
      const y = r.y - 7
      ctx.beginPath()
      ctx.roundRect(x, y, w, 13, 6.5)
      ctx.fillStyle = tokens.fg
      ctx.fill()
      ctx.fillStyle = tokens.card
      ctx.fillText(t, x + 5, y + 9.5)
    }
  }
})
