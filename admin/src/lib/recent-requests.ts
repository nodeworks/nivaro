/**
 * The last failed API calls of this tab (#19 request story): the response's request id
 * (`x-nivaro-request-id`), method, path (no query string) and status. Session storage only — the
 * Request story page offers them as "your recent failures", so an error toast's id never has to
 * be copied by hand.
 */
const KEY = 'nvr:recent-failed-requests'
const KEEP = 20
const RID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface RecentFailedRequest {
  id: string
  method: string
  path: string
  status: number
  at: string
}

export function recentFailedRequests(): RecentFailedRequest[] {
  try {
    const raw = sessionStorage.getItem(KEY)
    const list = raw ? (JSON.parse(raw) as RecentFailedRequest[]) : []
    return Array.isArray(list) ? list.filter((r) => r && RID.test(String(r.id))) : []
  } catch {
    return []
  }
}

/** Called by the axios error interceptor; never throws. */
export function noteFailedRequest(opts: {
  id: unknown
  method?: string | null
  url?: string | null
  status?: number | null
}): void {
  try {
    const id = typeof opts.id === 'string' ? opts.id.toLowerCase() : ''
    if (!RID.test(id)) return
    const path = String(opts.url ?? '')
      .split('?')[0]
      .slice(0, 200)
    const next = [
      {
        id,
        method: String(opts.method ?? 'get').toUpperCase(),
        path: path.startsWith('/api') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`,
        status: Number(opts.status ?? 0),
        at: new Date().toISOString()
      },
      ...recentFailedRequests().filter((r) => r.id !== id)
    ].slice(0, KEEP)
    sessionStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage full or blocked — the list is a convenience */
  }
}

/** The admin path of one request's story. */
export function requestStoryPath(requestId: string): string {
  return `/health/request-story?id=${encodeURIComponent(requestId)}`
}
