import type { ActivityEntryInput } from '../../lib/activity-sentence'
import type { ActivitySource } from '../../lib/activity-table'

/** The request an entry came from (GET /api/activity/table → `request`). */
export interface ActivityRequestRef {
  request_id: string | null
  chain_id: string
  method: string | null
  path: string | null
  status: number | null
  latency_ms: number | null
  at: string | null
}

/** One row of GET /api/activity/table. */
export interface ActivityTableRow extends ActivityEntryInput {
  id: number
  action: string
  timestamp: string
  collection: string | null
  item: string | null
  comment?: string | null
  user?: string | null
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
  ip?: string | null
  group_key?: string | null
  source: ActivitySource
  fields_changed: string[]
  group_count: number | null
  request: ActivityRequestRef | null
}

export interface ActivityTablePage {
  data: ActivityTableRow[]
  total: number | null
  has_more: boolean
  limit: number
  offset: number
  sort: string
  window_from?: string
}

export interface FacetValue {
  value: string
  count: number
  label?: string | null
}

export interface ActivityFacets {
  facets: Record<'action' | 'collection' | 'user' | 'actor_kind' | 'source', FacetValue[]>
  from: string | null
  defaulted: boolean
}

export interface FieldChange {
  field: string
  from?: unknown
  to?: unknown
  hidden?: boolean
  no_previous?: boolean
}

/** GET /api/activity/:id/detail. */
export interface ActivityEntryDetailData {
  entry: ActivityTableRow & { user_agent?: string | null }
  changes: FieldChange[]
  revision: { id: number; previous_id: number | null } | null
  snapshot: Record<string, unknown> | null
  person: {
    id: string
    /** A name, or what the account is ("Deleted user", "Redacted person"). */
    name: string | null
    kind?: 'person' | 'deleted' | 'redacted' | 'placeholder' | 'machine' | 'unnamed'
    email: string | null
    status: string | null
    role: string | null
  } | null
  related: {
    same_request: ActivityTableRow[]
    same_group: { count: number; rows: ActivityTableRow[] }
    before: ActivityTableRow | null
    after: ActivityTableRow | null
    on_record: number
  } | null
}
