/**
 * Board lenses in the URL (CC-19), so a view can be shared and survives a reload:
 *   region=<region id>  at=<ISO instant>  map=<map collection>  peek=<collection>:<id>  tv=1
 * Read once on load; written with history.replaceState (no new history entry per change) or a
 * host-provided adapter. Unrelated query parameters are kept as they are.
 */

export interface BoardUrlState {
  region: string | null
  at: number | null
  map: string | null
  peek: { collection: string; id: string } | null
  tv: boolean
}

export const EMPTY_URL_STATE: BoardUrlState = {
  region: null,
  at: null,
  map: null,
  peek: null,
  tv: false
}

/** The keys this board owns in the query string. */
export const BOARD_URL_KEYS = ['region', 'at', 'map', 'peek', 'tv'] as const

const REGION = /^[A-Za-z0-9_-]{1,64}$/
const COLLECTION = /^[A-Za-z0-9_]{1,64}$/
const MAX_REWIND_MS = 31 * 86_400_000

export function parseBoardUrl(search: string, now = Date.now()): BoardUrlState {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const region = q.get('region')
  const map = q.get('map')
  const atRaw = q.get('at')
  let at: number | null = null
  if (atRaw) {
    const t = /^\d{10,14}$/.test(atRaw) ? Number(atRaw) : new Date(atRaw).getTime()
    // Only a past instant inside the rewind window; anything else opens live.
    if (Number.isFinite(t) && t < now && now - t <= MAX_REWIND_MS) at = t
  }
  let peek: BoardUrlState['peek'] = null
  const p = q.get('peek')
  if (p) {
    const i = p.indexOf(':')
    const collection = i > 0 ? p.slice(0, i) : ''
    const id = i > 0 ? p.slice(i + 1) : ''
    if (COLLECTION.test(collection) && id.length > 0 && id.length <= 128) peek = { collection, id }
  }
  return {
    region: region && REGION.test(region) ? region : null,
    at,
    map: map && COLLECTION.test(map) ? map : null,
    peek,
    tv: q.get('tv') === '1'
  }
}

/** `search` with the board's keys replaced by `state` (empty values removed). */
export function writeBoardUrl(search: string, state: BoardUrlState): string {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  for (const k of BOARD_URL_KEYS) q.delete(k)
  if (state.region) q.set('region', state.region)
  if (state.at) q.set('at', new Date(state.at).toISOString())
  if (state.map) q.set('map', state.map)
  if (state.peek) q.set('peek', `${state.peek.collection}:${state.peek.id}`)
  if (state.tv) q.set('tv', '1')
  const out = q.toString()
  return out ? `?${out}` : ''
}

/** How the board reads and replaces the URL's query string. */
export interface BoardUrlAdapter {
  read: () => string
  replace: (search: string) => void
}

/**
 * The default: window.location + history.replaceState, keeping the router's own history.state
 * (React Router keys its entries there) so back/forward still work.
 */
export const windowUrlAdapter: BoardUrlAdapter = {
  read: () => (typeof window === 'undefined' ? '' : window.location.search),
  replace: (search) => {
    if (typeof window === 'undefined') return
    if (search === window.location.search) return
    const url = `${window.location.pathname}${search}${window.location.hash}`
    window.history.replaceState(window.history.state, '', url)
  }
}

/** The full URL of the current view, for "Copy link". */
export function currentViewUrl(): string {
  return typeof window === 'undefined' ? '' : window.location.href
}
