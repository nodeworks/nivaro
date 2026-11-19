import { featureLabel, resultLabel } from './format'

/**
 * The call log's whole state lives in the URL, so a filtered view, an open
 * call and an open conversation are links, and Back steps out of each:
 *
 *   window=24h|7d|30d|90d|custom  from=  to=        (custom: ISO or YYYY-MM-DD)
 *   feature= model= user= tool= result=             (comma lists)
 *   q=  error=  request_id=  conversation=  feedback=up|down|any|none
 *   cost_min= cost_max= tokens_min= tokens_max= ms_min= ms_max=
 *   sort=-when|+cost|…   page=
 *   call=<id>            the open call
 *   thread=1             its conversation is open over it
 */

export const WINDOWS = [
  { value: '24h', label: '24h', hours: 24 },
  { value: '7d', label: '7d', hours: 168 },
  { value: '30d', label: '30d', hours: 720 },
  { value: '90d', label: '90d', hours: 2160 }
] as const

export const LIST_KEYS = ['feature', 'model', 'user', 'tool', 'result'] as const
export type ListKey = (typeof LIST_KEYS)[number]
export const TEXT_KEYS = ['q', 'error', 'request_id', 'conversation', 'feedback'] as const
export const RANGE_KEYS = [
  'cost_min',
  'cost_max',
  'tokens_min',
  'tokens_max',
  'ms_min',
  'ms_max'
] as const
/** Keys that change what the list counts (a change goes back to page 1). */
export const FILTER_KEYS = [
  'window',
  'from',
  'to',
  ...LIST_KEYS,
  ...TEXT_KEYS,
  ...RANGE_KEYS
] as const

export function listOf(p: URLSearchParams, key: string): string[] {
  return (p.get(key) ?? '').split(',').filter(Boolean)
}

/** Add or remove one value of a comma-list key. */
export function toggleIn(p: URLSearchParams, key: string, value: string): void {
  const cur = listOf(p, key)
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
  if (next.length) p.set(key, next.join(','))
  else p.delete(key)
  p.delete('page')
}

/** The API querystring (filter only — no paging, sort or open call). */
export function apiFilter(p: URLSearchParams): URLSearchParams {
  const q = new URLSearchParams()
  const w = p.get('window') ?? '7d'
  if (w === 'custom' && p.get('from')) {
    q.set('from', p.get('from') as string)
    const to = p.get('to')
    if (to) q.set('to', to)
  } else {
    q.set('hours', String(WINDOWS.find((x) => x.value === w)?.hours ?? 168))
  }
  for (const k of [...LIST_KEYS, ...TEXT_KEYS, ...RANGE_KEYS]) {
    const v = p.get(k)
    if (v) q.set(k, v)
  }
  return q
}

export interface Chip {
  key: string
  label: string
  /** Remove just this chip from the params. */
  clear: (p: URLSearchParams) => void
}

/** Every filter that is on, as removable chips (window not included). */
export function activeChips(
  p: URLSearchParams,
  names: { people?: Map<string, string> } = {}
): Chip[] {
  const out: Chip[] = []
  const listLabel: Record<ListKey, (v: string) => string> = {
    feature: (v) => featureLabel(v),
    model: (v) => v,
    user: (v) => (v === 'system' ? 'System' : (names.people?.get(v) ?? 'Person')),
    tool: (v) => `tool ${v}`,
    result: (v) => resultLabel(v)
  }
  for (const k of LIST_KEYS) {
    for (const v of listOf(p, k)) {
      out.push({
        key: `${k}:${v}`,
        label: listLabel[k](v),
        clear: (x) => toggleIn(x, k, v)
      })
    }
  }
  const text: Record<string, (v: string) => string> = {
    q: (v) => `“${v}”`,
    error: (v) => `error has “${v}”`,
    request_id: (v) => `question #${v.slice(0, 6)}`,
    conversation: () => 'one conversation',
    feedback: (v) =>
      v === 'up'
        ? 'thumbs up'
        : v === 'down'
          ? 'thumbs down'
          : v === 'any'
            ? 'has feedback'
            : 'no feedback'
  }
  for (const k of TEXT_KEYS) {
    const v = p.get(k)
    if (v)
      out.push({
        key: k,
        label: text[k](v),
        clear: (x) => {
          x.delete(k)
          x.delete('page')
        }
      })
  }
  const range = (lo: string, hi: string, label: string, fmt: (n: string) => string) => {
    const a = p.get(lo)
    const b = p.get(hi)
    if (!a && !b) return
    out.push({
      key: lo,
      label:
        a && b
          ? `${label} ${fmt(a)}–${fmt(b)}`
          : a
            ? `${label} ≥ ${fmt(a)}`
            : `${label} ≤ ${fmt(b as string)}`,
      clear: (x) => {
        x.delete(lo)
        x.delete(hi)
        x.delete('page')
      }
    })
  }
  range('cost_min', 'cost_max', 'cost', (n) => `$${n}`)
  range('tokens_min', 'tokens_max', 'tokens', (n) => Number(n).toLocaleString('en-US'))
  range('ms_min', 'ms_max', 'time', (n) => `${(Number(n) / 1000).toFixed(1)}s`)
  return out
}

/** Clear every filter but the window (and close what is open). */
export function clearFilters(p: URLSearchParams): void {
  for (const k of [...LIST_KEYS, ...TEXT_KEYS, ...RANGE_KEYS, 'page']) p.delete(k)
}
