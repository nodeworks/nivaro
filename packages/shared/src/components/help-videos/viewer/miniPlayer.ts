// The mini player (#1500), kept free of React so it can be tested in node:
// where the one player instance lives (the sheet, a pop-out, or nowhere) and
// the time it carries across a move. The player's DOM is moved, never
// rebuilt, so normally it keeps its own clock; the hand-over only steps in
// when a browser reset the media element on adoption.

export type MiniPlace = 'sheet' | 'mini' | 'closed'
/** How a pop-out is shown: a Document Picture-in-Picture window where the
 *  browser has it, else a floating panel docked to the page's corner. */
export type MiniKind = 'pip' | 'panel'

export type MiniState = {
  place: MiniPlace
  kind: MiniKind | null
  /** The player's clock (edited ms) when it last moved. */
  at: number
  playing: boolean
}

export type MiniEvent =
  | { type: 'open' }
  | { type: 'pop-out'; kind: MiniKind; at: number; playing: boolean }
  | { type: 'pop-in'; at: number; playing: boolean }
  /** The pop-out window or panel was closed (by the person or the OS):
   *  the sheet comes back at the same moment. */
  | { type: 'mini-closed'; at: number; playing: boolean }
  | { type: 'close' }

export const MINI_INITIAL: MiniState = { place: 'closed', kind: null, at: 0, playing: false }

export function miniReducer(s: MiniState, e: MiniEvent): MiniState {
  switch (e.type) {
    case 'open':
      return s.place === 'closed' ? { ...s, place: 'sheet', kind: null } : s
    case 'pop-out':
      if (s.place !== 'sheet') return s
      return { place: 'mini', kind: e.kind, at: e.at, playing: e.playing }
    case 'pop-in':
    case 'mini-closed':
      if (s.place !== 'mini') return s
      return { place: 'sheet', kind: null, at: e.at, playing: e.playing }
    case 'close':
      return s.place === 'closed' ? s : { ...MINI_INITIAL }
  }
}

/** What to do with the clock after a move. The video keeps playing where it
 *  was unless the element lost its position (a jump back of more than a
 *  second, or to 0): then seek to where it was and play again if it was
 *  playing. */
export function handOver(
  before: { at: number; playing: boolean },
  after: { at: number; playing: boolean }
): { seekTo: number | null; resume: boolean } {
  const lost = after.at < before.at - 1000 || (before.at > 1000 && after.at === 0)
  return {
    seekTo: lost ? before.at : null,
    resume: before.playing && !after.playing
  }
}

/** The browser offers Document Picture-in-Picture: a window of our own
 *  (our DOM moves into it), not the `<video>`-only kind. */
export function hasDocumentPip(w: unknown): boolean {
  if (!w || typeof w !== 'object') return false
  const d = (w as { documentPictureInPicture?: { requestWindow?: unknown } })
    .documentPictureInPicture
  return !!d && typeof d.requestWindow === 'function'
}

/** The floating panel's place at the page's corner; the page keeps that much
 *  room at the bottom so nothing is covered (like the pinned chat panel). */
export const MINI_PANEL = { width: 400, height: 300, margin: 16 } as const
