import type { NivaroClient } from '@nivaro/sdk'
import { post } from './commands'

/**
 * Search analytics client (#1581). A search someone ran (Cmd+K, a collection
 * browser's search box) is logged with its query text, result count and time
 * taken; picking a result adds what kind of thing was opened — a collection
 * and id, never the result's content. Fire-and-forget: a failure is swallowed
 * and never reaches the person. Administrators read the totals.
 */

export interface SearchLogEntry {
  surface: 'palette' | 'collection'
  collection?: string | null
  query: string
  result_count: number
  duration_ms: number
}

export interface SearchOpen {
  type: 'record' | 'page' | 'action' | 'similar'
  collection?: string | null
  item?: string | number | null
}

/** Too short to be a search worth keeping. */
export const MIN_LOGGED_QUERY = 2

export async function logSearch(client: NivaroClient, e: SearchLogEntry): Promise<number | null> {
  if (e.query.trim().length < MIN_LOGGED_QUERY) return null
  try {
    const res = await client.request<{ data: { id: number | null } }>(
      post('/search-analytics/log', e)
    )
    return res?.data?.id ?? null
  } catch {
    return null
  }
}

export async function logSearchOpen(
  client: NivaroClient,
  id: Promise<number | null> | number | null,
  o: SearchOpen
): Promise<void> {
  try {
    const resolved = await id
    if (resolved == null) return
    await client.request(post(`/search-analytics/log/${resolved}/open`, o))
  } catch {
    // never reaches the person
  }
}
