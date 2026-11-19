/** Shapes of /api/ai/call-log/* (api/src/routes/ai-call-log.ts). */

export interface CallRow {
  id: number
  created_at: string
  request_id: string | null
  user: string | null
  user_name: string | null
  feature: string
  provider: string
  model: string
  status: 'ok' | 'error'
  latency_ms: number
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cost_usd: number | null
  stop_reason: string | null
  tool_calls: number | null
  error: string | null
  question: string | null
  tools: string[]
  conversation_id: string | null
  feedback: { up: number; down: number } | null
  tier: 'cheap' | 'main' | null
  tier_reason: string | null
}

export interface CallPage {
  data: CallRow[]
  total: number
  page: number
  limit: number
  sort: string
  search_ready: boolean
}

export interface Breakdown {
  key: string | null
  calls: number
  questions?: number
  errors?: number
  cost_usd: number
  avg_latency?: number
}

export interface FacetOption {
  value: string
  label: string
  count: number
}

export interface CallSummary {
  from: string
  to: string
  bucket: 'hour' | 'day'
  calls: number
  questions: number
  errors: number
  error_rate: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cost_usd: number
  avg_latency: number
  p50: number
  p95: number
  tool_calls: number
  feedback: { up: number; down: number }
  by_feature: Breakdown[]
  by_model: Array<
    Breakdown & {
      provider: string
      input_tokens: number
      cache_read_tokens: number
      output_tokens: number
    }
  >
  by_person: Array<Breakdown & { name: string }>
  by_result: Breakdown[]
  series: Array<{ bucket: string; calls: number; errors: number; cost_usd: number }>
  facets: {
    features: FacetOption[]
    models: FacetOption[]
    people: FacetOption[]
    tools: FacetOption[]
  }
  search_ready: boolean
}

export interface ToolResultSummary {
  error: boolean
  rows: number | null
  total: number | null
  columns: string[]
  sample: Array<Record<string, string>>
  text: string
  chars: number
}

export interface ToolStep {
  kind: 'tool'
  id: string | null
  name: string
  input: Array<[string, string]>
  result: ToolResultSummary | null
  from_this_call: boolean
}

export interface AttachmentNote {
  type: string
  media_type: string | null
  size_kb: number | null
  name: string | null
}

export type TranscriptStep =
  | { kind: 'question'; text: string; attachments: AttachmentNote[] }
  | { kind: 'note'; text: string }
  | ToolStep
  | { kind: 'answer'; text: string; final: boolean }

export interface Transcript {
  earlier: Array<{ role: 'user' | 'assistant'; text: string }>
  steps: TranscriptStep[]
  hidden: {
    system_chars: number
    tool_definitions: number
    tool_names: string[]
    cache_markers: number
  }
  cut: { request: boolean; response: boolean }
  unreadable: boolean
}

export interface ThreadCall {
  id: number
  created_at: string
  model: string
  status: string
  stop_reason: string | null
  latency_ms: number
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cost_usd: number | null
  tool_calls: number | null
  tools: string[]
}

export interface FeedbackEntry {
  rating: number
  comment: string | null
  user_name: string
  at: string
}

export interface RawBody {
  value: unknown
  cut: boolean
  text: string | null
}

export interface CallDetail {
  call: {
    id: number
    created_at: string
    request_id: string | null
    user: string | null
    user_name: string | null
    feature: string
    route: string | null
    provider: string
    model: string
    status: 'ok' | 'error'
    stop_reason: string | null
    latency_ms: number
    input_tokens: number | null
    output_tokens: number | null
    cache_read_tokens: number | null
    cache_write_tokens: number | null
    cost_usd: number | null
    tool_calls: number | null
    rounds: number | null
    error: string | null
    routing: {
      tier: 'cheap' | 'main'
      main_model: string
      cheap_model: string
      reason?: string
      rerun?: boolean
    } | null
    tool_payload: Record<
      string,
      { calls: number; before: number; after: number; reused: number }
    > | null
    prompt_parts: { v?: string; p?: Array<[string, number, number]> } | null
  }
  transcript: Transcript
  question_calls: ThreadCall[]
  question_totals: { calls: number; cost_usd: number; tokens: number; latency_ms: number }
  feedback: FeedbackEntry[]
  conversation: { id: string; title: string; message_id: string | null } | null
  raw?: { request: RawBody; response: RawBody }
}

export interface ThreadTurn {
  question_id: string
  question: string
  asked_by: string | null
  asked_at: string | null
  answer_id: string | null
  answer: string | null
  answered_at: string | null
  withheld: boolean
  request_id: string | null
  trace: Array<{ tool: string; summary: string | null; error: boolean }>
  calls: ThreadCall[]
  cost_usd: number
  tokens: number
  latency_ms: number
  feedback: FeedbackEntry[]
}

export interface Thread {
  conversation: {
    id: string
    title: string
    owner: string | null
    owner_name: string
    created_at: string | null
    updated_at: string | null
    message_count: number
    parent_id: string | null
  } | null
  reconstructed: boolean
  turns: ThreadTurn[]
  totals: { turns: number; calls: number; cost_usd: number; tokens: number; latency_ms: number }
  focus_message_id: string | null
}

export interface SavedView {
  id: string
  name: string
  query: string
  shared: boolean
  owner: string
  owner_name: string
  created_at: string
  mine: boolean
}
