/**
 * #3233 — Share this list. A list's view as seen (filters, sort, visible
 * columns, search, page size …) rides one URL parameter, `lv`, so "Copy link"
 * hands another person exactly that view and opening the link restores it.
 *
 * It is URL state and nothing more: the person who opens the link reads the
 * list with their own access (User Scopes, row filters, field lists all apply
 * as usual) — a link never carries ids of what the sender could see, only the
 * view's settings.
 *
 * Envelope: base64url(JSON {v: 1, k: <list key>, s: <state>}). The key ties a
 * link to one list (`cbv:<collection>`, `queue:<id>`) so a parameter left on
 * the URL never bends a different list.
 */

export const LIST_LINK_PARAM = 'lv'
const VERSION = 1
/** Past this the link would not survive chat clients / proxies; refuse to build it. */
export const LIST_LINK_MAX_CHARS = 7000

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(raw: string): string | null {
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/** Drop empty values so the link stays short (`[]`, `{}`, `''`, null, undefined). */
export function pruneListLinkState<T extends Record<string, unknown>>(state: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(state)) {
    if (v == null || v === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue
    out[k] = v
  }
  return out as Partial<T>
}

export function encodeListLink(key: string, state: Record<string, unknown>): string {
  return toBase64Url(JSON.stringify({ v: VERSION, k: key, s: pruneListLinkState(state) }))
}

/** The state a link carries for THIS list, or null (absent, garbled, another list). */
export function decodeListLink(
  raw: string | null | undefined,
  key: string
): Record<string, unknown> | null {
  if (!raw) return null
  const text = fromBase64Url(raw)
  if (!text) return null
  try {
    const env = JSON.parse(text) as { v?: unknown; k?: unknown; s?: unknown }
    if (env?.v !== VERSION || env.k !== key) return null
    if (!env.s || typeof env.s !== 'object' || Array.isArray(env.s)) return null
    return env.s as Record<string, unknown>
  } catch {
    return null
  }
}

/** `href` with the list's `lv` parameter set (every other parameter kept). */
export function listLinkUrl(href: string, key: string, state: Record<string, unknown>): string {
  const url = new URL(href)
  url.searchParams.set(LIST_LINK_PARAM, encodeListLink(key, state))
  return url.toString()
}

/** The state on the current page's URL for this list. */
export function readListLinkFromLocation(key: string): Record<string, unknown> | null {
  if (typeof window === 'undefined') return null
  return decodeListLink(new URLSearchParams(window.location.search).get(LIST_LINK_PARAM), key)
}

/** Take `lv` off the address bar once applied, so a reload starts from the person's own defaults. */
export function dropListLinkParam(): void {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  if (!params.has(LIST_LINK_PARAM)) return
  params.delete(LIST_LINK_PARAM)
  const qs = params.toString()
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
  )
}

/**
 * Copy the link for this view. Resolves 'copied', 'too-long' (the view is too
 * big for a link — save it as a shared view instead) or 'failed' (no clipboard).
 */
export async function copyListLink(
  key: string,
  state: Record<string, unknown>
): Promise<'copied' | 'too-long' | 'failed'> {
  if (typeof window === 'undefined') return 'failed'
  const url = listLinkUrl(window.location.href, key, state)
  if (url.length > LIST_LINK_MAX_CHARS) return 'too-long'
  try {
    await navigator.clipboard.writeText(url)
    return 'copied'
  } catch {
    return 'failed'
  }
}

// ─── Shape guards (a link is untrusted text — never let it crash a list) ─────

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
const scalarArr = (v: unknown): Array<string | number> =>
  Array.isArray(v)
    ? v.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
    : []
const posInt = (v: unknown, max: number): number | undefined => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : undefined
}

/** The collection browser's shareable view. */
export interface CbvLinkState {
  /** Search box text. */
  q?: string
  /** Filter chips (ActiveFilter[] shape) incl. a `$at_risk` highlight entry. */
  f?: Array<Record<string, unknown>>
  /** Sort (`field` / `-field`). */
  s?: string
  /** Visible columns in order — saved-view column entries (key or {key, …}). */
  c?: Array<string | Record<string, unknown>>
  /** Quick-filter selections by key. */
  qf?: Record<string, Array<string | number>>
  /** Header column filters by column key. */
  cf?: Record<string, Record<string, unknown>>
  /** Deep-link context conditions. */
  lc?: Array<{ path: string[]; op: string; value: unknown; label?: string }>
  /** Right-click "exclude" filters. */
  ex?: Array<Record<string, unknown>>
  /** Group-by column. */
  g?: string
  /** Page size. */
  ps?: number
  /** Page number. */
  p?: number
  /** Only records with an addendum in flight. */
  a?: boolean
}

export function sanitizeCbvLinkState(raw: Record<string, unknown> | null): CbvLinkState | null {
  if (!raw) return null
  const out: CbvLinkState = {}
  const q = str(raw.q)
  if (q) out.q = q.slice(0, 500)
  if (Array.isArray(raw.f))
    out.f = raw.f
      .filter(
        (x): x is Record<string, unknown> =>
          isObj(x) && Array.isArray(x.path) && typeof x.op === 'string'
      )
      .slice(0, 50)
      // A chip needs an id (React key, edit / remove) and labels to render.
      .map((x, i) => ({
        ...x,
        id: typeof x.id === 'string' && x.id ? x.id : `lv-${i}`,
        pathLabels: Array.isArray(x.pathLabels) ? x.pathLabels : x.path,
        fieldType: typeof x.fieldType === 'string' ? x.fieldType : 'string',
        value: x.value ?? ''
      }))
  const s = str(raw.s)
  if (s && /^-?[\w.$]+$/.test(s)) out.s = s
  if (Array.isArray(raw.c))
    out.c = raw.c
      .filter(
        (x): x is string | Record<string, unknown> =>
          typeof x === 'string' || (isObj(x) && typeof x.key === 'string')
      )
      .slice(0, 100)
  if (isObj(raw.qf)) {
    const qf: Record<string, Array<string | number>> = {}
    for (const [k, v] of Object.entries(raw.qf)) {
      const vals = scalarArr(v)
      if (vals.length) qf[k] = vals.slice(0, 500)
    }
    out.qf = qf
  }
  if (isObj(raw.cf)) {
    const cf: Record<string, Record<string, unknown>> = {}
    for (const [k, v] of Object.entries(raw.cf))
      if (isObj(v) && typeof v.kind === 'string') cf[k] = v
    out.cf = cf
  }
  if (Array.isArray(raw.lc))
    out.lc = raw.lc
      .filter(
        (x): x is { path: string[]; op: string; value: unknown; label?: string } =>
          isObj(x) && Array.isArray(x.path) && typeof x.op === 'string'
      )
      .slice(0, 50)
  if (Array.isArray(raw.ex))
    out.ex = raw.ex
      .filter((x): x is Record<string, unknown> => isObj(x) && Array.isArray(x.path))
      .slice(0, 50)
  const g = str(raw.g)
  if (g && /^[\w.$]+$/.test(g)) out.g = g
  const ps = posInt(raw.ps, 200)
  if (ps) out.ps = ps
  const p = posInt(raw.p, 100000)
  if (p) out.p = p
  if (raw.a === true) out.a = true
  return out
}

/** A queue worklist's shareable view (its saved-view state + page). */
export interface QueueLinkState {
  scope?: 'mine' | 'unowned' | 'all' | 'claimed'
  filters?: Record<string, string | string[]>
  sort?: string
  group_by?: string | null
  view?: 'table' | 'kanban' | 'workload'
  columns?: string[] | null
  pins?: Record<string, 'left' | 'right'> | null
  page?: number
}

export function sanitizeQueueLinkState(raw: Record<string, unknown> | null): QueueLinkState | null {
  if (!raw) return null
  const out: QueueLinkState = {}
  if (
    raw.scope === 'mine' ||
    raw.scope === 'unowned' ||
    raw.scope === 'all' ||
    raw.scope === 'claimed'
  )
    out.scope = raw.scope
  if (isObj(raw.filters)) {
    const f: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(raw.filters)) {
      if (typeof v === 'string') f[k] = v.slice(0, 500)
      else {
        const arr = strArr(v)
        if (arr?.length) f[k] = arr.slice(0, 500)
      }
    }
    out.filters = f
  }
  const sort = str(raw.sort)
  if (sort && /^-?[\w.$]+$/.test(sort)) out.sort = sort
  const g = str(raw.group_by)
  if (g) out.group_by = g
  if (raw.view === 'table' || raw.view === 'kanban' || raw.view === 'workload') out.view = raw.view
  const cols = strArr(raw.columns)
  if (cols?.length) out.columns = cols.slice(0, 100)
  if (isObj(raw.pins)) {
    const pins: Record<string, 'left' | 'right'> = {}
    for (const [k, v] of Object.entries(raw.pins)) if (v === 'left' || v === 'right') pins[k] = v
    if (Object.keys(pins).length) out.pins = pins
  }
  const page = posInt(raw.page, 100000)
  if (page) out.page = page
  return out
}
