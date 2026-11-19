import { ROUTINE_READ_ACTIONS } from '@nivaro/shared'
import type { ActivityFilters } from '@/components/activity/activity-search'

/**
 * Whether a pulse entry (one activity row as it is written) can land on the Activity Log's
 * first page with these filters — rt4 #15. Only the filters the pulse can answer are judged
 * here (person, action, collection, record, burst); text search and date ranges are left to
 * the server's own re-read. `'read'` = a routine read (record views …), re-read on a slower beat.
 */
export function pulseMatchesLog(
  e: {
    action?: string | null
    collection?: string | null
    item?: string | null
    user?: string | null
    group_key?: string | null
  },
  f: ActivityFilters,
  groupKey = ''
): 'write' | 'read' | null {
  const action = e.action ?? ''
  if (!action) return null
  if (f.actions?.length && !f.actions.includes(action)) return null
  if (f.exclude_actions?.length) {
    const excluded = f.exclude_actions.includes('read')
      ? [...f.exclude_actions, ...ROUTINE_READ_ACTIONS]
      : f.exclude_actions
    if (excluded.includes(action)) return null
  }
  if (f.collections?.length && !f.collections.includes(e.collection ?? '')) return null
  if (f.item && String(e.item ?? '') !== String(f.item)) return null
  if (f.user && String(e.user ?? '').toLowerCase() !== String(f.user).toLowerCase()) return null
  if (groupKey && e.group_key !== groupKey) return null
  // A past window ("yesterday", or a `to` date) never gains new entries.
  if (f.range === 'yesterday') return null
  if (!f.range && f.to && Date.parse(f.to) < Date.now() - 86_400_000) return null
  return ROUTINE_READ_ACTIONS.includes(action) ? 'read' : 'write'
}

/**
 * rt-fix C (admin #12): the Table view follows the pulse only where a new entry can show up
 * without a jump — page 1, newest first. Other sorts and pages keep their rows still (the person
 * is reading them); a filter or page change re-reads anyway.
 */
export function tableFollowsPulse(
  state: { page: number; sort?: string | null },
  defaultSort: string | null | undefined
): boolean {
  return state.page === 1 && (state.sort ?? defaultSort) === defaultSort
}
