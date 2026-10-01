// #1166 — the whole view in the URL: filters, selection, rewind position and every registered
// view param (lenses, workspace, node scope, zoom…). Pure encode/decode; TrafficMap keeps the
// address bar in step (replaceState) and applies a link once on open.
import { defaultFilters } from './model'
import { type Filters, KIND_ORDER, type Kind, LANE_ORDER, type Lane, type Selection } from './types'

/** Parameters the page itself owns (the rest belong to view params; `snapshot` to #1097). */
export const CORE_PARAMS = ['lanes', 'kinds', 'caller', 'callers', 'win', 'sel', 'at'] as const
const SEL_KINDS = new Set(['entity', 'lane', 'caller', 'down'])

export interface ViewState {
  filters: Filters
  selection: Selection | null
  /** The rewound second (epoch), or null when live. */
  at: number | null
}

const sameSet = <T>(a: Set<T>, b: Set<T>) => a.size === b.size && [...a].every((x) => b.has(x))

/** URL entries for the view; defaults are left out so the default view has a clean URL. */
export function encodeView(v: ViewState): Array<[string, string]> {
  const d = defaultFilters()
  const out: Array<[string, string]> = []
  if (!sameSet(v.filters.types, d.types))
    out.push(['lanes', LANE_ORDER.filter((l) => v.filters.types.has(l)).join(',')])
  if (!sameSet(v.filters.kinds, d.kinds))
    out.push(['kinds', KIND_ORDER.filter((k) => v.filters.kinds.has(k)).join(',')])
  if (v.filters.caller) out.push(['caller', v.filters.caller])
  else if (v.filters.callers?.length) out.push(['callers', v.filters.callers.join(',')])
  if (v.filters.win !== d.win) out.push(['win', String(v.filters.win)])
  if (v.selection) {
    const s = v.selection
    const caller = s.kind === 'entity' && s.caller ? `@${s.caller}` : ''
    out.push(['sel', `${s.kind}:${s.id}${caller}`])
  }
  if (v.at != null) out.push(['at', String(v.at)])
  return out
}

/** The view a link describes, on top of `cur` (anything missing or malformed keeps `cur`). */
export function decodeView(p: URLSearchParams, cur: ViewState): ViewState {
  const filters: Filters = { ...cur.filters }
  const lanes = p.get('lanes')
  if (lanes !== null) {
    const set = new Set(lanes.split(',').filter((l): l is Lane => LANE_ORDER.includes(l as Lane)))
    if (set.size) filters.types = set
  }
  const kinds = p.get('kinds')
  if (kinds !== null) {
    const set = new Set(kinds.split(',').filter((k): k is Kind => KIND_ORDER.includes(k as Kind)))
    if (set.size) filters.kinds = set
  }
  const caller = p.get('caller')
  if (caller && caller.length <= 200) filters.caller = caller
  const callers = p.get('callers')
  if (!caller && callers) {
    const list = callers
      .split(',')
      .filter((c) => c && c.length <= 200)
      .slice(0, 200)
    if (list.length) filters.callers = list
  }
  const win = Number(p.get('win'))
  if (win === 60 || win === 300 || win === 900) filters.win = win
  let selection = cur.selection
  const sel = p.get('sel')
  if (sel) {
    const cut = sel.indexOf(':')
    const kind = sel.slice(0, cut)
    let id = sel.slice(cut + 1)
    let focus: string | undefined
    if (kind === 'entity' && id.includes('@')) {
      focus = id.slice(id.lastIndexOf('@') + 1)
      id = id.slice(0, id.lastIndexOf('@'))
    }
    if (cut > 0 && SEL_KINDS.has(kind) && id && id.length <= 200)
      selection =
        kind === 'entity'
          ? { kind: 'entity', id, ...(focus ? { caller: focus } : {}) }
          : ({ kind, id } as Selection)
  }
  const atRaw = p.get('at')
  const at = atRaw && /^\d{9,11}$/.test(atRaw) ? Number(atRaw) : cur.at
  return { filters, selection, at }
}
