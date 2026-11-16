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

/**
 * Calm, clearly distinct outline colours (readable on white and on the dark card). No amber,
 * orange or red: those read as status (warning, refused) in this app.
 */
export const CURSOR_COLORS = [
  '#0ea5e9', // sky
  '#8b5cf6', // violet
  '#10b981', // emerald
  '#ec4899', // pink
  '#64748b', // slate
  '#84cc16' // lime
]

/** One colour per person, the same on every screen (a hash of their id). */
export function cursorColor(personId: string | null | undefined): string {
  const s = String(personId ?? '').toUpperCase()
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return CURSOR_COLORS[Math.abs(h) % CURSOR_COLORS.length]
}

/**
 * Colours for the people on one screen right now: everyone keeps the colour they already had
 * while they stay, a newcomer takes the first colour nobody on screen holds, so no two people
 * share a colour until there are more people than colours. Pure; `prev` is the last answer.
 */
export function assignCursorColors(
  ids: string[],
  prev: ReadonlyMap<string, string> = new Map()
): Map<string, string> {
  const out = new Map<string, string>()
  const key = (id: string) => id.toUpperCase()
  for (const id of ids) {
    const kept = prev.get(key(id))
    if (kept && ![...out.values()].includes(kept)) out.set(key(id), kept)
  }
  for (const id of ids) {
    if (out.has(key(id))) continue
    const used = new Set(out.values())
    const free = CURSOR_COLORS.find((c) => !used.has(c))
    out.set(key(id), free ?? cursorColor(id))
  }
  return out
}

/** "Beth Ray" → "BR" (one name → its first two letters). */
export function personInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

/**
 * Mark a grid cell as someone else's cursor: their colour as the outline (`--nvr-cursor`,
 * the hosts' CSS reads it) and their name as the hover tip. `color` overrides the hashed one
 * (a screen that assigns colours per person present). Returns the undo.
 */
export function markRemoteCell(
  el: HTMLElement,
  person: { id?: string | null; name: string },
  color?: string
): () => void {
  const hadTip = el.getAttribute('data-tip')
  const hadSide = el.getAttribute('data-tip-side')
  el.classList.add('nvr-remote-editing')
  el.dataset.remoteEditor = person.name
  el.style.setProperty('--nvr-cursor', color ?? cursorColor(person.id ?? person.name))
  el.setAttribute('data-tip', `${person.name} is here`)
  // Above the cell: a tip below it covered the next row's value.
  el.setAttribute('data-tip-side', 'top')
  return () => {
    el.classList.remove('nvr-remote-editing')
    delete el.dataset.remoteEditor
    el.style.removeProperty('--nvr-cursor')
    if (hadTip == null) el.removeAttribute('data-tip')
    else el.setAttribute('data-tip', hadTip)
    if (hadSide == null) el.removeAttribute('data-tip-side')
    else el.setAttribute('data-tip-side', hadSide)
  }
}
