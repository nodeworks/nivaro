/**
 * Cursors in shared grids (realtime round 2, item 25): which cell each other person has
 * focused in an inline grid or a plan grid — a small outline in that person's colour, their
 * name on hover. Names and cell keys only (`<collection>:<row>:<field>`), never values.
 *
 * Grids announce focus through window `nvr:cell-editing {cell, state}` (#69); the presence
 * hosts (admin use-record-presence, efp-new record-presence) relay it into the record room as
 * a `cell:` field and mark the cell on co-viewers' screens with `markRemoteCell`.
 *
 * `createCellAnnouncer` throttles the announcements: arrowing or tabbing across a row of cells
 * sends one start for the cell the person stops on (after CURSOR_SETTLE_MS), not one per
 * cell passed; leaving the grid sends one end (after CURSOR_LEAVE_MS, so a hop between two
 * cells or into a picker popover never flickers the mark).
 */

export const CURSOR_SETTLE_MS = 150
export const CURSOR_LEAVE_MS = 250

export type CellEmit = (cell: string, state: 'start' | 'end') => void

export interface CellAnnouncer {
  /** Focus is in this cell now (null = focus left every cell). */
  focus: (cell: string | null) => void
  /** Focus left the grid. */
  blur: () => void
  /** Send any pending end now (unmount). */
  flush: () => void
}

/** One announcer per grid. `emit` defaults to the window event the presence hosts relay. */
export function createCellAnnouncer(emit: CellEmit = windowCellEmit): CellAnnouncer {
  let announced: string | null = null
  let wanted: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const settle = () => {
    timer = null
    if (wanted === announced) return
    if (announced) emit(announced, 'end')
    announced = wanted
    if (announced) emit(announced, 'start')
  }
  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(settle, ms)
  }
  return {
    focus(cell) {
      wanted = cell
      schedule(cell ? CURSOR_SETTLE_MS : CURSOR_LEAVE_MS)
    },
    blur() {
      wanted = null
      schedule(CURSOR_LEAVE_MS)
    },
    flush() {
      if (timer) clearTimeout(timer)
      timer = null
      if (announced) emit(announced, 'end')
      announced = null
      wanted = null
    }
  }
}

export function windowCellEmit(cell: string, state: 'start' | 'end'): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('nvr:cell-editing', { detail: { cell, state } }))
}

/** Calm, distinct outline colours (readable on white and on the dark card). */
const CURSOR_COLORS = [
  '#0ea5e9', // sky
  '#8b5cf6', // violet
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ec4899', // pink
  '#6366f1', // indigo
  '#f97316', // orange
  '#14b8a6' // teal
]

/** One colour per person, the same on every screen (a hash of their id). */
export function cursorColor(personId: string | null | undefined): string {
  const s = String(personId ?? '').toUpperCase()
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return CURSOR_COLORS[Math.abs(h) % CURSOR_COLORS.length]
}

/**
 * Mark a grid cell as someone else's cursor: their colour as the outline (`--nvr-cursor`,
 * the hosts' CSS reads it) and their name as the hover tip. Returns the undo.
 */
export function markRemoteCell(
  el: HTMLElement,
  person: { id?: string | null; name: string }
): () => void {
  const hadTip = el.getAttribute('data-tip')
  el.classList.add('nvr-remote-editing')
  el.dataset.remoteEditor = person.name
  el.style.setProperty('--nvr-cursor', cursorColor(person.id ?? person.name))
  el.setAttribute('data-tip', `${person.name} is here`)
  return () => {
    el.classList.remove('nvr-remote-editing')
    delete el.dataset.remoteEditor
    el.style.removeProperty('--nvr-cursor')
    if (hadTip == null) el.removeAttribute('data-tip')
    else el.setAttribute('data-tip', hadTip)
  }
}
