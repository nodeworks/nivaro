export interface Issue {
  id: number
  collection: string | null
  item: string | null
  title: string
  severity: string
  status: string
  source?: string | null
  details?: string | null
  assigned_to: string | null
  assigned_to_name?: string | null
  assigned_to_email?: string | null
  raised_by: string | null
  raised_by_name?: string | null
  raised_by_email?: string | null
  resolution_notes: string | null
  occurrence_count?: number | null
  last_seen_at?: string | null
  recording_id?: string | null
  recording_offset_ms?: number | null
  created_at: string
  updated_at: string
}

export interface IssueSummary {
  by_status: Record<string, number>
  by_severity: Record<string, number>
  active_by_severity?: Record<string, number>
  new_24h?: number
  seen_24h?: number
  unassigned_active?: number
  mine_active?: number
}

export interface CmsUser {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export const STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const

export const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
  active: 'Active',
  '': 'All'
}

export const SOURCE_LABEL: Record<string, string> = {
  server: 'Server',
  client: 'Browser',
  manual: 'Reported'
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace('_', ' ')
}

export function userLabel(u: CmsUser): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return name || u.email
}

export function personName(name?: string | null, email?: string | null): string | null {
  const n = (name ?? '').trim()
  return n || email || null
}

/** When the issue last happened: the newest occurrence, else when it was raised. */
export function lastSeen(i: Issue): string {
  return i.last_seen_at ?? i.created_at
}
