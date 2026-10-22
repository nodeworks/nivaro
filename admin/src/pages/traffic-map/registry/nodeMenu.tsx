import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { type NavigateFunction, useInRouterContext, useNavigate } from 'react-router'
import { cn } from '@/lib/utils'
import type { Selection } from '../types'
import { byOrder, type Registered } from './registry'

/**
 * Node context menu (#2851): right-click a node on the map for actions on it ("Simulate down",
 * "Inject fault here"…). Features register providers; each returns the entries it offers for the
 * node (none = it adds nothing). The menu opens only when some provider offers something, so the
 * browser's own menu stays everywhere else.
 */
export interface NodeMenuEntry {
  key: string
  label: string
  /** A short line under the label. */
  hint?: string
  tone?: 'danger'
  run(ctx: NodeMenuContext): void
}
export interface NodeMenuContext {
  navigate: NavigateFunction
  /** Select a node on the map (opens it in the inspector). */
  select(sel: Selection): void
}
export interface NodeMenuProvider extends Registered {
  entries(sel: Selection): NodeMenuEntry[]
}

export const nodeMenuProviders: NodeMenuProvider[] = []

/** Every entry the providers offer for `sel`, in provider order (a throwing provider adds none). */
export function nodeMenuEntries(sel: Selection): NodeMenuEntry[] {
  const out: NodeMenuEntry[] = []
  for (const p of byOrder(nodeMenuProviders)) {
    try {
      out.push(...p.entries(sel))
    } catch {
      /* a broken provider offers nothing */
    }
  }
  return out
}

export interface NodeMenuState {
  sel: Selection
  /** Viewport point the menu opens at. */
  x: number
  y: number
  entries: NodeMenuEntry[]
}

const ITEM =
  'grid w-full rounded px-2 py-1.5 text-left text-[12px] outline-none hover:bg-[var(--tm-card-2)] focus-visible:bg-[var(--tm-card-2)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan'

const assign = ((to: string) => window.location.assign(to)) as NavigateFunction

interface MenuProps {
  state: NodeMenuState
  onClose: () => void
  onSelect: (sel: Selection) => void
}

function RoutedMenu(props: MenuProps) {
  return <MenuBody {...props} nav={useNavigate()} />
}

/** The open menu: portalled to body at the pointer, kept on screen; Escape / outside click close. */
export function NodeMenu(props: MenuProps) {
  return useInRouterContext() ? <RoutedMenu {...props} /> : <MenuBody {...props} nav={assign} />
}

function MenuBody({ state, onClose, onSelect, nav }: MenuProps & { nav: NavigateFunction }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: state.x, top: state.y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    setPos({
      left: Math.max(8, Math.min(state.x, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(state.y, window.innerHeight - h - 8))
    })
    el.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus()
  }, [state])
  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', away, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])
  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = items.length
      items[(i + (e.key === 'ArrowDown' ? 1 : n - 1) + n) % n]?.focus()
    }
  }
  return createPortal(
    <div
      ref={ref}
      role='menu'
      aria-label='Node actions'
      data-tm-node-menu={`${state.sel.kind}:${state.sel.id}`}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
      className='traffic-map fixed z-50 min-w-[200px] max-w-[300px] rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] p-1 shadow-[0_4px_16px_rgba(0,0,0,0.10),0_1px_4px_rgba(0,0,0,0.06)]'
      style={pos}
    >
      {state.entries.map((e) => (
        <button
          key={e.key}
          type='button'
          role='menuitem'
          data-tm-node-menu-item={e.key}
          className={ITEM}
          onClick={() => {
            onClose()
            e.run({ navigate: nav, select: onSelect })
          }}
        >
          <span
            className={cn(
              'font-medium',
              e.tone === 'danger' ? 'text-[var(--tm-error-ink)]' : 'text-[var(--tm-fg)]'
            )}
          >
            {e.label}
          </span>
          {e.hint ? (
            <span className='text-[11px] leading-snug text-[var(--tm-fg-2)]'>{e.hint}</span>
          ) : null}
        </button>
      ))}
    </div>,
    document.body
  )
}
