/**
 * The wire shape of GET /api/ops/request-story/:id (api/src/services/request-story.ts) and its
 * /related twin. Text only: statement TEXT, field NAMES, ids — never bound values, bodies,
 * query-string values or another person's subject lines.
 */

export type TimelineKind =
  | 'request'
  | 'phase'
  | 'hook'
  | 'sql'
  | 'write'
  | 'transition'
  | 'flow'
  | 'push'
  | 'call'
  | 'notify'
  | 'mail'
  | 'emit'
  | 'error'
  | 'other'

export interface TimelineEvent {
  kind: TimelineKind
  offset_ms: number | null
  at: string | null
  text: string
  ms?: number | null
  failed?: boolean
  record?: { collection: string; item: string; label?: string | null } | null
}

export interface StoryRequest {
  method: string
  path: string
  route: string
  status: number
  started_at: string | null
  finished_at: string | null
  latency_ms: number
  instance: string | null
  auth: string | null
  ip: string | null
  user_agent: string | null
  has_query: boolean
  body_kept: boolean
  error: string | null
  graphql: {
    operation: string | null
    kind: string | null
    depth: number | null
    selections: number | null
    errors: number | null
  } | null
  matched_by: string | null
}

export interface StoryCaller {
  kind: 'user' | 'api_key' | 'anonymous'
  label: string
  user_id: string | null
  api_key_id: number | null
  auth: string | null
  mcp: {
    conn: string | null
    client: string | null
    tool: string | null
    outcome: string | null
  } | null
}

export type PhaseCategory = 'auth' | 'access' | 'hooks' | 'work'

export interface StoryPhase {
  seq: number
  phase: string
  label: string
  category: PhaseCategory
  at: number
  ms: number
  depth: number
  detail: string | null
  queries: number | null
  repeat: { sql: string; n: number; ms: number } | null
  wide: Array<{ table: string; n: number }>
}

export interface StoryStatement {
  index: number
  sql: string
  n: number
  ms: number
  avg_ms: number
  share: number
  sha: string | null
  tables: string[]
  select: boolean
  truncated: boolean
  repeat_n: number | null
  wide: boolean
}

export interface StoryTraceDetail {
  total_ms: number
  queries: number
  sql_ms: number
  unaccounted_ms: number
  split: Array<{ key: PhaseCategory | 'unmeasured'; label: string; ms: number }>
  phases: StoryPhase[]
  statements: StoryStatement[]
  wide: Array<{ table: string; n: number }>
}

export type EffectKind =
  | 'write'
  | 'transition'
  | 'flow'
  | 'push'
  | 'attempt'
  | 'call'
  | 'notify'
  | 'mail'
  | 'other'

export interface EffectFacts {
  id?: number | null
  action?: 'create' | 'update' | 'delete' | null
  fields?: Array<{ field: string; label: string }>
  from?: string | null
  to?: string | null
  flow_id?: string | null
  status?: string | null
  halted_at?: string | null
  error?: string | null
  submission_id?: number | null
  api_id?: number | null
  attempts?: number | null
  http_status?: number | null
  method?: string | null
  url?: string | null
  duration_ms?: number | null
  recipient?: string | null
  recipient_id?: string | null
  category?: string | null
  lane?: string | null
  channels?: Array<{ channel: string; status: string; reason?: string | null }>
  template?: string | null
  recipients?: number | null
}

export interface StoryEffect {
  key: string
  parent: string | null
  kind: EffectKind
  at: string | null
  offset_ms: number | null
  who: string | null
  record: { collection: string; item: string; label?: string | null } | null
  summary: string
  failed: boolean
  reason: string | null
  facts: EffectFacts
}

export interface Story {
  request_id: string
  found: boolean
  headline: string
  status: number | null
  at: string | null
  total_ms: number | null
  route: string | null
  who: string | null
  chain_id: string | null
  timeline: TimelineEvent[]
  sql: {
    count: number
    ms: number
    statements: Array<{ sql: string; n: number; ms: number }>
  } | null
  hooks: Array<{ name: string; ms: number }>
  emits: Array<{ event: string; n: number }>
  notified: number
  sources: {
    log: 'found' | 'pending' | 'missing'
    trace: 'kept' | 'missing'
    chain: 'found' | 'empty' | 'none'
  }
  missing: string[]
  /** v2 — absent on an API older than the drill-down page. */
  request?: StoryRequest | null
  caller?: StoryCaller | null
  trace?: StoryTraceDetail | null
  effects?: StoryEffect[]
}

export interface RelatedRef {
  kind: string
  id: string
  label?: string
  at?: number
}

export interface RelatedGroup {
  key: string
  label: string
  refs: RelatedRef[]
  more?: number
}

export interface Related {
  groups: RelatedGroup[]
  notes: string[]
  load?: { id: string; page: string; calls: number } | null
  window?: number
}

/** activity /labels answer, the parts this page reads. */
export interface Labels {
  records?: Record<string, string | null>
  collections?: Record<string, { singular?: string | null; plural?: string | null } | string>
}
